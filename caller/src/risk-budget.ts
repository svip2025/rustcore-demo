import type { DatabaseSync } from "node:sqlite";

/** Private caller integration payloads; these are not public HTTP/SSE schemas. */
export interface RiskBudgetEventPayload {
  kind: "budget_baseline_reset" | "budget_day_started" | "budget_not_applied" | "budget_rejected";
  message: string;
  details: Record<string, string | number | boolean | null>;
}

export interface RiskBudgetObservation {
  credentialId: string;
  account: unknown;
  positionStates: unknown;
  nowMs?: number;
  /** One explicit user action, never a heuristic based on a balance change. */
  reset?: boolean;
}

export interface RiskBudgetRequest {
  credential_id: string;
  as_of_ms: string;
  equity_usdt: string;
  available_usdt: string;
  today_realized_pnl_usdt: string;
  today_realized_pnl_pct: number;
  drawdown_pct: number;
  total_exposure_pct: number;
  open_positions_count: string;
  schema_version: 1;
}

export interface RiskBudgetBaseline {
  utcDay: string;
  epoch: number;
  dayEquityUsdt: string;
  highWaterEquityUsdt: string;
  firstObservedAtMs: number;
  firstSourceAsOfMs: number;
}

export interface RiskBudgetMetrics {
  todayPnlUsdt: string;
  todayPnlPct: number;
  drawdownPct: number;
  totalExposurePct: number;
  totalExposureUsdt: string;
  openPositionsCount: number;
  pnlBasis: "equity_change_since_observed_day_baseline";
}

export type RiskBudgetResult =
  | {
      publish: true;
      budget: RiskBudgetRequest;
      baseline: RiskBudgetBaseline;
      metrics: RiskBudgetMetrics;
      events: RiskBudgetEventPayload[];
    }
  | {
      publish: false;
      reason: string;
      message: string;
      baseline?: RiskBudgetBaseline;
      events: RiskBudgetEventPayload[];
    };

type Row = Record<string, unknown>;
type Decimal = { coefficient: bigint; scale: number };
const MAX_AGE_MS = 30_000;
const ZERO: Decimal = { coefficient: 0n, scale: 0 };

class InvalidObservation extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

function invalid(reason: string, message: string): never {
  throw new InvalidObservation(reason, message);
}

function object(value: unknown, label: string): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid("MISSING_FACTS", `${label} is missing or invalid`);
  return value as Row;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
    invalid("INVALID_FACT", `${label} must be a nonempty string`);
  return value;
}

function integer(value: unknown, label: string, positive = false): number {
  let number: number;
  if (typeof value === "number") number = value;
  else if (typeof value === "bigint" || (typeof value === "string" && /^[0-9]+$/.test(value))) {
    const big = BigInt(value);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) invalid("INVALID_TIME", `${label} exceeds the safe integer range`);
    number = Number(big);
  } else invalid("INVALID_TIME", `${label} must be an integer`);
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0))
    invalid("INVALID_TIME", `${label} must be a valid ${positive ? "positive " : ""}integer`);
  return number;
}

function fresh(value: unknown, label: string, now: number): number {
  const timestamp = integer(value, label, true);
  if (timestamp > now) invalid("FUTURE_SOURCE", `${label} is in the future`);
  if (now - timestamp > MAX_AGE_MS) invalid("STALE_SOURCE", `${label} is older than 30 seconds`);
  return timestamp;
}

function decimal(value: unknown, label: string): Decimal {
  if (typeof value !== "string" || value.length > 256 || !/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value))
    invalid("INVALID_DECIMAL", `${label} must be a finite decimal string`);
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  return normalize({ coefficient: BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n), scale: fraction.length });
}

function normalize(value: Decimal): Decimal {
  let { coefficient, scale } = value;
  if (coefficient === 0n) return ZERO;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale--;
  }
  return { coefficient, scale };
}

const power = (scale: number): bigint => 10n ** BigInt(scale);
const absolute = (value: Decimal): Decimal => ({ ...value, coefficient: value.coefficient < 0n ? -value.coefficient : value.coefficient });

function add(left: Decimal, right: Decimal): Decimal {
  const scale = Math.max(left.scale, right.scale);
  return normalize({ coefficient: left.coefficient * power(scale - left.scale) + right.coefficient * power(scale - right.scale), scale });
}

const subtract = (left: Decimal, right: Decimal): Decimal => add(left, { ...right, coefficient: -right.coefficient });
const multiply = (left: Decimal, right: Decimal): Decimal => normalize({ coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale });
const compare = (left: Decimal, right: Decimal): bigint => subtract(left, right).coefficient;

function decimalText(value: Decimal): string {
  const normalized = normalize(value);
  const sign = normalized.coefficient < 0n ? "-" : "";
  const digits = absolute(normalized).coefficient.toString().padStart(normalized.scale + 1, "0");
  return normalized.scale === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -normalized.scale)}.${digits.slice(-normalized.scale)}`;
}

/** Only the final dimensionless ratio is converted to floating point. */
function ratio(numerator: Decimal, denominator: Decimal): number {
  if (denominator.coefficient === 0n) invalid("INVALID_RATIO", "ratio denominator is zero");
  if (numerator.coefficient === 0n) return 0;
  const n = absolute(numerator).coefficient * power(denominator.scale);
  const d = absolute(denominator).coefficient * power(numerator.scale);
  const shift = 18 + d.toString().length - n.toString().length;
  const quotient = shift >= 0 ? n * power(shift) / d : n / (d * power(-shift));
  const negative = (numerator.coefficient < 0n) !== (denominator.coefficient < 0n);
  const value = Number(`${negative ? "-" : ""}${quotient}e${-shift}`);
  if (!Number.isFinite(value) || value === 0) invalid("INVALID_RATIO", "ratio cannot be represented as a finite nonzero number");
  return value;
}

function credential(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value)
    invalid("INVALID_CREDENTIAL", "credentialId is invalid");
  return value;
}

function observationTime(value: number): number {
  const now = integer(value, "nowMs", true);
  if (!Number.isFinite(new Date(now).getTime())) invalid("INVALID_TIME", "nowMs is outside the Date range");
  return now;
}

function positionKey(row: Row, directionField: string): string {
  const symbol = text(row.symbol_key, "symbol_key");
  const direction = text(row[directionField], directionField);
  if (direction !== "long" && direction !== "short") invalid("INVALID_POSITION", "position direction is invalid");
  return `${symbol}\u0000${direction}`;
}

export class RiskBudgetCalculator {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS caller_risk_budget_accounts (
        credential_id TEXT PRIMARY KEY,
        epoch INTEGER NOT NULL,
        high_water_usdt TEXT,
        last_source_ms INTEGER,
        last_observed_ms INTEGER,
        pending_reset INTEGER NOT NULL DEFAULT 0,
        reset_requested_ms INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS caller_risk_budget_days (
        credential_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        utc_day TEXT NOT NULL,
        baseline_usdt TEXT NOT NULL,
        first_observed_ms INTEGER NOT NULL,
        first_source_ms INTEGER NOT NULL,
        PRIMARY KEY (credential_id, epoch, utc_day)
      ) STRICT;
    `);
  }

  /** Persist a one-shot reset request; completion waits for a new valid source observation. */
  requestReset(credentialId: string, nowMs = Date.now()): void {
    const id = credential(credentialId);
    const now = observationTime(nowMs);
    this.db.prepare(`
      INSERT INTO caller_risk_budget_accounts (credential_id, epoch, pending_reset, reset_requested_ms)
      VALUES (?, 0, 1, ?)
      ON CONFLICT(credential_id) DO UPDATE SET pending_reset=1,
        reset_requested_ms=CASE WHEN pending_reset=1 THEN reset_requested_ms ELSE excluded.reset_requested_ms END
    `).run(id, now);
  }

  observe(input: RiskBudgetObservation): RiskBudgetResult {
    const events: RiskBudgetEventPayload[] = [];
    let baseline: RiskBudgetBaseline | undefined;
    try {
      const id = credential(input.credentialId);
      const now = observationTime(input.nowMs ?? Date.now());
      if (input.reset === true) this.requestReset(id, now);
      const account = object(input.account, "GetAccountState");
      if (account.available !== true) invalid("ACCOUNT_UNAVAILABLE", "account truth is unavailable");
      const source = fresh(account.as_of_ms, "account.as_of_ms", now);
      const equity = decimal(account.equity_usdt, "equity_usdt");

      // Valid equity is recorded even if marks/positions later prevent publication.
      baseline = this.recordEquity(id, equity, source, now, events);
      const available = decimal(account.available_usdt, "available_usdt");
      const states = object(input.positionStates, "GetPositionStates");
      if (!Array.isArray(states.positions) || !Array.isArray(account.positions))
        invalid("MISSING_POSITIONS", "both position arrays must be present, including explicit [] when flat");
      if (states.orphan_positions !== undefined && (!Array.isArray(states.orphan_positions) || states.orphan_positions.length !== 0))
        invalid("ORPHAN_POSITION", "orphan position truth cannot be omitted from the budget");

      let asOf = source;
      const amounts = new Map<string, Decimal>();
      for (const raw of states.positions) {
        const state = object(raw, "position state");
        if (state.credential_id !== undefined && state.credential_id !== id)
          invalid("POSITION_SCOPE_MISMATCH", "position belongs to another credential");
        const quantity = absolute(decimal(state.qty, "position.qty"));
        if (state.state === "closed" && quantity.coefficient !== 0n)
          invalid("INVALID_POSITION", "closed position has nonzero quantity");
        if (quantity.coefficient === 0n) continue;
        asOf = Math.min(asOf, fresh(state.last_reconciled_ms, "position.last_reconciled_ms", now));
        const key = positionKey(state, "direction");
        amounts.set(key, add(amounts.get(key) ?? ZERO, quantity));
      }

      const marks = new Map<string, { quantity: Decimal; mark: Decimal }>();
      for (const raw of account.positions) {
        const position = object(raw, "account position");
        const quantity = absolute(decimal(position.qty, "account position.qty"));
        if (quantity.coefficient === 0n) continue;
        const key = positionKey(position, "side");
        if (marks.has(key)) invalid("AMBIGUOUS_MARK", "account positions contain duplicate symbol/direction entries");
        if (position.mark_price === undefined || position.mark_price === null || position.mark_price === "")
          invalid("MISSING_MARK", "a held position has no current mark_price");
        const mark = decimal(position.mark_price, "mark_price");
        if (mark.coefficient <= 0n) invalid("INVALID_MARK", "mark_price must be positive");
        if (position.mark_truth !== undefined && position.mark_truth !== null) {
          const truth = object(position.mark_truth, "mark_truth");
          asOf = Math.min(asOf, fresh(truth.source_timestamp_ms, "mark_truth.source_timestamp_ms", now));
          if ((truth.credential_id !== undefined && truth.credential_id !== id) ||
              (truth.symbol_key !== undefined && truth.symbol_key !== position.symbol_key))
            invalid("MARK_SCOPE_MISMATCH", "mark truth has a different credential or instrument");
        }
        marks.set(key, { quantity, mark });
      }
      if (marks.size !== amounts.size) invalid("POSITION_MISMATCH", "local and account holding scopes do not agree");
      let exposure = ZERO;
      for (const [key, quantity] of amounts) {
        const marked = marks.get(key);
        if (!marked) invalid("MISSING_MARK", "no account mark matches the held symbol and direction");
        if (compare(quantity, marked.quantity) !== 0n)
          invalid("POSITION_MISMATCH", "local and account quantities do not agree");
        exposure = add(exposure, multiply(quantity, marked.mark));
      }
      if (account.open_positions_count !== undefined && integer(account.open_positions_count, "open_positions_count") !== marks.size)
        invalid("POSITION_MISMATCH", "open_positions_count disagrees with account holdings");

      const pnl = subtract(equity, decimal(baseline.dayEquityUsdt, "stored day baseline"));
      const highWater = decimal(baseline.highWaterEquityUsdt, "stored high water");
      const todayPnlPct = ratio(pnl, decimal(baseline.dayEquityUsdt, "stored day baseline"));
      const drawdownPct = ratio(subtract(highWater, equity), highWater);
      const exposurePct = ratio(exposure, equity);
      return {
        publish: true,
        budget: {
          credential_id: id,
          as_of_ms: String(asOf),
          equity_usdt: decimalText(equity),
          available_usdt: decimalText(available),
          today_realized_pnl_usdt: decimalText(pnl),
          today_realized_pnl_pct: todayPnlPct,
          drawdown_pct: drawdownPct,
          total_exposure_pct: exposurePct,
          open_positions_count: String(marks.size),
          schema_version: 1,
        },
        baseline,
        metrics: {
          todayPnlUsdt: decimalText(pnl), todayPnlPct, drawdownPct, totalExposurePct: exposurePct,
          totalExposureUsdt: decimalText(exposure), openPositionsCount: marks.size,
          pnlBasis: "equity_change_since_observed_day_baseline",
        },
        events,
      };
    } catch (error) {
      if (!(error instanceof InvalidObservation)) throw error;
      return { publish: false, reason: error.reason, message: error.message, events, ...(baseline ? { baseline } : {}) };
    }
  }

  /** Return private timeline payloads; scheduling, gRPC calls and public mapping belong to root. */
  recordPublishResponse(credentialId: string, response: unknown): RiskBudgetEventPayload[] {
    const id = credential(credentialId);
    const value = object(response, "PutRiskBudget response");
    if (value.accepted === true && value.applied === true) return [];
    return [{
      kind: value.accepted === true ? "budget_not_applied" : "budget_rejected",
      message: value.accepted === true ? "风险预算未应用" : "风险预算发布被拒绝",
      details: {
        credential_id: id,
        accepted: value.accepted === true,
        applied: value.applied === true,
        current_as_of_ms: typeof value.current_as_of_ms === "string" || typeof value.current_as_of_ms === "number"
          ? String(value.current_as_of_ms) : null,
        response_message: typeof value.message === "string" ? value.message : null,
      },
    }];
  }

  private recordEquity(id: string, equity: Decimal, source: number, now: number,
                       events: RiskBudgetEventPayload[]): RiskBudgetBaseline {
    const day = new Date(now).toISOString().slice(0, 10);
    this.db.exec("SAVEPOINT caller_risk_budget_observe");
    try {
      const state = this.db.prepare("SELECT * FROM caller_risk_budget_accounts WHERE credential_id=?").get(id);
      const pending = state !== undefined && integer(state.pending_reset, "stored pending reset") === 1;
      if (state !== undefined && state.high_water_usdt === null && !pending)
        throw new Error("stored budget history is unknown; an explicit reset is required");
      const resetting = state === undefined || state.high_water_usdt === null || pending;
      if (pending && source < integer(state.reset_requested_ms, "reset request time", true))
        invalid("RESET_WAITING_FOR_OBSERVATION", "reset waits for an account source observed after the explicit request");
      if (!resetting && source < integer(state.last_source_ms, "stored source time", true))
        invalid("OUT_OF_ORDER_SOURCE", "account source is older than the last recorded account observation");
      if (!resetting && now < integer(state.last_observed_ms, "stored observation time", true))
        invalid("CLOCK_ROLLBACK", "observation clock moved backwards");
      const previousEpoch = state === undefined ? 0 : integer(state.epoch, "stored reset epoch");
      const epoch = resetting ? previousEpoch + 1 : previousEpoch;
      if (!Number.isSafeInteger(epoch)) throw new Error("risk budget reset epoch is invalid");
      const oldHigh = resetting ? equity : decimal(state.high_water_usdt, "stored high water");
      const high = compare(equity, oldHigh) > 0n ? equity : oldHigh;
      let daily = this.db.prepare(`SELECT * FROM caller_risk_budget_days
        WHERE credential_id=? AND epoch=? AND utc_day=?`).get(id, epoch, day);
      if (daily === undefined) {
        this.db.prepare(`INSERT INTO caller_risk_budget_days
          (credential_id,epoch,utc_day,baseline_usdt,first_observed_ms,first_source_ms) VALUES (?,?,?,?,?,?)`)
          .run(id, epoch, day, decimalText(equity), now, source);
        daily = { baseline_usdt: decimalText(equity), first_observed_ms: now, first_source_ms: source };
        events.push({
          kind: resetting ? "budget_baseline_reset" : "budget_day_started",
          message: resetting ? "预算基准已重置" : "UTC 新日预算基准已建立",
          details: { credential_id: id, utc_day: day, epoch,
            reason: resetting ? (pending ? "explicit_reset" : "first_valid_observation") : "first_valid_observation_of_utc_day",
            day_baseline_usdt: decimalText(equity), high_water_usdt: decimalText(high),
            first_observed_at_ms: now, source_as_of_ms: source, history_before_baseline: "unknown" },
        });
      }
      this.db.prepare(`INSERT INTO caller_risk_budget_accounts
        (credential_id,epoch,high_water_usdt,last_source_ms,last_observed_ms,pending_reset,reset_requested_ms)
        VALUES (?,?,?,?,?,0,NULL) ON CONFLICT(credential_id) DO UPDATE SET
        epoch=excluded.epoch,high_water_usdt=excluded.high_water_usdt,last_source_ms=excluded.last_source_ms,
        last_observed_ms=excluded.last_observed_ms,pending_reset=0,reset_requested_ms=NULL`)
        .run(id, epoch, decimalText(high), source, now);
      const result = { utcDay: day, epoch, dayEquityUsdt: text(daily.baseline_usdt, "stored day baseline"),
        highWaterEquityUsdt: decimalText(high), firstObservedAtMs: integer(daily.first_observed_ms, "stored first observation", true),
        firstSourceAsOfMs: integer(daily.first_source_ms, "stored first source", true) };
      this.db.exec("RELEASE caller_risk_budget_observe");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO caller_risk_budget_observe; RELEASE caller_risk_budget_observe");
      throw error;
    }
  }
}
