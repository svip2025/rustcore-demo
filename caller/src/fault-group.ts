import type { RoundSummary, ScenarioConfig } from '../../shared/schema.js';
import { scenarioFor } from './scenario-config.js';
import type { FaultCommand } from './fault-control.js';
import { row, ScenarioFailure, type Row } from './facts.js';
import type { Round2Schedule } from './round2-schedule.js';

interface GroupOptions {
  schedule: Round2Schedule; group: number; now: () => number;
  command: (command: FaultCommand) => Promise<Row>;
  run: (scenario: ScenarioConfig, onEvent: (event: Row) => void) => Promise<RoundSummary>;
  network: (seconds: 60 | 300) => Promise<void>;
  pause: (milliseconds: number) => Promise<void>;
}

/** Fault group success means clean recovery + a separate S1 confirmation.
 * It never upgrades the immutable outcome of the injected round.
 */
export async function runFaultGroup(options: GroupOptions): Promise<{ fault_round: RoundSummary; s1_round: RoundSummary }> {
  const before = await options.command({ command: 'snapshot' });
  const fault = options.schedule.beginFault(options.group, options.now(), before.complete === true && before.clean === true);
  let original: Promise<RoundSummary> | undefined;
  try {
  let scenario = scenarioFor(fault as 'F1' | 'F2' | 'F3' | 'F4');
  if (fault === 'F3') scenario = { ...scenario, max_hold_ms: (options.group <= 4 ? 60 : 300) * 1000 + 30_000 };
  if (fault === 'F4' && options.group > 4) scenario = { ...scenarioFor('S2'), scenario_id: 'F4' };
  if (fault === 'F1' || fault === 'F2') await options.command({ command: 'arm', fault });
  let injected: Promise<void> | undefined;
  let roundEnded = false;
  const running = options.run(scenario, event => {
    const step = row(event.data);
    if (injected || !['F3', 'F4'].includes(fault) || event.event !== 'step' || step.step !== 'verify_protection'
      || step.phase !== 'COMPLETED' || step.result !== 'PASS') return;
    injected = (async () => {
      if (fault === 'F3') {
        await options.command({ command: 'network' });
        await options.network(options.group <= 4 ? 60 : 300);
      } else await options.command({ command: 'stream', action: options.group <= 4 ? 'disconnect' : 'listen_key_expired' });
    })();
    // Always attach a handler, including when a later IPC error races this operation.
    void injected.catch(() => {});
  }).finally(() => { roundEnded = true; });
  original = running;
  void running.catch(() => {});
  if (fault === 'F1' || fault === 'F2') {
    const until = options.now() + 120_000;
    while (true) {
      const status = await options.command({ command: 'status' });
      if (status.phase === 'CRASHED') break;
      if (status.phase === 'UNKNOWN' || roundEnded || options.now() >= until) throw new ScenarioFailure('FAULT_BOUNDARY_NOT_PROVEN');
      await options.pause(100);
    }
    // Restart now so the original run can resolve its safety cleanup against the new boot.
    const recovery = options.command({ command: 'recover' });
    void recovery.catch(() => {});
    const faultRound = await running;
    const after = await recovery;
    if (after.clean !== true) throw new ScenarioFailure('FAULT_RECOVERY_NOT_PROVEN');
    options.schedule.recordFaultClean(options.group, faultRound.round_id, true);
    const s1 = await options.run(scenarioFor('S1'), () => {});
    options.schedule.confirmFault(options.group, s1.round_id, s1.status === 'SUCCEEDED');
    return { fault_round: faultRound, s1_round: s1 };
  }
  const faultRound = await running;
  if (!injected) throw new ScenarioFailure('FAULT_NOT_INJECTED');
  await injected;
  const after = await options.command({ command: 'recover' });
  if (after.clean !== true) throw new ScenarioFailure('FAULT_RECOVERY_NOT_PROVEN');
  options.schedule.recordFaultClean(options.group, faultRound.round_id, true);
  const s1 = await options.run(scenarioFor('S1'), () => {});
  options.schedule.confirmFault(options.group, s1.round_id, s1.status === 'SUCCEEDED');
  return { fault_round: faultRound, s1_round: s1 };
  } catch (error) {
    // No armed fault may survive a rejected/unreached original round and kill a
    // later unrelated entry. Cleanup never upgrades or confirms this failed group.
    await original?.catch(() => {});
    await options.command({ command: 'recover' }).catch(() => {});
    throw error;
  }
}
