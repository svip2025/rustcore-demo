import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Server } from 'node:net';
import { DemoStore } from '../src/store.js';
import { openLocalControl, requestLocalRound } from '../src/local-control.js';

const options = { source: { kind: 'MOCK' as const, label: '测试假数据' }, build: { caller_commit: 'mock-caller-v1', rustcore_commit: 'mock-rustcore-v1' } };
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test('local command channel is 0600 and preserves MANUAL identity, failed round and progress', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-control-'));
  const store = new DemoStore(join(directory, 'caller.db'), options);
  let server: Server | undefined;
  try {
    const socket = join(directory, 'control.sock');
    server = await openLocalControl(socket, { run: async trigger => {
      const round = store.startRound(trigger);
      return store.finishRound(round.round_id, 'FAILED', 'not_started: 原失败保留');
    } }, store);
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    const events: Record<string, unknown>[] = [];
    const result = await requestLocalRound(socket, 'MANUAL', event => events.push(event));
    assert.equal(result.status, 'FAILED');
    assert.equal(result.trigger, 'MANUAL');
    assert.ok(events.some(e => e.event === 'round'));
    assert.equal(store.getTimeline().rounds[0]?.reason, 'not_started: 原失败保留');
  } finally { if (server) await close(server); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid local command never starts a round; a normal file is not removed as a stale socket', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'demo-control-'));
  const store = new DemoStore(join(directory, 'caller.db'), options);
  let calls = 0, server: Server | undefined;
  try {
    const socket = join(directory, 'control.sock');
    server = await openLocalControl(socket, { run: async trigger => { calls++; return store.startRound(trigger); } }, store);
    const response = await new Promise<string>((resolve, reject) => {
      const client = connect(socket); let data = '';
      client.on('connect', () => client.write('{"command":"trade","trigger":"MANUAL"}\n'));
      client.on('data', chunk => { data += chunk; }); client.on('end', () => resolve(data)); client.on('error', reject);
    });
    assert.match(response, /LOCAL_REQUEST_INVALID/); assert.equal(calls, 0);
    const other = join(directory, 'ordinary-file'); await writeFile(other, 'keep');
    await assert.rejects(openLocalControl(other, { run: async trigger => store.startRound(trigger) }, store), /占用/);
    assert.equal((await stat(other)).isFile(), true);
  } finally { if (server) await close(server); store.close(); await rm(directory, { recursive: true, force: true }); }
});
