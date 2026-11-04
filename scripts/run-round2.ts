import { mkdir, chmod } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { loadDemoConfig } from '../caller/src/config.js';
import { requestLocalRound } from '../caller/src/local-control.js';
import { scenarioFor } from '../caller/src/scenario-config.js';
import { ROUND_INTERVAL_MS, Round2Schedule, round2Plan } from '../caller/src/round2-schedule.js';
import { DatabaseSync } from 'node:sqlite';

process.umask(0o077);
let schedule: Round2Schedule | undefined;
try {
  const args = process.argv.slice(2);
  const take = (name: string): string | undefined => {
    const at = args.indexOf(name); if (at < 0) return undefined;
    const value = args[at + 1];
    if (!value || value.startsWith('--')) throw new Error('ARGUMENT_MISSING');
    args.splice(at, 2); return value;
  };
  const action = take('--action'), startText = take('--start'), file = take('--state');
  const start = startText === undefined ? undefined : Date.parse(startText);
  if (startText && (!Number.isSafeInteger(start) || new Date(start!).toISOString() !== startText)) throw new Error('UTC_ISO_START_REQUIRED');
  if (action === 'plan') {
    if (start === undefined || args.length || file) throw new Error('PLAN_ARGUMENTS');
    console.log(JSON.stringify({ start: startText, automatic_slots: round2Plan(start),
      fault_window: { start_hour: 24, end_hour: 30, groups: 8, interval_minutes: 30,
        confirmation: 'MANUAL S1 immediately after complete clean proof; other automatic scenarios paused' } }, null, 2));
  } else {
    if (!['activate', 'restore', 'tick', 'status'].includes(String(action)) || !file || !isAbsolute(file)) throw new Error('ARGUMENT_INVALID');
    const config = loadDemoConfig(args);
    if ([config.kernelDbFile, config.callerDbFile, config.lockFile].includes(file)) throw new Error('INDEPENDENT_SCHEDULER_DATABASE_REQUIRED');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    schedule = new Round2Schedule(file); await chmod(file, 0o600);
    if (action === 'activate') schedule.switchMode('2a', start);
    if (action === 'restore') schedule.switchMode('baseline');
    if (action === 'tick') {
      // Read-only caller access. The caller retains the actual scenario lock and round lifecycle.
      const now = Date.now();
      const db = new DatabaseSync(config.callerDbFile, { readOnly: true });
      let active = true;
      try {
        const row = db.prepare('SELECT body FROM demo_state WHERE id=1').get();
        if (!row || typeof row.body !== 'string') throw new Error('CALLER_STATE_UNAVAILABLE');
        const state = JSON.parse(row.body) as { active_round_id: string | null; latest_round: { started_at: string } | null };
        const lastStarted = state.latest_round === null ? null : Date.parse(state.latest_round.started_at);
        // Manual rounds are absent from the scheduler's claim database but obey the same start interval.
        active = state.active_round_id !== null || (lastStarted !== null && (!Number.isFinite(lastStarted) || now - lastStarted < ROUND_INTERVAL_MS));
      } finally { db.close(); }
      const slot = schedule.claim(now, active);
      if (slot) {
        try {
          const scenario = scenarioFor(slot.scenario_id, slot.direction, slot.funding_settlement_at ?? undefined);
          const round = await requestLocalRound(`${config.callerDbFile}.sock`, 'SCHEDULED', () => {}, scenario);
          schedule.finish(slot.key, round.round_id, round.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED');
          console.log(JSON.stringify({ event: 'round2_slot_completed', slot: slot.key, round }));
          if (round.status !== 'SUCCEEDED') process.exitCode = 1;
        } catch {
          schedule.finish(slot.key, null, 'UNKNOWN');
          console.error(JSON.stringify({ event: 'round2_slot_unknown', slot: slot.key,
            reason: 'Read the retained caller timeline; this slot is consumed and is never retried.' }));
          process.exitCode = 1;
        }
      }
    }
    console.log(JSON.stringify({ event: 'round2_schedule', ...schedule.config,
      baseline_timer: 'Operator disables scenario.timer for 2A and restores it afterward; this command does not control services.' }));
  }
} catch {
  console.error(JSON.stringify({ event: 'round2_dispatch_failed', code: 'SCHEDULE_NOT_COMPLETED' })); process.exitCode = 1;
} finally { schedule?.close(); }
