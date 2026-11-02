import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  BuildInfo, CheckResult, DataSource, Observation, Recording, RoundSummary,
  RoundTimeline, ScenarioStep, SseEvent, StateResponse, StepActual,
  TimelineResponse, TimelineStep,
} from "../../shared/schema.js";

export interface StoreOptions { source: DataSource; build: BuildInfo }
type Listener = (event: SseEvent) => void;
type JsonRow = { body: string };
type PageCursor = { boundary: string; last_started_at: string; last_round_id: string };
const STEPS: ScenarioStep[] = [
  "preflight", "cleanup_before", "open_position", "verify_protection", "hold",
  "restart_kernel", "verify_recovery", "close_position", "cleanup_after",
];

function iso(value = new Date().toISOString()): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("Expected a UTC ISO timestamp including milliseconds");
  }
  return value;
}
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function sameMetadata(a: StoreOptions, b: StoreOptions): boolean {
  return a.source.kind === b.source.kind && a.source.label === b.source.label
    && a.build.caller_commit === b.build.caller_commit && a.build.rustcore_commit === b.build.rustcore_commit;
}
function parse<T>(row: unknown): T {
  if (!row) throw new Error("Requested record does not exist");
  return JSON.parse((row as JsonRow).body) as T;
}
function unknown<T>(): Observation<T> {
  return { status: "UNKNOWN", observed_at: null, source_as_of: null, value: null, reason: "Not yet observed" };
}
function initialState(options: StoreOptions): StateResponse {
  const at = iso();
  return {
    schema_version: 1, generated_at: at, source: copy(options.source), build: copy(options.build),
    account: unknown(), positions: unknown(), open_orders: unknown(), protection: unknown(),
    risk_budget: {
      status: "NOT_PUBLISHED", source_as_of: null, published_at: null, age_ms: null,
      max_age_ms: 30000, last_publish_applied: null, reason: "No budget has been published",
      utc_day: null, day_start_equity_usdt: null, equity_high_water_usdt: null,
      approximate_today_pnl_usdt: null, approximate_today_pnl_pct: null,
      drawdown_pct: null, total_exposure_pct: null,
    },
    kill_switch: { level: "UNKNOWN", reason: "Not yet observed", observed_at: null },
    rustcore: { status: "UNKNOWN", checked_at: at, last_restart_at: null, reason: "Not yet checked" },
    active_round_id: null, latest_round: null,
  };
}

/** Caller-owned persistence. Only already-public projections enter the public journal. */
export class DemoStore {
  public readonly db: DatabaseSync;
  private readonly options: StoreOptions;
  private readonly listeners = new Set<Listener>();
  private readonly notificationQueue: SseEvent[] = [];
  private publishing = false;
  private closed = false;

  constructor(dbFile: string, options: StoreOptions) {
    this.options = copy(options);
    this.db = new DatabaseSync(dbFile);
    this.db.exec([
      "PRAGMA busy_timeout=5000",
      "PRAGMA journal_mode=WAL",
      "CREATE TABLE IF NOT EXISTS demo_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL) STRICT",
      "CREATE TABLE IF NOT EXISTS demo_rounds (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, round_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL, initial_state TEXT NOT NULL, initial_timeline TEXT NOT NULL, journal_start INTEGER NOT NULL, journal_end INTEGER) STRICT",
      "CREATE UNIQUE INDEX IF NOT EXISTS demo_one_running_round ON demo_rounds(status) WHERE status='RUNNING'",
      "CREATE TABLE IF NOT EXISTS demo_steps (round_id TEXT NOT NULL REFERENCES demo_rounds(round_id), step_id TEXT NOT NULL, sequence INTEGER NOT NULL, step TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(round_id,step_id), UNIQUE(round_id,sequence), UNIQUE(round_id,step)) STRICT",
      "CREATE TABLE IF NOT EXISTS demo_journal (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, emitted_at TEXT NOT NULL, body TEXT NOT NULL) STRICT",
      "CREATE TABLE IF NOT EXISTS demo_pages (cursor TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT",
      "CREATE TABLE IF NOT EXISTS demo_core_events (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, seq TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(seq,event_id)) STRICT",
      "CREATE TABLE IF NOT EXISTS demo_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
    ].join(";\n") + ";");
    this.db.prepare("INSERT OR IGNORE INTO demo_state(id,body) VALUES(1,?)").run(JSON.stringify(initialState(options)));
    this.db.prepare("INSERT OR IGNORE INTO demo_meta(key,value) VALUES('core_cursor','0')").run();
  }

  private transaction<T>(work: (events: SseEvent[]) => T): T {
    const events: SseEvent[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try { result = work(events); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    this.notificationQueue.push(...events);
    this.notify();
    return result;
  }

  private notify(): void {
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.notificationQueue.length) {
        const event = this.notificationQueue.shift()!;
        for (const listener of [...this.listeners]) {
          // Observers cannot roll back a committed operation or block other observers.
          try { listener(copy(event)); } catch { /* Observer owns its failure handling. */ }
        }
      }
    } finally { this.publishing = false; }
  }

  private lastEventTime(): string | null {
    const row = this.db.prepare("SELECT emitted_at FROM demo_journal ORDER BY ordinal DESC LIMIT 1").get();
    return row ? String(row.emitted_at) : null;
  }
  private now(): string {
    const last = this.lastEventTime();
    const at = iso();
    return last && last > at ? last : at;
  }
  private journalWatermark(): string {
    return String(this.db.prepare("SELECT CAST(COALESCE(MAX(ordinal),0) AS TEXT) AS value FROM demo_journal").get()!.value);
  }
  private emit(events: SseEvent[], type: "state" | "timeline" | "resync" | "round" | "step",
    data: StateResponse | TimelineResponse | { reason: string } | RoundSummary | TimelineStep, at: string): void {
    const last = this.lastEventTime();
    if (last && at < last) throw new Error("Public event time cannot move backwards");
    const source = type === "resync" ? this.getState().source
      : type === "state" || type === "timeline" ? (data as StateResponse | TimelineResponse).source
      : parse<StateResponse>(this.db.prepare("SELECT initial_state AS body FROM demo_rounds WHERE round_id=?")
        .get((data as RoundSummary | TimelineStep).round_id)).source;
    const event = {
      schema_version: 1, event_id: "evt_" + randomUUID(), emitted_at: at,
      source: copy(source), type, data: copy(data),
    } as SseEvent;
    this.db.prepare("INSERT INTO demo_journal(event_id,emitted_at,body) VALUES(?,?,?)")
      .run(event.event_id, at, JSON.stringify(event));
    events.push(event);
  }
  private round(roundId: string): RoundSummary {
    return parse(this.db.prepare("SELECT body FROM demo_rounds WHERE round_id=?").get(roundId));
  }
  private runningRound(roundId: string): RoundSummary {
    const round = this.round(roundId);
    if (round.status !== "RUNNING") throw new Error("Completed rounds are immutable");
    return round;
  }
  private roundSteps(roundId: string): TimelineStep[] {
    return this.db.prepare("SELECT body FROM demo_steps WHERE round_id=? ORDER BY sequence").all(roundId)
      .map((row) => parse<TimelineStep>(row));
  }
  private saveState(state: StateResponse): void {
    this.db.prepare("UPDATE demo_state SET body=? WHERE id=1").run(JSON.stringify(state));
  }
  private withRoundMetadata(state: StateResponse): StateResponse {
    const active = this.db.prepare("SELECT body FROM demo_rounds WHERE status='RUNNING'").get();
    const latest = active ?? this.db.prepare("SELECT body FROM demo_rounds ORDER BY started_at DESC,round_id DESC LIMIT 1").get();
    return { ...copy(state), active_round_id: active ? parse<RoundSummary>(active).round_id : null,
      latest_round: latest ? parse<RoundSummary>(latest) : null };
  }
  private verifyMetadata(state: StateResponse): void {
    if (state.schema_version !== 1 || !sameMetadata(state, this.options)) {
      throw new Error("State source/build must match this caller build");
    }
    const active = this.db.prepare("SELECT initial_state AS body FROM demo_rounds WHERE status='RUNNING'").get();
    if (active) {
      const original = parse<StateResponse>(active);
      if (!sameMetadata(original, state)) {
        throw new Error("A recording cannot change source or build mid-round");
      }
    }
  }

  getState(): StateResponse {
    return parse(this.db.prepare("SELECT body FROM demo_state WHERE id=1").get());
  }

  setState(state: StateResponse): SseEvent {
    const at = iso(state.generated_at);
    return this.transaction((events) => {
      this.verifyMetadata(state);
      const projected = this.withRoundMetadata(state);
      this.saveState(projected);
      this.emit(events, "state", projected, at);
      return copy(events[0]!);
    });
  }

  private timeline(limit: number, cursor?: string): TimelineResponse {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Timeline limit must be 1..100");
    let page: PageCursor;
    if (cursor !== undefined) {
      page = parse(this.db.prepare("SELECT body FROM demo_pages WHERE cursor=?").get(cursor));
    } else {
      const boundary = String(this.db.prepare("SELECT CAST(COALESCE(MAX(ordinal),0) AS TEXT) AS value FROM demo_rounds").get()!.value);
      page = { boundary, last_started_at: "\uffff", last_round_id: "\uffff" };
    }
    const rows = this.db.prepare(
      "SELECT body FROM demo_rounds WHERE ordinal<=? AND (started_at<? OR (started_at=? AND round_id<?)) ORDER BY started_at DESC,round_id DESC LIMIT ?",
    ).all(BigInt(page.boundary), page.last_started_at, page.last_started_at, page.last_round_id, limit + 1);
    const summaries = rows.slice(0, limit).map((row) => parse<RoundSummary>(row));
    let next: string | null = null;
    if (rows.length > limit) {
      const last = summaries[summaries.length - 1]!;
      next = "page_" + randomUUID();
      this.db.prepare("INSERT INTO demo_pages(cursor,body) VALUES(?,?)").run(next, JSON.stringify({
        boundary: page.boundary, last_started_at: last.started_at, last_round_id: last.round_id,
      } satisfies PageCursor));
    }
    return { schema_version: 1, generated_at: this.now(), source: copy(this.options.source),
      rounds: summaries.map((summary): RoundTimeline => ({ ...summary, steps: this.roundSteps(summary.round_id) })),
      next_cursor: next };
  }

  getTimeline(limit = 20, cursor?: string): TimelineResponse {
    return this.transaction(() => this.timeline(limit, cursor));
  }

  /** Subscribe before taking this durable baseline; deduplicate the returned IDs from live delivery. */
  snapshotEvents(resync = false): SseEvent[] {
    return this.transaction((events) => {
      const at = this.now();
      const state = { ...this.getState(), generated_at: at };
      const timeline = { ...this.timeline(20), generated_at: at };
      this.saveState(state);
      if (resync) this.emit(events, "resync", { reason: "Full state and timeline baseline after reconnect" }, at);
      this.emit(events, "state", state, at);
      this.emit(events, "timeline", timeline, at);
      return copy(events);
    });
  }

  startRound(trigger: RoundSummary["trigger"], roundId = "round_" + randomUUID(), at = this.now()): RoundSummary {
    iso(at);
    return this.transaction((events) => {
      if (trigger !== "SCHEDULED" && trigger !== "MANUAL") throw new Error("Invalid round trigger");
      if (!roundId.trim()) throw new Error("Round ID is required");
      if (this.db.prepare("SELECT 1 FROM demo_rounds WHERE status='RUNNING'").get()) throw new Error("A round is already running");
      const state = this.getState();
      this.verifyMetadata(state);
      const initial = { ...state, generated_at: at };
      const timeline = { ...this.timeline(20), generated_at: at };
      const round: RoundSummary = { round_id: roundId, trigger, status: "RUNNING", started_at: at, ended_at: null, reason: "Round started" };
      this.db.prepare("INSERT INTO demo_rounds(round_id,started_at,status,body,initial_state,initial_timeline,journal_start) VALUES(?,?,?,?,?,?,?)")
        .run(roundId, at, round.status, JSON.stringify(round), JSON.stringify(initial), JSON.stringify(timeline), BigInt(this.journalWatermark()));
      this.emit(events, "round", round, at);
      const current = this.withRoundMetadata({ ...state, generated_at: at });
      this.saveState(current);
      this.emit(events, "state", current, at);
      return copy(round);
    });
  }

  startStep(roundId: string, step: ScenarioStep, expected: string, actual: StepActual, at = this.now()): TimelineStep {
    iso(at);
    return this.transaction((events) => {
      const round = this.runningRound(roundId);
      const steps = this.roundSteps(roundId);
      if (!STEPS.includes(step)) throw new Error("Unknown scenario step");
      if (steps.some((item) => item.phase === "RUNNING")) throw new Error("A step is already running");
      if (steps.some((item) => item.step === step)) throw new Error("A scenario step cannot be retried within a round");
      if (steps.some((item) => item.result !== "PASS") && step !== "close_position" && step !== "cleanup_after") {
        throw new Error("Only safety cleanup may follow a failed or unknown step");
      }
      if (at < round.started_at) throw new Error("Step cannot start before its round");
      const value: TimelineStep = { round_id: roundId, step_id: "step_" + randomUUID(), sequence: steps.length + 1,
        step, started_at: at, expected, actual: copy(actual), reason: "Step running", phase: "RUNNING", ended_at: null, result: "UNKNOWN" };
      this.db.prepare("INSERT INTO demo_steps(round_id,step_id,sequence,step,body) VALUES(?,?,?,?,?)")
        .run(roundId, value.step_id, value.sequence, step, JSON.stringify(value));
      this.emit(events, "step", value, at);
      return copy(value);
    });
  }

  finishStep(roundId: string, stepId: string, result: CheckResult, reason: string, actual: StepActual, at = this.now()): TimelineStep {
    iso(at);
    return this.transaction((events) => {
      this.runningRound(roundId);
      const previous = parse<TimelineStep>(this.db.prepare("SELECT body FROM demo_steps WHERE round_id=? AND step_id=?").get(roundId, stepId));
      if (previous.phase !== "RUNNING") throw new Error("Completed steps are immutable");
      if (!["PASS", "FAIL", "UNKNOWN"].includes(result)) throw new Error("Invalid step result");
      if (at < previous.started_at) throw new Error("Step cannot finish before it started");
      const value: TimelineStep = { ...previous, phase: "COMPLETED", result, reason, actual: copy(actual), ended_at: at };
      this.db.prepare("UPDATE demo_steps SET body=? WHERE round_id=? AND step_id=?").run(JSON.stringify(value), roundId, stepId);
      this.emit(events, "step", value, at);
      return copy(value);
    });
  }

  finishRound(roundId: string, status: "SUCCEEDED" | "FAILED", reason: string, at = this.now()): RoundSummary {
    iso(at);
    return this.transaction((events) => {
      const previous = this.runningRound(roundId);
      const steps = this.roundSteps(roundId);
      if (status !== "SUCCEEDED" && status !== "FAILED") throw new Error("Invalid final round status");
      if (steps.some((step) => step.phase === "RUNNING")) throw new Error("Finish the running step before finishing its round");
      if (status === "SUCCEEDED" && (steps.length !== STEPS.length ||
          steps.some((step, index) => step.step !== STEPS[index] || step.result !== "PASS"))) {
        throw new Error("A successful round requires all nine steps in order, all PASS");
      }
      if (at < previous.started_at) throw new Error("Round cannot finish before it started");
      const round: RoundSummary = { ...previous, status, reason, ended_at: at };
      this.db.prepare("UPDATE demo_rounds SET status=?,body=? WHERE round_id=?").run(status, JSON.stringify(round), roundId);
      this.emit(events, "round", round, at);
      const state = this.withRoundMetadata({ ...this.getState(), generated_at: at });
      this.saveState(state);
      this.emit(events, "state", state, at);
      this.db.prepare("UPDATE demo_rounds SET journal_end=? WHERE round_id=?").run(BigInt(this.journalWatermark()), roundId);
      return copy(round);
    });
  }

  appendCoreEvent(seq: string, eventId: string, payload: unknown): boolean {
    if (!/^\d+$/.test(seq) || !eventId.trim()) throw new Error("Core event requires unsigned sequence and event ID");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Core event payload must be an object");
    const canonical = BigInt(seq).toString();
    return this.transaction(() => {
      const inserted = this.db.prepare("INSERT OR IGNORE INTO demo_core_events(seq,event_id,body) VALUES(?,?,?)")
        .run(canonical, eventId, JSON.stringify(payload));
      if (inserted.changes === 0) return false;
      if (BigInt(canonical) > BigInt(this.getCoreCursor())) {
        this.db.prepare("UPDATE demo_meta SET value=? WHERE key='core_cursor'").run(canonical);
      }
      return true;
    });
  }

  getCoreCursor(): string {
    return String(this.db.prepare("SELECT value FROM demo_meta WHERE key='core_cursor'").get()!.value);
  }

  /** Internal only: raw core payloads must never be forwarded to public endpoints. */
  getCoreEvents(): Record<string, unknown>[] {
    return this.db.prepare("SELECT body FROM demo_core_events ORDER BY length(seq),seq,ordinal").all()
      .map((row) => parse<Record<string, unknown>>(row));
  }

  exportRecording(roundId: string): Recording {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT *, CAST(journal_start AS TEXT) AS start_text, CAST(journal_end AS TEXT) AS end_text FROM demo_rounds WHERE round_id=?").get(roundId);
      if (!row) throw new Error("Round does not exist");
      const round = parse<RoundSummary>(row);
      if (round.status === "RUNNING" || round.ended_at === null || row.end_text === null) {
        throw new Error("Only finished rounds can be exported");
      }
      const initial = JSON.parse(String(row.initial_state)) as StateResponse;
      const events = this.db.prepare("SELECT body FROM demo_journal WHERE ordinal>? AND ordinal<=? ORDER BY ordinal")
        .all(BigInt(String(row.start_text)), BigInt(String(row.end_text))).map((item) => parse<SseEvent>(item));
      return { schema_version: 1, recording_id: "recording_" + roundId, title: "Scenario " + round.status,
        description: round.reason, source: copy(initial.source), build: copy(initial.build), created_at: this.now(),
        started_at: round.started_at, ended_at: round.ended_at, initial_state: initial,
        initial_timeline: JSON.parse(String(row.initial_timeline)) as TimelineResponse, events };
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    if (this.closed) return;
    this.listeners.clear();
    this.db.close();
    this.closed = true;
  }
}
