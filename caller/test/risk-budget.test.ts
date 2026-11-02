import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RiskBudgetCalculator, type RiskBudgetObservation, type RiskBudgetResult } from "../src/risk-budget.js";

const T = Date.parse("2026-11-02T12:00:00.000Z");
const BTC = "binance|futures|BTC|USDT|USDT";
const ETH = "binance|futures|ETH|USDT|USDT";

function flat(equity = "1000", now = T, source = now): RiskBudgetObservation {
  return {
    credentialId: "9001", nowMs: now,
    account: { available: true, as_of_ms: String(source), equity_usdt: equity, available_usdt: equity,
      positions: [], open_positions_count: "0" },
    positionStates: { positions: [], orphan_positions: [] },
  };
}

function holding(now = T): RiskBudgetObservation {
  return {
    credentialId: "9001", nowMs: now,
    account: { available: true, as_of_ms: String(now - 1000), equity_usdt: "1000", available_usdt: "500",
      positions: [{ symbol_key: BTC, side: "long", qty: "0.1", entry_price: "999999", mark_price: "100.25" }],
      open_positions_count: "1" },
    positionStates: { positions: [{ position_id: "position-1", credential_id: "9001", symbol_key: BTC,
      direction: "long", state: "protected", qty: "0.1", entry_price: "888888", last_reconciled_ms: String(now - 5000) }], orphan_positions: [] },
  };
}

function account(input: RiskBudgetObservation): Record<string, any> {
  return input.account as Record<string, any>;
}
function states(input: RiskBudgetObservation): Record<string, any> {
  return input.positionStates as Record<string, any>;
}
function published(result: RiskBudgetResult) {
  assert.equal(result.publish, true, result.publish ? "" : `${result.reason}: ${result.message}`);
  if (!result.publish) throw new Error("expected publishable budget");
  return result;
}
function blocked(result: RiskBudgetResult, reason: string) {
  assert.equal(result.publish, false);
  if (result.publish) throw new Error("expected blocked budget");
  assert.equal(result.reason, reason);
  assert.equal("budget" in result, false);
  return result;
}
function withCalculator(fn: (calculator: RiskBudgetCalculator, db: DatabaseSync) => void) {
  const db = new DatabaseSync(":memory:");
  try { fn(new RiskBudgetCalculator(db), db); } finally { db.close(); }
}
function near(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-14, `${actual} != ${expected}`);
}

test("first valid observation explicitly resets unknown history, and cached observations keep the source time", () => {
  withCalculator((calculator) => {
    const first = published(calculator.observe(flat("1000.000", T, T - 7)));
    assert.equal(first.events.length, 1);
    assert.equal(first.events[0]?.message, "预算基准已重置");
    assert.equal(first.events[0]?.details.reason, "first_valid_observation");
    assert.equal(first.events[0]?.details.history_before_baseline, "unknown");
    assert.equal(first.baseline.dayEquityUsdt, "1000");
    assert.equal(first.baseline.highWaterEquityUsdt, "1000");
    assert.equal(first.budget.today_realized_pnl_usdt, "0");
    assert.equal(first.budget.open_positions_count, "0");
    assert.equal(first.budget.as_of_ms, String(T - 7));
    assert.equal(first.metrics.todayPnlPct, 0);
    assert.equal(first.metrics.drawdownPct, 0);
    const second = published(calculator.observe(flat("1000", T + 10_000, T - 7)));
    assert.deepEqual(second.events, []);
    assert.equal(second.budget.as_of_ms, String(T - 7));
  });
});

test("a process restart keeps the persisted day baseline and high-water equity", () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-budget-"));
  const file = join(directory, "caller.sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file);
    let calculator = new RiskBudgetCalculator(db);
    published(calculator.observe(flat("1000")));
    published(calculator.observe(flat("1250", T + 1000)));
    db.close();
    db = new DatabaseSync(file);
    calculator = new RiskBudgetCalculator(db);
    const result = published(calculator.observe(flat("1100", T + 2000)));
    assert.equal(result.baseline.dayEquityUsdt, "1000");
    assert.equal(result.baseline.highWaterEquityUsdt, "1250");
    assert.equal(result.budget.today_realized_pnl_usdt, "100");
    near(result.metrics.todayPnlPct, 0.1);
    near(result.metrics.drawdownPct, 0.12);
    assert.deepEqual(result.events, []);
  } finally {
    db?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a first positive equity below 100 still produces the real budget for the kernel", () => {
  withCalculator((calculator) => {
    const input = holding();
    account(input).equity_usdt = "0.01";
    account(input).available_usdt = "0.01";
    const result = published(calculator.observe(input));
    assert.equal(result.baseline.dayEquityUsdt, "0.01");
    assert.equal(result.baseline.highWaterEquityUsdt, "0.01");
    assert.equal(result.events[0]?.message, "预算基准已重置");
    assert.equal(result.budget.equity_usdt, "0.01");
    assert.equal(result.budget.today_realized_pnl_usdt, "0");
    assert.equal(result.budget.today_realized_pnl_pct, 0);
    near(result.budget.total_exposure_pct, 1002.5);
  });
});

test("positive equity below 100 publishes against an existing low or high baseline", () => {
  for (const initial of ["50", "1000"]) {
    withCalculator((calculator) => {
      published(calculator.observe(flat(initial)));
      const input = holding(T + 1000);
      account(input).equity_usdt = "25";
      account(input).available_usdt = "-5";
      const result = published(calculator.observe(input));
      assert.equal(result.baseline.dayEquityUsdt, initial);
      assert.equal(result.baseline.highWaterEquityUsdt, initial);
      assert.equal(result.budget.equity_usdt, "25");
      assert.equal(result.budget.available_usdt, "-5");
      assert.equal(result.budget.today_realized_pnl_usdt, initial === "50" ? "-25" : "-975");
      near(result.budget.today_realized_pnl_pct, (25 - Number(initial)) / Number(initial));
      near(result.budget.drawdown_pct, (Number(initial) - 25) / Number(initial));
      near(result.budget.total_exposure_pct, 0.401);
      assert.deepEqual(result.events, []);
    });
  }
});

test("negative equity with a positive high water preserves its signed exposure ratio for kernel admission", () => {
  withCalculator((calculator) => {
    published(calculator.observe(flat("1000")));
    const input = holding(T + 1000);
    account(input).equity_usdt = "-25";
    account(input).available_usdt = "-30";
    const result = published(calculator.observe(input));
    assert.equal(result.budget.equity_usdt, "-25");
    assert.equal(result.budget.available_usdt, "-30");
    assert.equal(result.baseline.highWaterEquityUsdt, "1000");
    assert.equal(result.budget.today_realized_pnl_usdt, "-1025");
    near(result.budget.today_realized_pnl_pct, -1.025);
    near(result.budget.drawdown_pct, 1.025);
    near(result.budget.total_exposure_pct, -0.401);
  });
});

test("a zero denominator leaves the budget unpublished for the specific mathematical reason", () => {
  withCalculator((calculator) => {
    const first = blocked(calculator.observe(flat("0")), "INVALID_RATIO");
    assert.equal(first.message, "ratio denominator is zero");
    assert.equal(first.baseline?.dayEquityUsdt, "0");
    assert.equal(first.events[0]?.message, "预算基准已重置");
  });
  withCalculator((calculator) => {
    published(calculator.observe(flat("1000")));
    const input = holding(T + 1000);
    account(input).equity_usdt = "0";
    const result = blocked(calculator.observe(input), "INVALID_RATIO");
    assert.equal(result.message, "ratio denominator is zero");
    assert.equal(result.baseline?.highWaterEquityUsdt, "1000");
  });
});

test("UTC day change uses its first actual observation while retaining the cross-day high water", () => {
  withCalculator((calculator, db) => {
    const beforeMidnight = Date.parse("2026-11-02T23:59:40Z");
    published(calculator.observe(flat("1000", beforeMidnight)));
    published(calculator.observe(flat("1400", beforeMidnight + 1000)));
    const nextDay = Date.parse("2026-11-03T00:00:05Z");
    const result = published(calculator.observe(flat("1200", nextDay, nextDay - 10_000)));
    assert.equal(result.baseline.utcDay, "2026-11-03");
    assert.equal(result.baseline.dayEquityUsdt, "1200");
    assert.equal(result.baseline.highWaterEquityUsdt, "1400");
    assert.equal(result.baseline.firstObservedAtMs, nextDay);
    assert.equal(result.baseline.firstSourceAsOfMs, nextDay - 10_000);
    assert.equal(result.budget.today_realized_pnl_usdt, "0");
    near(result.metrics.drawdownPct, 200 / 1400);
    assert.equal(result.events[0]?.kind, "budget_day_started");
    const later = published(calculator.observe(flat("1190", nextDay + 1000)));
    assert.equal(later.metrics.todayPnlUsdt, "-10");
    near(later.metrics.todayPnlPct, -10 / 1200);
    near(later.metrics.drawdownPct, 0.15);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM caller_risk_budget_days").get()?.n, 2);
  });
});

test("exposure uses current marks, absolute negative quantities, and the oldest source timestamp", () => {
  withCalculator((calculator) => {
    const input = holding();
    account(input).positions[0].mark_truth = { credential_id: "9001", symbol_key: BTC, source_timestamp_ms: String(T - 9000) };
    account(input).positions.push({ symbol_key: ETH, side: "short", qty: "-2", entry_price: "99999", mark_price: "50" });
    account(input).open_positions_count = "2";
    states(input).positions.push({ credential_id: "9001", symbol_key: ETH, direction: "short", state: "open",
      qty: "-2", entry_price: "22222", last_reconciled_ms: String(T - 2000) });
    const result = published(calculator.observe(input));
    assert.equal(result.metrics.totalExposureUsdt, "110.025");
    near(result.metrics.totalExposurePct, 0.110025);
    assert.equal(result.budget.open_positions_count, "2");
    assert.equal(result.budget.as_of_ms, String(T - 9000));
  });
});

test("decimal money arithmetic keeps cents above the JavaScript safe integer range", () => {
  withCalculator((calculator) => {
    published(calculator.observe(flat("9007199254740993.10")));
    const result = published(calculator.observe(flat("9007199254740993.11", T + 1000)));
    assert.equal(result.metrics.todayPnlUsdt, "0.01");
    assert.equal(result.budget.equity_usdt, "9007199254740993.11");
    assert.ok(result.metrics.todayPnlPct > 0 && Number.isFinite(result.metrics.todayPnlPct));
  });
});

test("missing mark blocks publication without substituting entry_price or losing the first equity baseline", () => {
  withCalculator((calculator) => {
    const input = holding();
    delete account(input).positions[0].mark_price;
    const missing = blocked(calculator.observe(input), "MISSING_MARK");
    assert.equal(missing.events[0]?.message, "预算基准已重置");
    assert.equal(missing.baseline?.dayEquityUsdt, "1000");
    const later = holding(T + 1000);
    account(later).equity_usdt = "1010";
    const result = published(calculator.observe(later));
    assert.equal(result.metrics.todayPnlUsdt, "10");
    assert.deepEqual(result.events, []);
  });
});

test("unavailable, stale, future, missing and invalid facts never become a publishable zero budget", () => {
  const cases: [string, (input: RiskBudgetObservation) => void, string][] = [
    ["unavailable", (x) => { account(x).available = false; }, "ACCOUNT_UNAVAILABLE"],
    ["stale account", (x) => { account(x).as_of_ms = String(T - 30_001); }, "STALE_SOURCE"],
    ["future account", (x) => { account(x).as_of_ms = String(T + 1); }, "FUTURE_SOURCE"],
    ["stale holding", (x) => { states(x).positions[0].last_reconciled_ms = String(T - 30_001); }, "STALE_SOURCE"],
    ["unknown holding time", (x) => { states(x).positions[0].last_reconciled_ms = "0"; }, "INVALID_TIME"],
    ["stale mark", (x) => { account(x).positions[0].mark_truth = { source_timestamp_ms: String(T - 30_001) }; }, "STALE_SOURCE"],
    ["missing available", (x) => { delete account(x).available_usdt; }, "INVALID_DECIMAL"],
    ["nonfinite equity", (x) => { account(x).equity_usdt = "NaN"; }, "INVALID_DECIMAL"],
    ["number equity", (x) => { account(x).equity_usdt = 1000; }, "INVALID_DECIMAL"],
    ["zero mark", (x) => { account(x).positions[0].mark_price = "0"; }, "INVALID_MARK"],
    ["invalid quantity", (x) => { states(x).positions[0].qty = "NaN"; }, "INVALID_DECIMAL"],
    ["missing states", (x) => { delete states(x).positions; }, "MISSING_POSITIONS"],
    ["missing account positions", (x) => { delete account(x).positions; }, "MISSING_POSITIONS"],
    ["orphan", (x) => { states(x).orphan_positions = [{ qty: "1" }]; }, "ORPHAN_POSITION"],
    ["wrong credential", (x) => { states(x).positions[0].credential_id = "9002"; }, "POSITION_SCOPE_MISMATCH"],
    ["different quantities", (x) => { account(x).positions[0].qty = "2"; }, "POSITION_MISMATCH"],
    ["ambiguous marks", (x) => { account(x).positions.push({ ...account(x).positions[0] }); }, "AMBIGUOUS_MARK"],
  ];
  for (const [label, mutate, reason] of cases) {
    withCalculator((calculator) => {
      const input = holding();
      mutate(input);
      assert.doesNotThrow(() => blocked(calculator.observe(input), reason), label);
    });
  }
});

test("30-second boundary remains valid, and no source timestamp is refreshed to receipt time", () => {
  withCalculator((calculator) => {
    const input = holding();
    account(input).as_of_ms = String(T - 30_000);
    const result = published(calculator.observe(input));
    assert.equal(result.budget.as_of_ms, String(T - 30_000));
  });
});

test("a large balance change is not guessed to be an account reset", () => {
  withCalculator((calculator) => {
    published(calculator.observe(flat("1000")));
    published(calculator.observe(flat("1300", T + 1000)));
    const result = published(calculator.observe(flat("200", T + 2000)));
    assert.equal(result.baseline.dayEquityUsdt, "1000");
    assert.equal(result.baseline.highWaterEquityUsdt, "1300");
    assert.equal(result.metrics.todayPnlUsdt, "-800");
    near(result.metrics.drawdownPct, 1100 / 1300);
    assert.deepEqual(result.events, []);
  });
});

test("explicit reset persists until a post-request valid observation and resets both baselines once", () => {
  withCalculator((calculator, db) => {
    published(calculator.observe(flat("1000")));
    published(calculator.observe(flat("1300", T + 1000)));
    calculator.requestReset("9001", T + 2000);
    const restarted = new RiskBudgetCalculator(db);
    blocked(restarted.observe(flat("1300", T + 2100, T + 1000)), "RESET_WAITING_FOR_OBSERVATION");
    const reset = published(restarted.observe(flat("200", T + 3000)));
    assert.equal(reset.baseline.epoch, 2);
    assert.equal(reset.baseline.dayEquityUsdt, "200");
    assert.equal(reset.baseline.highWaterEquityUsdt, "200");
    assert.equal(reset.metrics.todayPnlUsdt, "0");
    assert.equal(reset.metrics.drawdownPct, 0);
    assert.equal(reset.events[0]?.message, "预算基准已重置");
    assert.equal(reset.events[0]?.details.reason, "explicit_reset");
    const after = published(restarted.observe(flat("190", T + 4000)));
    assert.deepEqual(after.events, []);
    assert.equal(after.metrics.todayPnlUsdt, "-10");
    near(after.metrics.drawdownPct, 0.05);
  });
});

test("the one-shot reset flag is explicit and an invalid first account does not synthesize a baseline", () => {
  withCalculator((calculator, db) => {
    const missing = flat();
    account(missing).available = false;
    blocked(calculator.observe(missing), "ACCOUNT_UNAVAILABLE");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM caller_risk_budget_days").get()?.n, 0);
    published(calculator.observe(flat("1000")));
    const reset = flat("300", T + 1000);
    reset.reset = true;
    const result = published(calculator.observe(reset));
    assert.equal(result.events[0]?.details.reason, "explicit_reset");
    assert.equal(result.baseline.highWaterEquityUsdt, "300");
  });
});

test("out-of-order account sources cannot rewrite the observed baseline or high water", () => {
  withCalculator((calculator) => {
    published(calculator.observe(flat("1000")));
    published(calculator.observe(flat("1200", T + 2000)));
    blocked(calculator.observe(flat("5000", T + 3000, T + 1000)), "OUT_OF_ORDER_SOURCE");
    const after = published(calculator.observe(flat("1100", T + 4000)));
    assert.equal(after.baseline.highWaterEquityUsdt, "1200");
  });
});

test("every applied=false publication can be recorded rather than reported as a successful update", () => {
  withCalculator((calculator) => {
    const response = { accepted: true, applied: false, current_as_of_ms: String(T), message: "stale or duplicate" };
    for (let index = 0; index < 2; index++) {
      const events = calculator.recordPublishResponse("9001", response);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.kind, "budget_not_applied");
      assert.equal(events[0]?.details.applied, false);
      assert.equal(events[0]?.details.current_as_of_ms, String(T));
    }
    assert.deepEqual(calculator.recordPublishResponse("9001", { accepted: true, applied: true }), []);
    assert.equal(calculator.recordPublishResponse("9001", { accepted: false, applied: false })[0]?.kind, "budget_rejected");
  });
});
