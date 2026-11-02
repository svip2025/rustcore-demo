import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ScenarioStep, SseEvent, StepActual } from "../../shared/schema.js";
import { DemoStore, type StoreOptions } from "../src/store.js";

const OPTIONS: StoreOptions = {
  source: { kind: "MOCK", label: "手写假测试，非交易记录" },
  build: { caller_commit: "mock-caller-v1", rustcore_commit: "mock-rustcore-v1" },
};
const STEPS: ScenarioStep[] = ["preflight", "cleanup_before", "open_position", "verify_protection", "hold",
  "restart_kernel", "verify_recovery", "close_position", "cleanup_after"];
const actual = (summary = "Synthetic observation"): StepActual => ({
  summary, code: null, account: null, position: null, open_orders: null,
  protection: null, fill: null, rustcore: null, risk_budget: null,
});
const at = (time: number) => new Date(time).toISOString();

function fixture(run: (file: string, initial: DemoStore, time: number) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-store-"));
  const store = new DemoStore(join(directory, "caller.sqlite"), OPTIONS);
  try { run(join(directory, "caller.sqlite"), store, Date.now() + 1000); }
  finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
}
function complete(store: DemoStore, round: string, step: ScenarioStep, time: number, result: "PASS" | "FAIL" | "UNKNOWN" = "PASS") {
  const running = store.startStep(round, step, "Expected synthetic condition", actual(), at(time));
  return store.finishStep(round, running.step_id, result, "Synthetic result", actual(), at(time + 1));
}

test("initial public values are unknown, and caller objects cannot mutate stored values", () => {
  fixture((_file, store) => {
    const state = store.getState();
    for (const observation of [state.account, state.positions, state.open_orders, state.protection]) {
      assert.deepEqual(observation, { status: "UNKNOWN", observed_at: null, source_as_of: null,
        value: null, reason: "Not yet observed" });
    }
    assert.equal(state.kill_switch.level, "UNKNOWN");
    assert.equal(state.risk_budget.approximate_today_pnl_usdt, null);
    assert.equal(state.risk_budget.age_ms, null);
    assert.equal(state.active_round_id, null);
    assert.equal(state.latest_round, null);
    state.source.label = "Changed by consumer";
    assert.equal(store.getState().source.label, OPTIONS.source.label);
  });
});

test("state and old source/observation times survive reopening without being refreshed", () => {
  fixture((file, first, time) => {
    const state = first.getState();
    state.generated_at = at(time);
    state.account = { status: "STALE", observed_at: at(time - 700), source_as_of: at(time - 900),
      value: null, reason: "An older observation remains stale" };
    const seen: SseEvent[] = [];
    first.subscribe((event) => seen.push(event));
    const event = first.setState(state);
    assert.deepEqual(seen, [event]);
    state.account.reason = "Mutated after write";
    first.close();
    const reopened = new DemoStore(file, OPTIONS);
    try {
      assert.equal(reopened.getState().generated_at, at(time));
      assert.equal(reopened.getState().account.observed_at, at(time - 700));
      assert.equal(reopened.getState().account.source_as_of, at(time - 900));
      assert.equal(reopened.getState().account.reason, "An older observation remains stale");
    } finally { reopened.close(); }
  });
});

test("round precedes its steps, sequences are continuous, and completed steps cannot be replaced", () => {
  fixture((_file, store, time) => {
    const seen: SseEvent[] = [];
    store.subscribe((event) => seen.push(event));
    store.startRound("SCHEDULED", "round-order", at(time));
    const running = store.startStep("round-order", "preflight", "Ready", actual(), at(time + 1));
    assert.deepEqual(seen.map((event) => event.type), ["round", "state", "step"]);
    assert.equal(running.sequence, 1);
    assert.equal(running.phase, "RUNNING");
    assert.equal(running.ended_at, null);
    assert.equal(running.result, "UNKNOWN");
    assert.throws(() => store.startStep("round-order", "cleanup_before", "", actual(), at(time + 2)), /already running/);
    const done = store.finishStep("round-order", running.step_id, "PASS", "Ready", actual(), at(time + 3));
    assert.throws(() => store.finishStep("round-order", running.step_id, "FAIL", "Replacement", actual(), at(time + 4)), /immutable/);
    assert.deepEqual(store.getTimeline().rounds[0]?.steps, [done]);
    const next = store.startStep("round-order", "cleanup_before", "Flat", actual(), at(time + 4));
    assert.equal(next.sequence, 2);
    assert.throws(() => store.finishRound("round-order", "FAILED", "Interrupted", at(time + 5)), /running step/);
  });
});

test("recording preserves exact live events and initial snapshots across reopen, without later rounds", () => {
  fixture((file, store, time) => {
    const initial = store.getState();
    initial.generated_at = at(time);
    store.setState(initial);
    const seen: SseEvent[] = [];
    const unsubscribe = store.subscribe((event) => seen.push(event));
    store.startRound("SCHEDULED", "round-success", at(time + 1));
    for (const [index, step] of STEPS.entries()) complete(store, "round-success", step, time + 2 + index * 3);
    const final = store.finishRound("round-success", "SUCCEEDED", "All checks passed", at(time + 31));
    unsubscribe();
    const recording = store.exportRecording("round-success");
    assert.deepEqual(recording.events, seen);
    assert.deepEqual(recording.initial_state, { ...initial, generated_at: at(time + 1) });
    assert.deepEqual(recording.initial_timeline.rounds, []);
    assert.deepEqual(recording.build, OPTIONS.build);
    assert.deepEqual(recording.source, OPTIONS.source);
    assert.equal(recording.started_at, at(time + 1));
    assert.equal(recording.ended_at, final.ended_at);
    assert.equal(new Set(seen.map((event) => event.event_id)).size, seen.length);
    assert.ok(seen.every((event, index) => index === 0 || event.emitted_at >= seen[index - 1]!.emitted_at));
    assert.equal(store.getState().active_round_id, null);
    assert.deepEqual(store.getState().latest_round, final);
    store.startRound("MANUAL", "next-round", at(time + 32));
    store.finishRound("next-round", "FAILED", "Not started", at(time + 33));
    assert.deepEqual(store.exportRecording("round-success").events, seen);
    store.close();
    const reopened = new DemoStore(file, OPTIONS);
    try {
      assert.deepEqual(reopened.exportRecording("round-success").events, seen);
      assert.deepEqual(reopened.exportRecording("next-round").initial_timeline.rounds[0]?.steps.length, 9);
      assert.equal(reopened.getTimeline().rounds[0]?.round_id, "next-round");
    } finally { reopened.close(); }
  });
});

test("TP failure stays failed after safety cleanup and a new manual round preserves the failed history", () => {
  fixture((_file, store, time) => {
    store.startRound("SCHEDULED", "failed-round", at(time));
    complete(store, "failed-round", "preflight", time + 1);
    complete(store, "failed-round", "cleanup_before", time + 3);
    complete(store, "failed-round", "open_position", time + 5);
    const start = store.startStep("failed-round", "verify_protection", "Both legs", actual(), at(time + 7));
    const failure = actual("TP was absent in the same complete synthetic observation");
    failure.code = "MOCK_TP_MISSING";
    const failedStep = store.finishStep("failed-round", start.step_id, "FAIL", "TP missing", failure, at(time + 8));
    assert.throws(() => store.startStep("failed-round", "hold", "", actual(), at(time + 9)), /Only safety/);
    assert.throws(() => store.startStep("failed-round", "verify_protection", "", actual(), at(time + 9)), /retried/);
    complete(store, "failed-round", "close_position", time + 9);
    complete(store, "failed-round", "cleanup_after", time + 11);
    assert.throws(() => store.finishRound("failed-round", "SUCCEEDED", "Cleanup passed", at(time + 13)), /all nine/);
    store.finishRound("failed-round", "FAILED", "TP missing; cleanup cannot erase failure", at(time + 13));
    assert.throws(() => store.finishRound("failed-round", "SUCCEEDED", "Replacement", at(time + 14)), /immutable/);
    assert.throws(() => store.startRound("MANUAL", "failed-round", at(time + 14)), /UNIQUE/);
    store.startRound("MANUAL", "new-manual-round", at(time + 14));
    const rounds = store.getTimeline().rounds;
    assert.equal(rounds[0]?.trigger, "MANUAL");
    assert.equal(rounds[1]?.status, "FAILED");
    assert.deepEqual(rounds[1]?.steps[3], failedStep);
    assert.equal(store.exportRecording("failed-round").events.filter((event) =>
      event.type === "step" && event.data.step_id === start.step_id && event.data.phase === "COMPLETED").length, 1);
  });
});

test("a completed UNKNOWN and an empty not-started round cannot be called successful", () => {
  fixture((_file, store, time) => {
    store.startRound("MANUAL", "unknown-round", at(time));
    complete(store, "unknown-round", "preflight", time + 1, "UNKNOWN");
    assert.throws(() => store.finishRound("unknown-round", "SUCCEEDED", "", at(time + 3)), /all nine/);
    store.finishRound("unknown-round", "FAILED", "Could not establish prerequisite", at(time + 3));
    store.startRound("SCHEDULED", "not-started", at(time + 4));
    assert.throws(() => store.finishRound("not-started", "SUCCEEDED", "", at(time + 5)), /all nine/);
    store.finishRound("not-started", "FAILED", "not_started", at(time + 5));
    assert.equal(store.getTimeline().rounds[0]?.steps.length, 0);
    assert.equal(store.getTimeline().rounds[0]?.status, "FAILED");
  });
});

test("core deduplication and high-water cursor are exact beyond Number.MAX_SAFE_INTEGER and durable", () => {
  fixture((file, store, time) => {
    const hidden = { seq: "9007199254740993", event_id: "private-internal-event",
      credential_id: "private-account", confidential: "PRIVATE_PAYLOAD_SENTINEL" };
    store.startRound("MANUAL", "public-round", at(time));
    assert.equal(store.appendCoreEvent("9007199254740993", "private-internal-event", hidden), true);
    assert.equal(store.appendCoreEvent("9007199254740993", "private-internal-event", { replacement: true }), false);
    assert.equal(store.appendCoreEvent("9007199254740995", "later", { seq: "9007199254740995" }), true);
    assert.equal(store.appendCoreEvent("9007199254740994", "late-arrival", { seq: "9007199254740994" }), true);
    assert.equal(store.getCoreCursor(), "9007199254740995");
    assert.deepEqual(store.getCoreEvents()[0], hidden);
    assert.deepEqual(store.getCoreEvents().map((event) => event.seq), [
      "9007199254740993", "9007199254740994", "9007199254740995",
    ]);
    store.finishRound("public-round", "FAILED", "Not started", at(time + 1));
    const publicJson = JSON.stringify({ state: store.getState(), timeline: store.getTimeline(), recording: store.exportRecording("public-round") });
    for (const secret of ["private-account", "private-internal-event", "PRIVATE_PAYLOAD_SENTINEL", "9007199254740995"]) {
      assert.equal(publicJson.includes(secret), false);
    }
    store.close();
    const reopened = new DemoStore(file, OPTIONS);
    try {
      assert.equal(reopened.getCoreCursor(), "9007199254740995");
      assert.equal(reopened.appendCoreEvent("9007199254740993", "private-internal-event", hidden), false);
      assert.equal(reopened.getCoreEvents().length, 3);
      assert.throws(() => reopened.appendCoreEvent("-1", "bad", {}), /unsigned/);
      assert.throws(() => reopened.appendCoreEvent("1.1", "bad", {}), /unsigned/);
    } finally { reopened.close(); }
  });
});

test("timeline pages have a durable insertion boundary and deterministic same-time ordering", () => {
  fixture((file, store, time) => {
    for (const id of ["a", "c", "b", "d"]) {
      store.startRound("MANUAL", id, at(time));
      store.finishRound(id, "FAILED", "not_started", at(time));
    }
    const page = store.getTimeline(2);
    assert.deepEqual(page.rounds.map((round) => round.round_id), ["d", "c"]);
    assert.ok(page.next_cursor);
    store.startRound("SCHEDULED", "newest", at(time + 1));
    store.finishRound("newest", "FAILED", "not_started", at(time + 2));
    store.close();
    const reopened = new DemoStore(file, OPTIONS);
    try {
      const second = reopened.getTimeline(2, page.next_cursor!);
      assert.deepEqual(second.rounds.map((round) => round.round_id), ["b", "a"]);
      assert.equal(second.next_cursor, null);
      assert.deepEqual(reopened.getTimeline(2).rounds.map((round) => round.round_id), ["newest", "d"]);
      assert.throws(() => reopened.getTimeline(0), /1..100/);
      assert.throws(() => reopened.getTimeline(101), /1..100/);
      assert.throws(() => reopened.getTimeline(2, "not-a-cursor"), /does not exist/);
    } finally { reopened.close(); }
  });
});

test("a rejected timestamp rolls back step changes and notifications atomically", () => {
  fixture((_file, store, time) => {
    const events: SseEvent[] = [];
    store.subscribe((event) => events.push(event));
    store.startRound("MANUAL", "atomic", at(time));
    const start = store.startStep("atomic", "preflight", "", actual(), at(time + 1));
    const state = store.getState();
    state.generated_at = at(time + 5);
    store.setState(state);
    const count = events.length;
    assert.throws(() => store.finishStep("atomic", start.step_id, "FAIL", "Too old", actual(), at(time + 3)), /backwards/);
    assert.equal(events.length, count);
    assert.equal(store.getTimeline().rounds[0]?.steps[0]?.phase, "RUNNING");
    store.finishStep("atomic", start.step_id, "FAIL", "At current time", actual(), at(time + 6));
  });
});

test("listener exceptions and reentrant writes cannot disturb committed event order", () => {
  fixture((_file, store, time) => {
    const seen: SseEvent[] = [];
    store.subscribe(() => { throw new Error("Broken observer"); });
    store.subscribe((event) => {
      if (event.type === "round" && event.data.status === "RUNNING") {
        const state = store.getState();
        state.generated_at = at(time);
        store.setState(state);
      }
    });
    const unsubscribe = store.subscribe((event) => seen.push(event));
    store.startRound("MANUAL", "reentrant", at(time));
    assert.deepEqual(seen.map((event) => event.type), ["round", "state", "state"]);
    store.finishRound("reentrant", "FAILED", "not_started", at(time + 1));
    assert.deepEqual(store.exportRecording("reentrant").events, seen);
    unsubscribe();
    const length = seen.length;
    const state = store.getState(); state.generated_at = at(time + 2); store.setState(state);
    assert.equal(seen.length, length);
  });
});

test("shared db is usable by internal components while active recording source/build stays fixed", () => {
  fixture((_file, store, time) => {
    store.db.exec("CREATE TABLE internal_component(value TEXT)");
    store.db.prepare("INSERT INTO internal_component(value) VALUES(?)").run("internal");
    assert.equal(store.db.prepare("SELECT value FROM internal_component").get()?.value, "internal");
    store.startRound("MANUAL", "fixed-build", at(time));
    const state = store.getState();
    state.generated_at = at(time + 1);
    state.build.caller_commit = "another-build";
    assert.throws(() => store.setState(state), /source\/build/);
    assert.equal(store.getState().build.caller_commit, OPTIONS.build.caller_commit);
    assert.throws(() => store.exportRecording("fixed-build"), /finished rounds/);
  });
});
