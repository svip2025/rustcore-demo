import { constants } from 'node:fs';
import { chmod, lstat, open, unlink } from 'node:fs/promises';
import { createServer, connect, type Server } from 'node:net';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type { StateResponse } from '../../shared/schema.js';
import type { DemoConfig } from './config.js';
import { credentialLocator } from './config.js';
import { ControlledFaultProxy, type FaultBoundary, type KillFault } from './fault-tools.js';
import type { ManagedKernel } from './kernel-process.js';
import type { CallerRuntime } from './runtime.js';
import type { ScenarioRunner } from './scenario.js';
import { fresh, row, ScenarioFailure, type Row } from './facts.js';

type Runtime = Pick<CallerRuntime, 'config' | 'store' | 'snapshot' | 'lastReconcile' | 'isStarted' | 'refresh' | 'restartKernel' | 'rpc'>;
export interface FaultSnapshot { complete: boolean; clean: boolean; observed_at: string; state: StateResponse }
export type FaultCommand = { command: 'status' } | { command: 'snapshot' } | { command: 'recover' } | { command: 'network' }
  | { command: 'arm'; fault: KillFault }
  | { command: 'stream'; action: 'disconnect' | 'listen_key_expired' };
interface Receipt {
  receipt_id: string; fault: 'F1' | 'F2' | 'F3' | 'F4'; phase: 'ARMED' | 'CRASHING' | 'CRASHED' | 'STREAM_FAULT' | 'NETWORK_FAULT' | 'RECOVERING' | 'CLEAN' | 'UNKNOWN';
  started_at: string; updated_at: string; boundary: FaultBoundary | null;
  before: FaultSnapshot; after: FaultSnapshot | null; code: string | null;
}
interface Transport {
  config: DemoConfig;
  proxy: ControlledFaultProxy;
  setBoundaryHandler(handler: (event: FaultBoundary) => Promise<void>): void;
}

function requireFaultMode(config: DemoConfig): void {
  const environment = config.environment;
  if (environment.DEMO_ROUND2_FAULTS !== '1' || environment.ENGINE_LIVE_ENABLED !== '0' || environment.ENGINE_STAGE_MAX !== 'demo'
    || environment[`BINANCE_VENUE_${credentialLocator(config.credentialId)}`] !== 'testnet' || config.connectOnly || config.kernelMode !== 'child')
    throw new ScenarioFailure('FAULT_MODE_NOT_AUTHORIZED', '故障工具需要明确测试网开关及 caller 自己持有的内核子进程');
}
async function pemFile(path: string | undefined, privateKey: boolean): Promise<Buffer> {
  if (!path || !isAbsolute(path)) throw new ScenarioFailure('FAULT_TLS_CONFIG_INVALID');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (privateKey && (info.mode & 0o7777) !== 0o600)) throw new ScenarioFailure('FAULT_TLS_PERMISSIONS');
    return await file.readFile();
  } finally { await file.close(); }
}

/** Called before ManagedKernel is constructed; the normal user config still rejects proxy overrides. */
export async function prepareFaultTransport(config: DemoConfig): Promise<Transport | null> {
  const flag = config.environment.DEMO_ROUND2_FAULTS;
  if (flag === undefined || flag === '0') return null;
  requireFaultMode(config);
  const key = await pemFile(config.environment.DEMO_FAULT_TLS_KEY, true);
  const cert = await pemFile(config.environment.DEMO_FAULT_TLS_CERT, false);
  const requested = config.environment.DEMO_FAULT_PROXY_PORT ?? '18791';
  if (!/^[1-9]\d*$/.test(requested) || Number(requested) > 65535) throw new ScenarioFailure('FAULT_PROXY_PORT_INVALID');
  let onBoundary: ((event: FaultBoundary) => Promise<void>) | null = null;
  const proxy = new ControlledFaultProxy({ tls: { key, cert }, onBoundary: async event => {
    if (!onBoundary) throw new ScenarioFailure('FAULT_CONTROLLER_NOT_READY');
    await onBoundary(event);
  } });
  try {
    const port = await proxy.listen(Number(requested));
    const environment = Object.freeze({ ...config.environment,
      BINANCE_FAULT_PROXY_REST_BASE_URL: `https://127.0.0.1:${port}`,
      BINANCE_FAULT_PROXY_WS_BASE_URL: `wss://127.0.0.1:${port}`,
      BINANCE_FAULT_PROXY_CA_PEM_PATH: config.environment.DEMO_FAULT_TLS_CERT!,
      RUSTCORE_BINANCE_WS_API_ENABLED: '0', ROUND2_TESTNET_FAULTS: '1',
    });
    return { config: { ...config, environment }, proxy, setBoundaryHandler(handler) { onBoundary = handler; } };
  } catch (error) { await proxy.close().catch(() => {}); throw error; }
}

/** The account must be complete and fresh; an empty local cache never proves clean. */
export function faultSnapshot(runtime: Runtime): FaultSnapshot {
  const state = runtime.store.getState(), core = runtime.snapshot;
  const orders = row(core?.accountOrders), venue = row(orders.venue), attempt = row(venue.latest_attempt);
  const reconcile = runtime.lastReconcile;
  const complete = Boolean(core && core.account.available === true && state.account.status === 'AVAILABLE' && state.positions.status === 'AVAILABLE'
    && state.open_orders.status === 'AVAILABLE'
    && [state.account, state.positions, state.open_orders].every(observation => observation.source_as_of !== null && fresh(Date.parse(observation.source_as_of)))
    && fresh(venue.capture_completed_at_ms)
    && fresh(core.account.as_of_ms) && venue.credential_id === runtime.config.credentialId
    && venue.engine_boot_id === orders.engine_boot_id && venue.observation_id
    && attempt.observation_id === venue.observation_id && attempt.status === 'succeeded' && attempt.coverage === 'full_account'
    && ['AOA_AVAILABLE', 1, '1'].includes(venue.availability as string | number)
    && reconcile.accepted === true && reconcile.completed === true);
  const clean = complete && reconcile.has_diff === false && reconcile.local_position_zero_diff === true
    && reconcile.all_positions_zero === true && reconcile.all_open_orders_empty === true && reconcile.all_open_algo_orders_empty === true
    && state.positions.value?.length === 0 && state.open_orders.value?.length === 0;
  return { complete, clean, observed_at: new Date().toISOString(), state };
}

export class FaultController {
  private current: Receipt | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly runtime: Runtime, private readonly runner: Pick<ScenarioRunner, 'recoverAfterFault'>,
    private readonly kernel: Pick<ManagedKernel, 'crash' | 'isRunning'>, private readonly proxy: ControlledFaultProxy) {
    requireFaultMode(runtime.config);
    runtime.store.db.exec('CREATE TABLE IF NOT EXISTS demo_fault_receipts (receipt_id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
    runtime.store.db.exec('CREATE TABLE IF NOT EXISTS demo_fault_snapshots (receipt_id TEXT NOT NULL, phase TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(receipt_id,phase)) STRICT');
    const previous = runtime.store.db.prepare('SELECT body FROM demo_fault_receipts ORDER BY rowid DESC LIMIT 1').get();
    if (previous) {
      this.current = JSON.parse(String(previous.body)) as Receipt;
      if (this.current.phase !== 'CLEAN') { this.current.phase = 'UNKNOWN'; this.current.code = 'FAULT_OWNER_RESTARTED'; this.save(); }
    }
  }
  private save(): void {
    if (!this.current) return;
    this.current.updated_at = new Date().toISOString();
    this.runtime.store.db.prepare('INSERT INTO demo_fault_receipts(receipt_id,body) VALUES (?,?) ON CONFLICT(receipt_id) DO UPDATE SET body=excluded.body')
      .run(this.current.receipt_id, JSON.stringify(this.current));
  }
  private savePrivateSnapshot(phase: string): void {
    if (!this.current) return;
    this.runtime.store.db.prepare('INSERT INTO demo_fault_snapshots(receipt_id,phase,body) VALUES (?,?,?)')
      .run(this.current.receipt_id, this.runtime.store.db.prepare('SELECT 1 FROM demo_fault_snapshots WHERE receipt_id=? AND phase=?').get(this.current.receipt_id, phase) ? phase + '_retry_' + randomUUID() : phase, JSON.stringify({ observed_at: new Date().toISOString(), snapshot: this.runtime.snapshot, reconcile: this.runtime.lastReconcile }));
  }
  status(): Row {
    return { receipt_id: this.current?.receipt_id ?? null, fault: this.current?.fault ?? null, phase: this.current?.phase ?? 'IDLE',
      code: this.current?.code ?? null, clean: this.current?.phase === 'CLEAN', boundary: this.current?.boundary ?? null,
      proxy: this.proxy.status, kernel_running: this.kernel.isRunning };
  }
  async onBoundary(event: FaultBoundary): Promise<void> {
    if (!this.current || this.current.fault !== event.fault || this.current.phase !== 'ARMED') throw new ScenarioFailure('FAULT_BOUNDARY_UNARMED');
    this.current.boundary = event; this.current.phase = 'CRASHING'; this.save();
    try { await this.kernel.crash(); this.current.phase = 'CRASHED'; this.save(); }
    catch { this.current.phase = 'UNKNOWN'; this.current.code = 'OWNED_CRASH_UNKNOWN'; this.save(); throw new ScenarioFailure('OWNED_CRASH_UNKNOWN'); }
  }
  execute(command: FaultCommand): Promise<Row> {
    const run = this.queue.then(() => this.executeOne(command));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async executeOne(command: FaultCommand): Promise<Row> {
    if (command.command === 'status') return this.status();
    if (!this.runtime.isStarted) throw new ScenarioFailure('FAULT_RUNTIME_NOT_STARTED');
    if (command.command === 'snapshot') { await this.runtime.refresh(true); return faultSnapshot(this.runtime) as unknown as Row; }
    if (command.command === 'arm' || command.command === 'stream' || command.command === 'network') {
      if (this.current && this.current.phase !== 'CLEAN') throw new ScenarioFailure('FAULT_RECOVERY_REQUIRED');
      await this.runtime.refresh(true);
      const before = faultSnapshot(this.runtime);
      if (!before.complete) throw new ScenarioFailure('FAULT_SNAPSHOT_INCOMPLETE', '缺少故障注入前完整 fresh 账户快照', 'UNKNOWN');
      const at = new Date().toISOString();
      this.current = { receipt_id: 'fault_' + randomUUID(), fault: command.command === 'arm' ? command.fault : command.command === 'network' ? 'F3' : 'F4', phase: 'ARMED',
        started_at: at, updated_at: at, boundary: null, before, after: null, code: null };
      this.save(); this.savePrivateSnapshot('before');
      if (command.command === 'arm') {
        try {
          if (this.proxy.status.consumed) this.proxy.reset();
          this.proxy.arm(command.fault);
        } catch { this.current.phase = 'UNKNOWN'; this.current.code = 'FAULT_ARM_FAILED'; this.save(); throw new ScenarioFailure('FAULT_ARM_FAILED'); }
      } else if (command.command === 'network') { this.current.phase = 'NETWORK_FAULT'; this.save(); } else {
        try {
          const result = await this.runtime.rpc.unary('v2', 'InjectUserStreamFault', { credential_id: this.runtime.config.credentialId,
            action: command.action, schema_version: 1 });
          if (result.accepted !== true) throw new ScenarioFailure('USER_STREAM_FAULT_REJECTED');
          this.current.phase = 'STREAM_FAULT'; this.save();
        } catch { this.current.phase = 'UNKNOWN'; this.current.code = 'USER_STREAM_FAULT_UNKNOWN'; this.save(); throw new ScenarioFailure('USER_STREAM_FAULT_UNKNOWN'); }
      }
      return this.status();
    }
    if (!this.current) throw new ScenarioFailure('FAULT_RECEIPT_MISSING');
    if (this.current.phase === 'CLEAN') return this.status();
    if (this.current.phase === 'CRASHING') throw new ScenarioFailure('FAULT_NOT_COMPLETED');
    if (this.current.phase === 'ARMED' || this.proxy.status.armed !== null) {
      if (this.runtime.store.getState().active_round_id) throw new ScenarioFailure('FAULT_NOT_COMPLETED');
      this.proxy.disarm();
      this.current.code = 'FAULT_BOUNDARY_NOT_REACHED';
      this.save();
    }
    this.current.phase = 'RECOVERING'; this.save();
    try {
      if (!this.kernel.isRunning) await this.runtime.restartKernel();
      const until = Date.now() + 300_000;
      while (this.runtime.store.getState().active_round_id) {
        if (Date.now() >= until) throw new ScenarioFailure('FAULT_ACTIVE_ROUND_TIMEOUT', '原轮次尚未终结，不能并发清理', 'UNKNOWN');
        await pause(100);
      }
      while (true) {
        try { await this.runner.recoverAfterFault(); break; }
        catch (error) {
          if (!(error instanceof ScenarioFailure) || error.code !== 'SCENARIO_ALREADY_RUNNING' || Date.now() >= until) throw error;
          await pause(100);
        }
      }
      await this.runtime.refresh(true);
      this.current.after = faultSnapshot(this.runtime);
      this.savePrivateSnapshot('after');
      this.current.phase = this.current.after.clean ? 'CLEAN' : 'UNKNOWN';
      this.current.code = this.current.after.clean ? this.current.boundary === null && ['F1', 'F2'].includes(this.current.fault) ? 'FAULT_BOUNDARY_NOT_REACHED' : null : 'FAULT_RECOVERY_NOT_PROVEN';
      this.save();
      return this.status();
    } catch { this.current.phase = 'UNKNOWN'; this.current.code = 'FAULT_RECOVERY_NOT_PROVEN'; this.save(); throw new ScenarioFailure('FAULT_RECOVERY_NOT_PROVEN', '故障后账户干净尚未证明', 'UNKNOWN'); }
  }
}

function parseCommand(input: unknown): FaultCommand {
  const value = row(input);
  if (Object.keys(value).some(key => !['command', 'fault', 'action'].includes(key))) throw new ScenarioFailure('FAULT_COMMAND_INVALID');
  if (['status', 'snapshot', 'recover', 'network'].includes(String(value.command)) && Object.keys(value).length === 1)
    return { command: value.command as 'status' | 'snapshot' | 'recover' | 'network' };
  if (value.command === 'arm' && ['F1', 'F2'].includes(String(value.fault)) && Object.keys(value).length === 2)
    return { command: 'arm', fault: value.fault as KillFault };
  if (value.command === 'stream' && ['disconnect', 'listen_key_expired'].includes(String(value.action)) && Object.keys(value).length === 2)
    return { command: 'stream', action: value.action as 'disconnect' | 'listen_key_expired' };
  throw new ScenarioFailure('FAULT_COMMAND_INVALID');
}

/** Independent 0600 local socket. No caller can supply a PID, unit or upstream. */
export async function openFaultControl(path: string, controller: Pick<FaultController, 'execute'>): Promise<Server> {
  try { if (!(await lstat(path)).isSocket()) throw new ScenarioFailure('FAULT_SOCKET_CONFLICT'); await unlink(path); }
  catch (error) { if (row(error).code !== 'ENOENT') throw error; }
  const server = createServer(socket => {
    let input = '', handled = false;
    socket.setEncoding('utf8'); socket.setTimeout(10_000, () => { if (!handled) socket.destroy(); }); socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;
      if (input.length > 1024) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      let command: FaultCommand;
      try { command = parseCommand(JSON.parse(input.trim())); }
      catch { socket.end(JSON.stringify({ ok: false, code: 'FAULT_COMMAND_INVALID' }) + '\n'); return; }
      void controller.execute(command).then(data => {
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, data }) + '\n');
      }, error => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, code: error instanceof ScenarioFailure ? error.code : 'FAULT_CONTROL_UNKNOWN' }) + '\n'); });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  await chmod(path, 0o600);
  return server;
}
export async function requestFaultControl(path: string, command: FaultCommand): Promise<Row> {
  parseCommand(command);
  return new Promise((resolve, reject) => {
    const socket = connect(path); let input = '', done = false;
    socket.setEncoding('utf8'); socket.setTimeout(360_000, () => { socket.destroy(); reject(new ScenarioFailure('FAULT_CONTROL_TIMEOUT')); });
    socket.on('connect', () => socket.write(JSON.stringify(command) + '\n'));
    socket.on('error', () => reject(new ScenarioFailure('FAULT_CONTROL_UNAVAILABLE')));
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 2_000_000) { socket.destroy(); reject(new ScenarioFailure('FAULT_CONTROL_INVALID')); return; }
      if (!input.includes('\n')) return;
      done = true;
      try {
        const result = row(JSON.parse(input.trim())); socket.end();
        if (result.ok !== true) reject(new ScenarioFailure(String(result.code ?? 'FAULT_CONTROL_UNKNOWN'))); else resolve(row(result.data));
      } catch { socket.destroy(); reject(new ScenarioFailure('FAULT_CONTROL_INVALID')); }
    });
    socket.on('close', () => { if (!done) reject(new ScenarioFailure('FAULT_CONTROL_UNKNOWN')); });
  });
}
