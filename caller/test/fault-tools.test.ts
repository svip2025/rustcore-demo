import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { ControlledFaultProxy, killOwnedChild } from '../src/fault-tools.js';

test('F1/F2 forward one request, hold response, SIGKILL only owned child at selected boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r2-proxy-'));
  try {
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
    const tls = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
    for (const fault of ['F1', 'F2'] as const) {
      let sent = 0, boundary = false, delivered = false;
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      await new Promise<void>(resolve => child.once('spawn', resolve));
      const upstream = createServer((_req, res) => { sent++; res.end('{"orderId":1}'); });
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const address = upstream.address(); assert.ok(address && typeof address !== 'string');
      const proxy = new ControlledFaultProxy({ tls, simulation: { rest_origin: `http://127.0.0.1:${address.port}` },
        onBoundary: async event => {
          assert.equal(event.fault, fault);
          assert.equal(event.phase, 'REQUEST_FORWARDED_RESPONSE_HELD');
          assert.equal(delivered, false);
          await killOwnedChild(child);
          assert.equal(child.signalCode, 'SIGKILL');
          boundary = true;
        } });
      try {
        const port = await proxy.listen(); proxy.arm(fault);
        const send = (reduce: boolean) => new Promise<void>((resolve, reject) => {
          const req = request(`https://127.0.0.1:${port}/fapi/v1/order?symbol=BTCUSDT&type=MARKET&reduceOnly=${reduce}&signature=private`,
            { method: 'POST', ca: tls.cert }, res => {
              delivered = true;
              if (reduce === (fault === 'F2')) assert.equal(boundary, true);
              res.resume(); res.on('end', resolve);
            });
          req.on('error', reject); req.end();
        });
        // The other kind of order must not consume the fault or kill anything.
        await send(fault !== 'F2');
        assert.equal(boundary, false); assert.equal(child.signalCode, null);
        delivered = false;
        await send(fault === 'F2');
        assert.equal(boundary, true); assert.equal(sent, 2);
        assert.equal(proxy.status.consumed, true);
        assert.equal(proxy.status.failure, null);
        assert.ok(!JSON.stringify(proxy.status).includes('private'));
        assert.throws(() => proxy.arm(fault), /FAULT_ALREADY/);
      } finally {
        if (child.signalCode === null) child.kill('SIGTERM');
        await proxy.close();
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('simulation cannot become a configurable remote forwarding proxy', () => {
  assert.throws(() => new ControlledFaultProxy({ tls: {}, simulation: { rest_origin: 'https://example.com' }, onBoundary: async () => {} }), /LOOPBACK/);
});
