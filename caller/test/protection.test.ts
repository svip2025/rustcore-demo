import assert from "node:assert/strict";
import test from "node:test";
import { verifyProtection, type VerifyProtectionInput } from "../src/protection.js";

// Deliberately expose both wire enum representations and 64-bit decimal strings.
function fixture() {
  const meta = (count: number, venue = false) => ({ coverage: venue ? "AOC_COMPLETE_VENUE" : 1,
    overflow: false, returned_count: count, total_count: count });
  const localOrder = (kind: string, id: string, price: string) => ({
    protection_order_id: `protection-${kind}`, credential_id: "testnet-demo", position_id: "pos-demo",
    kind, generation: "9007199254740993", exchange_algo_id: id, client_algo_id: `client-${kind}`,
    association_status: "matched", current_plan_generation_match: true, verified_projection: true,
    trigger_price: price, last_verified_at_ms: "100", algo_updated_at_ms: "100", raw_status: "confirmed",
  });
  const venueOrder = (kind: string, id: string, price: string) => ({
    algo_id: id, client_algo_id: `client-${kind}`, identity_valid: true, symbol: "BTCUSDT",
    order_type: kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET", side: "SELL",
    trigger_price: price, close_position: true, status: "NEW", updated_at_ms: "100",
  });
  const position = { position_id: "pos-demo", credential_id: "testnet-demo",
    bot_uid: "bot-demo", symbol_key: "binance|futures|BTC|USDT|USDT", direction: "long", quantity: "0.001", raw_state: "protected" };
  const plan = { position_id: "pos-demo", credential_id: "testnet-demo",
    bot_uid: "bot-demo", symbol_key: "binance|futures|BTC|USDT|USDT", direction: "long",
    generation: "9007199254740993", stop_loss_price: "95000.000", take_profit_price: "110000.0", association_status: "matched" };
  const snapshot = {
    credential_id: "testnet-demo", engine_boot_id: "boot-current", account_kind: "exchange",
    local: {
      positions: { meta: meta(1), rows: [position] as [typeof position] },
      protection_plans: { meta: meta(1), rows: [plan] as [typeof plan] },
      protection_orders: { meta: meta(2), rows: [localOrder("sl", "9007199254740995", "95000"), localOrder("tp", "9007199254740997", "110000")] as [ReturnType<typeof localOrder>, ReturnType<typeof localOrder>] },
    },
    venue: {
      availability: 1, credential_id: "testnet-demo", engine_boot_id: "boot-current", observation_id: "observation-one",
      capture_started_at_ms: "101000", capture_completed_at_ms: "102000", source_as_of_ms: "101000",
      latest_attempt: { status: "succeeded", coverage: "full_account", observation_id: "observation-one", started_at_ms: "101000", completed_at_ms: "102000" },
      ordinary: { meta: meta(0, true), rows: [] as object[], started_at_ms: "101100", completed_at_ms: "101300" },
      algo: { meta: meta(2, true), rows: [venueOrder("sl", "9007199254740995", "95000.00"), venueOrder("tp", "9007199254740997", "110000.000")] as [ReturnType<typeof venueOrder>, ReturnType<typeof venueOrder>], started_at_ms: "101300", completed_at_ms: "102000" },
    },
  };
  const input: VerifyProtectionInput = { snapshot, credential_id: "testnet-demo", position_id: "pos-demo",
    symbol_key: "binance|futures|BTC|USDT|USDT", direction: "long", expected_boot_id: "boot-current",
    boot_started_at_ms: "100000", now_ms: "103000" };
  return { input, snapshot };
}

test("both current NEW algo orders pass; old exchange updateTime and absent actual order IDs remain valid", () => {
  const { input, snapshot } = fixture();
  const before = structuredClone(snapshot);
  const result = verifyProtection(input);
  assert.equal(result.status, "PASS");
  assert.equal(result.sl.status, "PASS");
  assert.equal(result.tp.status, "PASS");
  assert.equal(result.generation, "9007199254740993");
  assert.deepEqual(snapshot, before, "verification is passive and does not mutate its source");
});

test("a complete snapshot proves missing TP as FAIL while retaining SL PASS", () => {
  const { input, snapshot } = fixture();
  snapshot.venue.algo.rows.pop();
  snapshot.venue.algo.meta.returned_count = snapshot.venue.algo.meta.total_count = 1;
  const result = verifyProtection(input);
  assert.equal(result.status, "FAIL");
  assert.equal(result.sl.status, "PASS");
  assert.equal(result.tp.status, "FAIL");
  assert.match(result.tp.reason, /absent/);
});

test("TP detail absence is UNKNOWN rather than a synthesized proof from its local plan", () => {
  const { input, snapshot } = fixture();
  delete (snapshot.venue.algo.rows[1] as Partial<typeof snapshot.venue.algo.rows[number]>).trigger_price;
  const result = verifyProtection(input);
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sl.status, "PASS");
  assert.equal(result.tp.status, "UNKNOWN");
});

test("NEW is stable; TRIGGERING and unknown states cannot pass, and TRIGGERED is a failure", () => {
  for (const [status, expected] of [["TRIGGERING", "UNKNOWN"], ["FINISHED", "UNKNOWN"], ["ALIEN", "UNKNOWN"], ["TRIGGERED", "FAIL"], ["CANCELED", "FAIL"]] as const) {
    const { input, snapshot } = fixture();
    snapshot.venue.algo.rows[1].status = status;
    const result = verifyProtection(input);
    assert.equal(result.sl.status, "PASS");
    assert.equal(result.tp.status, expected, status);
    assert.equal(result.tp.venue_status, status);
  }
});

test("cross-observation, old boot, stale source and out-of-window section observations are UNKNOWN", () => {
  for (const change of [
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.latest_attempt.observation_id = "another-round"; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.engine_boot_id = "old-boot"; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.engine_boot_id = "old-boot"; },
    (x: ReturnType<typeof fixture>) => { x.input.now_ms = "131001"; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.source_as_of_ms = "99999"; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.algo.started_at_ms = "99999"; },
  ]) {
    const x = fixture(); change(x);
    assert.equal(verifyProtection(x.input).status, "UNKNOWN");
  }
});

test("ordinary and algo coverage, counts, identity validity and overflow must all be complete", () => {
  for (const change of [
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.ordinary.meta.coverage = "AOC_PARTIAL"; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.algo.meta.overflow = true; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.algo.meta.total_count = 3; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.algo.rows[0].identity_valid = false; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.venue.availability = 99; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.local.protection_orders.meta.coverage = 99; },
  ]) {
    const x = fixture(); change(x);
    assert.equal(verifyProtection(x.input).status, "UNKNOWN");
  }
});

test("typed IDs must agree on one target, never an ordinary order with the same numeric ID", () => {
  const x = fixture();
  x.snapshot.venue.algo.rows[1].client_algo_id = "different-client";
  assert.equal(verifyProtection(x.input).tp.status, "FAIL");
  const y = fixture();
  y.snapshot.venue.algo.rows.pop();
  y.snapshot.venue.algo.meta.returned_count = y.snapshot.venue.algo.meta.total_count = 1;
  y.snapshot.venue.ordinary.rows.push({ order_id: "9007199254740997", identity_valid: true });
  y.snapshot.venue.ordinary.meta.returned_count = y.snapshot.venue.ordinary.meta.total_count = 1;
  assert.equal(verifyProtection(y.input).tp.status, "FAIL");
});

test("multiple targets, generation disagreement and an unverified local row remain UNKNOWN", () => {
  for (const change of [
    (x: ReturnType<typeof fixture>) => {
      x.snapshot.local.protection_orders.rows.push({ ...x.snapshot.local.protection_orders.rows[1], protection_order_id: "duplicate" });
      x.snapshot.local.protection_orders.meta.returned_count = x.snapshot.local.protection_orders.meta.total_count = 3;
    },
    (x: ReturnType<typeof fixture>) => { x.snapshot.local.protection_orders.rows[1].generation = "9007199254740992"; },
    (x: ReturnType<typeof fixture>) => { x.snapshot.local.protection_orders.rows[1].verified_projection = false; },
    (x: ReturnType<typeof fixture>) => {
      x.snapshot.venue.algo.rows.push({ ...x.snapshot.venue.algo.rows[1] });
      x.snapshot.venue.algo.meta.returned_count = x.snapshot.venue.algo.meta.total_count = 3;
    },
  ]) {
    const x = fixture(); change(x);
    const result = verifyProtection(x.input);
    assert.equal(result.sl.status, "PASS");
    assert.equal(result.tp.status, "UNKNOWN");
  }
});

test("closing side/type/price conflicts fail; absent reduce-only quantity remains unknown", () => {
  for (const field of ["side", "order_type", "trigger_price"] as const) {
    const { input, snapshot } = fixture();
    snapshot.venue.algo.rows[1][field] = field === "trigger_price" ? "110000.00000000000000000001" : "WRONG";
    assert.equal(verifyProtection(input).tp.status, "FAIL", field);
  }
  const { input, snapshot } = fixture();
  const tp: Record<string, unknown> = snapshot.venue.algo.rows[1];
  tp.close_position = false; tp.reduce_only = true;
  assert.equal(verifyProtection(input).tp.status, "UNKNOWN");
  tp.quantity = "0.000000000000000000000001";
  assert.equal(verifyProtection(input).tp.status, "PASS", "positive decimal is not rounded to zero");
  tp.actual_order_id = "7701";
  assert.equal(verifyProtection(input).tp.status, "FAIL", "an actual child is evidence of triggering");
});

test("short targets require BUY and a newer local triggering state cannot reuse cached NEW", () => {
  const { input, snapshot } = fixture();
  input.direction = "short";
  snapshot.local.positions.rows[0].direction = "short";
  snapshot.local.protection_plans.rows[0].direction = "short";
  for (const order of snapshot.venue.algo.rows) order.side = "BUY";
  assert.equal(verifyProtection(input).status, "PASS");
  const localTp: Record<string, unknown> = snapshot.local.protection_orders.rows[1];
  localTp.algo_status = "TRIGGERING";
  const result = verifyProtection(input);
  assert.equal(result.sl.status, "PASS");
  assert.equal(result.tp.status, "UNKNOWN");
  assert.equal(result.tp.local_algo_status, "TRIGGERING");
  assert.equal(result.tp.venue_status, "NEW");
});
