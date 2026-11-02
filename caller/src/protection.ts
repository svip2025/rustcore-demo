import type { CheckResult } from "../../shared/schema.js";

/** Passive verification of one complete GetAccountOrderState observation. */
export type VerificationStatus = CheckResult;
export type WireInteger = string | number | bigint;

export interface VerifyProtectionInput {
  snapshot: unknown;
  credential_id: string;
  position_id: string;
  symbol_key: string;
  direction: "long" | "short";
  expected_boot_id: string;
  boot_started_at_ms: WireInteger;
  now_ms: WireInteger;
}

export interface ProtectionLegVerification {
  status: VerificationStatus;
  reason: string;
  protection_order_id?: string;
  exchange_algo_id?: string;
  client_algo_id?: string;
  venue_status?: string;
  local_status?: string;
  local_algo_status?: string;
}

export interface ProtectionVerification {
  status: VerificationStatus;
  reason: string;
  sl: ProtectionLegVerification;
  tp: ProtectionLegVerification;
  observation_id?: string;
  engine_boot_id?: string;
  generation?: string;
}

type Row = Record<string, unknown>;
const FRESHNESS_MS = 30_000n;
const row = (value: unknown): Row | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : undefined;

function integer(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? BigInt(value)
    : undefined;
}

/** Money/quantity equality never passes through a JavaScript floating number. */
function decimal(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256 || !/^\+?[0-9]+(?:\.[0-9]+)?$/.test(value))
    return undefined;
  const [whole = "", fraction = ""] = value.replace(/^\+/, "").split(".");
  const digits = BigInt(whole + fraction).toString();
  if (digits === "0") return undefined;
  let coefficient = digits;
  let scale = fraction.length;
  while (scale > 0 && coefficient.endsWith("0")) {
    coefficient = coefficient.slice(0, -1);
    scale--;
  }
  return `${coefficient}:${scale}`;
}

function enumIs(value: unknown, number: number, name: string): boolean {
  return value === number || value === name || value === String(number);
}

function completeSection(value: unknown, venue: boolean): Row[] | undefined {
  const section = row(value);
  const meta = row(section?.meta);
  if (!meta || !Array.isArray(section?.rows) || meta.overflow !== false ||
      !enumIs(meta.coverage, venue ? 2 : 1, venue ? "AOC_COMPLETE_VENUE" : "AOC_COMPLETE_LOCAL"))
    return undefined;
  const rows = section.rows.map(row);
  if (rows.some((value) => value === undefined) ||
      integer(meta.returned_count) !== BigInt(rows.length) ||
      integer(meta.total_count) !== BigInt(rows.length)) return undefined;
  if (venue && rows.some((value) => value?.identity_valid !== true)) return undefined;
  return rows as Row[];
}

const verdict = (status: VerificationStatus, reason: string): ProtectionLegVerification => ({ status, reason });

function result(sl: ProtectionLegVerification, tp: ProtectionLegVerification,
                details: Pick<ProtectionVerification, "observation_id" | "engine_boot_id" | "generation"> = {}): ProtectionVerification {
  const status = sl.status === "FAIL" || tp.status === "FAIL" ? "FAIL"
    : sl.status === "PASS" && tp.status === "PASS" ? "PASS" : "UNKNOWN";
  return { status, reason: `sl=${sl.status}: ${sl.reason}; tp=${tp.status}: ${tp.reason}`, sl, tp, ...details };
}

function unavailable(reason: string): ProtectionVerification {
  return result(verdict("UNKNOWN", reason), verdict("UNKNOWN", reason));
}

function verifyLeg(kind: "sl" | "tp", input: VerifyProtectionInput, plan: Row,
                   generation: bigint, localOrders: Row[], venueOrders: Row[], symbol: string): ProtectionLegVerification {
  const relevant = localOrders.filter((order) => order.position_id === input.position_id &&
    order.credential_id === input.credential_id && order.kind === kind);
  if (relevant.some((order) => order.current_plan_generation_match === true && integer(order.generation) !== generation))
    return verdict("UNKNOWN", "local generation claim contradicts the current plan");
  const current = relevant.filter((order) => integer(order.generation) === generation);
  if (current.length !== 1) return verdict("UNKNOWN", current.length ? "multiple current protection targets" : "current protection target missing");
  const local = current[0]!; // The single-target check above establishes this row.
  if (local.association_status !== "matched" || local.current_plan_generation_match !== true || local.verified_projection !== true)
    return verdict("UNKNOWN", "current local association/generation is not exchange-verified");
  const algo_id = text(local.exchange_algo_id), client_id = text(local.client_algo_id);
  if (!algo_id || !client_id) return verdict("UNKNOWN", "typed algo/client identity is incomplete");
  const protection_order_id = text(local.protection_order_id), local_status = text(local.raw_status), local_algo_status = text(local.algo_status);
  const detail = { exchange_algo_id: algo_id, client_algo_id: client_id,
    ...(protection_order_id ? { protection_order_id } : {}), ...(local_status ? { local_status } : {}),
    ...(local_algo_status ? { local_algo_status } : {}) };
  const finish = (status: VerificationStatus, reason: string, venue_status?: string) =>
    ({ ...verdict(status, reason), ...detail, ...(venue_status ? { venue_status } : {}) });
  const candidates = venueOrders.filter((order) => order.algo_id === algo_id || order.client_algo_id === client_id);
  if (candidates.length === 0) return finish("FAIL", "protection absent from the complete same-round venue snapshot");
  if (candidates.length !== 1) return finish("UNKNOWN", "typed identities map to multiple venue targets");
  const venue = candidates[0]!, status = text(venue.status)?.toUpperCase();
  if (!text(venue.algo_id) || !text(venue.client_algo_id)) return finish("UNKNOWN", "venue typed identity is incomplete", status);
  if (venue.algo_id !== algo_id || venue.client_algo_id !== client_id)
    return finish("FAIL", "algo/client identity conflict", status);
  const expectedType = kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
  const expectedSide = input.direction === "long" ? "SELL" : "BUY";
  if (!text(venue.symbol) || !text(venue.order_type) || !text(venue.side))
    return finish("UNKNOWN", "venue symbol/type/side detail is incomplete", status);
  if (venue.symbol !== symbol || venue.order_type !== expectedType || venue.side !== expectedSide)
    return finish("FAIL", "venue symbol/type/closing side does not match the target", status);
  if (venue.position_side !== undefined && venue.position_side !== null) {
    if (!text(venue.position_side) || !["BOTH", "LONG", "SHORT"].includes(venue.position_side as string))
      return finish("UNKNOWN", "venue position side is unknown", status);
    if (venue.position_side !== "BOTH" && venue.position_side !== input.direction.toUpperCase())
      return finish("FAIL", "venue position side does not match the target", status);
  }
  const expectedPrice = decimal(kind === "sl" ? plan.stop_loss_price : plan.take_profit_price);
  const localPrice = decimal(local.trigger_price), venuePrice = decimal(venue.trigger_price);
  if (!expectedPrice || !localPrice || !venuePrice) return finish("UNKNOWN", "positive trigger-price detail is incomplete", status);
  if (expectedPrice !== localPrice || expectedPrice !== venuePrice)
    return finish("FAIL", "trigger price does not match the current plan", status);
  if (venue.close_position !== true && !(venue.reduce_only === true && decimal(venue.quantity))) {
    if (venue.close_position === false && venue.reduce_only === false)
      return finish("FAIL", "venue order has no close-position or reduce-only semantics", status);
    return finish("UNKNOWN", "close-position or positive reduce-only quantity is not proven", status);
  }
  const actual = text(venue.actual_order_id);
  if (actual && actual !== "0") return finish("FAIL", "conditional order has already triggered", status);
  if (status === "TRIGGERING") return finish("UNKNOWN", "conditional order is triggering, not stable protection", status);
  if (status === "TRIGGERED" || ["CANCELED", "EXPIRED", "REJECTED", "FAILED"].includes(status ?? ""))
    return finish("FAIL", "conditional order is no longer standing protection", status);
  if (status !== "NEW") return finish("UNKNOWN", "venue order status is not a proven stable NEW", status);
  // A local stream update can be newer than the cached full-account capture.
  // Keep that conflict visible instead of declaring its earlier NEW stable.
  if ((text(local.algo_status) && local.algo_status !== "NEW") ||
      (text(local.actual_order_id) && local.actual_order_id !== "0") ||
      ["triggering", "triggered", "filled", "canceled", "expired", "rejected", "failed"].includes(String(local.raw_status)))
    return finish("UNKNOWN", "newer local protection state conflicts with the stable venue capture", status);
  return finish("PASS", "current protection is independently proven NEW on the venue", status);
}

export function verifyProtection(input: VerifyProtectionInput): ProtectionVerification {
  const state = row(input.snapshot), venue = row(state?.venue), local = row(state?.local);
  const now = integer(input.now_ms), bootStart = integer(input.boot_started_at_ms);
  const symbolParts = input.symbol_key.split("|");
  if (!text(input.credential_id) || !text(input.position_id) || !text(input.expected_boot_id) ||
      !["long", "short"].includes(input.direction) ||
      symbolParts.length !== 5 || symbolParts[0] !== "binance" || symbolParts[1] !== "futures" ||
      !/^[A-Z0-9]+$/.test(symbolParts[2] ?? "") || symbolParts[3] !== "USDT" || symbolParts[4] !== "USDT" ||
      now === undefined || bootStart === undefined || bootStart === 0n || bootStart > now)
    return unavailable("expected position or current boot window is invalid");
  if (!state || !venue || !local || state.account_kind !== "exchange" ||
      state.credential_id !== input.credential_id || venue.credential_id !== input.credential_id ||
      state.engine_boot_id !== input.expected_boot_id || venue.engine_boot_id !== input.expected_boot_id)
    return unavailable("snapshot credential/current boot does not match");
  const attempt = row(venue.latest_attempt), observation_id = text(venue.observation_id);
  if (!enumIs(venue.availability, 1, "AOA_AVAILABLE") || !attempt ||
      attempt.status !== "succeeded" || attempt.coverage !== "full_account" ||
      !observation_id || attempt.observation_id !== observation_id)
    return unavailable("one successful available full-account observation is required");
  const start = integer(venue.capture_started_at_ms), end = integer(venue.capture_completed_at_ms);
  const source = integer(venue.source_as_of_ms);
  if (start === undefined || end === undefined || source === undefined ||
      start < bootStart || source < bootStart || end < start || end > now ||
      source < start || source > end || now - start > FRESHNESS_MS || now - source > FRESHNESS_MS ||
      end - start > FRESHNESS_MS || integer(attempt.started_at_ms) !== start || integer(attempt.completed_at_ms) !== end)
    return unavailable("source capture is stale, mixed, or outside the current boot window");
  for (const name of ["ordinary", "algo"] as const) {
    const section = row(venue[name]), sectionStart = integer(section?.started_at_ms), sectionEnd = integer(section?.completed_at_ms);
    if (!completeSection(section, true) || sectionStart === undefined || sectionEnd === undefined ||
        sectionStart < start || sectionEnd < sectionStart || sectionEnd > end)
      return unavailable(`${name} coverage/counts/source timing is incomplete`);
  }
  const positions = completeSection(local.positions, false), plans = completeSection(local.protection_plans, false);
  const orders = completeSection(local.protection_orders, false);
  if (!positions || !plans || !orders) return unavailable("local position/plan/protection coverage is incomplete");
  const targets = positions.filter((value) => value.position_id === input.position_id && value.credential_id === input.credential_id);
  const targetPlans = plans.filter((value) => value.position_id === input.position_id && value.credential_id === input.credential_id);
  if (targets.length !== 1 || targetPlans.length !== 1) return unavailable("position/current plan association is missing or ambiguous");
  const position = targets[0]!, plan = targetPlans[0]!, generation = integer(plan.generation);
  if (plan.association_status !== "matched" || !text(position.bot_uid) || plan.bot_uid !== position.bot_uid ||
      position.symbol_key !== input.symbol_key || plan.symbol_key !== input.symbol_key ||
      position.direction !== input.direction || plan.direction !== input.direction || generation === undefined || generation === 0n)
    return unavailable("position/current plan identity or generation does not match");
  const details = { observation_id, engine_boot_id: input.expected_boot_id, generation: generation.toString() };
  if (!["open", "protected"].includes(String(position.raw_state)) || !decimal(position.quantity))
    return result(verdict("FAIL", "target is not a stable positive open position"), verdict("FAIL", "target is not a stable positive open position"), details);
  const venueOrders = completeSection(venue.algo, true)!;
  const symbol = `${symbolParts[2]}USDT`;
  const sl = verifyLeg("sl", input, plan, generation, orders, venueOrders, symbol);
  const tp = verifyLeg("tp", input, plan, generation, orders, venueOrders, symbol);
  if (sl.exchange_algo_id && tp.exchange_algo_id &&
      (sl.exchange_algo_id === tp.exchange_algo_id || sl.client_algo_id === tp.client_algo_id))
    return result(verdict("UNKNOWN", "SL and TP share a typed target identity"), verdict("UNKNOWN", "SL and TP share a typed target identity"), details);
  return result(sl, tp, details);
}
