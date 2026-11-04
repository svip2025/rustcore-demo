import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagedKernel } from '../src/kernel-process.js';
import type { DemoConfig } from '../src/config.js';
import { DemoStore } from '../src/store.js';
import { ControlledFaultProxy } from '../src/fault-tools.js';
import { FaultController, faultSnapshot, openFaultControl, prepareFaultTransport, requestFaultControl } from '../src/fault-control.js';
import { ScenarioFailure } from '../src/facts.js';

type Runtime = Parameters<typeof faultSnapshot>[0];
function fixture(directory: string): { runtime: Runtime; store: DemoStore; config: DemoConfig } {
  const config: DemoConfig = { envFile: join(directory, 'env'), credentialId: '9001', grpcAddress: '127.0.0.1:1',
    kernelMode: 'child', kernelBinary: process.execPath, kernelDbFile: join(directory, 'kernel.sqlite'), callerDbFile: join(directory, 'caller.sqlite'),
    lockFile: join(directory, 'scenario.lock'), holdMs: 1, phaseTimeoutMs: 1000, source: { kind: 'MOCK', label: '离线故障控制模拟' },
    build: { caller_commit: 'mock-caller', rustcore_commit: 'mock-core' }, connectOnly: false,
    environment: { DEMO_ROUND2_FAULTS: '1', ENGINE_LIVE_ENABLED: '0', ENGINE_STAGE_MAX: 'demo', BINANCE_VENUE_H39303031: 'testnet' } };
  const store = new DemoStore(config.callerDbFile, config);
  const at = Date.now(), iso = new Date(at).toISOString();
  const state = store.getState();
  state.account = { status: 'AVAILABLE', observed_at: iso, source_as_of: iso, reason: '合成', value: { account_label: '离线别名',
    equity_usdt: '10000', available_usdt: '10000', position_mode: 'ONE_WAY', margin_mode: 'CROSS', btc_leverage: 1 } };
  state.positions = { status: 'AVAILABLE', observed_at: iso, source_as_of: iso, reason: '合成', value: [] };
  state.open_orders = { status: 'AVAILABLE', observed_at: iso, source_as_of: iso, reason: '合成', value: [] };
  store.setState(state);
  const runtime: Runtime = { config, store, isStarted: true, snapshot: {
    receivedAt: at, bootStartedAt: at - 1000, account: { available: true, as_of_ms: String(at) }, positions: {}, orders: {}, kills: {},
    accountOrders: { engine_boot_id: 'mock-boot', venue: { credential_id: '9001', engine_boot_id: 'mock-boot', observation_id: 'mock-observation',
      capture_completed_at_ms: String(at), availability: 'AOA_AVAILABLE', latest_attempt: { observation_id: 'mock-observation', status: 'succeeded', coverage: 'full_account' } } },
  }, lastReconcile: { accepted: true, completed: true, has_diff: false, local_position_zero_diff: true,
    all_positions_zero: true, all_open_orders_empty: true, all_open_algo_orders_empty: true },
    refresh: async () => {}, restartKernel: async () => {}, rpc: { unary: async () => ({ accepted: true }), streamEvents: () => ({ cancel() {} }), close() {} } };
  return { runtime, store, config };
}

test('fault snapshots require a complete fresh same-boot venue observation, never just empty local arrays', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fault-snapshot-'));
  const { runtime, store } = fixture(directory);
  try {
    assert.equal(faultSnapshot(runtime).clean, true);
    runtime.lastReconcile.all_open_algo_orders_empty = false;
    assert.equal(faultSnapshot(runtime).complete, true);
    assert.equal(faultSnapshot(runtime).clean, false);
    runtime.lastReconcile.all_open_algo_orders_empty = true;
    const venue = runtime.snapshot!.accountOrders.venue as Record<string, unknown>;
    venue.capture_completed_at_ms = String(Date.now() - 30001);
    assert.equal(faultSnapshot(runtime).complete, false);
    assert.equal(faultSnapshot(runtime).clean, false);
    venue.capture_completed_at_ms = String(Date.now()); venue.engine_boot_id = 'other-boot';
    assert.equal(faultSnapshot(runtime).complete, false);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('fault control stores private before/after snapshots, refuses parallel faults and makes clean recovery idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fault-control-'));
  const { runtime, store } = fixture(directory);
  const proxy = new ControlledFaultProxy({ tls: {}, onBoundary: async () => {} });
  let crashes = 0, restarts = 0, cleanup = 0, running = true;
  const kernel = { get isRunning() { return running; }, async crash() { crashes++; running = false; } };
  runtime.restartKernel = async () => { restarts++; running = true; };
  const controller = new FaultController(runtime, { recoverAfterFault: async () => { cleanup++; return { summary: '合成恢复', code: null,
    account: null, position: null, open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null }; } }, kernel, proxy);
  const socket = join(directory, 'fault.sock');
  const server = await openFaultControl(socket, controller);
  try {
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    const armed = await requestFaultControl(socket, { command: 'arm', fault: 'F1' });
    assert.equal(armed.phase, 'ARMED');
    await assert.rejects(requestFaultControl(socket, { command: 'arm', fault: 'F2' }), /FAULT_RECOVERY_REQUIRED/);
    const active = store.startRound('MANUAL');
    await assert.rejects(requestFaultControl(socket, { command: 'recover' }), /FAULT_NOT_COMPLETED/);
    store.finishRound(active.round_id, 'FAILED', '合成未完成轮次');
    await controller.onBoundary({ fault: 'F1', phase: 'REQUEST_FORWARDED_RESPONSE_HELD', at: new Date().toISOString() });
    assert.equal(crashes, 1);
    assert.equal((await requestFaultControl(socket, { command: 'status' })).phase, 'CRASHED');
    const clean = await requestFaultControl(socket, { command: 'recover' });
    assert.equal(clean.clean, true);
    assert.equal(clean.phase, 'CLEAN');
    assert.equal(restarts, 1); assert.equal(cleanup, 1);
    await requestFaultControl(socket, { command: 'recover' });
    assert.equal(restarts, 1); assert.equal(cleanup, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM demo_fault_snapshots').get()!.n, 2);
    assert.ok(!JSON.stringify(clean).includes('credential_id'));
    assert.equal(store.getTimeline().rounds.length, 1);
    assert.equal(store.getTimeline().rounds[0]!.status, 'FAILED', 'fault recovery cannot rewrite a failed scenario');
    const invalid = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = connect(socket); let body = '';
      client.on('connect', () => client.write(JSON.stringify({ command: 'arm', fault: 'F1', pid: 1 }) + '\n'));
      client.on('data', data => { body += data; }); client.on('end', () => resolve(JSON.parse(body) as Record<string, unknown>)); client.on('error', reject);
    });
    assert.equal(invalid.ok, false); assert.equal(invalid.code, 'FAULT_COMMAND_INVALID');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('fault opt-in rejects foreign/service owners and private keys with broad permissions before opening a proxy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fault-transport-'));
  const { config, store } = fixture(directory);
  try {
    assert.equal(await prepareFaultTransport({ ...config, environment: {} }), null);
    await assert.rejects(prepareFaultTransport({ ...config, kernelMode: 'systemd' }), error => error instanceof ScenarioFailure && error.code === 'FAULT_MODE_NOT_AUTHORIZED');
    await assert.rejects(prepareFaultTransport({ ...config, connectOnly: true }), /故障工具/);
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
    await writeFile(key, 'not a real key', { mode: 0o644 }); await chmod(key, 0o644);
    await writeFile(cert, 'not a real cert');
    await assert.rejects(prepareFaultTransport({ ...config, environment: { ...config.environment, DEMO_FAULT_TLS_KEY: key, DEMO_FAULT_TLS_CERT: cert } }),
      error => error instanceof ScenarioFailure && error.code === 'FAULT_TLS_PERMISSIONS');
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('F3 records the complete before snapshot, restores after evidence and blocks a new fault after caller restart until recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fault-owner-restart-'));
  const { runtime, store } = fixture(directory);
  const kernel = { isRunning: true, crash: async () => { throw new Error('F3 must never crash the child'); } };
  const runner = { recoverAfterFault: async () => ({ summary: '合成恢复', code: null,
    account: null, position: null, open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null }) };
  try {
    const first = new FaultController(runtime, runner, kernel, new ControlledFaultProxy({ tls: {}, onBoundary: async () => {} }));
    const before = await first.execute({ command: 'network' });
    assert.equal(before.fault, 'F3'); assert.equal(before.phase, 'NETWORK_FAULT');
    const restored = new FaultController(runtime, runner, kernel, new ControlledFaultProxy({ tls: {}, onBoundary: async () => {} }));
    assert.equal(restored.status().phase, 'UNKNOWN'); assert.equal(restored.status().code, 'FAULT_OWNER_RESTARTED');
    await assert.rejects(restored.execute({ command: 'arm', fault: 'F1' }), /FAULT_RECOVERY_REQUIRED/);
    const after = await restored.execute({ command: 'recover' });
    assert.equal(after.phase, 'CLEAN'); assert.equal(after.receipt_id, before.receipt_id);
    const repeat = await restored.execute({ command: 'network' });
    assert.notEqual(repeat.receipt_id, before.receipt_id, 'each injection owns a fresh receipt');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM demo_fault_receipts').get()!.n, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('controller crash/recover uses the actual owned child handle and preserves its independent SQLite database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fault-real-owned-child-'));
  const { runtime, config, store } = fixture(directory);
  const child = new ManagedKernel(config, { args: ['--input-type=module', '-e', `
    import {DatabaseSync} from 'node:sqlite';
    import {randomUUID} from 'node:crypto';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('CREATE TABLE IF NOT EXISTS boots (id TEXT PRIMARY KEY) STRICT');
    db.prepare('INSERT INTO boots(id) VALUES(?)').run(randomUUID());
    setInterval(()=>{},1000);
  `, config.kernelDbFile] });
  const kernelDb = new DatabaseSync(config.kernelDbFile);
  kernelDb.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS boots (id TEXT PRIMARY KEY) STRICT');
  const count = () => Number(kernelDb.prepare('SELECT COUNT(*) AS n FROM boots').get()!.n);
  const waitCount = async (target: number) => {
    const until = Date.now() + 5000;
    while (count() < target) { assert.ok(Date.now() < until); await delay(10); }
  };
  const controller = new FaultController(runtime, { recoverAfterFault: async () => ({ summary: '合成交易所快照；真实子进程/数据库', code: null,
    account: null, position: null, open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null }) }, child,
    new ControlledFaultProxy({ tls: {}, onBoundary: async () => {} }));
  runtime.restartKernel = async () => { await child.restart(); await waitCount(2); };
  try {
    await child.start(); await waitCount(1);
    const original = child.processId;
    await controller.execute({ command: 'arm', fault: 'F1' });
    await controller.onBoundary({ fault: 'F1', phase: 'REQUEST_FORWARDED_RESPONSE_HELD', at: new Date().toISOString() });
    assert.equal(child.isRunning, false);
    assert.equal((await child.waitForExit()).signal, 'SIGKILL');
    assert.equal(count(), 1);
    const result = await controller.execute({ command: 'recover' });
    assert.equal(result.clean, true); assert.equal(child.isRunning, true);
    assert.notEqual(child.processId, original); assert.equal(count(), 2);
    assert.equal(store.getTimeline().rounds.length, 0);
  } finally { await child.stop(); kernelDb.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a fault that never reaches its boundary can be disarmed and cleaned without claiming injection success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fault-unhit-'));
  const { runtime, store } = fixture(directory);
  try {
    let crashes = 0;
    const proxy = new ControlledFaultProxy({ tls: {}, onBoundary: async () => {} });
    const controller = new FaultController(runtime, { recoverAfterFault: async () => ({ summary: '合成', code: null,
      account: null, position: null, open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null }) },
    { isRunning: true, async crash() { crashes++; } }, proxy);
    await controller.execute({ command: 'arm', fault: 'F1' });
    const recovered = await controller.execute({ command: 'recover' });
    assert.equal(crashes, 0); assert.equal(recovered.clean, true);
    assert.equal(recovered.code, 'FAULT_BOUNDARY_NOT_REACHED'); assert.equal(recovered.boundary, null);
    assert.equal(proxy.status.armed, null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM demo_fault_snapshots').get()!.n, 2);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
