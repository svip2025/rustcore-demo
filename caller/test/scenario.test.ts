import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before, mock } from "node:test";
import type { Recording, ScenarioStep, SseEvent } from "../../shared/schema.js";
import type { DemoConfig } from "../src/config.js";
import { BTC, row, rows, safeReason, type Row } from "../src/facts.js";
import type { runPreflight } from "../src/preflight.js";
import { projectSnapshot, type AccountSettings, type CoreSnapshot } from "../src/projection.js";
import { BOT } from "../src/runtime.js";
import { ScenarioRunner } from "../src/scenario.js";
import { DemoStore } from "../src/store.js";

type Runtime = ConstructorParameters<typeof ScenarioRunner>[0];
type Options = NonNullable<ConstructorParameters<typeof ScenarioRunner>[1]>;
type Behavior = "not_started" | "missing_tp" | "success";
const MOCK_SOURCE = { kind: "MOCK" as const, label: "自动化测试中的虚构依赖；非交易所运行证据" };
const MOCK_BUILD = { caller_commit: "mock-caller-v1", rustcore_commit: "mock-rustcore-v1" };
const NINE_STEPS: ScenarioStep[] = ["preflight", "cleanup_before", "open_position", "verify_protection", "hold",
  "restart_kernel", "verify_recovery", "close_position", "cleanup_after"];

before(() => {
  mock.method(globalThis, "fetch", async () => { throw new Error("External network is forbidden in scenario tests"); });
});
after(() => mock.restoreAll());

function section(list: Row[], venue = false, start?: number, end?: number): Row {
  return { rows: list, meta: { coverage: venue ? "AOC_COMPLETE_VENUE" : "AOC_COMPLETE_LOCAL",
    overflow: false, returned_count: list.length, total_count: list.length },
    ...(start === undefined ? {} : { started_at_ms: String(start), completed_at_ms: String(end) }) };
}

class MockRuntime implements Runtime {
  readonly config: DemoConfig;
  readonly store: DemoStore;
  snapshot: CoreSnapshot | null = null;
  settings: AccountSettings = { positionMode: "UNKNOWN", marginMode: "UNKNOWN", leverage: null };
  lastReconcile: Row = {};
  budgetNotes: string[] = ["预算基准已重置（MOCK）"];
  isStarted = false;
  behavior: Behavior;
  restartChangesBoot = true;
  closeAcknowledgmentLost = false;
  held = false;
  boot = "mock-boot-before-restart";
  bootStartedAt = Date.now() - 1000;
  restartCount = 0;
  filterFetchCount = 0;
  startupEntry = false;
  startupEntryOwner = BOT;
  startupCancelAccepted = true;
  startupCancelled = false;
  startupPendingReadbacks = 0;
  startupReadbacks: { at: number; status: string }[] = [];
  fillLookups: { key: string; side: "BUY" | "SELL" }[] = [];
  requests: { service: "v2" | "next"; method: string; request: Row }[] = [];
  private openKey = "";
  private closeKey = "mock-close-fill";
  private closeRef = "";
  private sequence = 0;
  private readonly positionId = "mock-private-position";

  constructor(readonly directory: string, behavior: Behavior) {
    this.behavior = behavior;
    this.config = {
      envFile: join(directory, "unused-private-env"), credentialId: "9001", grpcAddress: "127.0.0.1:1",
      kernelBinary: join(directory, "not-a-kernel"), kernelDbFile: join(directory, "unused-kernel.sqlite"),
      callerDbFile: join(directory, "caller.sqlite"), lockFile: join(directory, "scenario.lock"),
      holdMs: 1, phaseTimeoutMs: 10, source: MOCK_SOURCE, build: MOCK_BUILD, environment: {}, connectOnly: false,
    };
    this.store = new DemoStore(this.config.callerDbFile, { source: MOCK_SOURCE, build: MOCK_BUILD });
  }

  readonly rpc: Runtime["rpc"] = {
    unary: async (service, method, request) => {
      this.requests.push({ service, method, request: structuredClone(request) });
      if (method === "ExecuteIntents") {
        assert.equal(service, "v2");
        assert.equal(request.run_mode, "demo");
        assert.equal(rows(request.intents).length, 1);
        const intent = rows(request.intents)[0]!;
        this.openKey = "mock-authority-" + String(intent.idempotency_key);
        if (this.behavior === "not_started") {
          return { acks: [{ status: "STATUS_REJECTED", message: "FILL_RECOVERY_IN_PROGRESS phase=not_started" }] };
        }
        this.held = true;
        return { acks: [{ status: "STATUS_ACCEPTED", engine_order_id: "mock-entry-order" }] };
      }
      if (method === "GetOrder") {
        if (request.engine_order_id === "mock-startup-entry") {
          const stillPending = this.startupPendingReadbacks-- > 0;
          const status = this.startupCancelled && !stillPending ? "canceled" : "acked";
          this.startupReadbacks.push({ at: Date.now(), status });
          return { found: true, order: { status } };
        }
        return { found: true, order: { status: "filled", idempotency_key: request.engine_order_id === "mock-entry-order" ? this.openKey : this.closeKey } };
      }
      if (method === "CancelOrder") {
        assert.equal(request.engine_order_id, "mock-startup-entry");
        if (this.startupCancelAccepted) this.startupCancelled = true;
        return { accepted: this.startupCancelAccepted };
      }
      if (method === "GetOrderByClientOrderId") {
        return { completed: true, found: this.behavior !== "not_started", order: { status: "filled", engine_order_id: "mock-entry-order" } };
      }
      if (method === "GetPositionCloseTarget") {
        assert.equal(this.held, true);
        return { available: true, engine_boot_id: this.boot,
          target: { revision: this.restartCount ? "9007199254740995" : "9007199254740993" } };
      }
      if (method === "ClosePosition") {
        assert.equal(request.expected_boot_id, this.boot, "close must use a freshly read target from the current boot");
        this.closeRef = String(request.request_ref);
        this.held = false;
        if (this.closeAcknowledgmentLost) throw new Error("Mock close response was lost after applying the close");
        return { request_status: "accepted" };
      }
      if (method === "GetPositionCloseReceipt") {
        assert.equal(request.request_ref, this.closeRef, "the original close request_ref must be reused");
        return { request_status: "filled", target_quantity: "0.001", filled_quantity: "0.001",
          engine_order_id: "mock-exit-order", position_observation: { status: "observed", state: "closed", quantity: "0" },
          protection_observation: { status: "cleaned" } };
      }
      throw new Error("Unexpected mocked RPC: " + method);
    },
    streamEvents: () => { throw new Error("Scenario unit tests must not create a real stream"); },
    close: () => undefined,
  };

  async start(): Promise<void> { this.isStarted = true; await this.refresh(true); }

  async refresh(_forceReconcile = false): Promise<void> {
    const now = Date.now(), start = now - 4, end = now - 1;
    const position: Row = { position_id: this.positionId, credential_id: this.config.credentialId,
      bot_uid: BOT, symbol_key: BTC, direction: "long", state: "protected", qty: "0.001",
      entry_price: "100000", last_reconciled_ms: String(end) };
    const localPosition: Row = { ...position, raw_state: "protected", quantity: "0.001" };
    const plan: Row = { position_id: this.positionId, credential_id: this.config.credentialId,
      bot_uid: BOT, symbol_key: BTC, direction: "long", generation: "1",
      stop_loss_price: "99000", take_profit_price: "102500", association_status: "matched" };
    const localOrders = (["sl", "tp"] as const).map((kind): Row => ({
      protection_order_id: "mock-private-" + kind, credential_id: this.config.credentialId, position_id: this.positionId,
      kind, generation: "1", exchange_algo_id: "mock-algo-" + kind, client_algo_id: "mock-client-" + kind,
      association_status: "matched", current_plan_generation_match: true, verified_projection: true,
      trigger_price: kind === "sl" ? "99000" : "102500", raw_status: "confirmed",
    }));
    const venueOrders = (this.behavior === "missing_tp" ? ["sl"] : ["sl", "tp"]).map((kind): Row => ({
      algo_id: "mock-algo-" + kind, client_algo_id: "mock-client-" + kind, identity_valid: true, symbol: "BTCUSDT",
      order_type: kind === "sl" ? "STOP_MARKET" : "TAKE_PROFIT_MARKET", side: "SELL", position_side: "BOTH",
      trigger_price: kind === "sl" ? "99000" : "102500", close_position: true, status: "NEW",
    }));
    const startup: Row = { engine_order_id: "mock-startup-entry", credential_id: this.config.credentialId,
      bot_uid: this.startupEntryOwner, symbol_key: BTC, order_role: "entry", action: "open_long",
      order_type: "limit", reduce_only: false, raw_status: this.startupCancelled ? "canceled" : "acked" };
    const ordinaryLocal: Row[] = this.startupEntry ? [startup] : [];
    const protectiveLocal: Row[] = this.held ? ["sl", "tp"].map(kind => ({ engine_order_id: "mock-engine-" + kind,
      credential_id: this.config.credentialId, bot_uid: BOT, symbol_key: BTC, order_role: "protection_" + kind,
      raw_status: "confirmed", action: "close_long", order_type: kind === "sl" ? "stop_market" : "take_profit_market", reduce_only: true })) : [];
    const openLocal = [...ordinaryLocal, ...protectiveLocal].filter(order => order.raw_status !== "canceled");
    const ordinaryVenue: Row[] = this.startupEntry && !this.startupCancelled ? [{ order_id: "mock-startup-venue-order",
      identity_valid: true, symbol: "BTCUSDT", order_type: "LIMIT", side: "BUY", quantity: "0.001", price: "99999", status: "NEW" }] : [];
    const observationId = "mock-observation-" + (++this.sequence);
    this.snapshot = {
      receivedAt: now, bootStartedAt: this.bootStartedAt,
      account: { available: true, observed_at_ms: String(now), as_of_ms: String(end), equity_usdt: "10000",
        available_usdt: this.held ? "9900" : "10000", positions: this.held ? [{
          symbol_key: BTC, side: "long", qty: "0.001", entry_price: "100000", mark_price: "100000",
        }] : [] },
      positions: { positions: this.held ? [position] : [], orphan_positions: [] },
      orders: { orders: openLocal.map(order => ({ ...order, status: order.raw_status })) },
      kills: { snapshot_stale: false, rows: [{ found: false }, { found: false }, { found: false }] },
      accountOrders: {
        credential_id: this.config.credentialId, engine_boot_id: this.boot, account_kind: "exchange", observed_at_ms: String(now),
        local: { orders: section([...ordinaryLocal, ...protectiveLocal]), positions: section(this.held ? [localPosition] : []), protection_plans: section(this.held ? [plan] : []),
          protection_orders: section(this.held ? localOrders : []) },
        venue: {
          availability: "AOA_AVAILABLE", credential_id: this.config.credentialId, engine_boot_id: this.boot, observation_id: observationId,
          capture_started_at_ms: String(start), capture_completed_at_ms: String(end), source_as_of_ms: String(start),
          latest_attempt: { status: "succeeded", coverage: "full_account", observation_id: observationId,
            started_at_ms: String(start), completed_at_ms: String(end) },
          ordinary: section(ordinaryVenue, true, start, start + 1),
          algo: section(this.held ? venueOrders : [], true, start + 1, end),
        },
      },
    };
    this.lastReconcile = { accepted: true, completed: true, has_diff: false, local_position_zero_diff: true,
      all_positions_zero: !this.held, all_open_orders_empty: !this.startupEntry || this.startupCancelled, all_open_algo_orders_empty: !this.held };
    const state = projectSnapshot(this.store.getState(), this.snapshot, this.config.credentialId, this.settings);
    state.risk_budget = { ...state.risk_budget, status: "FRESH", source_as_of: new Date(end).toISOString(),
      published_at: new Date(now).toISOString(), age_ms: now - end, last_publish_applied: true,
      utc_day: state.generated_at.slice(0, 10), day_start_equity_usdt: "10000", equity_high_water_usdt: "10000",
      approximate_today_pnl_usdt: "0", approximate_today_pnl_pct: 0, drawdown_pct: 0,
      total_exposure_pct: this.held ? 0.01 : 0, reason: "MOCK budget; not a real account observation" };
    this.store.setState(state);
  }

  market(): { price: string; sourceAt: number } { return { price: "100000", sourceAt: Date.now() }; }
  fills(key: string, side: "BUY" | "SELL") {
    this.fillLookups.push({ key, side });
    if (side === "BUY" && key !== this.openKey) return null;
    if (side === "SELL" && key !== this.closeKey) return null;
    return { side, quantity: "0.001", average_price: side === "BUY" ? "100000" : "100100",
      notional_usdt: side === "BUY" ? "100" : "100.1" };
  }
  async restartKernel(): Promise<void> {
    this.restartCount++;
    for (const status of ["RESTARTING", "OFFLINE"] as const) {
      const state = this.store.getState();
      state.generated_at = new Date().toISOString();
      state.rustcore = { status, checked_at: state.generated_at, last_restart_at: state.generated_at,
        reason: "MOCK lifecycle only; no real process was signaled" };
      this.store.setState(state);
    }
    if (this.restartChangesBoot) this.boot = "mock-boot-after-restart";
    this.bootStartedAt = Date.now() - 10;
    await this.refresh(true);
  }
  publicReason(error: unknown): string { return safeReason(error instanceof Error ? error.message : error, [this.config.credentialId]); }
  options(overrides: Options = {}): Options {
    const preflight: typeof runPreflight = async () => ({
      ok: true, result: "PASS", reason: "MOCK preflight, no signed request", code: "MOCK_PREFLIGHT_PASS",
      positionMode: "ONE_WAY", marginMode: "CROSS", leverage: 1, balanceUsdt: "10000", observedAt: new Date().toISOString(),
    });
    const fetchFilters: typeof fetch = async (input) => {
      assert.equal(String(input), "https://demo-fapi.binance.com/fapi/v1/exchangeInfo");
      this.filterFetchCount++;
      return new Response(JSON.stringify({ symbols: [{ symbol: "BTCUSDT", filters: [{ filterType: "PRICE_FILTER", tickSize: "0.10" }] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } });
    };
    return { preflight, fetch: fetchFilters, pause: async <T>(_delay?: number, value?: T) => value as T,
      recordDir: join(this.directory, "recordings"), ...overrides };
  }
  calls(method: string) { return this.requests.filter((request) => request.method === method); }
}

async function fixture(behavior: Behavior, run: (runtime: MockRuntime) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-scenario-mock-"));
  const runtime = new MockRuntime(directory, behavior);
  try { await run(runtime); }
  finally { runtime.store.close(); rmSync(directory, { recursive: true, force: true }); }
}
function loadRecording(runtime: MockRuntime, roundId: string): Recording {
  const file = join(runtime.directory, "recordings", roundId + ".json");
  assert.equal(existsSync(file), true);
  const recording = JSON.parse(readFileSync(file, "utf8")) as Recording;
  assert.equal(recording.source.kind, "MOCK");
  assert.deepEqual(recording.build, MOCK_BUILD);
  assert.equal(recording.initial_state.source.kind, "MOCK");
  assert.ok(recording.events.every((event) => event.source.kind === "MOCK"));
  for (const event of recording.events) if (event.type === "state") assert.deepEqual(event.data.build, MOCK_BUILD);
  assert.equal(JSON.stringify(recording).includes('"credential_id"'), false);
  return recording;
}

test("a not_started opening is sent once, stays FAILED, and a new MANUAL round cannot overwrite it", async () => {
  await fixture("not_started", async (runtime) => {
    const runner = new ScenarioRunner(runtime, runtime.options());
    const first = await runner.run("SCHEDULED");
    assert.equal(first.status, "FAILED");
    assert.match(first.reason, /not_started/);
    assert.equal(runtime.calls("ExecuteIntents").length, 1);
    assert.equal(runtime.calls("ClosePosition").length, 0);
    const old = runtime.store.getTimeline().rounds.find((round) => round.round_id === first.round_id)!;
    assert.deepEqual(old.steps.map((step) => [step.step, step.result]), [
      ["preflight", "PASS"], ["cleanup_before", "PASS"], ["open_position", "FAIL"], ["cleanup_after", "PASS"],
    ]);
    const firstRecording = loadRecording(runtime, first.round_id);
    runtime.behavior = "success";
    const second = await runner.run("MANUAL");
    assert.equal(second.status, "SUCCEEDED");
    assert.equal(second.trigger, "MANUAL");
    assert.notEqual(second.round_id, first.round_id);
    assert.equal(runtime.calls("ExecuteIntents").length, 2, "exactly one opening per separately requested round");
    assert.deepEqual(runtime.store.getTimeline().rounds.find((round) => round.round_id === first.round_id), old);
    assert.deepEqual(loadRecording(runtime, first.round_id), firstRecording);
    assert.equal(readdirSync(join(runtime.directory, "recordings")).length, 2);
  });
});

test("SL PASS plus missing TP remains FAILED after successful safety close and cleanup", async () => {
  await fixture("missing_tp", async (runtime) => {
    const result = await new ScenarioRunner(runtime, runtime.options()).run("MANUAL");
    assert.equal(result.status, "FAILED");
    assert.match(result.reason, /DOUBLE_PROTECTION_NOT_PROVEN/);
    assert.equal(runtime.calls("ExecuteIntents").length, 1);
    assert.equal(runtime.calls("ClosePosition").length, 1);
    assert.equal(runtime.restartCount, 0);
    const round = runtime.store.getTimeline().rounds[0]!;
    assert.deepEqual(round.steps.map((step) => step.step), [
      "preflight", "cleanup_before", "open_position", "verify_protection", "close_position", "cleanup_after",
    ]);
    const failed = round.steps[3]!;
    assert.equal(failed.result, "FAIL");
    assert.equal(failed.actual.protection?.sl.status, "PASS");
    assert.equal(failed.actual.protection?.tp.status, "FAIL");
    assert.ok(failed.actual.protection?.observation_id);
    assert.equal(failed.actual.protection?.sl.source_as_of, failed.actual.protection?.tp.source_as_of);
    assert.deepEqual(round.steps.slice(4).map((step) => step.result), ["PASS", "PASS"]);
    assert.equal(round.status, "FAILED");
    const recording = loadRecording(runtime, result.round_id);
    assert.equal(recording.events.filter((event) => event.type === "step"
      && event.data.step_id === failed.step_id && event.data.phase === "COMPLETED").length, 1);
  });
});

test("all nine steps succeed with real wire ack enum, changed boot, fresh close target, and exact live recording events", async () => {
  await fixture("success", async (runtime) => {
    const live: SseEvent[] = [];
    runtime.store.subscribe((event) => live.push(event));
    const result = await new ScenarioRunner(runtime, runtime.options()).run("SCHEDULED");
    assert.equal(result.status, "SUCCEEDED");
    const round = runtime.store.getTimeline().rounds[0]!;
    assert.deepEqual(round.steps.map((step) => step.step), NINE_STEPS);
    assert.ok(round.steps.every((step) => step.phase === "COMPLETED" && step.result === "PASS"));
    assert.deepEqual(round.steps.map((step) => step.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.equal(runtime.calls("ExecuteIntents").length, 1);
    const submittedKey = rows(runtime.calls("ExecuteIntents")[0]!.request.intents)[0]!.idempotency_key;
    const authorityKey = runtime.fillLookups.find(lookup => lookup.side === "BUY")!.key;
    assert.notEqual(authorityKey, submittedKey, "the kernel authority key is not the caller's submitted key");
    assert.equal(authorityKey, "mock-authority-" + String(submittedKey));
    assert.equal(runtime.filterFetchCount, 1);
    assert.equal(runtime.restartCount, 1);
    const close = runtime.calls("ClosePosition")[0]!.request;
    assert.equal(close.expected_boot_id, "mock-boot-after-restart");
    assert.equal(close.expected_revision, "9007199254740995");
    assert.ok(runtime.calls("GetPositionCloseTarget").length >= 1);
    assert.equal(runtime.calls("GetPositionCloseReceipt")[0]!.request.request_ref, close.request_ref);
    assert.equal(round.steps[2]!.actual.fill?.quantity, "0.001");
    assert.equal(round.steps[2]!.actual.fill?.notional_usdt, "100");
    assert.equal(round.steps[7]!.actual.fill?.notional_usdt, "100.1");
    assert.equal(runtime.store.getState().positions.value?.length, 0);
    assert.equal(runtime.store.getState().open_orders.value?.length, 0);
    const recording = loadRecording(runtime, result.round_id);
    assert.deepEqual(recording.events, live);
    const states = recording.events.filter((event) => event.type === "state").map((event) => event.data.rustcore.status);
    assert.ok(states.includes("RESTARTING") && states.includes("OFFLINE"));
    assert.equal(states.at(-1), "ONLINE");
    assert.equal(recording.events[0]?.type, "round");
    assert.equal(existsSync(runtime.config.lockFile), true);
  });
});

test("a lost close acknowledgment is read back with one original request_ref, never resubmitted", async () => {
  await fixture("success", async (runtime) => {
    runtime.closeAcknowledgmentLost = true;
    const result = await new ScenarioRunner(runtime, runtime.options()).run("MANUAL");
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(runtime.calls("ClosePosition").length, 1);
    const ref = runtime.calls("ClosePosition")[0]!.request.request_ref;
    assert.ok(runtime.calls("GetPositionCloseReceipt").every((call) => call.request.request_ref === ref));
    loadRecording(runtime, result.round_id);
  });
});

test("an unchanged boot cannot pass restart verification or manufacture a successful round", async () => {
  await fixture("success", async (runtime) => {
    runtime.restartChangesBoot = false;
    const result = await new ScenarioRunner(runtime, runtime.options()).run("MANUAL");
    assert.equal(result.status, "FAILED");
    assert.match(result.reason, /NEW_BOOT_NOT_PROVEN/);
    const steps = runtime.store.getTimeline().rounds[0]!.steps;
    assert.equal(steps.find((step) => step.step === "restart_kernel")?.result, "UNKNOWN");
    assert.equal(steps.some((step) => step.step === "verify_recovery"), false);
    assert.equal(runtime.calls("ExecuteIntents").length, 1);
    assert.equal(runtime.calls("ClosePosition").length, 1);
    loadRecording(runtime, result.round_id);
  });
});

test("the native scenario lock rejects a concurrent round before any second submission", async () => {
  await fixture("success", async (runtime) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const ordinary = runtime.options();
    const preflight: typeof runPreflight = async (config, options) => {
      entered(); await gate;
      return ordinary.preflight!(config, options);
    };
    const first = new ScenarioRunner(runtime, runtime.options({ preflight })).run("SCHEDULED");
    await ready;
    try {
      await assert.rejects(new ScenarioRunner(runtime, runtime.options()).run("MANUAL"),
        (error: unknown) => row(error).code === "SCENARIO_ALREADY_RUNNING");
      assert.equal(runtime.calls("ExecuteIntents").length, 0);
      assert.equal(runtime.store.getTimeline().rounds.length, 1);
    } finally { release(); }
    assert.equal((await first).status, "SUCCEEDED");
    assert.equal(runtime.calls("ExecuteIntents").length, 1);
  });
});


test("startup known ENTRY is canceled once and read terminal before closing; linked protective children are left to the core", async () => {
  await fixture("success", async (runtime) => {
    runtime.startupEntry = true;
    // This case intentionally needs two observations; allow parallel worker/SQLite scheduling jitter.
    runtime.config.phaseTimeoutMs = 1000;
    runtime.startupPendingReadbacks = 1;
    runtime.held = true;
    const result = await new ScenarioRunner(runtime, runtime.options()).run("MANUAL");
    assert.equal(result.status, "SUCCEEDED", JSON.stringify({ reason: result.reason,
      steps: runtime.store.getTimeline().rounds[0]?.steps.map(step => ({ step: step.step, result: step.result, reason: step.reason })),
      phase_timeout_ms: runtime.config.phaseTimeoutMs, startup_readbacks: runtime.startupReadbacks }));
    assert.equal(runtime.calls("CancelOrder").length, 1);
    assert.equal(runtime.calls("CancelOrder")[0]!.request.engine_order_id, "mock-startup-entry");
    const cancel = runtime.requests.findIndex(call => call.method === "CancelOrder");
    const readback = runtime.requests.findIndex(call => call.method === "GetOrder" && call.request.engine_order_id === "mock-startup-entry");
    const target = runtime.requests.findIndex(call => call.method === "GetPositionCloseTarget");
    const open = runtime.requests.findIndex(call => call.method === "ExecuteIntents");
    assert.ok(cancel >= 0 && cancel < readback && readback < target && target < open);
    assert.equal(runtime.calls("GetOrder").filter(call => call.request.engine_order_id === "mock-startup-entry").length, 2,
      "accepted cancellation alone is insufficient; wait through the first non-terminal readback");
    assert.equal(runtime.calls("ClosePosition").length, 2, "one startup residual close and one requested-round close");
    assert.equal(runtime.store.getTimeline().rounds[0]!.steps[1]!.result, "PASS");
    loadRecording(runtime, result.round_id);
  });
});

test("foreign startup ENTRY is preserved and fails the round without cancellation or a new opening", async () => {
  await fixture("success", async (runtime) => {
    runtime.startupEntry = true;
    runtime.startupEntryOwner = "foreign-bot";
    const result = await new ScenarioRunner(runtime, runtime.options()).run("MANUAL");
    assert.equal(result.status, "FAILED");
    assert.match(result.reason, /UNOWNED_RESIDUAL_ORDER/);
    assert.equal(runtime.calls("CancelOrder").length, 0);
    assert.equal(runtime.calls("ClosePosition").length, 0);
    assert.equal(runtime.calls("ExecuteIntents").length, 0);
    assert.equal(runtime.startupCancelled, false);
    loadRecording(runtime, result.round_id);
  });
});

test("a refused startup cancellation is checked, never repeated, and cannot be mistaken for safe cleanup", async () => {
  await fixture("success", async (runtime) => {
    runtime.startupEntry = true;
    runtime.startupCancelAccepted = false;
    const result = await new ScenarioRunner(runtime, runtime.options()).run("MANUAL");
    assert.equal(result.status, "FAILED");
    assert.match(result.reason, /ENTRY_CANCEL_REJECTED/);
    assert.equal(runtime.calls("CancelOrder").length, 1);
    assert.equal(runtime.calls("GetPositionCloseTarget").length, 0);
    assert.equal(runtime.calls("ExecuteIntents").length, 0);
    assert.equal(runtime.store.getTimeline().rounds[0]!.steps[1]!.result, "FAIL");
    loadRecording(runtime, result.round_id);
  });
});
