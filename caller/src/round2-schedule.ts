import { DatabaseSync } from 'node:sqlite';

const MINUTE = 60_000;
export const ROUND_INTERVAL_MS = 30 * MINUTE;
export const HOUR_MS = 60 * MINUTE;
export type AutomaticScenario = 'S1' | 'S2' | 'S3' | 'S4' | 'S5';
export interface ScheduleSlot {
  key: string;
  due_at_ms: number;
  scenario_id: AutomaticScenario;
  direction: 'LONG' | 'SHORT';
  funding_settlement_at: string | null;
}
export const FAULT_GROUPS = ['F1', 'F2', 'F3', 'F4', 'F1', 'F2', 'F3', 'F4'] as const;

/** Absolute time slots: restart/reload never creates a bootstrap or catch-up round. */
export function round2Plan(start: number): ScheduleSlot[] {
  if (!Number.isSafeInteger(start) || start < 0) throw new Error('INVALID_START');
  const funding: ScheduleSlot[] = [];
  // Beijing 00/08/16 is UTC 16/00/08. These are the same eight-hour grid.
  for (let settlement = Math.ceil((start + 10 * MINUTE) / (8 * HOUR_MS)) * 8 * HOUR_MS;
    settlement + 10 * MINUTE <= start + 48 * HOUR_MS; settlement += 8 * HOUR_MS) {
    const due = settlement - 10 * MINUTE, elapsed = due - start;
    if (elapsed < 2 * HOUR_MS || (elapsed < 30 * HOUR_MS && elapsed + 20 * MINUTE > 24 * HOUR_MS)) continue;
    funding.push({ key: `funding-${settlement}`, due_at_ms: due, scenario_id: 'S4', direction: 'LONG',
      funding_settlement_at: new Date(settlement).toISOString() });
  }
  const smoke = ['S1', 'S1', 'S5', 'S2'] as const;
  const cycle = ['S1', 'S5', 'S2', 'S3'] as const;
  const slots: ScheduleSlot[] = [];
  let main = 0, sl = 0, tp = 0;
  for (let index = 0; index < 96; index++) {
    const due = start + index * ROUND_INTERVAL_MS;
    if (index >= 48 && index < 60) continue; // Supervised fault groups only.
    if (funding.some(f => Math.abs(f.due_at_ms - due) < ROUND_INTERVAL_MS)) continue;
    const id = index < 4 ? smoke[index]! : cycle[main++ % cycle.length]!;
    const direction = id === 'S5' ? 'SHORT' : id === 'S2' ? sl++ % 2 ? 'SHORT' : 'LONG'
      : id === 'S3' ? tp++ % 2 ? 'SHORT' : 'LONG' : 'LONG';
    slots.push({ key: `automatic-${index}`, due_at_ms: due, scenario_id: id, direction, funding_settlement_at: null });
  }
  return [...slots, ...funding].sort((a, b) => a.due_at_ms - b.due_at_ms);
}

/** Own scratch DB, separate from caller and kernel. A durable claim is never resent. */
export class Round2Schedule {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS schedule_config(singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT NOT NULL, start_ms INTEGER);
      INSERT OR IGNORE INTO schedule_config VALUES(1,'baseline',NULL);
      CREATE TABLE IF NOT EXISTS schedule_slots(key TEXT PRIMARY KEY,due_ms INTEGER NOT NULL,disposition TEXT NOT NULL,round_id TEXT,claimed_ms INTEGER,scenario_id TEXT NOT NULL,direction TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fault_groups(group_no INTEGER PRIMARY KEY,fault TEXT NOT NULL,started_ms INTEGER NOT NULL,fault_round TEXT,s1_round TEXT,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedule_samples(hour_no INTEGER PRIMARY KEY,at_ms INTEGER NOT NULL);`);
  }
  close(): void { this.db.close(); }
  get config(): { mode: 'baseline' | '2a'; start_ms: number | null } {
    return this.db.prepare('SELECT mode,start_ms FROM schedule_config').get() as unknown as { mode: 'baseline' | '2a'; start_ms: number | null };
  }
  switchMode(mode: 'baseline' | '2a', start?: number): void {
    if (mode === '2a' && (!Number.isSafeInteger(start) || start! < 0)) throw new Error('INVALID_START');
    const old = this.config;
    if (mode === '2a' && old.start_ms !== null && old.start_ms !== start) throw new Error('USE_NEW_SCHEDULE_DB');
    this.db.prepare('UPDATE schedule_config SET mode=?,start_ms=coalesce(start_ms,?)').run(mode, start ?? null);
  }
  claim(now: number, activeRound: boolean): ScheduleSlot | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { mode, start_ms: start } = this.config;
      if (mode !== '2a' || start === null) return null;
      const age = now - start;
      if (age < 0 || age >= 48 * HOUR_MS || (age >= 24 * HOUR_MS && age < 30 * HOUR_MS)) return null;
      // A dispatcher crash leaves an unresolved claim. Inspect its caller timeline before resolving it.
      if (this.db.prepare("SELECT 1 FROM schedule_slots WHERE disposition='CLAIMED'").get()) return null;
      if (this.db.prepare("SELECT 1 FROM fault_groups WHERE status!='CONFIRMED'").get()) return null;
      let selected: ScheduleSlot | null = null;
      for (const slot of round2Plan(start)) {
        if (slot.due_at_ms > now) break;
        if (this.db.prepare('SELECT 1 FROM schedule_slots WHERE key=?').get(slot.key)) continue;
        // One minute dispatcher window; delayed timers do not manufacture historical rounds.
        const last = this.db.prepare('SELECT max(claimed_ms) AS at FROM schedule_slots').get();
        const interval = last?.at === null || last?.at === undefined || now - Number(last.at) >= ROUND_INTERVAL_MS;
        const state = now - slot.due_at_ms >= MINUTE ? 'MISSED' : activeRound || !interval ? 'BUSY' : 'CLAIMED';
        if (state === 'CLAIMED' && (slot.scenario_id === 'S2' || slot.scenario_id === 'S3')) {
          const count = Number(this.db.prepare('SELECT count(*) AS n FROM schedule_slots WHERE claimed_ms IS NOT NULL AND scenario_id=?').get(slot.scenario_id)?.n);
          slot.direction = count % 2 ? 'SHORT' : 'LONG';
        }
        this.db.prepare('INSERT INTO schedule_slots VALUES(?,?,?,NULL,?,?,?)').run(slot.key, slot.due_at_ms, state, state === 'CLAIMED' ? now : null, slot.scenario_id, slot.direction);
        if (state === 'CLAIMED') { selected = slot; break; }
      }
      return selected;
    } finally { this.db.exec('COMMIT'); }
  }
  finish(key: string, roundId: string | null, outcome: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN'): void {
    const change = this.db.prepare("UPDATE schedule_slots SET disposition=?,round_id=? WHERE key=? AND disposition='CLAIMED'")
      .run(outcome, roundId, key);
    if (change.changes !== 1) throw new Error('SLOT_NOT_CLAIMED');
  }
  claimSample(now: number): boolean {
    const { mode, start_ms: start } = this.config;
    if (mode !== '2a' || start === null || now < start || now >= start + 48 * HOUR_MS) return false;
    return this.db.prepare('INSERT OR IGNORE INTO schedule_samples VALUES(?,?)').run(Math.floor((now - start) / HOUR_MS), now).changes === 1;
  }
  beginFault(groupNo: number, now: number, clean: boolean): string {
    const { mode, start_ms: start } = this.config;
    if (mode !== '2a' || start === null || now < start + 24 * HOUR_MS || now >= start + 30 * HOUR_MS) throw new Error('OUTSIDE_FAULT_WINDOW');
    if (!clean) throw new Error('CLEAN_ACCOUNT_REQUIRED');
    if (!Number.isInteger(groupNo) || groupNo < 1 || groupNo > FAULT_GROUPS.length) throw new Error('INVALID_FAULT_GROUP');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT * FROM fault_groups ORDER BY group_no DESC LIMIT 1').get();
      if ((previous && (previous.status !== 'CONFIRMED' || Number(previous.group_no) !== groupNo - 1 || now - Number(previous.started_ms) < ROUND_INTERVAL_MS))
        || (!previous && groupNo !== 1)) throw new Error('FAULT_GROUP_NOT_READY');
      const fault = FAULT_GROUPS[groupNo - 1]!;
      this.db.prepare("INSERT INTO fault_groups VALUES(?,?,?,NULL,NULL,'RUNNING')").run(groupNo, fault, now);
      return fault;
    } finally { this.db.exec('COMMIT'); }
  }
  recordFaultClean(group: number, faultRound: string, clean: boolean): void {
    if (!clean) throw new Error('CLEAN_ACCOUNT_REQUIRED');
    if (this.db.prepare("UPDATE fault_groups SET fault_round=?,status='CLEAN' WHERE group_no=? AND status='RUNNING'").run(faultRound, group).changes !== 1)
      throw new Error('FAULT_GROUP_NOT_RUNNING');
  }
  confirmFault(group: number, s1Round: string, succeeded: boolean): void {
    if (!succeeded) throw new Error('CONFIRMATION_FAILED');
    if (this.db.prepare("UPDATE fault_groups SET s1_round=?,status='CONFIRMED' WHERE group_no=? AND status='CLEAN'").run(s1Round, group).changes !== 1)
      throw new Error('FAULT_NOT_CLEAN');
  }
}
