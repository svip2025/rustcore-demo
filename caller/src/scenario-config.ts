import type { ScenarioConfig, ScenarioId } from '../../shared/schema.js';
import { ScenarioFailure } from './facts.js';
export type { ScenarioConfig, ScenarioId } from '../../shared/schema.js';

export function scenarioFor(id: ScenarioId, direction?: 'LONG' | 'SHORT', settlementAt?: string): ScenarioConfig {
  const selected = direction ?? (id === 'S5' ? 'SHORT' : 'LONG');
  const value: ScenarioConfig = { scenario_id: id, direction: selected, symbol: 'BTCUSDT', sl_pct: '0.01', tp_pct: '0.025',
    max_hold_ms: 60_000, exit_mode: 'ACTIVE_CLOSE', policy_version: 'risk_policy_v3', funding_settlement_at: null };
  if (id === 'S2' || id === 'S3') Object.assign(value, { sl_pct: id === 'S2' ? '0.0015' : '0.03',
    tp_pct: id === 'S3' ? '0.0015' : '0.03', max_hold_ms: 1_800_000,
    exit_mode: id === 'S2' ? 'WAIT_SL' : 'WAIT_TP', policy_version: 'risk_policy_testnet_v1' });
  if (id === 'S4') Object.assign(value, { max_hold_ms: 1_200_000, exit_mode: 'FUNDING_WINDOW', funding_settlement_at: settlementAt ?? null });
  return validateScenario(value);
}

/** No coercion or silent clamping of scenario parameters. */
export function validateScenario(input: unknown): ScenarioConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ScenarioFailure('SCENARIO_CONFIG_INVALID');
  const value = input as Record<string, unknown>;
  const expectedKeys = ['scenario_id', 'direction', 'symbol', 'sl_pct', 'tp_pct', 'max_hold_ms', 'exit_mode', 'policy_version', 'funding_settlement_at'];
  if (Object.keys(value).some(k => !expectedKeys.includes(k)) || expectedKeys.some(k => !Object.hasOwn(value, k))
    || !['S1', 'S2', 'S3', 'S4', 'S5', 'F1', 'F2', 'F3', 'F4'].includes(String(value.scenario_id))
    || !['LONG', 'SHORT'].includes(String(value.direction)) || value.symbol !== 'BTCUSDT'
    || !['ACTIVE_CLOSE', 'WAIT_SL', 'WAIT_TP', 'FUNDING_WINDOW'].includes(String(value.exit_mode))
    || !['risk_policy_v3', 'risk_policy_testnet_v1'].includes(String(value.policy_version))
    || !Number.isSafeInteger(value.max_hold_ms) || Number(value.max_hold_ms) < 1 || Number(value.max_hold_ms) > 1_800_000
    || [value.sl_pct, value.tp_pct].some(p => typeof p !== 'string' || !/^0\.\d+$/.test(p) || Number(p) <= 0 || Number(p) >= 1))
    throw new ScenarioFailure('SCENARIO_CONFIG_INVALID', '场景只接受 2A 的明确参数，BTCUSDT、比例字符串和有界持仓时长');
  if ((value.scenario_id === 'S2' && value.exit_mode !== 'WAIT_SL') || (value.scenario_id === 'S3' && value.exit_mode !== 'WAIT_TP')
    || (value.scenario_id === 'S4' && value.exit_mode !== 'FUNDING_WINDOW')
    || (['WAIT_SL', 'WAIT_TP'].includes(String(value.exit_mode)) && value.policy_version !== 'risk_policy_testnet_v1'))
    throw new ScenarioFailure('SCENARIO_CONFIG_INVALID', '保护触发场景必须明确选择测试网 policy 和匹配的退出模式');
  const settlement = value.funding_settlement_at;
  if (value.exit_mode === 'FUNDING_WINDOW') {
    if (typeof settlement !== 'string' || !Number.isFinite(Date.parse(settlement)) || new Date(settlement).toISOString() !== settlement
      || Date.parse(settlement) % 28_800_000 !== 0 || value.max_hold_ms !== 1_200_000)
      throw new ScenarioFailure('SCENARIO_FUNDING_WINDOW_INVALID', 'S4 必须提供 UTC 资金费结算时刻并完整覆盖前后各十分钟');
  } else if (settlement !== null) throw new ScenarioFailure('SCENARIO_FUNDING_WINDOW_INVALID');
  return structuredClone(value) as unknown as ScenarioConfig;
}
