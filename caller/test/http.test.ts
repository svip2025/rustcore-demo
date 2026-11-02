import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { SseEvent, StepActual } from '../../shared/schema.js';
import { createReadOnlyApp, type ReadOnlyHttpOptions } from '../src/http.js';
import { DemoStore } from '../src/store.js';

const metadata = { source: { kind: 'MOCK' as const, label: 'Synthetic HTTP fixture' },
  build: { caller_commit: 'mock-caller-v1', rustcore_commit: 'mock-rustcore-v1' } };
const actual: StepActual = { summary: 'Synthetic step', code: null, account: null, position: null,
  open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null };

function fixture(t: TestContext, options: ReadOnlyHttpOptions = {}) {
  const store = new DemoStore(':memory:', metadata);
  const http = createReadOnlyApp(store, options);
  t.after(() => { http.close(); store.close(); });
  return { store, ...http };
}

async function event(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SseEvent> {
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  const lines = new TextDecoder().decode(chunk.value).trim().split('\n');
  const data = JSON.parse(lines.find(line => line.startsWith('data: '))!.slice(6)) as SseEvent;
  assert.equal(lines.find(line => line.startsWith('event: ')), `event: ${data.type}`);
  assert.equal(lines.find(line => line.startsWith('id: ')), `id: ${data.event_id}`);
  assert.equal(data.schema_version, 1);
  assert.deepEqual(data.source, metadata.source);
  return data;
}

function countSubscriptions(t: TestContext, store: DemoStore) {
  const subscribe = store.subscribe.bind(store);
  let active = 0;
  t.mock.method(store, 'subscribe', (listener: Parameters<DemoStore['subscribe']>[0]) => {
    const release = subscribe(listener);
    active++;
    return () => { active--; release(); };
  });
  return () => active;
}

test('state and timeline expose only the public store contract, preserve source time, and hide private core events', async t => {
  const { app, store } = fixture(t);
  const privateMarker = 'synthetic-private-key-do-not-expose';
  store.appendCoreEvent('9007199254740993', 'private-event', { credential_id: 'fixture-credential',
    payload_json: privateMarker, private_path: '/tmp/private-fixture' });
  const initial = store.getState();
  const response = await app.request('/api/state');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), initial);
  const timeline = await app.request('/api/timeline');
  assert.equal(timeline.status, 200);
  const body = await timeline.text();
  assert.equal(JSON.parse(body).schema_version, 1);
  assert.deepEqual(JSON.parse(body).rounds, []);
  assert.equal(JSON.stringify({ body, initial }).includes(privateMarker), false);
  assert.equal(body.includes('fixture-credential'), false);
  assert.equal((await app.request('/api/core-events')).status, 404);
  assert.equal((await app.request('/api/health')).status, 503);
  assert.deepEqual(store.getState(), initial, 'reads do not refresh source observations');
});

test('health requires fresh account/core dependencies while reporting snapshot completeness separately', async t => {
  const { app, store } = fixture(t);
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  const state = store.getState();
  const at = new Date(now).toISOString();
  state.generated_at = at;
  state.rustcore = { ...state.rustcore, status: 'ONLINE', checked_at: at };
  const observation = { status: 'AVAILABLE' as const, observed_at: at, source_as_of: at, reason: 'Synthetic complete fact' };
  state.account = { ...observation, value: { account_label: 'Demo account', equity_usdt: '1000', available_usdt: '900',
    position_mode: 'ONE_WAY', margin_mode: 'CROSS', btc_leverage: 1 } };
  state.positions = { ...observation, value: [] };
  state.open_orders = { ...observation, value: [] };
  state.protection = { ...observation, value: [] };
  store.setState(state);
  assert.equal((await app.request('/api/health')).status, 200);
  t.mock.timers.tick(30_001);
  const stale = await app.request('/api/health');
  assert.equal(stale.status, 503);
  assert.equal((await stale.json() as { status: string }).status, 'degraded');
  assert.deepEqual(store.getState(), state);
  state.generated_at = new Date(Date.now()).toISOString();
  state.rustcore.checked_at = state.generated_at;
  state.account.source_as_of = state.generated_at;
  state.positions.source_as_of = state.generated_at;
  state.open_orders.source_as_of = state.generated_at;
  state.protection.source_as_of = state.generated_at;
  state.protection.status = 'PARTIAL';
  store.setState(state);
  const partial = await app.request('/api/health');
  assert.equal(partial.status, 200);
  assert.equal((await partial.json() as { snapshot_complete: boolean }).snapshot_complete, false);
  assert.equal(store.getState().protection.status, 'PARTIAL');
  state.generated_at = new Date(Date.now()).toISOString();
  state.account.status = 'UNAVAILABLE';
  store.setState(state);
  assert.equal((await app.request('/api/health')).status, 503);
});

test('every non-GET method is rejected and exact origins are enforced', async t => {
  const { app, store } = fixture(t, { allowedOrigin: 'https://viewer.example' });
  const before = store.getState();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    const response = await app.request('/api/state', { method });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'GET');
  }
  assert.deepEqual(store.getState(), before);
  const allowed = await app.request('/api/state', { headers: { Origin: 'https://viewer.example' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://viewer.example');
  for (const origin of ['https://viewer.example.evil', 'http://viewer.example', 'null', 'http://localhost']) {
    const rejected = await app.request('/api/state', { headers: { Origin: origin } });
    assert.equal(rejected.status, 403, origin);
    assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
  }
  const local = fixture(t);
  assert.equal((await local.app.request('/api/state', { headers: { Origin: 'http://localhost' } })).status, 200);
  assert.equal((await local.app.request('/api/state', { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  assert.throws(() => createReadOnlyApp(store, { allowedOrigin: '*' }));
});

test('rate limits use adapter peer IP rather than spoofed forwarding headers, and expire', async t => {
  const { app } = fixture(t, { rateLimit: 1, windowMs: 60_000 });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const peer = (address: string) => ({ incoming: { socket: { remoteAddress: address, remotePort: 1234, remoteFamily: 'IPv4' } } });
  assert.equal((await app.request('/api/state', { headers: { 'X-Forwarded-For': '198.51.100.1' } }, peer('192.0.2.1'))).status, 200);
  const blocked = await app.request('/api/state', { headers: { 'X-Forwarded-For': '198.51.100.2', 'X-Real-IP': '198.51.100.3' } }, peer('192.0.2.1'));
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
  assert.equal((await app.request('/api/state', {}, peer('192.0.2.2'))).status, 200);
  t.mock.timers.tick(60_000);
  assert.equal((await app.request('/api/state', {}, peer('192.0.2.1'))).status, 200);
  const trusted = fixture(t, { rateLimit: 1, resolveIp: context => context.req.header('X-Test-Trusted-IP') ?? 'unknown' });
  assert.equal((await trusted.app.request('/api/state', { headers: { 'X-Test-Trusted-IP': 'one' } })).status, 200);
  assert.equal((await trusted.app.request('/api/state', { headers: { 'X-Test-Trusted-IP': 'two' } })).status, 200);
});

test('timeline validates bounds and returns its opaque cursor without exposing internal errors', async t => {
  const { app, store } = fixture(t);
  store.startRound('MANUAL', 'public-round-one');
  store.finishRound('public-round-one', 'FAILED', 'Synthetic failure retained');
  store.startRound('MANUAL', 'public-round-two');
  const response = await app.request('/api/timeline?limit=1');
  const page = await response.json() as { rounds: { round_id: string }[]; next_cursor: string };
  assert.equal(page.rounds.length, 1);
  assert.equal(typeof page.next_cursor, 'string');
  const next = await app.request(`/api/timeline?limit=1&cursor=${encodeURIComponent(page.next_cursor)}`);
  assert.equal(next.status, 200);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=NaN', 'limit=', 'cursor=unknown']) {
    const rejected = await app.request(`/api/timeline?${query}`);
    assert.equal(rejected.status, 400, query);
    assert.deepEqual(await rejected.json(), { error: 'Invalid timeline query' });
  }
});

test('first SSE connection sends one durable state/timeline baseline, then ordered round/state/step updates; cancellation releases subscription', async t => {
  const { app, store } = fixture(t);
  const active = countSubscriptions(t, store);
  const response = await app.request('/api/stream');
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8');
  const reader = response.body!.getReader();
  const first = await event(reader), second = await event(reader);
  assert.deepEqual([first.type, second.type], ['state', 'timeline']);
  assert.equal(active(), 1);
  store.startRound('MANUAL', 'stream-round');
  store.startStep('stream-round', 'preflight', 'Synthetic expected condition', actual);
  const updates = [await event(reader), await event(reader), await event(reader)];
  assert.deepEqual(updates.map(value => value.type), ['round', 'state', 'step']);
  assert.equal(new Set([first, second, ...updates].map(value => value.event_id)).size, 5);
  await reader.cancel();
  assert.equal(active(), 0);
});

test('any reconnect cursor triggers resync then full baseline and preserves updates arriving during baseline construction', async t => {
  const { app, store } = fixture(t);
  const snapshot = store.snapshotEvents.bind(store);
  t.mock.method(store, 'snapshotEvents', (...args: Parameters<DemoStore['snapshotEvents']>) => {
    const baseline = snapshot(...args);
    store.startRound('MANUAL', 'arrived-during-baseline');
    return baseline;
  });
  const response = await app.request('/api/stream?since_event_id=unknown');
  const reader = response.body!.getReader();
  const events = [await event(reader), await event(reader), await event(reader), await event(reader), await event(reader)];
  assert.deepEqual(events.map(value => value.type), ['resync', 'state', 'timeline', 'round', 'state']);
  assert.equal(new Set(events.map(value => value.event_id)).size, 5, 'baseline subscriber notifications are not sent twice');
  await reader.cancel();
  t.mock.restoreAll();
  const header = await app.request('/api/stream', { headers: { 'Last-Event-ID': '' } });
  const headerReader = header.body!.getReader();
  assert.equal((await event(headerReader)).type, 'resync', 'even an empty present reconnect header requests resync');
  await headerReader.cancel();
});

test('aborted requests, slow consumers, and app.close release their live subscriptions', async t => {
  const { app, store, close } = fixture(t, { rateLimit: 1000 });
  const active = countSubscriptions(t, store);
  const abort = new AbortController();
  const aborted = await app.request('/api/stream', { signal: abort.signal });
  assert.equal(active(), 1);
  abort.abort();
  assert.equal(active(), 0);
  await aborted.body!.cancel();
  const slow = await app.request('/api/stream');
  for (let i = 0; i < 140; i++) store.setState(store.getState());
  assert.equal(active(), 0, 'a stalled reader is disconnected after its bounded queue fills');
  await slow.body!.cancel();
  const last = await app.request('/api/stream');
  assert.equal(active(), 1);
  close();
  assert.equal(active(), 0);
  await last.body!.cancel();
  assert.equal((await app.request('/api/state')).status, 503);
});
