import assert from 'node:assert/strict';
import { createServer, get as httpGet } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createPreviewServer, parseProxyTarget } from './serve.mjs';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
async function setup(t, handler) {
  const root = await mkdtemp('/tmp/rustcore-demo-proxy-test-');
  await writeFile(join(root, 'config.json'), JSON.stringify({ api_base: '', live_enabled: true }));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Preview</title>');
  const upstream = createServer(handler);
  const port = await listen(upstream);
  const preview = await createPreviewServer({ root, proxyTarget: `http://127.0.0.1:${port}` });
  const localPort = await listen(preview);
  t.after(async () => { await close(preview); await close(upstream); await rm(root, { recursive: true, force: true }); });
  return `http://127.0.0.1:${localPort}`;
}

test('only explicit literal loopback targets are accepted', () => {
  assert.equal(parseProxyTarget(null), null);
  assert.equal(parseProxyTarget('http://127.0.0.1:8787').hostname, '127.0.0.1');
  for (const target of ['http://localhost:8787', 'http://127.1:8787', 'http://2130706433:8787', 'http://[::1]:8787', 'https://127.0.0.1:8787', 'http://192.168.1.1:8787', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://user@127.0.0.1:8787', 'http://127.0.0.1:8787/api', 'http://127.0.0.1:8787/?target=example.com', 'http://127.0.0.1:8787/#fragment']) {
    assert.throws(() => parseProxyTarget(target), /DEMO_API_PROXY/);
  }
});

test('read proxy preserves timeline cursor and strips browser identity and credentials', async (t) => {
  let observed;
  const url = await setup(t, (request, response) => {
    observed = { method: request.method, url: request.url, headers: request.headers };
    response.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'private=do-not-forward' });
    response.end('{"rounds":[]}');
  });
  const response = await fetch(url + '/api/timeline?limit=20&cursor=opaque%2Bcursor', { headers: { Origin: 'https://visitor.example', Authorization: 'Bearer browser-only', Cookie: 'browser=only', 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.2' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rounds: [] });
  assert.equal(observed.method, 'GET');
  assert.equal(observed.url, '/api/timeline?limit=20&cursor=opaque%2Bcursor');
  for (const key of ['origin', 'authorization', 'cookie', 'x-forwarded-for', 'x-real-ip']) assert.equal(observed.headers[key], undefined, key);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('write methods, HEAD API requests and unlisted routes never reach caller', async (t) => {
  let forwarded = 0;
  const url = await setup(t, (_request, response) => { forwarded++; response.end('{}'); });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const response = await fetch(url + '/api/state', { method });
    assert.equal(response.status, 405, method);
    await response.text();
  }
  for (const path of ['/api/run-scenario', '/api/other', '/%2e%2e%2fpackage.json']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 404, path);
    await response.text();
  }
  assert.equal(forwarded, 0);
  assert.equal((await fetch(url)).status, 200);
});

test('SSE arrives before completion, forwards public cursor, and disconnect cancels upstream', async (t) => {
  let observeClose;
  const closed = new Promise((resolve) => { observeClose = resolve; });
  let headers;
  const url = await setup(t, (request, response) => {
    headers = request.headers;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('id: public-opaque\nevent: heartbeat\ndata: {"at":"now"}\n\n');
    response.on('close', observeClose);
    // Deliberately stay open. A buffering proxy would never deliver this event.
  });
  await new Promise((resolve, reject) => {
    const request = httpGet(url + '/api/stream', { headers: { 'Last-Event-ID': 'public-before', Origin: 'https://visitor.example', Cookie: 'private' } }, (response) => {
      response.once('data', (chunk) => {
        assert.match(chunk.toString(), /id: public-opaque/);
        assert.equal(response.headers['x-accel-buffering'], 'no');
        request.destroy();
        resolve();
      });
    });
    request.setTimeout(2000, () => { request.destroy(); reject(new Error('SSE did not stream its first chunk.')); });
    request.on('error', reject);
  });
  assert.equal(headers['last-event-id'], 'public-before');
  assert.equal(headers.origin, undefined);
  assert.equal(headers.cookie, undefined);
  await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Upstream did not close after downstream disconnect.')), 2000); timer.unref(); })]);
});
