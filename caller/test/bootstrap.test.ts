import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareStore } from '../src/bootstrap.js';
import { DemoStore } from '../src/store.js';

test('caller upgrade preserves an interrupted failed recording and binds new observations to the new build', () => {
  const directory = mkdtempSync(join(tmpdir(), 'demo-upgrade-'));
  const source = { kind: 'MOCK' as const, label: '手写测试数据' };
  const old = { source, build: { caller_commit: 'mock-old-caller', rustcore_commit: 'mock-core' } };
  const next = { source, build: { caller_commit: 'mock-new-caller', rustcore_commit: 'mock-core' } };
  let store = new DemoStore(join(directory, 'caller.db'), old);
  try {
    const round = store.startRound('MANUAL');
    const step = store.startStep(round.round_id, 'open_position', 'observe actual fill', { summary: 'original pending request', code: 'SUBMITTED',
      account: null, position: null, open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null });
    store.close(); store = new DemoStore(join(directory, 'caller.db'), next);
    prepareStore(store, next);
    assert.deepEqual(store.getState().build, next.build);
    const recording = store.exportRecording(round.round_id);
    assert.deepEqual(recording.build, old.build);
    assert.equal(store.getTimeline().rounds[0]?.status, 'FAILED');
    const previous = store.getTimeline().rounds[0]?.steps.find(s => s.step_id === step.step_id);
    assert.equal(previous?.result, 'UNKNOWN'); assert.match(previous!.actual.summary, /original pending request/);
    assert.equal(store.getState().account.status, 'UNKNOWN');
    const newRound = store.startRound('MANUAL');
    assert.notEqual(newRound.round_id, round.round_id);
    assert.equal(store.getTimeline().rounds.length, 2);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a different source cannot relabel existing mock history as testnet', () => {
  const store = new DemoStore(':memory:', { source: { kind: 'MOCK', label: 'mock' }, build: { caller_commit: 'mock', rustcore_commit: 'mock' } });
  try {
    assert.throws(() => prepareStore(store, { source: { kind: 'TESTNET', label: 'testnet' }, build: { caller_commit: 'abc', rustcore_commit: 'def' } }), /独立/);
    assert.equal(store.getState().source.kind, 'MOCK');
  } finally { store.close(); }
});
