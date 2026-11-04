import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DemoStore } from '../src/store.js';
import { openLocalControl } from '../src/local-control.js';
import { ScenarioFailure } from '../src/facts.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../scripts/run-round2.ts', import.meta.url));
const FAULT_SCRIPT = fileURLToPath(new URL('../../scripts/fault-round2.ts', import.meta.url));
const OPTIONS = { source: { kind: 'MOCK' as const, label: 'CLI offline IPC fixture' },
  build: { caller_commit: 'mock-caller-v1', rustcore_commit: 'mock-rustcore-v1' } };
interface Result { code: number; stdout: string; stderr: string }
function child(script: string, args: string[]): Promise<Result> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', script, ...args], { cwd: ROOT, shell: false, timeout: 20_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      if (error && (!('code' in error) || typeof error.code !== 'number')) { reject(error); return; }
      resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
async function fixture(work: (context: { directory: string; env: string; state: string; store: DemoStore;
  command: (action: string, extra?: string[]) => Promise<Result>; server: (run: Parameters<typeof openLocalControl>[1]['run']) => Promise<void> }) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'r2-cli-')), env = join(directory, 'env'), state = join(directory, 'schedule.db');
  const store = new DemoStore(join(directory, 'caller.db'), OPTIONS);
  let server: Server | undefined;
  const values = { ENGINE_LIVE_ENABLED: '0', ENGINE_STAGE_MAX: 'demo', DEMO_CREDENTIAL_ID: '9001',
    BINANCE_VENUE_H39303031: 'testnet', BINANCE_API_KEY_H39303031: 'offline-fixture-key', BINANCE_API_SECRET_H39303031: 'offline-fixture-secret',
    RUSTCORE_DB_URL: `sqlite://${join(directory, 'kernel.db')}`, DEMO_CALLER_DB_FILE: join(directory, 'caller.db'),
    DEMO_LOCK_FILE: join(directory, 'scenario.lock'), DEMO_KERNEL_BINARY: join(directory, 'unused-kernel'),
    DEMO_CALLER_COMMIT: 'a'.repeat(40), DEMO_RUSTCORE_COMMIT: 'b'.repeat(40) };
  await writeFile(env, Object.entries(values).map(([key, value]) => `${key}="${value}"`).join('\n'), { mode: 0o600 });
  try {
    await work({ directory, env, state, store, command: (action, extra = []) => child(SCRIPT, ['--action', action, '--state', state, '--env', env, ...extra]),
      server: async run => { server = await openLocalControl(`${join(directory, 'caller.db')}.sock`, { run }, store); } });
  } finally { if (server) await close(server); store.close(); await rm(directory, { recursive: true, force: true }); }
}
function readSchedule(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { mode: db.prepare('SELECT mode FROM schedule_config').get()?.mode,
    slots: db.prepare('SELECT key,disposition,round_id FROM schedule_slots ORDER BY due_ms').all() }; }
  finally { db.close(); }
}

test('activate/tick/restore subprocesses use real Unix IPC, preserve FAILED and never resend a consumed slot', async () => fixture(async context => {
  let calls = 0;
  await context.server(async (trigger, scenario) => {
    calls++; assert.equal(trigger, 'SCHEDULED'); assert.equal(scenario?.scenario_id, 'S1');
    const round = context.store.startRound(trigger, undefined, undefined, scenario);
    return context.store.finishRound(round.round_id, 'FAILED', 'retained offline caller failure');
  });
  const start = new Date(Date.now() - 1000).toISOString();
  assert.equal((await context.command('activate', ['--start', start])).code, 0);
  assert.equal(readSchedule(context.state).mode, '2a');
  assert.equal((await stat(context.state)).mode & 0o777, 0o600);
  const first = await context.command('tick');
  assert.equal(first.code, 1); assert.match(first.stdout, /round2_slot_completed/);
  const failed = context.store.getTimeline().rounds[0]!;
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.trigger, 'SCHEDULED');
  assert.equal(failed.reason, 'retained offline caller failure');
  assert.deepEqual(readSchedule(context.state).slots.map(slot => [slot.key, slot.disposition, slot.round_id]), [['automatic-0', 'FAILED', failed.round_id]]);
  assert.equal((await context.command('tick')).code, 0); assert.equal(calls, 1);
  assert.equal(context.store.getTimeline().rounds.length, 1);
  assert.equal((await context.command('restore')).code, 0); assert.equal(readSchedule(context.state).mode, 'baseline');
  assert.equal((await context.command('tick')).code, 0); assert.equal(calls, 1);
  assert.equal(context.store.getTimeline().rounds[0]?.status, 'FAILED');
}));

test('caller reports an IPC error after retaining FAILED: dispatcher retains UNKNOWN and does not retry', async () => fixture(async context => {
  let calls = 0;
  await context.server(async (trigger, scenario) => {
    calls++;
    const round = context.store.startRound(trigger, undefined, undefined, scenario);
    context.store.finishRound(round.round_id, 'FAILED', 'original failed round before IPC error');
    throw new ScenarioFailure('SIMULATED_IPC_FAILURE');
  });
  assert.equal((await context.command('activate', ['--start', new Date(Date.now() - 1000).toISOString()])).code, 0);
  const first = await context.command('tick');
  assert.equal(first.code, 1); assert.match(first.stderr, /round2_slot_unknown/);
  assert.equal(readSchedule(context.state).slots[0]?.disposition, 'UNKNOWN');
  assert.equal(readSchedule(context.state).slots[0]?.round_id, null);
  assert.equal((await context.command('tick')).code, 0); assert.equal(calls, 1);
  assert.equal(context.store.getTimeline().rounds[0]?.status, 'FAILED');
  assert.equal(context.store.getTimeline().rounds[0]?.reason, 'original failed round before IPC error');
}));

test('concurrent tick processes dispatch one IPC round; an active caller consumes no new execution', async () => fixture(async context => {
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  await context.server(async (trigger, scenario) => {
    calls++; const round = context.store.startRound(trigger, undefined, undefined, scenario); began();
    await gate;
    return context.store.finishRound(round.round_id, 'FAILED', 'concurrent dispatch retained once');
  });
  assert.equal((await context.command('activate', ['--start', new Date(Date.now() - 1000).toISOString()])).code, 0);
  const first = context.command('tick'), second = context.command('tick');
  try {
    await started;
    assert.equal(calls, 1);
    assert.equal(readSchedule(context.state).slots[0]?.disposition, 'CLAIMED');
    assert.ok(context.store.getState().active_round_id);
  } finally { release(); }
  const outcomes = await Promise.all([first, second]);
  assert.deepEqual(outcomes.map(outcome => outcome.code).sort(), [0, 1]);
  assert.equal(calls, 1); assert.equal(context.store.getTimeline().rounds.length, 1);
  assert.equal(readSchedule(context.state).slots[0]?.disposition, 'FAILED');
}));

test('fault CLI requires explicit test-VPS acknowledgement before reading config or changing a database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'r2-cli-ack-'));
  try {
    const state = join(directory, 'keep.db'); await writeFile(state, 'unrelated unchanged fixture');
    const result = await child(FAULT_SCRIPT, ['--state', state, '--group', '1', '--env', join(directory, 'nonexistent-env')]);
    assert.equal(result.code, 1); assert.match(result.stderr, /TEST_VPS_ACK_REQUIRED/);
    assert.equal(await readFile(state, 'utf8'), 'unrelated unchanged fixture');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
