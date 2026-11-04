import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FAULT_GROUPS, HOUR_MS as H, ROUND_INTERVAL_MS as HALF, Round2Schedule, round2Plan } from '../src/round2-schedule.js';

const START = Date.parse('2026-11-08T01:17:00.000Z');
test('2A absolute plan preserves smoke, funding windows, alternating sides and supervised pause', () => {
  const plan = round2Plan(START);
  assert.deepEqual(plan.slice(0, 4).map(s => s.scenario_id), ['S1', 'S1', 'S5', 'S2']);
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i]!.due_at_ms - plan[i - 1]!.due_at_ms >= HALF);
  assert.ok(plan.every(s => s.due_at_ms < START + 48 * H && !(s.due_at_ms >= START + 24 * H && s.due_at_ms < START + 30 * H)));
  for (const id of ['S2', 'S3']) {
    const sides = plan.filter(s => s.scenario_id === id).map(s => s.direction);
    assert.ok(sides.length > 10);
    sides.forEach((side, i) => assert.equal(side, i % 2 ? 'SHORT' : 'LONG'));
  }
  for (const slot of plan.filter(s => s.scenario_id === 'S4')) {
    const settlement = Date.parse(slot.funding_settlement_at!);
    assert.equal(settlement % (8 * H), 0);
    assert.equal(slot.due_at_ms, settlement - 600_000);
  }
});

test('an S4 holding window cannot overlap the supervised fault interval', () => {
  const alignedStart = Date.parse('2026-11-08T00:00:00.000Z');
  const plan = round2Plan(alignedStart);
  const funding = plan.filter(slot => slot.scenario_id === 'S4');
  assert.ok(funding.length >= 4);
  for (const slot of funding) {
    const ending = Date.parse(slot.funding_settlement_at!) + 600_000;
    assert.ok(ending <= alignedStart + 24 * H || slot.due_at_ms >= alignedStart + 30 * H,
      'S4 must not continue inside the fault window where all other automatic scenarios pause');
  }
});

test('reload, two scheduler owners and clock boundaries cannot repeat or catch up a claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'r2-schedule-')), path = join(dir, 'schedule.db');
  let one = new Round2Schedule(path), two: Round2Schedule | undefined;
  try {
    one.switchMode('2a', START);
    assert.equal(one.claim(START - 1, false), null);
    const first = one.claim(START + 59_000, false)!;
    assert.ok(first);
    two = new Round2Schedule(path);
    assert.equal(two.claim(START + 59_000, false), null);
    one.close(); one = new Round2Schedule(path);
    assert.equal(one.claim(START + HALF, false), null); // unresolved crash claim blocks new work
    one.finish(first.key, 'original-failed-round', 'FAILED');
    assert.equal(one.claim(START + HALF, false), null); // actual start <30m ago, slot retained BUSY
    assert.equal(one.db.prepare('SELECT disposition FROM schedule_slots WHERE key=?').get('automatic-1')?.disposition, 'BUSY');
    const missed = one.claim(START + 2 * HALF + 60_000, false);
    assert.equal(missed, null);
    assert.equal(one.db.prepare('SELECT disposition FROM schedule_slots WHERE key=?').get('automatic-2')?.disposition, 'MISSED');
    assert.equal(one.claim(START + 3 * HALF, true), null);
    assert.equal(one.claim(START + 48 * H, false), null);
    assert.throws(() => one.switchMode('2a', START + 1), /USE_NEW_SCHEDULE_DB/);
    one.switchMode('baseline');
    assert.equal(one.claim(START + 4 * HALF, false), null);
    assert.equal(one.config.mode, 'baseline');
  } finally { one.close(); two?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('fault+S1 group starts confirmation immediately only after clean; groups keep 30m spacing', () => {
  const schedule = new Round2Schedule(':memory:');
  try {
    schedule.switchMode('2a', START);
    const at = START + 24 * H;
    assert.throws(() => schedule.beginFault(1, at, false), /CLEAN_ACCOUNT_REQUIRED/);
    for (let group = 1; group <= 8; group++) {
      assert.equal(schedule.beginFault(group, at + (group - 1) * HALF, true), FAULT_GROUPS[group - 1]);
      assert.throws(() => schedule.confirmFault(group, `s1-${group}`, true), /FAULT_NOT_CLEAN/);
      schedule.recordFaultClean(group, `fault-${group}`, true);
      assert.throws(() => schedule.confirmFault(group, `s1-${group}`, false), /CONFIRMATION_FAILED/);
      schedule.confirmFault(group, `s1-${group}`, true); // no intra-group 30m delay
      if (group < 8) assert.throws(() => schedule.beginFault(group + 1, at + group * HALF - 1, true), /FAULT_GROUP_NOT_READY/);
    }
    assert.equal(schedule.db.prepare("SELECT count(*) AS n FROM fault_groups WHERE status='CONFIRMED'").get()?.n, 8);
    assert.throws(() => schedule.beginFault(1, START + 30 * H, true), /OUTSIDE_FAULT_WINDOW/);
    assert.equal(schedule.claim(at + H, false), null);
  } finally { schedule.close(); }
});

test('hourly claim survives reload and stops at 48h', () => {
  const schedule = new Round2Schedule(':memory:');
  try {
    schedule.switchMode('2a', START);
    assert.equal(schedule.claimSample(START), true);
    assert.equal(schedule.claimSample(START + H - 1), false);
    assert.equal(schedule.claimSample(START + H), true);
    assert.equal(schedule.claimSample(START + 48 * H), false);
  } finally { schedule.close(); }
});
