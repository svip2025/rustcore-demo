import { normalizePublicWire } from '../../shared/replay.js';
import type {
  Recording, RoundSummary, RoundTimeline, SseEvent, StateResponse,
  TimelineResponse, TimelineStep,
} from '../../shared/schema.js';

export interface Snapshot {
  state: StateResponse;
  timeline: TimelineResponse;
  awaitingBaseline: boolean;
  /** Transport bookkeeping is separate from the observed facts. */
  meta: {
    seen: ReadonlySet<string>;
    historicalLoaded: boolean;
    pendingState: StateResponse | null;
    pendingTimeline: TimelineResponse | null;
  };
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message: string): never => { throw new Error(message); };
const requiredObject = (value: unknown, label: string): ObjectValue => object(value) ? value : fail(`数据格式错误：${label}`);
const string = (value: unknown): value is string => typeof value === 'string';
const nullableString = (value: unknown): boolean => value === null || string(value);
const timestamp = (value: unknown): boolean => string(value) && Number.isFinite(Date.parse(value));
const stringFields = (value: ObjectValue, fields: string[]): boolean => fields.every(field => string(value[field]));
const oneOf = (value: unknown, values: readonly string[]): boolean => string(value) && values.includes(value);
const assert = (condition: unknown, label: string): void => { if (!condition) fail(`数据格式错误：${label}`); };

export function assertVersion(value: unknown): asserts value is ObjectValue & { schema_version: 2 } {
  const item = requiredObject(value, '响应');
  if (item.schema_version !== 2) fail(`不支持的数据版本：${String(item.schema_version)}（支持 v1/v2）`);
}

function source(value: unknown): void {
  const item = requiredObject(value, '数据来源');
  assert(oneOf(item.kind, ['MOCK', 'TESTNET', 'PAPER']) && string(item.label), '数据来源');
}

function observation(value: unknown, isArray: boolean): void {
  const item = requiredObject(value, '观察数据');
  assert(oneOf(item.status, ['AVAILABLE', 'PARTIAL', 'STALE', 'UNAVAILABLE', 'UNKNOWN']), '观察状态');
  assert(nullableString(item.observed_at) && nullableString(item.source_as_of) && string(item.reason), '观察时间与原因');
  assert(item.value === null || (isArray ? Array.isArray(item.value) : object(item.value)), '观察值');
}

export function assertState(value: unknown): asserts value is StateResponse {
  assertVersion(value);
  source(value.source);
  const build = requiredObject(value.build, '构建版本');
  assert(stringFields(build, ['caller_commit', 'rustcore_commit']) && timestamp(value.generated_at), '构建版本和生成时间');
  observation(value.account, false);
  for (const field of ['positions', 'open_orders', 'protection']) observation(value[field], true);
  const account = (value.account as ObjectValue).value;
  if (account !== null) assert(stringFields(requiredObject(account, '账户'), ['account_label', 'equity_usdt', 'available_usdt']), '账户');
  const positions = (value.positions as ObjectValue).value;
  if (Array.isArray(positions)) for (const item of positions) {
    const position = requiredObject(item, '持仓');
    assert(stringFields(position, ['position_id', 'symbol', 'side', 'quantity', 'state']), '持仓');
  }
  const orders = (value.open_orders as ObjectValue).value;
  if (Array.isArray(orders)) for (const item of orders) {
    assert(stringFields(requiredObject(item, '挂单'), ['order_id', 'symbol', 'role', 'side', 'order_type', 'status']), '挂单');
  }
  const protection = (value.protection as ObjectValue).value;
  if (Array.isArray(protection)) for (const item of protection) {
    const pair = requiredObject(item, '保护单');
    assert(string(pair.position_id) && nullableString(pair.observation_id), '保护单快照');
    for (const field of ['sl', 'tp']) {
      const leg = requiredObject(pair[field], '保护腿');
      assert(oneOf(leg.status, ['PASS', 'FAIL', 'UNKNOWN']) && string(leg.reason), '保护腿状态');
    }
  }
  const risk = requiredObject(value.risk_budget, '风险预算');
  assert(oneOf(risk.status, ['FRESH', 'STALE', 'NOT_PUBLISHED', 'UNAVAILABLE']) && string(risk.reason), '风险预算状态');
  assert(typeof risk.max_age_ms === 'number' && Number.isFinite(risk.max_age_ms) && risk.max_age_ms > 0, '预算有效窗口');
  assert(risk.age_ms === null || (typeof risk.age_ms === 'number' && Number.isFinite(risk.age_ms) && risk.age_ms >= 0), '预算年龄');
  const kill = requiredObject(value.kill_switch, '熔断状态');
  assert(oneOf(kill.level, ['none', 'pause_new', 'manage_only', 'flatten', 'UNKNOWN']) && string(kill.reason), '熔断状态');
  const kernel = requiredObject(value.rustcore, '内核状态');
  assert(oneOf(kernel.status, ['ONLINE', 'OFFLINE', 'RESTARTING', 'UNKNOWN']) && string(kernel.reason) && timestamp(kernel.checked_at), '内核状态');
  assert(nullableString(value.active_round_id), '当前轮次');
  if (value.latest_round !== null) assertRound(value.latest_round);
}

function assertRound(value: unknown): asserts value is RoundSummary {
  const item = requiredObject(value, '场景轮次');
  assert(stringFields(item, ['round_id', 'reason']) && timestamp(item.started_at), '场景轮次');
  assert(oneOf(item.status, ['RUNNING', 'SUCCEEDED', 'FAILED']) && oneOf(item.trigger, ['SCHEDULED', 'MANUAL']), '轮次结果和触发来源');
  assert(item.ended_at === null || timestamp(item.ended_at), '轮次结束时间');
  assert(Object.hasOwn(item, 'scenario') && Object.hasOwn(item, 'metrics'), 'v2 场景与指标字段');
  if (item.scenario !== null) {
    const scenario = requiredObject(item.scenario, '场景配置');
    assert(oneOf(scenario.scenario_id, ['S1', 'S2', 'S3', 'S4', 'S5', 'F1', 'F2', 'F3', 'F4'])
      && oneOf(scenario.direction, ['LONG', 'SHORT']) && scenario.symbol === 'BTCUSDT', '场景范围');
    assert(stringFields(scenario, ['sl_pct', 'tp_pct', 'exit_mode', 'policy_version']) && Number.isSafeInteger(scenario.max_hold_ms), '场景参数');
  }
  if (item.metrics !== null) {
    const metrics = requiredObject(item.metrics, '轮次指标');
    assert(object(metrics.step_durations_ms) && Array.isArray(metrics.unknown_windows)
      && typeof metrics.unknown_duration_ms === 'number' && oneOf(metrics.accounting_status, ['UNKNOWN', 'COMPLETE']), '轮次指标');
  }
}

function assertStep(value: unknown): asserts value is TimelineStep {
  const item = requiredObject(value, '场景步骤');
  assert(stringFields(item, ['round_id', 'step_id', 'expected', 'reason']) && timestamp(item.started_at), '场景步骤');
  assert(Number.isInteger(item.sequence) && Number(item.sequence) > 0, '步骤顺序');
  assert(oneOf(item.step, ['preflight', 'cleanup_before', 'open_position', 'verify_protection', 'hold', 'restart_kernel', 'verify_recovery', 'close_position', 'cleanup_after']), '步骤类型');
  assert(oneOf(item.result, ['PASS', 'FAIL', 'UNKNOWN']), '步骤结果');
  assert(item.phase === 'RUNNING' ? item.result === 'UNKNOWN' && item.ended_at === null : item.phase === 'COMPLETED' && timestamp(item.ended_at), '步骤阶段');
  const actual = requiredObject(item.actual, '步骤实际结果');
  assert(string(actual.summary), '步骤实际摘要');
  for (const field of ['account', 'position', 'protection', 'fill', 'rustcore', 'risk_budget']) assert(actual[field] === null || object(actual[field]), '步骤观察值');
  assert(actual.open_orders === null || Array.isArray(actual.open_orders), '步骤挂单');
}

export function assertTimeline(value: unknown): asserts value is TimelineResponse {
  assertVersion(value);
  source(value.source);
  assert(timestamp(value.generated_at) && Array.isArray(value.rounds) && nullableString(value.next_cursor), '时间线');
  for (const item of value.rounds as unknown[]) {
    assertRound(item);
    const round = item as unknown as ObjectValue;
    assert(Array.isArray(round.steps), '轮次步骤列表');
    for (const step of round.steps as unknown[]) { assertStep(step); assert(step.round_id === item.round_id, '步骤所属轮次'); }
  }
}

export function parseEvent(value: unknown): SseEvent {
  value = normalizePublicWire(value);
  assertVersion(value);
  source(value.source);
  assert(string(value.event_id) && value.event_id.length > 0 && timestamp(value.emitted_at), '事件标识和时间');
  switch (value.type) {
    case 'state': assertState(value.data); break;
    case 'timeline': assertTimeline(value.data); break;
    case 'round': assertRound(value.data); break;
    case 'step': assertStep(value.data); break;
    case 'heartbeat': assert(timestamp(requiredObject(value.data, '心跳').at), '心跳时间'); break;
    case 'resync': assert(string(requiredObject(value.data, '重新同步').reason), '重新同步原因'); break;
    default: fail(`不支持的事件类型：${String(value.type)}`);
  }
  if (value.type === 'state' || value.type === 'timeline') {
    const data = value.data as StateResponse | TimelineResponse;
    assert(data.source.kind === (value.source as ObjectValue).kind && data.source.label === (value.source as ObjectValue).label, '事件来源不一致');
  }
  return value as unknown as SseEvent;
}

export function parseRecording(value: unknown): Recording {
  value = normalizePublicWire(value);
  assertVersion(value);
  source(value.source);
  assert(stringFields(value, ['recording_id', 'title', 'description', 'created_at']), '录制元数据');
  assert(timestamp(value.started_at) && timestamp(value.ended_at) && Date.parse(String(value.ended_at)) >= Date.parse(String(value.started_at)), '录制时间范围');
  assertState(value.initial_state);
  assertTimeline(value.initial_timeline);
  const build = requiredObject(value.build, '录制构建版本');
  assert(stringFields(build, ['caller_commit', 'rustcore_commit']), '录制构建版本');
  assert(Array.isArray(value.events), '录制事件');
  const recording = value as unknown as Recording;
  const seen = new Set<string>();
  let previousAt = Date.parse(recording.started_at);
  const sameSource = (candidate: { kind: string; label: string }) => candidate.kind === recording.source.kind && candidate.label === recording.source.label;
  assert(sameSource(recording.initial_state.source) && sameSource(recording.initial_timeline.source), '录制来源不一致');
  const sameBuild = (candidate: StateResponse['build']) => candidate.caller_commit === recording.build.caller_commit && candidate.rustcore_commit === recording.build.rustcore_commit;
  assert(sameBuild(recording.initial_state.build), '录制构建版本不一致');
  for (const item of recording.events) {
    const event = parseEvent(item);
    const at = Date.parse(event.emitted_at);
    assert(at >= previousAt && at <= Date.parse(recording.ended_at) && !seen.has(event.event_id), '录制事件顺序、时间范围或重复标识');
    assert(sameSource(event.source), '录制事件来源不一致');
    if (event.type === 'state') assert(sameBuild(event.data.build), '录制事件构建版本不一致');
    seen.add(event.event_id);
    previousAt = at;
  }
  return recording;
}

export function createLiveSnapshot(state: StateResponse, timeline: TimelineResponse): Snapshot {
  assertState(state);
  assertTimeline(timeline);
  assert(state.source.kind === timeline.source.kind && state.source.label === timeline.source.label, '实时基线来源不一致');
  return {
    state: structuredClone(state), timeline: structuredClone(timeline), awaitingBaseline: false,
    meta: { seen: new Set(), historicalLoaded: false, pendingState: null, pendingTimeline: null },
  };
}

export function createSnapshot(recording: Recording): Snapshot {
  return createLiveSnapshot(recording.initial_state, recording.initial_timeline);
}

function mergeStep(previous: TimelineStep | undefined, next: TimelineStep): TimelineStep {
  return previous?.phase === 'COMPLETED' ? previous : structuredClone(next);
}

function mergeRound(previous: RoundTimeline | undefined, next: RoundTimeline): RoundTimeline {
  if (!previous) return structuredClone({ ...next, steps: [...next.steps].sort((a, b) => a.sequence - b.sequence) });
  const steps = new Map(previous.steps.map(step => [step.step_id, step]));
  for (const step of next.steps) steps.set(step.step_id, mergeStep(steps.get(step.step_id), step));
  const summary = previous.status === 'RUNNING' ? next : previous;
  return { ...summary, steps: [...steps.values()].sort((a, b) => a.sequence - b.sequence) };
}

function mergeRounds(previous: RoundTimeline[], incoming: RoundTimeline[]): RoundTimeline[] {
  const rounds = new Map(previous.map(round => [round.round_id, round]));
  for (const round of incoming) rounds.set(round.round_id, mergeRound(rounds.get(round.round_id), round));
  return [...rounds.values()].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.round_id.localeCompare(a.round_id));
}

export function mergeTimelinePage(snapshot: Snapshot, page: TimelineResponse): Snapshot {
  assertTimeline(page);
  assert(page.source.kind === snapshot.timeline.source.kind && page.source.label === snapshot.timeline.source.label, '历史页来源不一致');
  return {
    ...snapshot,
    timeline: { ...snapshot.timeline, rounds: mergeRounds(snapshot.timeline.rounds, page.rounds), next_cursor: page.next_cursor },
    meta: { ...snapshot.meta, historicalLoaded: true },
  };
}

function preserveRoundConclusion(snapshot: Snapshot, incoming: StateResponse): StateResponse {
  const latest = incoming.latest_round;
  if (!latest) return incoming;
  const previous = snapshot.timeline.rounds.find(round => round.round_id === latest.round_id)
    ?? (snapshot.state.latest_round?.round_id === latest.round_id ? snapshot.state.latest_round : null);
  if (previous && previous.status !== 'RUNNING') {
    const { round_id, trigger, status, started_at, ended_at, reason, scenario, metrics } = previous;
    return { ...incoming, latest_round: { round_id, trigger, status, started_at, ended_at, reason, scenario, metrics } };
  }
  return incoming;
}

export function applyEvent(snapshot: Snapshot, input: SseEvent): Snapshot {
  const event = parseEvent(input);
  if (snapshot.meta.seen.has(event.event_id)) return snapshot;
  if (event.type === 'resync') return {
    ...snapshot, awaitingBaseline: true,
    meta: { ...snapshot.meta, seen: new Set(), pendingState: null, pendingTimeline: null },
  };
  const seen = new Set(snapshot.meta.seen);
  seen.add(event.event_id);
  let result: Snapshot = { ...snapshot, meta: { ...snapshot.meta, seen } };
  if (snapshot.awaitingBaseline) {
    if (event.type === 'state') result.meta.pendingState = structuredClone(event.data);
    else if (event.type === 'timeline') result.meta.pendingTimeline = structuredClone(event.data);
    else if (event.type !== 'heartbeat') return result;
    if (result.meta.pendingState && result.meta.pendingTimeline) {
      const baseline = createLiveSnapshot(result.meta.pendingState, result.meta.pendingTimeline);
      return {
        ...baseline,
        state: preserveRoundConclusion(snapshot, baseline.state),
        timeline: {
          ...baseline.timeline,
          rounds: mergeRounds(snapshot.timeline.rounds, baseline.timeline.rounds),
          next_cursor: snapshot.meta.historicalLoaded ? snapshot.timeline.next_cursor : baseline.timeline.next_cursor,
        },
        meta: { ...baseline.meta, seen, historicalLoaded: snapshot.meta.historicalLoaded },
      };
    }
    return result;
  }
  assert(event.source.kind === snapshot.state.source.kind && event.source.label === snapshot.state.source.label, '事件来源与当前基线不一致');
  switch (event.type) {
    case 'state': result.state = structuredClone(preserveRoundConclusion(snapshot, event.data)); break;
    case 'timeline': result.timeline = {
      ...structuredClone(event.data), rounds: mergeRounds(snapshot.timeline.rounds, event.data.rounds),
      next_cursor: snapshot.meta.historicalLoaded ? snapshot.timeline.next_cursor : event.data.next_cursor,
    }; break;
    case 'round': {
      const previous = snapshot.timeline.rounds.find(round => round.round_id === event.data.round_id);
      const round = mergeRound(previous, { ...event.data, steps: previous?.steps ?? [] });
      result.timeline = { ...snapshot.timeline, rounds: mergeRounds(snapshot.timeline.rounds, [round]) };
      break;
    }
    case 'step': {
      const previous = snapshot.timeline.rounds.find(round => round.round_id === event.data.round_id);
      if (!previous) return fail('步骤缺少所属轮次，请重新同步');
      const round = mergeRound(previous, { ...previous, steps: [event.data] });
      result.timeline = { ...snapshot.timeline, rounds: mergeRounds(snapshot.timeline.rounds, [round]) };
      break;
    }
    case 'heartbeat': break; // Transport activity never refreshes observed facts.
  }
  return result;
}

export function seekRecording(recording: Recording, offsetMs: number): Snapshot {
  const start = Date.parse(recording.started_at);
  const duration = Math.max(0, Date.parse(recording.ended_at) - start);
  const target = start + Math.max(0, Math.min(duration, Number.isFinite(offsetMs) ? offsetMs : 0));
  let snapshot = createSnapshot(recording);
  for (const event of recording.events) {
    if (Date.parse(event.emitted_at) > target) break;
    snapshot = applyEvent(snapshot, event);
  }
  return snapshot;
}
