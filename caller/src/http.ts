import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import type { SseEvent, StateResponse } from '../../shared/schema.js';
import type { DemoStore } from './store.js';

export interface ReadOnlyHttpOptions {
  allowedOrigin?: string;
  /** Override only when the caller explicitly trusts its reverse proxy. */
  resolveIp?: (context: Context) => string;
  rateLimit?: number;
  windowMs?: number;
}

const MAX_QUEUED_EVENTS = 128;
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const MAX_RATE_BUCKETS = 10_000;
const encoder = new TextEncoder();

function available(state: StateResponse, now: number): boolean {
  const recent = (at: string | null) => {
    const time = at === null ? NaN : Date.parse(at);
    return Number.isFinite(time) && time <= now && now - time <= 30_000;
  };
  return state.rustcore.status === 'ONLINE' && recent(state.rustcore.checked_at)
    && [state.account, state.positions, state.open_orders, state.protection]
      .every(value => value.status === 'AVAILABLE' && value.value !== null && recent(value.source_as_of));
}

/** Only public store projections are reachable through this app. */
export function createReadOnlyApp(store: DemoStore, options: ReadOnlyHttpOptions = {}) {
  const { allowedOrigin } = options;
  if (allowedOrigin !== undefined) {
    const parsed = new URL(allowedOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== allowedOrigin)
      throw new Error('allowedOrigin must be one exact HTTP or HTTPS origin');
  }
  const rateLimit = options.rateLimit ?? 120;
  const windowMs = options.windowMs ?? 60_000;
  if (!Number.isSafeInteger(rateLimit) || rateLimit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1)
    throw new Error('rateLimit and windowMs must be positive safe integers');
  const app = new Hono();
  const buckets = new Map<string, { count: number; expiresAt: number }>();
  const connections = new Set<() => void>();
  let closed = false;
  const sweep = () => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.expiresAt <= now) buckets.delete(key);
  };
  const cleanupTimer = setInterval(sweep, Math.min(windowMs, 60_000));
  cleanupTimer.unref();

  app.onError((_error, context) => context.json({ error: 'Read unavailable' }, 503));
  app.use('*', async (context, next) => {
    context.header('Vary', 'Origin');
    context.header('Cache-Control', 'no-store');
    context.header('X-Content-Type-Options', 'nosniff');
    const origin = context.req.header('Origin');
    if (origin !== undefined) {
      const expectedOrigin = allowedOrigin ?? new URL(context.req.url).origin;
      if (origin !== expectedOrigin)
        return context.json({ error: 'Origin not allowed' }, 403);
      context.header('Access-Control-Allow-Origin', expectedOrigin);
    }
    if (context.req.method !== 'GET') {
      context.header('Allow', 'GET');
      return context.json({ error: 'Read only' }, 405);
    }
    if (closed) return context.json({ error: 'Read unavailable' }, 503);
    let ip: string;
    if (options.resolveIp) ip = options.resolveIp(context);
    else {
      // In-process requests have no adapter bindings. Never infer identity from XFF.
      try { ip = getConnInfo(context).remote.address ?? 'unknown'; }
      catch { ip = 'unknown'; }
    }
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || bucket.expiresAt <= now) {
      if (!bucket && buckets.size >= MAX_RATE_BUCKETS) sweep();
      if (!bucket && buckets.size >= MAX_RATE_BUCKETS)
        return context.json({ error: 'Too many requests' }, 429);
      bucket = { count: 0, expiresAt: now + windowMs };
      buckets.set(ip, bucket);
    }
    if (++bucket.count > rateLimit) {
      context.header('Retry-After', String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))));
      return context.json({ error: 'Too many requests' }, 429);
    }
    await next();
  });

  app.get('/api/health', context => {
    const state = store.getState();
    const healthy = available(state, Date.now());
    return context.json({ schema_version: 1, status: healthy ? 'healthy' : 'degraded',
      dependencies: { rustcore: state.rustcore.status, account: state.account.status,
        positions: state.positions.status, open_orders: state.open_orders.status,
        protection: state.protection.status, risk_budget: state.risk_budget.status },
      generated_at: state.generated_at, checked_at: new Date().toISOString() }, healthy ? 200 : 503);
  });
  app.get('/api/state', context => context.json(store.getState()));
  app.get('/api/timeline', context => {
    const rawLimit = context.req.query('limit');
    const cursor = context.req.query('cursor');
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if ((rawLimit !== undefined && !/^[1-9]\d*$/.test(rawLimit)) || limit > 100
      || (cursor !== undefined && (!cursor.length || cursor.length > 256)))
      return context.json({ error: 'Invalid timeline query' }, 400);
    try { return context.json(store.getTimeline(limit, cursor)); }
    catch { return context.json({ error: 'Invalid timeline query' }, 400); }
  });

  app.get('/api/stream', context => {
    const resync = context.req.header('Last-Event-ID') !== undefined
      || context.req.query('since_event_id') !== undefined;
    const signal = context.req.raw.signal;
    const queue: Uint8Array[] = [];
    let queuedBytes = 0;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let unsubscribe: (() => void) | undefined;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
      signal.removeEventListener('abort', finish);
      connections.delete(finish);
      queue.length = 0;
      queuedBytes = 0;
      try { controller?.close(); } catch { /* The reader may already have cancelled. */ }
    };
    const pump = () => {
      if (!controller || finished) return;
      while (queue.length && (controller.desiredSize ?? 0) > 0) {
        const frame = queue.shift()!;
        queuedBytes -= frame.byteLength;
        controller.enqueue(frame);
      }
    };
    const enqueue = (frame: Uint8Array) => {
      if (finished) return;
      if (queue.length >= MAX_QUEUED_EVENTS || queuedBytes + frame.byteLength > MAX_QUEUED_BYTES) {
        finish(); // A slow client reconnects through an explicit full resync.
        return;
      }
      queue.push(frame);
      queuedBytes += frame.byteLength;
      pump();
    };
    const frame = (event: SseEvent) => encoder.encode(
      `event: ${event.type}\nid: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`);
    const buffered: SseEvent[] = [];
    let bufferedBytes = 0;
    let bootstrapping = true;
    unsubscribe = store.subscribe(event => {
      if (bootstrapping) {
        bufferedBytes += frame(event).byteLength;
        if (buffered.length >= MAX_QUEUED_EVENTS || bufferedBytes > MAX_QUEUED_BYTES) { finish(); return; }
        buffered.push(event);
      } else enqueue(frame(event));
    });
    let baseline: SseEvent[];
    try { baseline = store.snapshotEvents(resync); }
    catch { finish(); return context.json({ error: 'Read unavailable' }, 503); }
    const baselineIds = new Set(baseline.map(event => event.event_id));
    for (const event of baseline) enqueue(frame(event));
    for (const event of buffered) if (!baselineIds.has(event.event_id)) enqueue(frame(event));
    buffered.length = 0;
    bootstrapping = false;
    if (!finished) {
      connections.add(finish);
      signal.addEventListener('abort', finish, { once: true });
    }
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; if (finished) value.close(); else pump(); },
      pull() { pump(); },
      cancel() { finish(); },
    });
    if (signal.aborted) finish();
    if (!finished) {
      heartbeat = setInterval(() => {
        if (!queue.length) enqueue(encoder.encode(': keepalive\n\n'));
      }, 15_000);
      heartbeat.unref();
    }
    return context.newResponse(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } });
  });
  app.notFound(context => context.json({ error: 'Not found' }, 404));

  return { app, close() {
    if (closed) return;
    closed = true;
    clearInterval(cleanupTimer);
    buckets.clear();
    for (const finish of [...connections]) finish();
  } };
}
