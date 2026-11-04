import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { RoundSummary, ScenarioConfig, ScenarioStep, StepActual } from '../../shared/schema.js';
import { runFaultGroup } from '../src/fault-group.js';
import { FAULT_GROUPS, HOUR_MS, ROUND_INTERVAL_MS, Round2Schedule } from '../src/round2-schedule.js';
import { DemoStore } from '../src/store.js';
import type { FaultCommand } from '../src/fault-control.js';
import type { Row } from '../src/facts.js';
import { withF3Network } from '../../scripts/fault-round2.js';

const START = Date.parse('2026-11-08T01:17:00.000Z');
const OPTIONS = { source: { kind: 'MOCK' as const, label: '离线故障组模拟' },
  build: { caller_commit: 'mock-caller-v1', rustcore_commit: 'mock-rustcore-v1' } };
const STEPS: ScenarioStep[] = ['preflight', 'cleanup_before', 'open_position', 'verify_protection', 'hold', 'restart_kernel', 'verify_recovery', 'close_position', 'cleanup_after'];
const actual: StepActual = { summary: 'Offline fixture observation', code: null, account: null, position: null,
  open_orders: null, protection: null, fill: null, rustcore: null, risk_budget: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(group: number, work: (schedule: Round2Schedule, store: DemoStore, now: number) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'r2-fault-group-'));
  const schedule = new Round2Schedule(join(dir, 'schedule.db')), store = new DemoStore(join(dir, 'caller.db'), OPTIONS);
  try {
    schedule.switchMode('2a', START);
    for (let prior = 1; prior < group; prior++) {
      schedule.beginFault(prior, START + 24 * HOUR_MS + (prior - 1) * ROUND_INTERVAL_MS, true);
      schedule.recordFaultClean(prior, `prior-fault-${prior}`, true); schedule.confirmFault(prior, `prior-s1-${prior}`, true);
    }
    await work(schedule, store, START + 24 * HOUR_MS + (group - 1) * ROUND_INTERVAL_MS);
  } finally { schedule.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
}
function complete(store: DemoStore, scenario: ScenarioConfig, successful: boolean): RoundSummary {
  const round = store.startRound('MANUAL', undefined, undefined, scenario);
  if (successful) for (const name of STEPS) {
    const step = store.startStep(round.round_id, name, 'Offline fixture', actual);
    store.finishStep(round.round_id, step.step_id, 'PASS', 'Offline fixture PASS', actual);
  }
  return store.finishRound(round.round_id, successful ? 'SUCCEEDED' : 'FAILED', successful ? 'Offline confirmation' : 'Original injected failure; retained');
}
const event = { event: 'step', data: { step: 'verify_protection', phase: 'COMPLETED', result: 'PASS' } };

test('fault group refuses incomplete or dirty before-snapshot without arming or starting a round', async () => {
  for (const before of [{ complete: false, clean: true }, { complete: true, clean: false }]) await fixture(1, async (schedule, _store, now) => {
    const commands: string[] = [];
    await assert.rejects(runFaultGroup({ schedule, group: 1, now: () => now,
      command: async command => { commands.push(command.command); return before; },
      run: async () => { throw new Error('must not run'); }, network: async () => { throw new Error('must not inject'); }, pause: async () => {},
    }), /CLEAN_ACCOUNT_REQUIRED/);
    assert.deepEqual(commands, ['snapshot']); assert.equal(schedule.db.prepare('SELECT count(*) n FROM fault_groups').get()?.n, 0);
  });
});

test('F1/F2 proved crash recovers before separate immediate S1 and preserves original FAILED round', async () => {
  for (const group of [1, 2]) await fixture(group, async (schedule, store, initial) => {
    let now = initial;
    const calls: string[] = [], finished = deferred<RoundSummary>();
    let original: RoundSummary | undefined;
    const options = { schedule, group, now: () => now,
      command: async (command: FaultCommand): Promise<Row> => {
        calls.push(command.command);
        if (command.command === 'snapshot') return { complete: true, clean: true };
        if (command.command === 'status') return { phase: 'CRASHED' };
        if (command.command === 'recover') {
          assert.equal(schedule.claim(START + 30 * HOUR_MS, false), null, 'unresolved fault group must block automatic dispatch after the fault window');
          original = complete(store, { ...optionsScenario, scenario_id: FAULT_GROUPS[group - 1]! }, false);
          finished.resolve(original); return { clean: true };
        }
        return {};
      },
      run: async (scenario: ScenarioConfig) => {
        calls.push(`run:${scenario.scenario_id}`);
        if (scenario.scenario_id !== 'S1') return finished.promise;
        assert.equal(now, initial, 'S1 must have no artificial thirty-minute delay');
        assert.ok(calls.indexOf('recover') < calls.indexOf('run:S1'));
        return complete(store, scenario, true);
      }, network: async () => { throw new Error('not a network fault'); }, pause: async (ms: number) => { now += ms; },
    };
    const optionsScenario: ScenarioConfig = { scenario_id: 'S1', direction: 'LONG', symbol: 'BTCUSDT', sl_pct: '0.01', tp_pct: '0.025',
      max_hold_ms: 60_000, exit_mode: 'ACTIVE_CLOSE', policy_version: 'risk_policy_v3', funding_settlement_at: null };
    const result = await runFaultGroup(options);
    assert.equal(result.fault_round.status, 'FAILED'); assert.equal(result.s1_round.status, 'SUCCEEDED');
    assert.equal(result.fault_round.round_id, original?.round_id);
    const retained = store.getTimeline().rounds.find(round => round.round_id === result.fault_round.round_id)!;
    assert.equal(retained.status, 'FAILED'); assert.equal(retained.reason, 'Original injected failure; retained');
    assert.equal(schedule.db.prepare('SELECT status FROM fault_groups WHERE group_no=?').get(group)?.status, 'CONFIRMED');
    assert.deepEqual(calls, ['snapshot', 'arm', `run:${FAULT_GROUPS[group - 1]}`, 'status', 'recover', 'run:S1']);
  });
});

test('F1/F2 unproved boundaries cannot start recovery confirmation or release automatic scheduling', async () => {
  for (const group of [1, 2]) await fixture(group, async (schedule, store, initial) => {
    let now = initial, runs = 0, recovered = 0;
    const pending = deferred<RoundSummary>();
    let faultScenario!: ScenarioConfig;
    await assert.rejects(runFaultGroup({ schedule, group, now: () => now,
      command: async command => {
        if (command.command === 'snapshot') return { complete: true, clean: true };
        if (command.command === 'recover') recovered++;
        return { phase: 'ARMED' };
      }, run: async scenario => { runs++; faultScenario = scenario; return pending.promise; },
      network: async () => {}, pause: async ms => { now += ms; },
    }), /FAULT_BOUNDARY_NOT_PROVEN/);
    pending.resolve(complete(store, faultScenario, false));
    assert.equal(runs, 1); assert.equal(recovered, 0);
    assert.equal(schedule.claim(START + 30 * HOUR_MS, false), null);
    assert.equal(store.getTimeline().rounds[0]?.status, 'FAILED');
  });
});

test('F3 network failure preserves FAILED and keeps group blocking; no S1 is manufactured', async () => fixture(3, async (schedule, store, now) => {
  const commands: string[] = [], runs: string[] = [], durations: number[] = [];
  await assert.rejects(runFaultGroup({ schedule, group: 3, now: () => now,
    command: async command => { commands.push(command.command); return { complete: true, clean: true }; },
    run: async (scenario, publish) => { runs.push(scenario.scenario_id); publish(event); return complete(store, scenario, false); },
    network: async seconds => { durations.push(seconds); throw new Error('SIMULATED_NETWORK_INSTALL_FAILED'); }, pause: async () => {},
  }), /SIMULATED_NETWORK_INSTALL_FAILED/);
  assert.deepEqual(durations, [60]); assert.deepEqual(runs, ['F3']); assert.deepEqual(commands, ['snapshot', 'network']);
  assert.equal(store.getTimeline().rounds[0]?.status, 'FAILED');
  assert.equal(schedule.claim(START + 30 * HOUR_MS, false), null);
}));

test('F3/F4 are injected only after protection PASS; clean recovery immediately runs S1', async () => {
  for (const group of [3, 4, 7, 8]) await fixture(group, async (schedule, store, now) => {
    const commands: FaultCommand[] = [], order: string[] = [], durations: number[] = [];
    const result = await runFaultGroup({ schedule, group, now: () => now,
      command: async command => { commands.push(command); order.push(command.command); return { complete: true, clean: true }; },
      run: async (scenario, publish) => {
        order.push(`run:${scenario.scenario_id}`);
        if (scenario.scenario_id !== 'S1') {
          assert.equal(commands.length, 1);
          publish({ event: 'step', data: { step: 'verify_protection', phase: 'COMPLETED', result: 'UNKNOWN' } });
          assert.equal(commands.length, 1, 'UNKNOWN protection must not inject');
          publish(event);
          if (group === 8) { assert.equal(scenario.exit_mode, 'WAIT_SL'); assert.equal(scenario.policy_version, 'risk_policy_testnet_v1'); }
        }
        return complete(store, scenario, scenario.scenario_id === 'S1');
      }, network: async seconds => { durations.push(seconds); }, pause: async () => {},
    });
    assert.equal(result.fault_round.status, 'FAILED'); assert.equal(result.s1_round.status, 'SUCCEEDED');
    assert.ok(order.indexOf('recover') < order.indexOf('run:S1'));
    if (group === 3 || group === 7) assert.deepEqual(durations, [group === 3 ? 60 : 300]);
    else assert.deepEqual(commands[1], { command: 'stream', action: group === 4 ? 'disconnect' : 'listen_key_expired' });
  });
});

test('unclean recovery and absent injection both prevent S1 confirmation', async () => {
  for (const inject of [true, false]) await fixture(4, async (schedule, store, now) => {
    const runs: string[] = [];
    await assert.rejects(runFaultGroup({ schedule, group: 4, now: () => now,
      command: async command => command.command === 'snapshot' ? { complete: true, clean: true } : { clean: false },
      run: async (scenario, publish) => { runs.push(scenario.scenario_id); if (inject) publish(event); return complete(store, scenario, false); },
      network: async () => {}, pause: async () => {},
    }), inject ? /FAULT_RECOVERY_NOT_PROVEN/ : /FAULT_NOT_INJECTED/);
    assert.deepEqual(runs, ['F4']); assert.equal(schedule.claim(START + 30 * HOUR_MS, false), null);
  });
});

test('F3 command wrapper always cleans up and requires explicit VERIFIED after the exact wait', async () => {
  for (const seconds of [60, 300] as const) {
    const calls: Array<string[] | number> = [];
    await withF3Network(seconds, '/tmp/offline-network-receipt.json', {
      command: async args => { calls.push(args); return args[0] === '--inject' ? { injection: 'ACTIVE' } : { cleanup: 'VERIFIED' }; },
      wait: async ms => { calls.push(ms); },
    });
    assert.deepEqual(calls, [['--inject', '--test-vps-ack', '--duration', String(seconds), '--state', '/tmp/offline-network-receipt.json'], seconds * 1000, ['--cleanup', '/tmp/offline-network-receipt.json']]);
  }
  const commands: string[] = [];
  await assert.rejects(withF3Network(60, '/tmp/offline-network-receipt.json', {
    command: async args => { commands.push(args[0]!); if (args[0] === '--inject') throw new Error('SIMULATED_INSTALL_FAILED'); return { cleanup: 'VERIFIED' }; }, wait: async () => {},
  }), /SIMULATED_INSTALL_FAILED/);
  assert.deepEqual(commands, ['--inject', '--cleanup']);
  await assert.rejects(withF3Network(60, '/tmp/offline-network-receipt.json', {
    command: async args => args[0] === '--inject' ? { injection: 'ACTIVE' } : { cleanup: 'UNKNOWN' }, wait: async () => {},
  }), /F3_CLEANUP_NOT_VERIFIED/);
});
