import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer, type Server } from 'node:net';
import { CallerRuntime, type Rpc, type RuntimeKernel } from '../src/runtime.js';
import type { DemoConfig } from '../src/config.js';
import { DemoStore } from '../src/store.js';
import { BTC, type Row } from '../src/facts.js';
import type { StepActual } from '../../shared/schema.js';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const TOKEN = 'synthetic-private-runtime-token';
const SECRET = 'synthetic-private-runtime-secret';
const config: DemoConfig = {
  envFile: '/tmp/runtime-fixture/env', credentialId: '9001', grpcAddress: '127.0.0.1:1',
  kernelBinary: '/tmp/runtime-fixture/kernel', kernelDbFile: '/tmp/runtime-fixture/kernel.db',
  callerDbFile: ':memory:', lockFile: '/tmp/runtime-fixture/round.lock', holdMs: 1000, phaseTimeoutMs: 1000,
  source: { kind: 'MOCK', label: '离线运行时测试' }, build: { caller_commit: 'mock-runtime-v1', rustcore_commit: 'mock-kernel-v1' },
  environment: { ENGINE_LIVE_ENABLED: '0', ENGINE_STAGE_MAX: 'demo', RUSTCORE_GRPC_AUTH_TOKEN: TOKEN,
    BINANCE_API_SECRET_FIXTURE: SECRET }, connectOnly: false,
};

interface Subscription {
  request: Row;
  data(event: Row): void;
  error(error: Error): void;
  cancelled: boolean;
}

class MockRpc implements Rpc {
  calls: { method: string; request: Row; at: number }[] = [];
  subscriptions: Subscription[] = [];
  closed = 0;
  boot = 'boot-one';
  online = true;
  readError: Error | null = null;
  onReadyRead: (() => void) | null = null;
  accountGate: Promise<void> | null = null;
  reconcileGate: Promise<void> | null = null;
  reconcileError: Error | null = null;
  account: Row = { available: true, as_of_ms: String(NOW - 7), observed_at_ms: String(NOW),
    equity_usdt: '1000', available_usdt: '900', open_positions_count: '0', positions: [] };
  positions: Row = { positions: [], orphan_positions: [] };
  publishResponse: Row = { accepted: true, applied: true };

  async unary(_service: 'v2' | 'next', method: string, request: Row): Promise<Row> {
    this.calls.push({ method, request: structuredClone(request), at: Date.now() });
    if (method === 'GetKillSwitchStates') {
      if (!this.online) throw new Error(`private ${TOKEN} ${SECRET} 9001 /tmp/runtime-fixture/private`);
      this.onReadyRead?.();
      return { snapshot_stale: false, rows: [{ found: false }, { found: false }, { found: false }] };
    }
    if (method === 'EnsureMarketData') return { accepted: true };
    if (method === 'ReconcileNow') {
      await this.reconcileGate;
      if (this.reconcileError) throw this.reconcileError;
      return { accepted: true, completed: true, has_diff: false,
        local_position_zero_diff: true, all_positions_zero: true, all_open_orders_empty: true, all_open_algo_orders_empty: true };
    }
    if (method === 'GetAccountState') {
      await this.accountGate;
      if (this.readError) throw this.readError;
      return structuredClone(this.account);
    }
    if (method === 'GetPositionStates') return structuredClone(this.positions);
    if (method === 'GetOpenOrders') return { orders: [] };
    if (method === 'GetAccountOrderState') {
      const now = String(Date.now()), meta = { coverage: 'AOC_COMPLETE_VENUE', overflow: false, returned_count: 0, total_count: 0 };
      return { credential_id: config.credentialId, engine_boot_id: this.boot, observed_at_ms: now, account_kind: 'exchange', local: {},
        venue: { availability: 'AOA_AVAILABLE', credential_id: config.credentialId, engine_boot_id: this.boot,
          observation_id: `observation-${this.boot}-${now}`, capture_started_at_ms: now, capture_completed_at_ms: now, source_as_of_ms: now,
          latest_attempt: { observation_id: `observation-${this.boot}-${now}`, status: 'succeeded', coverage: 'full_account', started_at_ms: now, completed_at_ms: now },
          ordinary: { meta, rows: [], started_at_ms: now, completed_at_ms: now }, algo: { meta, rows: [], started_at_ms: now, completed_at_ms: now } } };
    }
    if (method === 'PutRiskBudget') return structuredClone(this.publishResponse);
    throw new Error(`Unexpected mock RPC ${method}`);
  }
  streamEvents(request: Row, data: (event: Row) => void, error: (error: Error) => void): { cancel(): void } {
    const subscription: Subscription = { request: structuredClone(request), data, error, cancelled: false };
    this.subscriptions.push(subscription);
    return { cancel: () => { subscription.cancelled = true; } };
  }
  close(): void { this.closed++; }
  budgets(): Row[] { return this.calls.filter(value => value.method === 'PutRiskBudget').map(value => value.request); }
  current(): Subscription { const value = this.subscriptions.at(-1); assert.ok(value); return value; }
  emit(seq: string | number, eventId: string, body: Row = {}, key = 'authority-key'): void {
    this.current().data({ credential_id: config.credentialId, seq, event_id: eventId, event_type: 'fill',
      symbol_key: BTC, idempotency_key: key, payload_json: Buffer.from(JSON.stringify(body)) });
  }
}

class MockKernel implements RuntimeKernel {
  starts = 0; restarts = 0; stops = 0;
  isRunning = false;
  onRestart: (() => void) | null = null;
  async start(): Promise<void> { this.starts++; this.isRunning = true; }
  async restart(): Promise<void> { this.restarts++; this.onRestart?.(); }
  async stop(): Promise<void> { this.stops++; this.isRunning = false; }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `127.0.0.1:${address.port}`;
}
async function freeAddress(): Promise<string> {
  const server = createServer(), address = await listen(server);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address;
}

async function fixture(t: TestContext, grpcAddress?: string) {
  const address = grpcAddress ?? await freeAddress();
  t.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: NOW });
  const store = new DemoStore(':memory:', { source: config.source, build: config.build });
  const rpc = new MockRpc(), kernel = new MockKernel();
  const runtime = new CallerRuntime({ ...config, grpcAddress: address }, store, kernel, rpc);
  t.after(async () => { await runtime.stop(); store.close(); });
  return { runtime, store, rpc, kernel };
}

test('timer cadence publishes every ten seconds while preserving original source as_of and approximate public fields', async (t) => {
  const { runtime, store, rpc } = await fixture(t);
  await runtime.start();
  assert.equal(rpc.budgets().length, 1);
  assert.equal(rpc.budgets()[0]?.as_of_ms, String(NOW - 7));
  t.mock.timers.tick(9999); await runtime.refresh();
  assert.equal(rpc.budgets().length, 1);
  t.mock.timers.tick(1); await runtime.refresh();
  assert.equal(rpc.budgets().length, 2);
  assert.equal(rpc.budgets()[1]?.as_of_ms, String(NOW - 7));
  assert.equal(store.getState().risk_budget.source_as_of, new Date(NOW - 7).toISOString());
  rpc.account.equity_usdt = '1200'; rpc.account.as_of_ms = String(NOW + 10000);
  await runtime.refresh(); // Populate the next timer's cache; do not assume an unread RPC response.
  t.mock.timers.tick(10000); await runtime.refresh();
  const view = store.getState().risk_budget;
  assert.equal(view.approximate_today_pnl_usdt, '200');
  assert.equal(view.approximate_today_pnl_pct, 0.2);
  assert.equal(view.last_publish_applied, true);
  assert.equal(Object.keys(view).some(key => key.includes('realized')), false);
  assert.equal(rpc.budgets().at(-1)?.today_realized_pnl_usdt, '200', 'only the private RPC retains the kernel field name');
});

test('unavailable or stale observations never publish replacement budgets', async (t) => {
  const { runtime, store, rpc } = await fixture(t);
  rpc.account.available = false;
  await runtime.start();
  assert.equal(rpc.budgets().length, 0);
  assert.equal(store.getState().risk_budget.status, 'NOT_PUBLISHED');
  rpc.account.available = true;
  rpc.account.as_of_ms = String(NOW - 30001);
  t.mock.timers.tick(10000); await runtime.refresh();
  assert.equal(rpc.budgets().length, 0);
  assert.notEqual(store.getState().risk_budget.status, 'FRESH');
});

test('applied=false is retained as a failed publication rather than upgraded to fresh', async (t) => {
  const { runtime, store, rpc } = await fixture(t);
  rpc.publishResponse = { accepted: true, applied: false, current_as_of_ms: String(NOW - 1) };
  await runtime.start();
  const state = store.getState();
  assert.equal(rpc.budgets().length, 1);
  assert.equal(state.risk_budget.last_publish_applied, false);
  assert.equal(state.risk_budget.status, 'NOT_PUBLISHED');
  assert.match(state.risk_budget.reason, /未确认应用/);
  assert.ok(runtime.budgetNotes.includes('风险预算未应用'));
});

test('stream cursors above 2^53 remain exact, dedupe persists, reconnect resumes, and stop cancels all scheduling', async (t) => {
  const { runtime, store, rpc, kernel } = await fixture(t);
  await runtime.start();
  assert.equal(rpc.current().request.since_seq, '0');
  rpc.emit('9007199254740993', 'event-a');
  rpc.emit('9007199254740993', 'event-a');
  rpc.emit('9007199254740994', 'event-b');
  rpc.emit('9007199254740992', 'late-event');
  rpc.emit(Number.MAX_SAFE_INTEGER + 2, 'unsafe-number');
  assert.equal(store.getCoreCursor(), '9007199254740994');
  assert.equal(store.getCoreEvents().length, 3);
  const original = rpc.current();
  original.error(new Error('disconnected'));
  t.mock.timers.tick(1999); await runtime.refresh();
  assert.equal(rpc.subscriptions.length, 1);
  t.mock.timers.tick(1); await runtime.refresh();
  assert.equal(rpc.subscriptions.length, 2);
  assert.equal(original.cancelled, true);
  assert.equal(rpc.current().request.since_seq, '9007199254740994');
  original.data({ credential_id: config.credentialId, seq: '9999999999999999', event_id: 'obsolete-stream' });
  assert.equal(store.getCoreEvents().length, 3);
  rpc.current().error(new Error('pending reconnect'));
  await runtime.stop(); await runtime.stop();
  const count = rpc.calls.length, streams = rpc.subscriptions.length;
  t.mock.timers.tick(100000); await runtime.refresh();
  assert.equal(rpc.calls.length, count);
  assert.equal(rpc.subscriptions.length, streams);
  assert.equal(rpc.current().cancelled, true);
  assert.equal(kernel.stops, 1);
  assert.equal(rpc.closed, 1);
});

test('fill summaries aggregate actual trades once and never substitute requested or cumulative quantity', async (t) => {
  const { runtime, rpc } = await fixture(t);
  await runtime.start();
  rpc.emit('1', 'first-ws-fill', { exchangeTradeId: '9007199254740993', fillQty: '0.1', fillPrice: '100', requestedQty: '99', cumulativeFilledQty: '99' });
  rpc.emit('2', 'same-trade-rest-replay', { exchange_trade_id: '9007199254740993', fillQty: '0.1', fillPrice: '100' });
  rpc.emit('3', 'second-fill', { exchangeTradeId: '9007199254740994', fillQty: '0.2', fillPrice: '110' });
  rpc.emit('4', 'requested-only', { exchangeTradeId: 'other-trade', requestedQty: '1000', fillPrice: '1000' });
  rpc.emit('5', 'missing-trade-id', { fillQty: '1000', fillPrice: '1000' });
  rpc.emit('6', 'unsafe-trade-id', { exchangeTradeId: Number.MAX_SAFE_INTEGER + 2, fillQty: '1000', fillPrice: '1000' });
  rpc.emit('7', 'other-order', { exchangeTradeId: 'other-order-trade', fillQty: '1000', fillPrice: '1000' }, 'different-authority-key');
  assert.deepEqual(runtime.fills('authority-key', 'BUY'), { side: 'BUY', quantity: '0.3', average_price: '106.666666666666666666', notional_usdt: '32' });
  assert.equal(runtime.fills('no-fills', 'SELL'), null);
});

test('restart records RESTARTING then OFFLINE then ONLINE, observes the new boot and keeps its durable stream cursor', async (t) => {
  const { runtime, store, rpc, kernel } = await fixture(t);
  await runtime.start();
  rpc.emit('9007199254740993', 'before-restart');
  const statuses: string[] = [];
  const unsubscribe = store.subscribe(event => { if (event.type === 'state') statuses.push(event.data.rustcore.status); });
  kernel.onRestart = () => {
    t.mock.timers.tick(1); rpc.boot = 'boot-two';
    rpc.account.equity_usdt = '1100'; rpc.account.as_of_ms = String(Date.now());
  };
  await runtime.restartKernel(); unsubscribe();
  assert.deepEqual(statuses, ['RESTARTING', 'OFFLINE', 'ONLINE', 'ONLINE']); // Read, then independent budget publication.
  assert.equal(runtime.snapshot?.accountOrders.engine_boot_id, 'boot-two');
  assert.equal(runtime.snapshot?.bootStartedAt, NOW + 1);
  assert.equal(store.getState().rustcore.last_restart_at, new Date(NOW + 1).toISOString());
  assert.equal(rpc.current().request.since_seq, '9007199254740993');
  assert.equal(kernel.restarts, 1);
  assert.equal(store.getState().risk_budget.day_start_equity_usdt, '1000');
  assert.equal(store.getState().risk_budget.approximate_today_pnl_usdt, '100');
  assert.equal(rpc.calls.filter(value => value.method === 'EnsureMarketData').length, 2);
});

test('restart state advances past a later startStep journal event without refreshing source facts', async (t) => {
  const { runtime, store, kernel } = await fixture(t);
  await runtime.start();
  store.startRound('MANUAL', 'restart-order-regression');
  const oldStateTime = store.getState().generated_at;
  const oldSource = store.getState().account.source_as_of;
  t.mock.timers.tick(500);
  const actual: StepActual = { summary: 'synthetic restart', code: null, account: null, position: null,
    open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null };
  const step = store.startStep('restart-order-regression', 'restart_kernel', 'restart the owned child', actual);
  assert.equal(store.getState().generated_at, oldStateTime, 'a step can be newer than the stored state snapshot');
  assert.ok(step.started_at > oldStateTime);
  const stateTimes: string[] = [];
  const unsubscribe = store.subscribe(event => { if (event.type === 'state') stateTimes.push(event.data.generated_at); });
  await runtime.restartKernel(); unsubscribe();
  assert.equal(kernel.restarts, 1);
  assert.ok(stateTimes.every(time => time >= step.started_at));
  assert.equal(store.getState().account.source_as_of, oldSource);
});

test('a restart state-write exception before killing the child restores stream and reads and still permits stop', async (t) => {
  const { runtime, store, rpc, kernel } = await fixture(t);
  await runtime.start();
  const before = store.getState();
  before.rustcore.last_restart_at = new Date(NOW - 1000).toISOString();
  store.setState(before);
  const originalStream = rpc.current();
  const setState = store.setState.bind(store);
  let rejectOnce = true;
  t.mock.method(store, 'setState', (...args: Parameters<DemoStore['setState']>) => {
    if (rejectOnce) { rejectOnce = false; throw new Error('synthetic journal failure'); }
    return setState(...args);
  });
  await assert.rejects(runtime.restartKernel(), /synthetic journal failure/);
  assert.equal(kernel.restarts, 0, 'the journal failure occurs before any kernel restart');
  assert.equal(store.getState().rustcore.last_restart_at, before.rustcore.last_restart_at);
  assert.equal(originalStream.cancelled, true);
  assert.equal(rpc.subscriptions.length, 2);
  rpc.emit('9007199254740993', 'after-restart-write-failure');
  assert.equal(store.getCoreCursor(), '9007199254740993');
  const reads = rpc.calls.filter(call => call.method === 'GetAccountState').length;
  await runtime.refresh();
  t.mock.timers.tick(2000); await runtime.refresh();
  assert.ok(rpc.calls.filter(call => call.method === 'GetAccountState').length > reads);
  assert.equal(store.getState().rustcore.status, 'ONLINE');
  await runtime.stop();
  assert.equal(kernel.stops, 1);
});

test('stop aborts a startup wait and an in-flight refresh cannot write public state after shutdown', async (t) => {
  const { runtime, store, rpc } = await fixture(t);
  await runtime.start();
  let resolveAccount!: () => void;
  rpc.accountGate = new Promise<void>(resolve => { resolveAccount = resolve; });
  let updates = 0;
  store.subscribe(event => { if (event.type === 'state') updates++; });
  t.mock.timers.tick(2000);
  const stopping = runtime.stop();
  resolveAccount(); await stopping;
  assert.equal(updates, 0);
  t.mock.timers.tick(100000);
  assert.equal(updates, 0);

  const secondStore = new DemoStore(':memory:', { source: config.source, build: config.build });
  const secondRpc = new MockRpc(); secondRpc.online = false;
  const second = new CallerRuntime({ ...config, grpcAddress: await freeAddress() }, secondStore, new MockKernel(), secondRpc);
  try {
    const starting = second.start();
    // The real loopback ownership probe is asynchronous even with mocked RPCs.
    while (!secondRpc.calls.length) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(secondRpc.calls.filter(value => value.method === 'GetKillSwitchStates').length, 1);
    await second.stop(); await starting;
    const count = secondRpc.calls.length;
    t.mock.timers.tick(100000);
    assert.equal(secondRpc.calls.length, count);
    assert.equal(second.isStarted, false);
  } finally { await second.stop(); secondStore.close(); }
});

test('public failures redact private values and the real transport constructor resolves the pinned submodule proto directory', async (t) => {
  const { runtime, store, rpc } = await fixture(t);
  await runtime.start();
  rpc.readError = new Error(`failed ${TOKEN} ${SECRET} 9001 https://private.example/path /tmp/runtime-fixture/private`);
  await assert.rejects(runtime.refresh(), (error: unknown) => {
    assert.ok(error instanceof Error);
    for (const secret of [TOKEN, SECRET, '9001', 'private.example', '/tmp/runtime-fixture/private'])
      assert.equal(error.message.includes(secret), false, secret);
    return true;
  });
  assert.equal(store.getState().rustcore.status, 'OFFLINE');
  assert.equal(store.getState().account.status, 'UNAVAILABLE');
  for (const secret of [TOKEN, SECRET, 'private.example']) assert.equal(JSON.stringify(store.getState()).includes(secret), false);
  const transportStore = new DemoStore(':memory:', { source: config.source, build: config.build });
  const transport = new CallerRuntime(config, transportStore, new MockKernel());
  await transport.stop(); transportStore.close(); // No start/RPC: constructs and closes lazy local channels only.
});

test('managed startup refuses an occupied port and never mistakes the existing service for its own core', async (t) => {
  const existing = createServer(socket => socket.end());
  const address = await listen(existing);
  try {
    const { runtime, rpc, kernel } = await fixture(t, address);
    await assert.rejects(runtime.start(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'GRPC_ADDRESS_IN_USE'); return true;
    });
    assert.equal(kernel.starts, 0);
    assert.equal(rpc.calls.length, 0, 'no health RPC adopts the already listening service');
    assert.equal(existing.listening, true, 'the pre-existing listener is preserved');
  } finally { await new Promise<void>(resolve => existing.close(() => resolve())); }
});

test('a successful health reply cannot make an exited owned child ready', async (t) => {
  const { runtime, rpc, kernel } = await fixture(t);
  rpc.onReadyRead = () => { kernel.isRunning = false; };
  await assert.rejects(runtime.start(), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'OWNED_KERNEL_EXITED'); return true;
  });
  assert.equal(kernel.starts, 1);
  assert.equal(rpc.calls.some(call => call.method === 'EnsureMarketData'), false);
  assert.equal(runtime.isStarted, false);
});

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

test('a pending poll/full reconcile cannot block ten-second cached budget publication or hide its expiry', async (t) => {
  const { runtime, store, rpc } = await fixture(t);
  await runtime.start();
  const oldAccount = structuredClone(store.getState().account), oldPositions = structuredClone(store.getState().positions);
  let releaseAccount!: () => void, releaseReconcile!: () => void;
  rpc.accountGate = new Promise<void>(resolve => { releaseAccount = resolve; });
  rpc.reconcileGate = new Promise<void>(resolve => { releaseReconcile = resolve; });
  try {
    t.mock.timers.tick(2000); await flush(); // The ordinary read is now pending.
    t.mock.timers.tick(8000); await flush(); // Full reconcile also starts, independently.
    assert.equal(runtime.snapshot?.receivedAt, NOW);
    assert.equal(rpc.budgets().length, 2);
    assert.equal(rpc.budgets()[1]?.as_of_ms, String(NOW - 7));
    t.mock.timers.tick(10000); await flush();
    assert.equal(rpc.budgets().length, 3);
    t.mock.timers.tick(10000); await flush();
    assert.equal(rpc.budgets().length, 3, 'the old source is now over 30 seconds old, regardless of cached receipt time');
    const state = store.getState();
    assert.equal(state.risk_budget.status, 'STALE');
    assert.equal(state.risk_budget.age_ms, 30007);
    assert.equal(state.generated_at, new Date(NOW + 30000).toISOString());
    assert.deepEqual(state.account, oldAccount);
    assert.deepEqual(state.positions, oldPositions);
    assert.equal(rpc.calls.filter(call => call.method === 'ReconcileNow').length, 2, 'only one background full request is in flight');
  } finally {
    releaseAccount(); releaseReconcile(); await runtime.refresh();
  }
});

test('ordinary reads continue during full reconcile, while force waits for it and then obtains a new snapshot', async (t) => {
  const { runtime, rpc } = await fixture(t);
  await runtime.start();
  let releaseReconcile!: () => void;
  rpc.reconcileGate = new Promise<void>(resolve => { releaseReconcile = resolve; });
  t.mock.timers.tick(10000);
  await runtime.refresh();
  assert.equal(runtime.snapshot?.receivedAt, NOW + 10000, 'normal poll did not await the full request');
  let releaseAccount!: () => void;
  rpc.accountGate = new Promise<void>(resolve => { releaseAccount = resolve; });
  const olderRead = runtime.refresh();
  await flush();
  let forcedDone = false;
  const forced = runtime.refresh(true).then(() => { forcedDone = true; });
  const before = rpc.calls.filter(call => call.method === 'GetAccountState').length;
  await flush(); assert.equal(forcedDone, false);
  releaseReconcile(); await flush(); assert.equal(forcedDone, false, 'a read already in progress must be drained first');
  releaseAccount(); await olderRead; await forced;
  assert.equal(rpc.calls.filter(call => call.method === 'GetAccountState').length, before + 1);
  assert.equal(rpc.calls.filter(call => call.method === 'ReconcileNow').length, 2, 'forced read joined the same full request');
});

test('read failure disables cached budget inputs until a fresh read succeeds; full failure does not stop ordinary reads', async (t) => {
  const { runtime, store, rpc } = await fixture(t);
  await runtime.start();
  rpc.readError = new Error('synthetic read failure');
  await assert.rejects(runtime.refresh());
  const count = rpc.budgets().length;
  t.mock.timers.tick(10000); await flush();
  assert.equal(rpc.budgets().length, count);
  assert.equal(store.getState().risk_budget.status, 'UNAVAILABLE');
  rpc.readError = null;
  rpc.reconcileError = new Error(`full failed ${TOKEN}`);
  await runtime.refresh(true);
  assert.equal(store.getState().rustcore.status, 'ONLINE');
  assert.equal(runtime.lastReconcile.accepted, false);
  assert.equal(runtime.lastReconcile.completed, false);
  assert.equal(String(runtime.lastReconcile.message).includes(TOKEN), false);
  t.mock.timers.tick(10000); await runtime.refresh(); await flush();
  assert.equal(rpc.budgets().length, count + 1);
});
