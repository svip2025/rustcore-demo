import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FillSummary, RiskBudgetView } from '../../shared/schema.js';
import type { DemoConfig } from './config.js';
import { CoreRpc } from './grpc.js';
import type { ManagedKernel } from './kernel-process.js';
import { DemoStore } from './store.js';
import { RiskBudgetCalculator } from './risk-budget.js';
import { projectSnapshot, type AccountSettings, type CoreSnapshot } from './projection.js';
import { abs, add, BTC, divide, fresh, money, multiply, nonzero, row, rows, safeReason, ScenarioFailure, text, timestamp, type Row } from './facts.js';

export interface Rpc {
  unary(service: 'v2' | 'next', method: string, request: Row): Promise<Row>;
  streamEvents(request: Row, onData: (event: Row) => void, onError: (error: Error) => void): { cancel(): void };
  close(): void;
}
export type RuntimeKernel = Pick<ManagedKernel, 'start' | 'restart' | 'stop' | 'isRunning'>;
export const BOT = 'rustcore_demo_btc';
export function payload(event: Row): Row {
  try {
    const raw = event.payload_json;
    return row(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8')));
  } catch { return {}; }
}

async function requireFreeGrpcPort(address: string): Promise<void> {
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(address);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535)
    throw new ScenarioFailure('GRPC_ADDRESS_INVALID', '内核地址必须为有效的 loopback 端口');
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', (error: NodeJS.ErrnoException) => reject(new ScenarioFailure(
      error.code === 'EADDRINUSE' ? 'GRPC_ADDRESS_IN_USE' : 'GRPC_PORT_CHECK_FAILED',
      error.code === 'EADDRINUSE' ? '内核端口已被占用，拒绝启动或接管已有服务' : '无法完成内核端口独占检查', 'UNKNOWN')));
    probe.listen({ host: match[1] === '[::1]' ? '::1' : match[1]!, port: Number(match[2]), exclusive: true }, () => {
      probe.close(error => error ? reject(new ScenarioFailure('GRPC_PORT_CHECK_FAILED', '内核端口检查未能完成', 'UNKNOWN')) : resolve());
    });
  });
}

/** One long-lived owner: independent manual rounds share the natural private-stream lifecycle. */
export class CallerRuntime {
  readonly rpc: Rpc;
  readonly calculator: RiskBudgetCalculator;
  settings: AccountSettings = { positionMode: 'UNKNOWN', marginMode: 'UNKNOWN', leverage: null };
  snapshot: CoreSnapshot | null = null;
  lastReconcile: Row = {};
  budgetNotes: string[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private budgetTimer: ReturnType<typeof setInterval> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private subscription: { cancel(): void } | undefined;
  private polling: Promise<void> | null = null;
  private reconciling: Promise<void> | null = null;
  private publishingBudget: Promise<void> | null = null;
  private budgetInputsAvailable = false;
  private stopped = true;
  private restarting = false;
  private bootStartedAt = Date.now();
  private lastReconciledAt = 0;
  private budget: RiskBudgetView;
  private streamGeneration = 0;
  private readonly shutdown = new AbortController();
  private stopping: Promise<void> | undefined;

  constructor(readonly config: DemoConfig, readonly store: DemoStore, readonly kernel: RuntimeKernel, rpc?: Rpc) {
    const token = config.environment.RUSTCORE_GRPC_AUTH_TOKEN;
    this.rpc = rpc ?? new CoreRpc({ address: config.grpcAddress,
      protoDir: fileURLToPath(new URL('../../rustcore/proto/', import.meta.url)),
      ...(token ? { token } : {}), deadlineMs: Math.min(config.phaseTimeoutMs, 80_000) });
    this.calculator = new RiskBudgetCalculator(store.db);
    this.budget = store.getState().risk_budget;
  }

  private hidden(): string[] { return [this.config.credentialId, ...Object.entries(this.config.environment)
    .filter(([k]) => /KEY|SECRET|TOKEN/.test(k)).map(([, v]) => v)]; }
  publicReason(error: unknown): string { return safeReason(error instanceof Error ? error.message : error, this.hidden()); }
  get isStarted(): boolean { return !this.stopped; }

  async start(): Promise<void> {
    if (this.stopping) throw new ScenarioFailure('RUNTIME_STOPPED', 'caller 已停止，不能复用已关闭的连接', 'UNKNOWN');
    if (!this.stopped) return;
    this.stopped = false;
    this.bootStartedAt = Date.now();
    try {
      if (!this.config.connectOnly) await requireFreeGrpcPort(this.config.grpcAddress);
      if (this.stopped) return;
      await this.kernel.start();
      if (this.stopped) return;
      this.requireOwnedKernel();
      await this.waitOnline();
      if (this.stopped) return;
      await this.ensureMarket();
      if (this.stopped) return;
      this.subscribe();
      await this.refresh(true);
      await this.publishBudget();
      if (!this.stopped) {
        this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 2_000);
        this.budgetTimer = setInterval(() => { this.writeBudgetState(); void this.publishBudget().catch(() => {}); }, 10_000);
      }
    } catch (error) {
      await this.stop();
      if (error instanceof ScenarioFailure) throw error;
      throw new ScenarioFailure('RUNTIME_START_FAILED', this.publicReason(error), 'UNKNOWN');
    }
  }
  private requireOwnedKernel(): void {
    if (!this.config.connectOnly && !this.kernel.isRunning)
      throw new ScenarioFailure('OWNED_KERNEL_EXITED', 'caller 持有的内核进程已退出，不能将其他服务当作就绪内核', 'UNKNOWN');
  }
  private async waitOnline(): Promise<void> {
    const until = Date.now() + this.config.phaseTimeoutMs;
    while (!this.stopped && Date.now() < until) {
      this.requireOwnedKernel();
      try {
        await this.rpc.unary('v2', 'GetKillSwitchStates', { scope_keys: ['global', `cred:${this.config.credentialId}`, `bot:${BOT}`], schema_version: 1 });
        this.requireOwnedKernel();
        return;
      } catch (error) {
        if (error instanceof ScenarioFailure && error.code === 'OWNED_KERNEL_EXITED') throw error;
        if (this.stopped) return;
        await sleep(500, undefined, { signal: this.shutdown.signal }).catch(() => {});
      }
    }
    if (this.stopped) return;
    throw new ScenarioFailure('KERNEL_UNAVAILABLE', '内核在等待窗口内未能提供公开 gRPC 读取', 'UNKNOWN');
  }
  private async ensureMarket(): Promise<void> {
    const result = await this.rpc.unary('next', 'EnsureMarketData', { credential_id: this.config.credentialId,
      subscriptions: [{ exchange: 'binance', market_kind: 'futures', symbol_key: BTC, timeframe: '1m' }] });
    if (result.accepted !== true) throw new ScenarioFailure('MARKET_SUBSCRIPTION_REJECTED', '行情订阅未被受理');
  }
  private subscribe(): void {
    if (this.stopped || this.restarting) return;
    this.subscription?.cancel();
    const generation = ++this.streamGeneration;
    this.subscription = this.rpc.streamEvents({ credential_id: this.config.credentialId, since_seq: this.store.getCoreCursor() }, event => {
      if (this.stopped || this.restarting || generation !== this.streamGeneration) return;
      const seq = typeof event.seq === 'string' ? event.seq :
        typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0 ? String(event.seq) : '';
      if (event.credential_id !== this.config.credentialId || !/^\d+$/.test(seq) || !text(event.event_id)?.trim()) return;
      const normalized: Row = { ...event, payload_json: JSON.stringify(payload(event)) };
      this.store.appendCoreEvent(seq, String(event.event_id), normalized);
    }, () => {
      if (!this.stopped && !this.restarting && generation === this.streamGeneration) {
        if (this.reconnect) clearTimeout(this.reconnect);
        this.reconnect = setTimeout(() => { this.reconnect = undefined; this.subscribe(); }, 2_000);
      }
    });
  }
  async refresh(forceReconcile = false): Promise<void> {
    if (this.restarting || this.stopped) return;
    if (forceReconcile) {
      await this.fullReconcile();
      // An already-running read can predate completion of the shared full
      // reconcile. Wait it out, then require a new read for this force request.
      if (this.polling) await this.polling.catch(() => {});
      if (this.restarting || this.stopped) return;
    } else if (Date.now() - this.lastReconciledAt >= 10_000) {
      void this.fullReconcile();
    }
    if (this.polling) return this.polling;
    this.polling = this.poll().finally(() => { this.polling = null; });
    return this.polling;
  }
  private fullReconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      try {
        const result = await this.rpc.unary('v2', 'ReconcileNow', { credential_id: this.config.credentialId,
          schema_version: 1, reason: 'testnet_demo_observation' });
        if (!this.stopped && !this.restarting) this.lastReconcile = result;
      } catch (error) {
        if (!this.stopped && !this.restarting) this.lastReconcile = { accepted: false, completed: false,
          reason_code: 'RECONCILE_UNAVAILABLE', message: this.publicReason(error) };
      } finally {
        if (!this.stopped && !this.restarting) this.lastReconciledAt = Date.now();
      }
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }
  private budgetView(): RiskBudgetView {
    const age = this.budget.source_as_of ? Date.now() - Date.parse(this.budget.source_as_of) : null;
    return { ...this.budget, age_ms: age, status: !this.budgetInputsAvailable ? 'UNAVAILABLE'
      : age !== null && age > this.budget.max_age_ms ? 'STALE' : this.budget.status };
  }
  private writeBudgetState(): void {
    if (this.stopped || this.restarting) return;
    const state = this.store.getState();
    state.generated_at = new Date().toISOString();
    state.risk_budget = this.budgetView();
    this.store.setState(state);
  }
  private async poll(): Promise<void> {
    const request = { credential_id: this.config.credentialId, schema_version: 1 };
    try {
      if (this.stopped || this.restarting) return;
      const [account, positions, orders, accountOrders, kills] = await Promise.all([
        this.rpc.unary('v2', 'GetAccountState', request),
        this.rpc.unary('v2', 'GetPositionStates', { ...request, include_closed: false }),
        this.rpc.unary('next', 'GetOpenOrders', { credential_id: this.config.credentialId }),
        this.rpc.unary('v2', 'GetAccountOrderState', { ...request, max_items_per_section: 500 }),
        this.rpc.unary('v2', 'GetKillSwitchStates', { scope_keys: ['global', `cred:${this.config.credentialId}`, `bot:${BOT}`], schema_version: 1 }),
      ]);
      if (this.stopped || this.restarting) return;
      this.snapshot = { account, positions, orders, accountOrders, kills, receivedAt: Date.now(), bootStartedAt: this.bootStartedAt };
      this.budgetInputsAvailable = true;
      const state = projectSnapshot(this.store.getState(), this.snapshot, this.config.credentialId, this.settings);
      state.risk_budget = this.budgetView();
      this.store.setState(state);
    } catch (error) {
      if (this.stopped || this.restarting) return;
      this.budgetInputsAvailable = false;
      const state = this.store.getState();
      state.generated_at = new Date().toISOString();
      state.rustcore = { ...state.rustcore, status: 'OFFLINE', checked_at: state.generated_at, reason: '公开读取未能完成，旧事实不会刷新时间' };
      for (const field of ['account', 'positions', 'open_orders', 'protection'] as const) state[field].status = 'UNAVAILABLE';
      state.risk_budget = { ...this.budget, status: 'UNAVAILABLE', reason: '账户读取未完成，不发布替代预算',
        age_ms: this.budget.source_as_of ? Date.now() - Date.parse(this.budget.source_as_of) : null };
      this.store.setState(state);
      throw new ScenarioFailure('READ_UNAVAILABLE', this.publicReason(error), 'UNKNOWN');
    }
  }
  private async publishBudget(): Promise<void> {
    if (this.stopped || this.restarting) return;
    if (!this.snapshot || !this.budgetInputsAvailable) { this.writeBudgetState(); return; }
    if (this.publishingBudget) return this.publishingBudget;
    this.publishingBudget = this.publishBudgetOnce().finally(() => {
      this.publishingBudget = null;
      this.writeBudgetState();
    });
    return this.publishingBudget;
  }
  private async publishBudgetOnce(): Promise<void> {
    if (!this.snapshot) return;
    const result = this.calculator.observe({ credentialId: this.config.credentialId, account: this.snapshot.account,
      positionStates: this.snapshot.positions, nowMs: Date.now() });
    this.budgetNotes.push(...result.events.map(e => e.message));
    this.budgetNotes = this.budgetNotes.slice(-30);
    if (!result.publish) {
      this.budget = { ...this.budget, status: 'NOT_PUBLISHED', reason: `${result.reason}: ${result.message}` };
      return;
    }
    let applied: boolean | null = null, accepted = false;
    let reason = '预算已发布；收益为权益变化近似值';
    try {
      const response = await this.rpc.unary('v2', 'PutRiskBudget', { ...result.budget });
      accepted = response.accepted === true;
      applied = typeof response.applied === 'boolean' ? response.applied : null;
      const events = this.calculator.recordPublishResponse(this.config.credentialId, response);
      this.budgetNotes.push(...events.map(e => e.message));
      if (response.accepted !== true || applied !== true) reason = '预算响应未确认应用（applied 不为 true），已记录';
    } catch { reason = '预算发布结果未知；不将调用异常当作已应用'; }
    if (this.stopped || this.restarting || !this.budgetInputsAvailable) return;
    const source = timestamp(result.budget.as_of_ms);
    this.budget = { status: accepted && applied === true && fresh(result.budget.as_of_ms) ? 'FRESH' : applied === false ? 'NOT_PUBLISHED' : 'UNAVAILABLE',
      source_as_of: source, published_at: new Date().toISOString(), age_ms: source ? Date.now() - Date.parse(source) : null,
      max_age_ms: 30_000, last_publish_applied: applied,
      reason: [...result.events.map(e => e.message), reason].join('；'), utc_day: result.baseline.utcDay,
      day_start_equity_usdt: result.baseline.dayEquityUsdt, equity_high_water_usdt: result.baseline.highWaterEquityUsdt,
      approximate_today_pnl_usdt: result.budget.today_realized_pnl_usdt,
      approximate_today_pnl_pct: result.budget.today_realized_pnl_pct, drawdown_pct: result.budget.drawdown_pct,
      total_exposure_pct: result.budget.total_exposure_pct };
  }

  async restartKernel(): Promise<void> {
    if (this.stopped) throw new ScenarioFailure('RUNTIME_STOPPED', 'caller 未运行，不能执行重启', 'UNKNOWN');
    this.restarting = true;
    this.budgetInputsAvailable = false;
    let failure: ScenarioFailure | null = null;
    let restartInvoked = false;
    try {
      if (this.polling) await this.polling.catch(() => {});
      if (this.reconciling) await this.reconciling;
      if (this.publishingBudget) await this.publishingBudget.catch(() => {});
      if (this.stopped) return;
      this.streamGeneration++;
      this.subscription?.cancel();
      this.subscription = undefined;
      if (this.reconnect) clearTimeout(this.reconnect);
      this.reconnect = undefined;
      const state = this.store.getState(), at = new Date().toISOString();
      state.generated_at = at;
      state.rustcore = { ...state.rustcore, status: 'RESTARTING', checked_at: at, reason: '本轮主动终止并重启自己持有的内核进程' };
      state.risk_budget.status = 'STALE';
      this.store.setState(state);
      restartInvoked = true;
      await this.kernel.restart();
      if (this.stopped) return;
      this.requireOwnedKernel();
      this.bootStartedAt = Date.now();
      const offline = this.store.getState(), offlineAt = new Date().toISOString();
      offline.generated_at = offlineAt;
      offline.rustcore = { ...offline.rustcore, status: 'OFFLINE', checked_at: offlineAt, last_restart_at: offlineAt, reason: '等待新进程公开接口' };
      this.store.setState(offline);
      await this.waitOnline();
      if (this.stopped) return;
      await this.ensureMarket();
    } catch (error) {
      failure = new ScenarioFailure('KERNEL_RESTART_FAILED', this.publicReason(error), 'UNKNOWN');
      try {
        const failed = this.store.getState(), failedAt = new Date().toISOString();
        failed.generated_at = failedAt;
        failed.rustcore = { ...failed.rustcore, status: !restartInvoked && this.kernel.isRunning ? 'ONLINE' : 'OFFLINE', checked_at: failedAt,
          reason: restartInvoked ? '受管内核重启未完成，恢复结果未知' : '重启未执行，继续观察原内核' };
        this.store.setState(failed);
      } catch { /* Preserve the original failure; recovery must not depend on a diagnostic state write. */ }
    } finally { this.restarting = false; }
    if (this.stopped) return;
    this.subscribe();
    this.lastReconciledAt = 0;
    if (failure) {
      // In particular, a pre-kill journal failure must not strand the original
      // process without reads/events needed for the scenario's safety close.
      void this.refresh().catch(() => {});
      throw failure;
    }
    await this.refresh(true);
    await this.publishBudget();
  }
  market(): { price: string; sourceAt: number } | null {
    for (const event of this.store.getCoreEvents().reverse()) {
      if (event.event_type !== 'bar_closed' || event.symbol_key !== BTC) continue;
      const data = payload(event), price = money(data.close), sourceAt = Number(data.closeTs);
      if (price && nonzero(price) && fresh(sourceAt, Date.now(), 90_000)) return { price, sourceAt };
    }
    return null;
  }
  fills(idempotencyKey: string, side: 'BUY' | 'SELL'): FillSummary | null {
    let quantity = '0', notional = '0';
    const trades = new Set<string>();
    for (const event of this.store.getCoreEvents()) {
      if (event.event_type !== 'fill' || event.idempotency_key !== idempotencyKey) continue;
      const data = payload(event), qty = money(data.fillQty), price = money(data.fillPrice);
      const rawTrade = data.exchangeTradeId ?? data.exchange_trade_id;
      const trade = typeof rawTrade === 'string' && rawTrade.trim() === rawTrade && rawTrade.length ? rawTrade :
        typeof rawTrade === 'number' && Number.isSafeInteger(rawTrade) && rawTrade >= 0 ? String(rawTrade) : null;
      if (!trade || !qty || !price || !nonzero(qty) || qty.startsWith('-') || !nonzero(price) || price.startsWith('-') || trades.has(trade)) continue;
      trades.add(trade); quantity = add(quantity, abs(qty)); notional = add(notional, multiply(abs(qty), price));
    }
    return nonzero(quantity) ? { side, quantity, average_price: divide(notional, quantity), notional_usdt: notional } : null;
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    this.shutdown.abort();
    this.streamGeneration++;
    if (this.timer) clearInterval(this.timer);
    if (this.budgetTimer) clearInterval(this.budgetTimer);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.timer = undefined;
    this.budgetTimer = undefined;
    this.reconnect = undefined;
    this.subscription?.cancel();
    this.subscription = undefined;
    this.stopping = (async () => {
      if (this.polling) await this.polling.catch(() => {});
      if (this.reconciling) await this.reconciling;
      if (this.publishingBudget) await this.publishingBudget.catch(() => {});
      this.rpc.close();
      await this.kernel.stop();
    })();
    return this.stopping;
  }
}
