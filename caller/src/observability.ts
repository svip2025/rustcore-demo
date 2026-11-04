import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Rpc } from './runtime.js';

export interface ResourceSample {
  sampled_at: string;
  kernel_rss_bytes: number | null;
  kernel_process_generation: string | null;
  database_bytes: { kernel: DatabaseBytes | null; caller: DatabaseBytes | null };
  websocket_reconnect_count: string | null;
  websocket_reconnects_last_minute: string | null;
  websocket_ready: boolean | null;
  websocket_scopes: Array<{ scope: 'USER_DATA_STREAM' | 'TRADE_WS_API' | 'MARKET_DATA';
    status: 'OBSERVED' | 'DISABLED' | 'NOT_OBSERVED' | 'UNKNOWN'; reconnect_count: string | null;
    reconnects_last_minute: string | null; exceeds_five_per_minute: boolean | null }>;
  clock_offset_ms: number | null;
  clock_uncertainty_ms: number | null;
  reasons: string[];
}
interface DatabaseBytes { main: number; wal: number; shm: number; total: number }
export interface ProcessIdentity { pid: number; start_ticks: string }

export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('INVALID_PID');
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const tail = contents.slice(contents.lastIndexOf(')') + 2).split(' ');
  const start = tail[19]; // proc field 22; tail starts at field 3.
  if (!start || !/^\d+$/.test(start)) throw new Error('INVALID_PROCESS_IDENTITY');
  return { pid, start_ticks: start };
}

export async function databaseBytes(file: string): Promise<DatabaseBytes> {
  const main = (await stat(file)).size;
  const optional = async (suffix: string): Promise<number> => {
    try { return (await stat(file + suffix)).size; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  };
  const [wal, shm] = await Promise.all([optional('-wal'), optional('-shm')]);
  return { main, wal, shm, total: main + wal + shm };
}

/** Independent failures retain nulls; a refreshed sample never invents zeros. */
export async function sampleResources(options: {
  kernel: ProcessIdentity | null; kernelDbFile: string; callerDbFile: string;
  rpc: Pick<Rpc, 'unary'>; credentialId: string;
  fetch?: typeof globalThis.fetch; now?: () => number;
}): Promise<ResourceSample> {
  const now = options.now ?? Date.now;
  const result: ResourceSample = { sampled_at: new Date(now()).toISOString(), kernel_rss_bytes: null,
    kernel_process_generation: null,
    database_bytes: { kernel: null, caller: null }, websocket_reconnect_count: null,
    websocket_reconnects_last_minute: null, websocket_ready: null,
    websocket_scopes: ['USER_DATA_STREAM', 'TRADE_WS_API', 'MARKET_DATA'].map(scope => ({
      scope: scope as 'USER_DATA_STREAM' | 'TRADE_WS_API' | 'MARKET_DATA', status: 'UNKNOWN', reconnect_count: null,
      reconnects_last_minute: null, exceeds_five_per_minute: null })),
    clock_offset_ms: null, clock_uncertainty_ms: null, reasons: [] };
  await Promise.all([
    (async () => {
      try {
        if (!options.kernel) throw new Error('KERNEL_OFFLINE');
        const before = await processIdentity(options.kernel.pid);
        const status = await readFile(`/proc/${before.pid}/status`, 'utf8');
        const after = await processIdentity(options.kernel.pid);
        if (before.start_ticks !== options.kernel.start_ticks || before.start_ticks !== after.start_ticks) throw new Error('PID_REUSED');
        const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
        if (!match || !Number.isSafeInteger(Number(match[1]) * 1024)) throw new Error('RSS_UNAVAILABLE');
        result.kernel_rss_bytes = Number(match[1]) * 1024;
        result.kernel_process_generation = createHash('sha256').update(`${before.pid}:${before.start_ticks}`).digest('hex');
      } catch { result.reasons.push('KERNEL_MEMORY_UNAVAILABLE'); }
    })(),
    ...(['kernel', 'caller'] as const).map(async name => {
      try { result.database_bytes[name] = await databaseBytes(name === 'kernel' ? options.kernelDbFile : options.callerDbFile); }
      catch { result.reasons.push(`${name.toUpperCase()}_DATABASE_SIZE_UNAVAILABLE`); }
    }),
    (async () => {
      try {
        const response = await options.rpc.unary('v2', 'GetRuntimeDiagnostics', { credential_id: options.credentialId, schema_version: 1 });
        const count = response.user_stream_reconnect_count, minute = response.user_stream_reconnects_last_minute;
        if (typeof count !== 'string' || !/^\d+$/.test(count) || typeof minute !== 'string' || !/^\d+$/.test(minute)
          || typeof response.user_stream_ready !== 'boolean' || !Number.isFinite(Number(response.observed_at_ms))
          || Math.abs(now() - Number(response.observed_at_ms)) > 30_000) throw new Error('INVALID_DIAGNOSTICS');
        result.websocket_reconnect_count = count;
        result.websocket_reconnects_last_minute = minute;
        result.websocket_ready = response.user_stream_ready;
        if (!Array.isArray(response.websocket_scopes)) { result.reasons.push('WEBSOCKET_SCOPE_COVERAGE_UNKNOWN'); return; }
        for (const target of result.websocket_scopes) {
          const matches = response.websocket_scopes.filter((v: unknown) => v !== null && typeof v === 'object' && 'scope' in v && v.scope === target.scope);
          if (matches.length !== 1) { result.reasons.push(`WEBSOCKET_${target.scope}_UNKNOWN`); continue; }
          const value = matches[0] as Record<string, unknown>;
          if (value.status === 'DISABLED' || value.status === 'NOT_OBSERVED') { target.status = value.status; continue; }
          if (value.status !== 'OBSERVED' || typeof value.reconnect_count !== 'string' || !/^\d+$/.test(value.reconnect_count)
            || typeof value.reconnects_last_minute !== 'string' || !/^\d+$/.test(value.reconnects_last_minute)) {
            result.reasons.push(`WEBSOCKET_${target.scope}_UNKNOWN`); continue;
          }
          target.status = 'OBSERVED'; target.reconnect_count = value.reconnect_count;
          target.reconnects_last_minute = value.reconnects_last_minute;
          target.exceeds_five_per_minute = BigInt(value.reconnects_last_minute) > 5n;
        }
      } catch { result.reasons.push('WEBSOCKET_DIAGNOSTICS_UNAVAILABLE'); }
    })(),
    (async () => {
      try {
        const sent = now();
        const response = await (options.fetch ?? globalThis.fetch)('https://demo-fapi.binance.com/fapi/v1/time', {
          method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        const body: unknown = await response.json(), received = now();
        if (!response.ok || body === null || typeof body !== 'object' || !('serverTime' in body)
          || !Number.isSafeInteger(body.serverTime) || received < sent) throw new Error('INVALID_CLOCK');
        result.clock_offset_ms = Number(body.serverTime) - (sent + received) / 2;
        result.clock_uncertainty_ms = (received - sent) / 2;
      } catch { result.reasons.push('EXCHANGE_CLOCK_UNAVAILABLE'); }
    })(),
  ]);
  result.reasons.sort();
  return result;
}
