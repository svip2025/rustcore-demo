import type { BuildInfo, DataSource } from '../../shared/schema.js';
import { ScenarioFailure } from './facts.js';
import type { DemoStore } from './store.js';

/** Invoke only after acquiring the caller instance lock, never from a read-only exporter. */
export function prepareStore(store: DemoStore, current: { source: DataSource; build: BuildInfo }): void {
  const previous = store.getState();
  if (previous.source.kind !== current.source.kind)
    throw new ScenarioFailure('DATA_SOURCE_CHANGED', '不同数据来源必须使用独立 caller 数据库，不能重新标注历史事实');
  if (previous.active_round_id) {
    const round = store.getTimeline(100).rounds.find(r => r.round_id === previous.active_round_id);
    if (!round) throw new ScenarioFailure('INTERRUPTED_ROUND_NOT_FOUND');
    for (const step of round.steps) if (step.phase === 'RUNNING')
      store.finishStep(round.round_id, step.step_id, 'UNKNOWN', 'caller 上次退出，中断步骤结果未知', {
        ...step.actual, summary: `caller 上次退出；原始观察：${step.actual.summary}`,
      });
    store.finishRound(round.round_id, 'FAILED', 'caller 上次退出；中断轮次保留，未重发开仓');
  }
  const state = store.getState();
  state.generated_at = new Date(Math.max(Date.now(), Date.parse(state.generated_at))).toISOString();
  state.source = current.source; state.build = current.build;
  for (const field of ['account', 'positions', 'open_orders', 'protection'] as const) {
    state[field].status = state[field].value === null ? 'UNKNOWN' : 'STALE';
    state[field].reason = 'caller 已启动，等待当前运行版本的新观察；保留原始源时间';
  }
  state.rustcore = { status: 'UNKNOWN', checked_at: state.generated_at, last_restart_at: state.rustcore.last_restart_at, reason: '尚未连接本次内核运行' };
  state.kill_switch = { level: 'UNKNOWN', reason: '等待当前运行的只读熔断观察', observed_at: null };
  state.risk_budget = { ...state.risk_budget, status: 'NOT_PUBLISHED', reason: '本次 caller 尚未发布预算', last_publish_applied: null };
  store.setState(state);
}
