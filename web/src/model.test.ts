import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Recording, SseEvent, TimelineResponse } from '../../shared/schema.js';
import {
  applyEvent, createSnapshot, mergeTimelinePage, parseRecording, seekRecording,
  type Snapshot,
} from './model.js';
import { LiveConnection, type LiveStatus } from './live.js';

const load = (name: string): Recording => parseRecording(JSON.parse(readFileSync(new URL(`../../recordings/${name}.json`, import.meta.url), 'utf8')));
const success = load('mock-success-v1');
const failure = load('mock-failure-v1');
const envelope = { schema_version: 2 as const, source: success.source, emitted_at: success.started_at };
const testnetRecordings = readdirSync(new URL('../../recordings/', import.meta.url))
  .filter(name => /^run-.*\.json$/.test(name)).sort().map(name => load(name.replace(/\.json$/, '')));
const testnetSuccess = testnetRecordings.find(recording => recording.recording_id.includes('succeeded'))
  ?? testnetRecordings.find(recording => seekRecording(recording, Number.MAX_SAFE_INTEGER).timeline.rounds[0]?.status === 'SUCCEEDED')!;

test('all six recorded TESTNET runs load with their original builds and conclusions', () => {
  assert.equal(testnetRecordings.length, 6);
  let failed = 0;
  let succeeded = 0;
  const identities = new Set<string>();
  for (const recording of testnetRecordings) {
    assert.equal(recording.source.kind, 'TESTNET');
    assert.notEqual(recording.build.caller_commit, 'mock-caller-v1');
    const duration = Date.parse(recording.ended_at) - Date.parse(recording.started_at);
    const finish = seekRecording(recording, duration);
    const current = finish.timeline.rounds[0]!;
    assert.equal(current.started_at, recording.started_at);
    assert.equal(current.ended_at, recording.ended_at);
    assert.equal(current.trigger, 'MANUAL');
    assert.equal(finish.state.latest_round?.round_id, current.round_id);
    assert.deepEqual(finish.state.build, recording.build);
    identities.add(current.round_id);
    if (current.status === 'FAILED') {
      failed++;
      assert.ok(current.reason.length > 0);
      assert.ok(current.steps.some(step => step.result !== 'PASS'));
    } else if (current.status === 'SUCCEEDED') succeeded++;
    else assert.fail('A completed exported run must retain a terminal conclusion');
  }
  assert.equal(identities.size, 6);
  assert.equal(succeeded, 1);
  assert.equal(failed, 5);
});

test('real success replay preserves nine steps, unknown recovery, fills, and all five earlier failures', () => {
  assert.ok(testnetSuccess);
  const final = seekRecording(testnetSuccess, Number.MAX_SAFE_INTEGER);
  const round = final.timeline.rounds[0]!;
  assert.equal(round.status, 'SUCCEEDED');
  assert.equal(round.steps.length, 9);
  assert.ok(round.steps.every(step => step.phase === 'COMPLETED' && step.result === 'PASS'));
  assert.equal(final.timeline.rounds.filter(item => item.status === 'FAILED').length, 5);
  assert.deepEqual(final.state.positions.value, []);
  assert.deepEqual(final.state.open_orders.value, []);
  assert.equal(round.steps.find(step => step.step === 'open_position')?.actual.fill?.quantity, '0.0095');
  assert.equal(round.steps.find(step => step.step === 'close_position')?.actual.fill?.notional_usdt, '739.30805');
  const restart = testnetSuccess.events.find(event => event.type === 'step' && event.data.step === 'restart_kernel' && event.data.phase === 'COMPLETED')!;
  const atRestart = seekRecording(testnetSuccess, Date.parse(restart.emitted_at) - Date.parse(testnetSuccess.started_at));
  assert.equal(atRestart.state.protection.value?.[0]?.sl.status, 'UNKNOWN');
  assert.equal(atRestart.state.protection.value?.[0]?.tp.status, 'UNKNOWN');
  const recovered = round.steps.find(step => step.step === 'verify_recovery')!;
  assert.equal(recovered.actual.protection?.sl.status, 'PASS');
  assert.equal(recovered.actual.protection?.tp.status, 'PASS');
  assert.equal(recovered.actual.position?.quantity, '0.0095');
});

test('replay seeks from the initial state and includes exact-boundary events', () => {
  const held = seekRecording(success, 40000);
  assert.equal(held.state.rustcore.status, 'ONLINE');
  assert.ok(held.state.positions.value?.length);
  const restart = seekRecording(success, 54000);
  assert.equal(restart.state.rustcore.status, 'OFFLINE');
  const expired = seekRecording(success, 84000);
  assert.equal(expired.state.risk_budget.status, 'STALE');
  assert.equal(expired.state.rustcore.status, 'OFFLINE');
  const restored = seekRecording(success, 98000);
  assert.equal(restored.state.rustcore.status, 'ONLINE');
  assert.equal(restored.state.protection.value?.[0]?.sl.status, 'PASS');
  assert.equal(restored.state.protection.value?.[0]?.tp.status, 'PASS');
  assert.equal(restored.timeline.rounds[0]?.steps.find(step => step.step === 'verify_recovery')?.result, 'PASS');
  const start = seekRecording(success, -500);
  assert.deepEqual(start.state, success.initial_state);
  assert.equal(start.timeline.rounds.length, 0);
  const finish = seekRecording(success, 999999);
  assert.equal(finish.timeline.rounds[0]?.status, 'SUCCEEDED');
  assert.equal(finish.timeline.rounds[0]?.steps.length, 9);
  assert.deepEqual(finish.state.positions.value, []);
  assert.deepEqual(seekRecording(success, 0).state, success.initial_state);
});

test('a missing TP is separate from SL and cleanup never erases failure', () => {
  const missing = seekRecording(failure, 19000);
  assert.equal(missing.state.protection.value?.[0]?.sl.status, 'PASS');
  assert.equal(missing.state.protection.value?.[0]?.tp.status, 'FAIL');
  const finish = seekRecording(failure, 30100);
  assert.equal(finish.timeline.rounds[0]?.status, 'FAILED');
  assert.equal(finish.state.latest_round?.status, 'FAILED');
  assert.deepEqual(finish.state.positions.value, []);
  assert.equal(finish.timeline.rounds[0]?.trigger, 'MANUAL');
  assert.equal(finish.timeline.rounds[0]?.steps.find(step => step.step === 'verify_protection')?.result, 'FAIL');
  assert.equal(finish.timeline.rounds[0]?.steps.some(step => step.step === 'restart_kernel'), false);
});

test('event identity is opaque and duplicate messages do not change state', () => {
  const baseline = createSnapshot(success);
  const first: SseEvent = { ...envelope, event_id: 'z', type: 'state', data: success.initial_state };
  const second: SseEvent = { ...envelope, event_id: 'a', type: 'state', data: { ...success.initial_state, rustcore: { ...success.initial_state.rustcore, status: 'OFFLINE' } } };
  const updated = applyEvent(applyEvent(baseline, first), second);
  assert.equal(updated.state.rustcore.status, 'OFFLINE');
  assert.equal(applyEvent(updated, first), updated);
  assert.equal(baseline.meta.seen.size, 0);
});

test('heartbeats do not refresh observations or response timestamps', () => {
  const before = seekRecording(success, 84000);
  const after = applyEvent(before, { ...envelope, event_id: 'heartbeat-new', type: 'heartbeat', data: { at: success.ended_at } });
  assert.equal(after.state, before.state);
  assert.equal(after.timeline, before.timeline);
  assert.equal(after.state.risk_budget.status, 'STALE');
});

test('resync holds the old display until both new baselines arrive', () => {
  const before = seekRecording(success, 84000);
  let snapshot = applyEvent(before, { ...envelope, event_id: 'reset', type: 'resync', data: { reason: 'cursor expired' } });
  assert.equal(snapshot.awaitingBaseline, true);
  assert.equal(snapshot.meta.seen.size, 0);
  snapshot = applyEvent(snapshot, { ...envelope, event_id: 'baseline-state', type: 'state', data: success.initial_state });
  assert.equal(snapshot.awaitingBaseline, true);
  assert.equal(snapshot.state.rustcore.status, 'OFFLINE');
  snapshot = applyEvent(snapshot, { ...envelope, event_id: 'baseline-timeline', type: 'timeline', data: success.initial_timeline });
  assert.equal(snapshot.awaitingBaseline, false);
  assert.deepEqual(snapshot.state, success.initial_state);
});

test('loaded historical failure pages survive subsequent timeline baselines', () => {
  let snapshot = seekRecording(success, 112100);
  const failedRound = seekRecording(failure, 30100).timeline.rounds[0]!;
  const history: TimelineResponse = {
    ...snapshot.timeline,
    source: success.source,
    rounds: [{ ...failedRound, round_id: 'old-failure', steps: failedRound.steps.map(step => ({ ...step, round_id: 'old-failure' })) }],
    next_cursor: 'opaque-history-next',
  };
  snapshot = mergeTimelinePage(snapshot, history);
  snapshot = applyEvent(snapshot, { ...envelope, event_id: 'new-baseline', type: 'timeline', data: success.initial_timeline });
  assert.equal(snapshot.timeline.rounds.find(round => round.round_id === 'old-failure')?.status, 'FAILED');
  assert.equal(snapshot.timeline.next_cursor, 'opaque-history-next');
});

test('terminal failed rounds and completed failed steps cannot become success', () => {
  const before = seekRecording(failure, 30100);
  const round = before.timeline.rounds[0]!;
  const forged: SseEvent = { ...envelope, source: failure.source, event_id: 'forged-round', type: 'round', data: { ...round, status: 'SUCCEEDED' } };
  const after = applyEvent(before, forged);
  assert.equal(after.timeline.rounds[0]?.status, 'FAILED');
  const step = round.steps.find(item => item.result === 'FAIL')!;
  const changed = applyEvent(after, { ...forged, event_id: 'forged-step', type: 'step', data: { ...step, result: 'PASS' } });
  assert.equal(changed.timeline.rounds[0]?.steps.find(item => item.step_id === step.step_id)?.result, 'FAIL');
  const state = applyEvent(changed, { ...forged, event_id: 'forged-state', type: 'state', data: { ...before.state, latest_round: { ...round, status: 'SUCCEEDED' } } });
  assert.equal(state.state.latest_round?.status, 'FAILED');
});

test('unsupported versions and malformed events are rejected', () => {
  assert.throws(() => parseRecording({ ...success, schema_version: 3 }), /不支持的数据版本/);
  assert.throws(() => parseRecording({ ...success, initial_state: { ...success.initial_state, schema_version: 3 } }), /混合的数据版本/);
  assert.throws(() => applyEvent(createSnapshot(success), { ...envelope, event_id: 'bad', type: 'state', data: null } as unknown as SseEvent), /数据格式错误/);
  assert.throws(() => parseRecording({ ...success, events: [success.events[1], success.events[0]] }), /录制事件顺序/);
});

class FakeSource extends EventTarget {
  closed = false;
  close(): void { this.closed = true; }
  emit(event: SseEvent): void {
    this.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.event_id }));
  }
}

test('the live consumer accepts the real caller event envelopes without losing earlier failures', () => {
  const transport = new FakeSource();
  const snapshots: Snapshot[] = [];
  const errors: string[] = [];
  const connection = new LiveConnection({
    url: '/api/stream', eventSourceFactory: () => transport as unknown as EventSource,
    onSnapshot: snapshot => snapshots.push(snapshot), onStatus: () => {}, onError: error => errors.push(error),
  });
  try {
    const baseline = { schema_version: 2 as const, source: testnetSuccess.source, emitted_at: testnetSuccess.started_at };
    transport.emit({ ...baseline, event_id: 'actual-baseline-state', type: 'state', data: testnetSuccess.initial_state });
    transport.emit({ ...baseline, event_id: 'actual-baseline-timeline', type: 'timeline', data: testnetSuccess.initial_timeline });
    for (const event of testnetSuccess.events) transport.emit(event);
    assert.deepEqual(errors, []);
    const final = snapshots.at(-1)!;
    assert.equal(final.state.source.kind, 'TESTNET');
    assert.deepEqual(final.state.build, testnetSuccess.build);
    assert.equal(final.timeline.rounds[0]?.status, 'SUCCEEDED');
    assert.equal(final.timeline.rounds[0]?.steps.length, 9);
    assert.equal(final.timeline.rounds.filter(round => round.status === 'FAILED').length, 5);
    assert.equal(connection.lastEventId, testnetSuccess.events.at(-1)?.event_id);
  } finally { connection.close(); }
});

test('an open SSE connection is not marked offline when only comment keepalives arrive', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = new FakeSource();
  const statuses: LiveStatus[] = [];
  const errors: string[] = [];
  const connection = new LiveConnection({
    url: '/api/stream', eventSourceFactory: () => transport as unknown as EventSource,
    onSnapshot: () => {}, onStatus: status => statuses.push(status), onError: error => errors.push(error),
  });
  try {
    transport.emit({ ...envelope, event_id: 'comment-baseline-state', type: 'state', data: success.initial_state });
    transport.emit({ ...envelope, event_id: 'comment-baseline-timeline', type: 'timeline', data: success.initial_timeline });
    // Native EventSource consumes ': keepalive' without dispatching an event.
    context.mock.timers.tick(60000);
    assert.deepEqual(errors, []);
    assert.equal(statuses.at(-1), 'live');
    assert.equal(transport.closed, false);
    transport.dispatchEvent(new Event('error'));
    assert.equal(errors.length, 1);
    assert.equal(statuses.at(-1), 'offline');
  } finally { connection.close(); context.mock.timers.reset(); }
});

test('live requires both SSE baselines; heartbeat is transport-only; disconnect triggers fallback', () => {
  const transport = new FakeSource();
  const statuses: LiveStatus[] = [];
  const errors: string[] = [];
  const snapshots: unknown[] = [];
  const connection = new LiveConnection({ url: '/api/stream', eventSourceFactory: () => transport as unknown as EventSource, onSnapshot: snapshot => snapshots.push(snapshot), onStatus: status => statuses.push(status), onError: error => errors.push(error) });
  try {
    transport.emit({ ...envelope, event_id: 'live-state', type: 'state', data: success.initial_state });
    assert.equal(snapshots.length, 0);
    transport.emit({ ...envelope, event_id: 'live-timeline', type: 'timeline', data: success.initial_timeline });
    assert.deepEqual(statuses, ['connecting', 'live']);
    assert.equal(snapshots.length, 1);
    transport.emit({ ...envelope, event_id: 'live-heartbeat', type: 'heartbeat', data: { at: success.started_at } });
    assert.equal(snapshots.length, 1);
    transport.emit({ ...envelope, event_id: 'live-reset', type: 'resync', data: { reason: 'expired' } });
    assert.equal(connection.lastEventId, '');
    assert.equal(statuses.at(-1), 'resyncing');
    transport.emit({ ...envelope, event_id: 'resync-state', type: 'state', data: success.initial_state });
    assert.equal(snapshots.length, 1);
    transport.emit({ ...envelope, event_id: 'resync-timeline', type: 'timeline', data: success.initial_timeline });
    assert.equal(snapshots.length, 2);
    assert.equal(statuses.at(-1), 'live');
    transport.dispatchEvent(new Event('error'));
    assert.equal(statuses.at(-1), 'offline');
    assert.equal(errors.length, 1);
    assert.equal(transport.closed, true);
  } finally { connection.close(); }
});

test('live baseline timeout closes its stream and reports fallback once', async () => {
  const transport = new FakeSource();
  const errors: string[] = [];
  const connection = new LiveConnection({ url: '/api/stream', timeoutMs: 10, eventSourceFactory: () => transport as unknown as EventSource, onSnapshot: () => assert.fail('No complete baseline exists'), onStatus: () => {}, onError: reason => errors.push(reason) });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(transport.closed, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /超时/);
    transport.dispatchEvent(new Event('error'));
    assert.equal(errors.length, 1);
  } finally { connection.close(); }
});
