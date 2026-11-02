/** Check handwritten fixtures against the single public TS contract and replay rules. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import type { Recording, RoundSummary, TimelineStep } from '../shared/schema.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = ['recordings/mock-success-v1.json', 'recordings/mock-failure-v1.json'];
const literals = await Promise.all(paths.map(async path => JSON.stringify(JSON.parse(
  await readFile(new URL(`../${path}`, import.meta.url), 'utf8'),
))));

// Literal assignments let TypeScript check JSON unions and required fields without
// a second schema definition, unsafe JSON import casts, or generated tracked files.
const temporary = `${root}.recording-check-${randomUUID()}.ts`;
try {
  await writeFile(temporary,
    `import type { Recording } from './shared/schema.js';\n` +
    literals.map((value, i) => `const recording${i}: Recording = ${value};`).join('\n'),
    { flag: 'wx' });
  const checked = spawnSync(process.execPath, [
    `${root}node_modules/typescript/bin/tsc`, '--noEmit', '--strict',
    '--exactOptionalPropertyTypes', '--noUncheckedIndexedAccess', '--skipLibCheck',
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', temporary,
  ], { cwd: root, encoding: 'utf8' });
  if (checked.error) throw checked.error;
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
} finally {
  await unlink(temporary);
}

const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const decimal = /^-?\d+(?:\.\d+)?$/;
const decimalFields = new Set([
  'equity_usdt', 'available_usdt', 'quantity', 'entry_price', 'mark_price',
  'notional_usdt', 'price', 'trigger_price', 'average_price',
  'day_start_equity_usdt', 'equity_high_water_usdt', 'approximate_today_pnl_usdt',
]);

function checkLeaves(value: unknown, recording: Recording, trigger: RoundSummary['trigger']): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) checkLeaves(item, recording, trigger);
    return;
  }
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (key.endsWith('_at') || key === 'source_as_of') {
      if (child !== null) {
        assert.equal(typeof child, 'string', key);
        assert.match(String(child), iso, key);
        assert.equal(new Date(String(child)).toISOString(), child, key);
      }
    }
    if (decimalFields.has(key) && child !== null) {
      assert.equal(typeof child, 'string', key);
      assert.match(String(child), decimal, key);
    }
    if (key === 'source') assert.deepEqual(child, recording.source);
    if (key === 'build') assert.deepEqual(child, recording.build);
    assert.ok(!key.includes('realized'), 'public fields must describe approximate PnL');
    if (key === 'btc_leverage') assert.equal(child, 1, 'fixtures follow approved 1x scenario');
    if (key === 'credential_id') assert.fail('private credential_id in public fixture');
    checkLeaves(child, recording, trigger);
  }
  if ('round_id' in object && 'status' in object) assert.equal(object.trigger, trigger);
  if ('sl' in object && 'tp' in object) {
    const sl = object.sl as { kind: string; status: string };
    const tp = object.tp as { kind: string; status: string };
    assert.equal(sl.kind, 'SL');
    assert.equal(tp.kind, 'TP');
    if (sl.status === 'PASS' || tp.status === 'PASS') assert.ok(object.observation_id);
  }
}

for (const [index, literal] of literals.entries()) {
  // The literal has passed the same TypeScript assignment as an imported producer.
  const recording: Recording = JSON.parse(literal);
  assert.equal(recording.source.kind, 'MOCK');
  assert.match(recording.source.label, /手写假数据/);
  assert.equal(recording.build.caller_commit, 'mock-caller-v1');
  assert.equal(recording.build.rustcore_commit, 'mock-rustcore-v1');
  checkLeaves(recording, recording, index === 0 ? 'SCHEDULED' : 'MANUAL');
  assert.ok(recording.started_at <= recording.ended_at);
  assert.equal(recording.initial_state.generated_at, recording.started_at);
  assert.equal(recording.initial_timeline.generated_at, recording.started_at);

  const ids = new Set<string>();
  const rounds = new Map<string, RoundSummary>();
  const steps = new Map<string, TimelineStep>();
  let previous = recording.started_at;
  for (const round of recording.initial_timeline.rounds) {
    rounds.set(round.round_id, round);
    for (const step of round.steps) steps.set(`${step.round_id}/${step.step_id}`, step);
  }
  for (const event of recording.events) {
    assert.ok(!ids.has(event.event_id), 'duplicate public event ID');
    ids.add(event.event_id);
    assert.ok(previous <= event.emitted_at && event.emitted_at <= recording.ended_at,
      'events must remain in recording emission order');
    previous = event.emitted_at;
    if (event.type === 'round') {
      const old = rounds.get(event.data.round_id);
      if (old) assert.equal(event.data.trigger, old.trigger);
      if (old && old.status !== 'RUNNING') assert.deepEqual(event.data, old);
      rounds.set(event.data.round_id, event.data);
    } else if (event.type === 'step') {
      assert.ok(rounds.has(event.data.round_id), 'round must precede its steps');
      const key = `${event.data.round_id}/${event.data.step_id}`;
      const old = steps.get(key);
      if (old?.phase === 'COMPLETED') assert.deepEqual(event.data, old);
      assert.ok(event.data.started_at <= event.emitted_at);
      if (event.data.ended_at !== null) {
        assert.ok(event.data.started_at <= event.data.ended_at);
        assert.ok(event.data.ended_at <= event.emitted_at);
      }
      steps.set(key, event.data);
    }
  }
  assert.equal(rounds.size, 1);
  const round = [...rounds.values()][0]!;
  const completed = [...steps.values()].sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(completed.map(step => step.sequence), completed.map((_, i) => i + 1));
  assert.ok(completed.every(step => step.phase === 'COMPLETED'));
  if (index === 0) {
    assert.equal(round.status, 'SUCCEEDED');
    assert.equal(completed.length, 9);
    assert.ok(completed.every(step => step.result === 'PASS'));
    const statuses = new Set<string>(recording.events.flatMap(event =>
      event.type === 'state' ? [event.data.rustcore.status] : []));
    for (const status of ['ONLINE', 'RESTARTING', 'OFFLINE']) assert.ok(statuses.has(status));
  } else {
    assert.equal(round.status, 'FAILED');
    const protection = completed.find(step => step.step === 'verify_protection');
    assert.equal(protection?.result, 'FAIL');
    assert.equal(protection.actual.protection?.sl.status, 'PASS');
    assert.equal(protection.actual.protection?.tp.status, 'FAIL');
    assert.equal(completed.at(-1)?.step, 'cleanup_after');
    assert.equal(completed.at(-1)?.result, 'PASS');
  }
  console.log(`${paths[index]}: v1 typecheck and replay consistency PASS (${ids.size} events)`);
}
