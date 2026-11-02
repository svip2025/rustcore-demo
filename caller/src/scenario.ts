import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ulid } from 'ulid';
import type { RoundSummary, ScenarioStep, StepActual, TimelineStep } from '../../shared/schema.js';
import { acquireFileLock } from './file-lock.js';
import { runPreflight, TESTNET_READ_ORIGIN } from './preflight.js';
import { protectionResult, protectionView } from './projection.js';
import { BOT, type CallerRuntime } from './runtime.js';
import { BTC, money, nonzero, priceAt, row, rows, ScenarioFailure, text, type Row } from './facts.js';

type Runtime = Pick<CallerRuntime, 'config' | 'store' | 'rpc' | 'snapshot' | 'settings' | 'lastReconcile' | 'budgetNotes' | 'isStarted' | 'start' | 'refresh' | 'market' | 'fills' | 'restartKernel' | 'publicReason'>;
interface Options { preflight?: typeof runPreflight; fetch?: typeof fetch; pause?: typeof sleep; recordDir?: string }
const emptyActual = (summary: string): StepActual => ({ summary, code: null, account: null, position: null, open_orders: null,
  protection: null, fill: null, rustcore: null, risk_budget: null });
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const terminalOrder = (status: unknown): boolean => ['filled', 'cancelled', 'canceled', 'rejected', 'expired', 'failed'].includes(String(status));

/** Terminal/local IPC only. Each run submits at most one new opening intent. */
export class ScenarioRunner {
  private current: TimelineStep | null = null;
  private roundId = '';
  private positionId: string | null = null;
  private openClientId: string | null = null;
  private readonly cancellationAttempts = new Set<string>();
  constructor(private readonly runtime: Runtime, private readonly options: Options = {}) {}
  private actual(summary: string): StepActual {
    const state = this.runtime.store.getState();
    return { ...emptyActual(summary), account: state.account.value, position: state.positions.value?.[0] ?? null,
      open_orders: state.open_orders.value, protection: state.protection.value?.[0] ?? null,
      rustcore: state.rustcore, risk_budget: state.risk_budget };
  }
  private async step(kind: ScenarioStep, expected: string, action: () => Promise<StepActual>): Promise<void> {
    const current = this.runtime.store.startStep(this.roundId, kind, expected, emptyActual('正在执行'));
    this.current = current;
    try {
      const actual = await action();
      this.runtime.store.finishStep(this.roundId, current.step_id, 'PASS', actual.summary, actual);
      this.current = null;
    } catch (error) {
      const failure = error instanceof ScenarioFailure ? error : new ScenarioFailure('STEP_UNKNOWN', this.runtime.publicReason(error), 'UNKNOWN');
      const actual = this.actual(failure.message); actual.code = failure.code;
      this.runtime.store.finishStep(this.roundId, current.step_id, failure.outcome, failure.message, actual);
      this.current = null;
      throw failure;
    }
  }
  private async wait<T>(observe: () => Promise<T | null>, code: string): Promise<T> {
    const until = Date.now() + this.runtime.config.phaseTimeoutMs;
    do {
      const result = await observe();
      if (result !== null) return result;
      await (this.options.pause ?? sleep)(1_000);
    } while (Date.now() < until);
    throw new ScenarioFailure(code, `${code}：观察窗口结束，不能证实预期结果`, 'UNKNOWN');
  }
  private positions(): Row[] { return rows(this.runtime.snapshot?.positions.positions).filter(p => nonzero(p.qty)); }
  private requireScope(): void {
    const snapshot = this.runtime.snapshot;
    if (!snapshot || snapshot.account.available !== true || !Array.isArray(snapshot.positions.positions))
      throw new ScenarioFailure('ACCOUNT_TRUTH_UNKNOWN', '账户/持仓事实不可用', 'UNKNOWN');
    if (rows(snapshot.positions.orphan_positions).length || this.positions().some(p => p.symbol_key !== BTC || p.bot_uid !== BOT))
      throw new ScenarioFailure('UNOWNED_RESIDUAL_EXPOSURE', '发现不属于演示的持仓或孤儿仓；保留现状并拒绝开新仓');
  }
  private flat(): boolean {
    const result = this.runtime.lastReconcile;
    const state = this.runtime.store.getState();
    return result.accepted === true && result.completed === true && result.has_diff === false
      && result.local_position_zero_diff === true && result.all_positions_zero === true
      && result.all_open_orders_empty === true && result.all_open_algo_orders_empty === true
      && state.positions.status === 'AVAILABLE' && state.positions.value?.length === 0
      && state.open_orders.status === 'AVAILABLE' && state.open_orders.value?.length === 0;
  }
  private async cancelEntry(engineOrderId: string): Promise<void> {
    if (!engineOrderId) throw new ScenarioFailure('ENTRY_IDENTITY_UNKNOWN', '无法证明待撤开仓订单身份', 'UNKNOWN');
    if (this.cancellationAttempts.has(engineOrderId)) return;
    this.cancellationAttempts.add(engineOrderId);
    const response = await this.runtime.rpc.unary('next', 'CancelOrder', { credential_id: this.runtime.config.credentialId,
      engine_order_id: engineOrderId, reason: 'demo_entry_cleanup' });
    if (response.accepted !== true) throw new ScenarioFailure('ENTRY_CANCEL_REJECTED', '内核未接受开仓挂单撤单；保留原失败，不重复撤单');
  }
  private async waitEntriesTerminal(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.wait(async () => {
      await this.runtime.refresh(true); this.requireScope();
      for (const engineOrderId of ids) {
        const found = await this.runtime.rpc.unary('next', 'GetOrder', { credential_id: this.runtime.config.credentialId, engine_order_id: engineOrderId });
        if (found.found !== true || !terminalOrder(row(found.order).status)) return null;
      }
      return true;
    }, 'ENTRY_CANCEL_NOT_PROVEN');
  }
  private async cleanup(): Promise<StepActual> {
    await this.runtime.refresh(true); this.requireScope();
    const snapshot = this.runtime.snapshot!;
    const local = row(row(snapshot.accountOrders.local).orders), meta = row(local.meta);
    const localOrders = rows(local.rows), openOrders = rows(snapshot.orders.orders);
    if (!Array.isArray(local.rows) || !Array.isArray(snapshot.orders.orders) || meta.overflow !== false
      || ![1, '1', 'AOC_COMPLETE_LOCAL'].includes(meta.coverage as string | number)
      || Number(meta.returned_count) !== localOrders.length || Number(meta.total_count) !== localOrders.length)
      throw new ScenarioFailure('LOCAL_ORDER_SCOPE_UNKNOWN', '本地订单覆盖不足，不能推断残留订单归属', 'UNKNOWN');
    const byId = new Map(localOrders.map(order => [String(order.engine_order_id), order]));
    if (byId.size !== localOrders.length) throw new ScenarioFailure('LOCAL_ORDER_SCOPE_UNKNOWN', '本地订单身份重复', 'UNKNOWN');
    for (const order of openOrders) {
      const linked = byId.get(String(order.engine_order_id));
      if (!linked || terminalOrder(linked.raw_status) || linked.credential_id !== order.credential_id
        || linked.bot_uid !== order.bot_uid || linked.symbol_key !== order.symbol_key)
        throw new ScenarioFailure('UNOWNED_RESIDUAL_ORDER', '发现无法关联的活跃挂单；未发送撤单');
    }
    const entries: string[] = [];
    for (const order of localOrders.filter(order => !terminalOrder(order.raw_status))) {
      if (order.credential_id !== this.runtime.config.credentialId || order.bot_uid !== BOT || order.symbol_key !== BTC)
        throw new ScenarioFailure('UNOWNED_RESIDUAL_ORDER', '发现非演示账户范围的活跃挂单；未发送撤单');
      if (['protection_sl', 'protection_tp', 'exit', 'emergency'].includes(String(order.order_role))) continue;
      if (order.order_role !== 'entry' || !['open_long', 'open_short'].includes(String(order.action))
        || !['market', 'limit'].includes(String(order.order_type)) || order.reduce_only !== false || !text(order.engine_order_id))
        throw new ScenarioFailure('UNOWNED_RESIDUAL_ORDER', '无法证明挂单是本演示的普通开仓单；未发送撤单');
      entries.push(String(order.engine_order_id));
    }
    for (const id of entries) await this.cancelEntry(id);
    await this.waitEntriesTerminal(entries);
    if (this.openClientId) {
      const found = await this.runtime.rpc.unary('v2', 'GetOrderByClientOrderId', { credential_id: this.runtime.config.credentialId,
        client_order_id_short: this.openClientId, schema_version: 1 });
      if (found.completed !== true) throw new ScenarioFailure('ENTRY_OUTCOME_UNKNOWN', '原开仓请求未能读回，不能假定未成交', 'UNKNOWN');
      const order = row(found.order);
      if (found.found === true && !terminalOrder(order.status)) {
        if (order.credential_id !== this.runtime.config.credentialId || order.bot_uid !== BOT || order.symbol_key !== BTC)
          throw new ScenarioFailure('UNOWNED_RESIDUAL_ORDER', '开仓读回身份无法匹配原演示请求；未发送撤单');
        const id = String(order.engine_order_id ?? '');
        await this.cancelEntry(id); await this.waitEntriesTerminal([id]);
      }
    }
    // A cancellation acknowledgment is insufficient: terminal readback precedes exact close.
    for (const position of this.positions()) await this.exactClose(String(position.position_id));
    return this.wait(async () => {
      await this.runtime.refresh(); this.requireScope();
      return this.flat() ? this.actual('完整对账确认零仓位、普通挂单和 Algo 挂单均为空') : null;
    }, 'CLEANUP_NOT_PROVEN');
  }
  private async exactClose(positionId: string): Promise<StepActual> {
    const request = { credential_id: this.runtime.config.credentialId, position_id: positionId, schema_version: 1 };
    const target = await this.runtime.rpc.unary('v2', 'GetPositionCloseTarget', request);
    if (target.available !== true) throw new ScenarioFailure(String(target.reason_code || 'CLOSE_TARGET_UNAVAILABLE'), '精确平仓目标不可用；没有修改数据库或使用替代订单');
    const requestRef = ulid();
    // Unknown transport outcome is resolved using the same durable request_ref.
    try {
      await this.runtime.rpc.unary('v2', 'ClosePosition', { ...request, expected_revision: row(target.target).revision,
        expected_boot_id: target.engine_boot_id, request_ref: requestRef, actor_member_id: '1' });
    } catch { /* never resubmit; read the immutable receipt below */ }
    const receiptRequest = { credential_id: this.runtime.config.credentialId, request_ref: requestRef, actor_member_id: '1', schema_version: 1 };
    return this.wait(async () => {
      await this.runtime.refresh();
      const receipt = await this.runtime.rpc.unary('v2', 'GetPositionCloseReceipt', receiptRequest);
      if (receipt.request_status === 'rejected') throw new ScenarioFailure(String(receipt.reason_code || 'CLOSE_REJECTED'), '内核明确拒绝精确平仓');
      const observation = row(receipt.position_observation), protection = row(receipt.protection_observation);
      if (receipt.request_status !== 'filled' || money(receipt.filled_quantity) !== money(receipt.target_quantity)
        || !nonzero(receipt.target_quantity) || observation.status !== 'observed' || observation.state !== 'closed'
        || money(observation.quantity) !== '0' || protection.status !== 'cleaned') return null;
      const order = row((await this.runtime.rpc.unary('next', 'GetOrder', { credential_id: this.runtime.config.credentialId,
        engine_order_id: receipt.engine_order_id })).order);
      const fill = this.runtime.fills(String(order.idempotency_key), 'SELL');
      if (!fill || money(fill.quantity) !== money(receipt.target_quantity)) return null;
      return { ...this.actual('精确平仓已成交，持仓为零且保护清理已证明'), fill };
    }, 'EXACT_CLOSE_NOT_PROVEN');
  }
  private verify(): StepActual {
    const snapshot = this.runtime.snapshot;
    const position = this.positions().find(p => p.position_id === this.positionId);
    if (!snapshot || !position) throw new ScenarioFailure('POSITION_NOT_HELD', '目标持仓已不在活跃持仓中');
    const pair = protectionView(snapshot, position, this.runtime.config.credentialId);
    const result = protectionResult(pair);
    const actual = { ...this.actual(`SL ${pair.sl.status}: ${pair.sl.reason}；TP ${pair.tp.status}: ${pair.tp.reason}`), protection: pair };
    if (result !== 'PASS') throw new ScenarioFailure('DOUBLE_PROTECTION_NOT_PROVEN', actual.summary, result);
    return actual;
  }

  async run(trigger: RoundSummary['trigger']): Promise<RoundSummary> {
    const lock = await acquireFileLock(this.runtime.config.lockFile);
    const store = this.runtime.store;
    this.positionId = null; this.openClientId = null; this.cancellationAttempts.clear();
    try {
      // A caller crash never silently removes the interrupted round.
      const state = store.getState();
      if (state.active_round_id) {
        const old = store.getTimeline(100).rounds.find(r => r.round_id === state.active_round_id);
        for (const step of old?.steps ?? []) if (step.phase === 'RUNNING')
          store.finishStep(old!.round_id, step.step_id, 'UNKNOWN', 'caller 上次退出，中断的步骤结果未知', { ...step.actual, summary: 'caller 上次退出，保留中断现场' });
        store.finishRound(state.active_round_id, 'FAILED', 'caller 上次退出；中断轮次原样保留');
      }
      this.roundId = `round_${ulid()}`;
      store.startRound(trigger, this.roundId);
      let failure: ScenarioFailure | null = null;
      try {
        await this.step('preflight', '测试网 One-way、全仓、BTCUSDT 1x、余额满足手工配置前提；读取真实账户预算', async () => {
          const checked = await (this.options.preflight ?? runPreflight)(this.runtime.config);
          if (!checked.ok) throw new ScenarioFailure(checked.code, checked.reason, checked.result === 'FAIL' ? 'FAIL' : 'UNKNOWN');
          this.runtime.settings = { positionMode: checked.positionMode, marginMode: checked.marginMode, leverage: checked.leverage };
          if (!this.runtime.isStarted) await this.runtime.start(); else await this.runtime.refresh(true);
          const notes = this.runtime.budgetNotes.splice(0);
          return this.actual(['账户设置通过只读检查', ...notes].join('；'));
        });
        await this.step('cleanup_before', '前置对账并清理本演示残留；不触碰未知持仓', () => this.cleanup());
        await this.step('open_position', '只提交一次真实开多意图，数量由默认风控自动计算；保存实际成交量与名义额', async () => {
          const market = await this.wait(async () => this.runtime.market(), 'MARKET_SNAPSHOT_UNKNOWN');
          const response = await (this.options.fetch ?? fetch)(TESTNET_READ_ORIGIN + '/fapi/v1/exchangeInfo', { redirect: 'error', signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new ScenarioFailure(`EXCHANGE_INFO_HTTP_${response.status}`, '交易所过滤器读取失败');
          const symbol = rows(row(await response.json()).symbols).find(s => s.symbol === 'BTCUSDT');
          const tick = money(rows(symbol?.filters).find(f => f.filterType === 'PRICE_FILTER')?.tickSize);
          if (!tick || !nonzero(tick)) throw new ScenarioFailure('TICK_SIZE_UNKNOWN', '缺少真实 BTCUSDT 价格步长', 'UNKNOWN');
          const config = { symbol: BTC, stop_fraction: '0.99', take_profit_fraction: '1.025', tick_size: tick, policy: 'risk_policy_v3' };
          const cycle = ulid(), key = `idem_${digest(`${this.roundId}|${cycle}|open_long`)}`;
          this.openClientId = `rcd_${ulid()}`;
          const data = { snapshot_id: `snap_${digest(`${market.sourceAt}|${market.price}|${tick}`).slice(0, 32)}`, quality_gate: 'pass', allow_open: true,
            allow_close: true, created_at_ms: String(market.sourceAt), schema_version: 1 };
          const intent = { bot_uid: BOT, run_id: this.roundId, cycle_id: cycle, intent_id: `int_${ulid()}`, idempotency_key: key,
            client_order_id_short: this.openClientId, exchange: 'binance', market_kind: 'futures', symbol_key: BTC,
            action: 'open_long', order_type: 'market', limit_price: '', reduce_only: false, max_slippage_bps: 15,
            valid_until_ms: String(Date.now() + 30_000), config_hash: digest(JSON.stringify(config)), prompt_hash: `sha256:${digest('')}`,
            code_commit: this.runtime.config.build.rustcore_commit, policy_version: 'risk_policy_v3', schema_version: 1,
            protection: { required: true, stop_loss_price: priceAt(market.price, '0.99', tick), take_profit_price: priceAt(market.price, '1.025', tick, true), confirm_timeout_ms: 5_000, schema_version: 1 } };
          store.db.exec('CREATE TABLE IF NOT EXISTS demo_scenario_inputs (round_id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT');
          store.db.prepare('INSERT INTO demo_scenario_inputs(round_id,body) VALUES (?,?)').run(this.roundId, JSON.stringify({ config, market, data_snapshot: data, intent }));
          let ack: Row;
          try {
            ack = rows((await this.runtime.rpc.unary('v2', 'ExecuteIntents', { credential_id: this.runtime.config.credentialId, run_mode: 'demo',
              intents: [intent], data_snapshot: data, schema_version: 1 })).acks)[0] ?? {};
          } catch { throw new ScenarioFailure('OPEN_SUBMISSION_UNKNOWN', '开仓调用结果未知；保留原身份读回，不重发', 'UNKNOWN'); }
          if (ack.status !== 'STATUS_ACCEPTED' && ack.status !== 'STATUS_DUPLICATE')
            throw new ScenarioFailure('OPEN_REJECTED', this.runtime.publicReason(ack.message ?? '开仓意图被内核拒绝'));
          return this.wait(async () => {
            await this.runtime.refresh();
            if (this.runtime.snapshot?.account.available !== true) return null;
            this.requireScope();
            const order = row((await this.runtime.rpc.unary('next', 'GetOrder', { credential_id: this.runtime.config.credentialId, engine_order_id: ack.engine_order_id })).order);
            if (['rejected', 'cancelled', 'expired'].includes(String(order.status))) throw new ScenarioFailure('ENTRY_NOT_FILLED', '开仓订单已终结且未完成成交');
            const position = this.positions().find(p => p.bot_uid === BOT && p.symbol_key === BTC && p.direction === 'long');
            const fill = this.runtime.fills(String(order.idempotency_key), 'BUY');
            if (order.status !== 'filled' || !position || !fill || money(fill.quantity) !== money(position.qty)) return null;
            this.positionId = String(position.position_id);
            return { ...this.actual('默认风控自动定量开多已成交；已保存实际成交量及名义额'), fill };
          }, 'ENTRY_FILL_NOT_PROVEN');
        });
        await this.step('verify_protection', 'SL 与 TP 分别由同一轮完整 Algo 快照证明', async () => { await this.runtime.refresh(true); return this.verify(); });
        await this.step('hold', '持仓期间目标仍存在且双保护分别通过', async () => {
          const until = Date.now() + this.runtime.config.holdMs;
          do { await (this.options.pause ?? sleep)(Math.min(2_000, Math.max(1, until - Date.now()))); await this.runtime.refresh(true); this.verify(); } while (Date.now() < until);
          return this.verify();
        });
        const oldBoot = this.runtime.snapshot?.accountOrders.engine_boot_id;
        const quantity = this.positions().find(p => p.position_id === this.positionId)?.qty;
        await this.step('restart_kernel', '终止自己持有的内核进程，保留数据库并启动新 boot', async () => {
          await this.runtime.restartKernel();
          if (!oldBoot || this.runtime.snapshot?.accountOrders.engine_boot_id === oldBoot) throw new ScenarioFailure('NEW_BOOT_NOT_PROVEN', '未证明新进程 boot', 'UNKNOWN');
          return this.actual('受管内核已重启，公开读取属于新 boot；持仓恢复在下一步核对');
        });
        await this.step('verify_recovery', '新 boot 下对账无差异、原持仓数量一致，SL/TP 各自通过', () => this.wait(async () => {
          await this.runtime.refresh();
          const position = this.positions().find(p => p.position_id === this.positionId);
          if (!position || money(position.qty) !== money(quantity) || this.runtime.lastReconcile.completed !== true
            || this.runtime.lastReconcile.has_diff !== false || this.runtime.lastReconcile.local_position_zero_diff !== true) return null;
          return this.verify();
        }, 'RECOVERY_NOT_PROVEN'));
        await this.step('close_position', '精确平仓回执 filled、成交量一致、持仓为零、保护 cleaned', () => this.exactClose(this.positionId!));
        await this.step('cleanup_after', '全账户无持仓、无普通挂单、无 Algo 挂单', () => this.cleanup());
      } catch (error) {
        failure = error instanceof ScenarioFailure ? error : new ScenarioFailure('SCENARIO_UNKNOWN', this.runtime.publicReason(error), 'UNKNOWN');
        // Cleanup is visible and cannot turn the original failed step/round into success.
        if (this.runtime.isStarted) {
          const done = store.getTimeline(1).rounds.find(r => r.round_id === this.roundId)?.steps ?? [];
          if (!done.some(s => s.step === 'close_position') && this.positions().some(p => p.bot_uid === BOT)) {
            try { await this.step('close_position', '失败后的受控精确平仓', () => this.exactClose(String(this.positions().find(p => p.bot_uid === BOT)?.position_id))); } catch { /* recorded */ }
          }
          if (!done.some(s => s.step === 'cleanup_after')) {
            try { await this.step('cleanup_after', '失败后核对残留；不补挂保护、不重开仓', () => this.cleanup()); } catch { /* recorded */ }
          }
        }
      }
      const result = store.finishRound(this.roundId, failure ? 'FAILED' : 'SUCCEEDED', failure ? `${failure.code}: ${failure.message}` : '完整场景九步均通过');
      const directory = this.options.recordDir ?? join(dirname(this.runtime.config.callerDbFile), 'recordings');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${this.roundId}.json`), JSON.stringify(store.exportRecording(this.roundId), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return result;
    } finally { await lock.release(); }
  }
}
