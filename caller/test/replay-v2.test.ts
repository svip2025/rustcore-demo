import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ScenarioStep, StepActual } from '../../shared/schema.js';
import { normalizePublicWire } from '../../shared/replay.js';
import { parseRecording, seekRecording } from '../../web/src/model.js';
import { emptyMetrics } from '../src/round-accounting.js';
import { scenarioFor } from '../src/scenario-config.js';
import { DemoStore } from '../src/store.js';

const actual: StepActual = { summary: '合成契约往返，非真实交易证据', code: null, account: null, position: null,
  open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null };

test('v2 producer → durable SQLite → recording → consumer replay retains scenario, metrics and failure provenance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rustcore-contract-v2-'));
  const store = new DemoStore(join(directory, 'caller.sqlite'), { source: { kind: 'MOCK', label: '合成契约往返，非交易所证据' },
    build: { caller_commit: 'mock-caller-v2', rustcore_commit: 'mock-rustcore-v2' } });
  try {
    const scenario = scenarioFor('S2', 'SHORT');
    store.startRound('MANUAL', 'mock-s2-v2', undefined, scenario);
    for (const kind of ['preflight', 'cleanup_before', 'open_position', 'verify_protection', 'hold', 'cleanup_after'] as ScenarioStep[]) {
      const step = store.startStep('mock-s2-v2', kind, '合成判据', actual);
      store.finishStep('mock-s2-v2', step.step_id, 'PASS', '仅契约合成', actual);
    }
    const metrics = emptyMetrics();
    metrics.funding_usdt = '-0.12345678';
    metrics.step_durations_ms.hold = 2000;
    store.setRoundMetrics('mock-s2-v2', metrics);
    store.finishRound('mock-s2-v2', 'SUCCEEDED', '仅契约合成；不证明交易所能力');
    const exported = store.exportRecording('mock-s2-v2');
    const replayed = seekRecording(parseRecording(JSON.parse(JSON.stringify(exported))), Number.MAX_SAFE_INTEGER);
    assert.equal(exported.schema_version, 2);
    assert.equal(replayed.timeline.rounds[0]?.status, 'SUCCEEDED');
    assert.deepEqual(replayed.timeline.rounds[0]?.scenario, scenario);
    assert.deepEqual(replayed.timeline.rounds[0]?.metrics, metrics);
    assert.deepEqual(replayed.state.latest_round?.scenario, scenario);
    assert.equal(JSON.stringify(exported).includes('credential_id'), false);
    assert.equal(JSON.stringify(exported).includes('listenKey'), false);
    assert.throws(() => store.setRoundMetrics('mock-s2-v2', emptyMetrics()), /immutable/);
    const malformed = structuredClone(exported);
    const first = malformed.events.find(event => event.type === 'round')!;
    if (first.type === 'round') delete (first.data as unknown as Record<string, unknown>).scenario;
    assert.throws(() => parseRecording(malformed), /场景与指标/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('every original v1 recording replays without rewriting its bytes, source, conclusions or inventing scenario/fees', () => {
  const directory = new URL('../../recordings/', import.meta.url);
  const names = readdirSync(directory).filter(name => name.endsWith('.json'));
  let failed = 0;
  for (const name of names) {
    const file = new URL(name, directory);
    const before = readFileSync(file);
    const original = JSON.parse(before.toString()) as { schema_version: number; source: unknown };
    if (original.schema_version !== 1) continue;
    const recording = parseRecording(original);
    const final = seekRecording(recording, Number.MAX_SAFE_INTEGER);
    assert.equal(recording.schema_version, 2);
    assert.deepEqual(final.state.source, original.source);
    for (const round of final.timeline.rounds) {
      assert.equal(round.scenario, null);
      assert.equal(round.metrics, null);
      if (round.status === 'FAILED') failed++;
    }
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), createHash('sha256').update(before).digest('hex'));
    assert.equal(original.schema_version, 1);
  }
  assert.ok(failed >= 5, 'original failed rounds must remain visible');
  assert.throws(() => normalizePublicWire({ schema_version: 999 }), /不支持/);
  assert.throws(() => normalizePublicWire({ schema_version: 1, initial_state: { schema_version: 2 } }), /混合/);
});
