import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIdentity, sampleResources } from '../src/observability.js';

test('hourly resource sample measures live process and DB/WAL bytes; clock includes uncertainty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r2-sample-'));
  try {
    await writeFile(join(dir, 'core.db'), Buffer.alloc(4096));
    await writeFile(join(dir, 'core.db-wal'), Buffer.alloc(128));
    await writeFile(join(dir, 'caller.db'), Buffer.alloc(8192));
    let at = 1800000000000;
    const sample = await sampleResources({ kernel: await processIdentity(process.pid), kernelDbFile: join(dir, 'core.db'),
      callerDbFile: join(dir, 'caller.db'), credentialId: 'private-account', now: () => at,
      rpc: { unary: async () => ({ user_stream_reconnect_count: '8', user_stream_reconnects_last_minute: '1',
        user_stream_ready: true, observed_at_ms: String(at), websocket_scopes: [
          { scope: 'USER_DATA_STREAM', status: 'OBSERVED', reconnect_count: '8', reconnects_last_minute: '1' },
          { scope: 'TRADE_WS_API', status: 'DISABLED' },
          { scope: 'MARKET_DATA', status: 'OBSERVED', reconnect_count: '9', reconnects_last_minute: '6' },
        ] }) },
      fetch: async () => { at += 100; return new Response(JSON.stringify({ serverTime: at + 450 })); } });
    assert.ok(sample.kernel_rss_bytes! > 0);
    assert.match(sample.kernel_process_generation!, /^[a-f0-9]{64}$/);
    assert.equal(sample.database_bytes.kernel?.total, 4224);
    assert.equal(sample.database_bytes.caller?.main, 8192);
    assert.equal(sample.clock_offset_ms, 500);
    assert.equal(sample.clock_uncertainty_ms, 50);
    assert.equal(sample.websocket_reconnect_count, '8');
    assert.equal(sample.websocket_scopes[1]?.reconnect_count, null);
    assert.equal(sample.websocket_scopes[2]?.exceeds_five_per_minute, true);
    assert.deepEqual(sample.reasons, []);
    assert.ok(!JSON.stringify(sample).includes('private-account'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed metrics stay unknown and a reused process identity is refused', async () => {
  const sample = await sampleResources({ kernel: { pid: process.pid, start_ticks: 'impossible' },
    kernelDbFile: '/missing-kernel.db', callerDbFile: '/missing-caller.db', credentialId: '9001',
    rpc: { unary: async () => { throw new Error('private secret listenKey'); } },
    fetch: async () => new Response('{}', { status: 503 }) });
  assert.equal(sample.kernel_rss_bytes, null);
  assert.equal(sample.kernel_process_generation, null);
  assert.equal(sample.database_bytes.kernel, null);
  assert.equal(sample.websocket_reconnect_count, null);
  assert.equal(sample.clock_offset_ms, null);
  assert.equal(sample.reasons.length, 5);
  assert.ok(!JSON.stringify(sample).includes('listenKey'));
});
