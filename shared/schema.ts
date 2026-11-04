/** Public contract v2. Original v1 wire types are frozen in schema-v1.ts. */
export const SCHEMA_VERSION = 2 as const;

export type IsoTimestamp = string; // UTC ISO 8601, including milliseconds and Z.
export type DecimalString = string; // Base-10 decimal; never a JS money number.
export type CheckResult = 'PASS' | 'FAIL' | 'UNKNOWN';
export type DataSourceKind = 'MOCK' | 'TESTNET' | 'PAPER';
export type DisplayMode = 'live' | 'replay'; // Client presentation, not mainnet.

export interface DataSource {
  kind: DataSourceKind;
  label: string;
}

export interface BuildInfo {
  caller_commit: string;
  rustcore_commit: string;
}

export type ObservationStatus =
  | 'AVAILABLE' | 'PARTIAL' | 'STALE' | 'UNAVAILABLE' | 'UNKNOWN';

export interface Observation<T> {
  status: ObservationStatus;
  observed_at: IsoTimestamp | null;
  source_as_of: IsoTimestamp | null;
  value: T | null;
  reason: string;
}

export interface AccountView {
  account_label: string; // Public alias; never the credential_id or exchange UID.
  equity_usdt: DecimalString;
  available_usdt: DecimalString;
  position_mode: 'ONE_WAY' | 'HEDGE' | 'UNKNOWN';
  margin_mode: 'CROSS' | 'ISOLATED' | 'UNKNOWN';
  btc_leverage: number | null;
}

export interface PositionView {
  position_id: string;
  symbol: 'BTCUSDT';
  side: 'LONG' | 'SHORT';
  quantity: DecimalString; // Absolute quantity, including a measured "0".
  entry_price: DecimalString | null;
  mark_price: DecimalString | null;
  notional_usdt: DecimalString | null;
  state: 'PENDING' | 'OPEN' | 'PROTECTED' | 'CLOSING' | 'FLATTENING' | 'CLOSED' | 'UNKNOWN';
  source_as_of: IsoTimestamp | null;
}

export interface OpenOrderView {
  order_id: string; // Opaque public identifier.
  position_id: string | null;
  symbol: 'BTCUSDT';
  role: 'ENTRY' | 'EXIT' | 'SL' | 'TP' | 'UNKNOWN';
  side: 'BUY' | 'SELL' | 'UNKNOWN';
  order_type: string;
  quantity: DecimalString | null;
  price: DecimalString | null;
  status: string;
  source_as_of: IsoTimestamp | null;
}

export interface ProtectionLegView {
  kind: 'SL' | 'TP';
  status: CheckResult;
  reason: string;
  reason_code: string | null;
  order_id: string | null;
  trigger_price: DecimalString | null;
  venue_status: string | null;
  observed_at: IsoTimestamp | null;
  source_as_of: IsoTimestamp | null;
}

export interface ProtectionPairView {
  position_id: string;
  observation_id: string | null; // Both legs must come from this same venue observation.
  sl: ProtectionLegView;
  tp: ProtectionLegView;
}

export interface RiskBudgetView {
  status: 'FRESH' | 'STALE' | 'NOT_PUBLISHED' | 'UNAVAILABLE';
  source_as_of: IsoTimestamp | null;
  published_at: IsoTimestamp | null;
  age_ms: number | null;
  max_age_ms: number;
  last_publish_applied: boolean | null;
  reason: string;
  utc_day: string | null; // YYYY-MM-DD.
  day_start_equity_usdt: DecimalString | null;
  equity_high_water_usdt: DecimalString | null;
  approximate_today_pnl_usdt: DecimalString | null;
  approximate_today_pnl_pct: number | null; // Ratio, e.g. 0.03 means 3%.
  drawdown_pct: number | null;
  total_exposure_pct: number | null;
}

export interface KillSwitchView {
  level: 'none' | 'pause_new' | 'manage_only' | 'flatten' | 'UNKNOWN';
  reason: string;
  observed_at: IsoTimestamp | null;
}

export interface KernelView {
  status: 'ONLINE' | 'OFFLINE' | 'RESTARTING' | 'UNKNOWN';
  checked_at: IsoTimestamp;
  last_restart_at: IsoTimestamp | null;
  reason: string;
}

export type ScenarioStep =
  | 'preflight'
  | 'cleanup_before'
  | 'open_position'
  | 'verify_protection'
  | 'hold'
  | 'restart_kernel'
  | 'verify_recovery'
  | 'close_position'
  | 'cleanup_after';

export interface FillSummary {
  side: 'BUY' | 'SELL';
  quantity: DecimalString;
  average_price: DecimalString;
  notional_usdt: DecimalString;
}

export interface StepActual {
  summary: string;
  code: string | null;
  account: AccountView | null;
  position: PositionView | null;
  open_orders: OpenOrderView[] | null;
  protection: ProtectionPairView | null;
  fill: FillSummary | null;
  rustcore: KernelView | null;
  risk_budget: RiskBudgetView | null;
}

interface TimelineStepBase {
  round_id: string;
  step_id: string; // Stable within a round; SSE upserts by (round_id, step_id).
  sequence: number; // One-based step order within the round.
  step: ScenarioStep;
  started_at: IsoTimestamp;
  expected: string;
  actual: StepActual;
  reason: string;
}

export type TimelineStep = TimelineStepBase & (
  | { phase: 'RUNNING'; ended_at: null; result: 'UNKNOWN' }
  | { phase: 'COMPLETED'; ended_at: IsoTimestamp; result: CheckResult }
);

export type ScenarioId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'F1' | 'F2' | 'F3' | 'F4';
export interface ScenarioConfig {
  scenario_id: ScenarioId;
  direction: 'LONG' | 'SHORT';
  symbol: 'BTCUSDT';
  sl_pct: DecimalString; // Requested ratio; never silently changed by a policy.
  tp_pct: DecimalString;
  max_hold_ms: number;
  exit_mode: 'ACTIVE_CLOSE' | 'WAIT_SL' | 'WAIT_TP' | 'FUNDING_WINDOW';
  policy_version: 'risk_policy_v3' | 'risk_policy_testnet_v1';
  funding_settlement_at: IsoTimestamp | null;
}
export interface FundingEntry {
  public_id: string;
  transaction_at: IsoTimestamp;
  symbol: 'BTCUSDT';
  asset: 'USDT';
  amount_usdt: DecimalString; // Signed income, negative means a charge.
}
export interface RoundMetrics {
  step_durations_ms: Partial<Record<ScenarioStep, number>>;
  unknown_duration_ms: number;
  unknown_windows: { started_at: IsoTimestamp; ended_at: IsoTimestamp; duration_ms: number }[];
  protection_confirmation_ms: number | null; // Conservative upper bound: before Entry RPC to independently proven pair.
  reference_price: DecimalString | null;
  planned_sl_price: DecimalString | null;
  planned_tp_price: DecimalString | null;
  effective_sl_pct: DecimalString | null;
  effective_tp_pct: DecimalString | null;
  tick_size: DecimalString | null;
  stop_grid: DecimalString | null;
  accounting_status: 'UNKNOWN' | 'COMPLETE';
  accounting_start_at: IsoTimestamp | null;
  accounting_end_at: IsoTimestamp | null;
  gross_pnl_usdt: DecimalString | null;
  fees_usdt: DecimalString | null;
  funding_usdt: DecimalString | null;
  net_pnl_usdt: DecimalString | null;
  funding_entries: FundingEntry[] | null;
  equity_before_usdt: DecimalString | null;
  equity_after_usdt: DecimalString | null;
  trigger_observed_at: IsoTimestamp | null;
  trigger_source_at: IsoTimestamp | null; // Exchange fill timestamp, kept separate from local receipt time.
  flat_confirmed_at: IsoTimestamp | null;
}

export interface RoundSummary {
  scenario: ScenarioConfig | null; // null only when faithfully consuming legacy v1.
  metrics: RoundMetrics | null;
  round_id: string;
  trigger: 'SCHEDULED' | 'MANUAL';
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  started_at: IsoTimestamp;
  ended_at: IsoTimestamp | null;
  reason: string;
}

export interface RoundTimeline extends RoundSummary {
  steps: TimelineStep[];
}

export interface StateResponse {
  schema_version: typeof SCHEMA_VERSION;
  generated_at: IsoTimestamp;
  source: DataSource;
  build: BuildInfo;
  account: Observation<AccountView>;
  positions: Observation<PositionView[]>;
  open_orders: Observation<OpenOrderView[]>;
  protection: Observation<ProtectionPairView[]>;
  risk_budget: RiskBudgetView;
  kill_switch: KillSwitchView;
  rustcore: KernelView;
  active_round_id: string | null;
  latest_round: RoundSummary | null;
}

export interface TimelineResponse {
  schema_version: typeof SCHEMA_VERSION;
  generated_at: IsoTimestamp;
  source: DataSource;
  rounds: RoundTimeline[]; // Newest rounds first; each round's steps oldest first.
  next_cursor: string | null; // Opaque pagination cursor, null means no next page.
}

interface SseEnvelope {
  schema_version: typeof SCHEMA_VERSION;
  event_id: string; // Durable, opaque public cursor; also the SSE id header.
  emitted_at: IsoTimestamp;
  source: DataSource;
}

export type SseEvent = SseEnvelope & (
  | { type: 'state'; data: StateResponse }
  | { type: 'timeline'; data: TimelineResponse }
  | { type: 'step'; data: TimelineStep }
  | { type: 'round'; data: RoundSummary }
  | { type: 'heartbeat'; data: { at: IsoTimestamp } }
  | { type: 'resync'; data: { reason: string } }
);

/** Replay starts from the initial snapshots, then applies these same SSE events. */
export interface Recording {
  schema_version: typeof SCHEMA_VERSION;
  recording_id: string;
  title: string;
  description: string;
  source: DataSource;
  build: BuildInfo;
  created_at: IsoTimestamp;
  started_at: IsoTimestamp;
  ended_at: IsoTimestamp;
  initial_state: StateResponse;
  initial_timeline: TimelineResponse;
  events: SseEvent[]; // Persisted emission order; do not sort by local arrival time.
}
