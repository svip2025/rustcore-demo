import type { StateResponse, TimelineResponse } from '../../shared/schema.js';
import {
  applyEvent, assertTimeline, createLiveSnapshot, mergeTimelinePage, parseEvent,
  type Snapshot,
} from './model.js';

export type LiveStatus = 'connecting' | 'live' | 'resyncing' | 'offline';

export interface LiveOptions {
  url: string;
  onSnapshot: (snapshot: Snapshot) => void;
  onStatus: (status: LiveStatus) => void;
  onError: (reason: string) => void;
  timeoutMs?: number;
  /** Opt-in only: EventSource does not expose the caller's keepalive comments. */
  staleTimeoutMs?: number;
  sinceEventId?: string;
  /** Enables isolated transport tests without a network or runtime dependency. */
  eventSourceFactory?: (url: string) => EventSource;
}

/** A read-only SSE subscription. The UI owns switching to replay on onError. */
export class LiveConnection {
  lastEventId = '';
  private stream: EventSource | null = null;
  private snapshot: Snapshot | null = null;
  private pendingState: StateResponse | null = null;
  private pendingTimeline: TimelineResponse | null = null;
  private pendingIds: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private status: LiveStatus = 'connecting';
  private pageRequests = new Set<AbortController>();

  constructor(private readonly options: LiveOptions) {
    options.onStatus('connecting');
    this.lastEventId = options.sinceEventId ?? '';
    const url = this.lastEventId
      ? `${options.url}${options.url.includes('?') ? '&' : '?'}since_event_id=${encodeURIComponent(this.lastEventId)}`
      : options.url;
    this.watch(options.timeoutMs ?? 6000, '实时连接超时，尚未收到完整数据基线。');
    try {
      this.stream = options.eventSourceFactory?.(url) ?? new EventSource(url);
      for (const type of ['state', 'timeline', 'step', 'round', 'heartbeat', 'resync']) {
        this.stream.addEventListener(type, ((message: MessageEvent<string>) => this.receive(type, message)) as EventListener);
      }
      this.stream.addEventListener('error', () => this.fail('实时连接已断开，当前改为录制回放。'));
    } catch {
      // Defer so the caller can retain the new connection before fallback runs.
      queueMicrotask(() => this.fail('当前环境无法建立实时连接，当前改为录制回放。'));
    }
  }

  private setStatus(status: LiveStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.options.onStatus(status);
    }
  }

  private watch(timeout: number, reason: string): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(reason), timeout);
  }

  private receive(type: string, message: MessageEvent<string>): void {
    if (this.closed) return;
    try {
      const event = parseEvent(JSON.parse(message.data));
      if (event.type !== type || (message.lastEventId && message.lastEventId !== event.event_id)) {
        throw new Error('SSE 事件类型或标识与数据不一致。');
      }
      if (event.type === 'resync') {
        this.lastEventId = '';
        this.pendingIds = [];
        this.pendingState = null;
        this.pendingTimeline = null;
        if (this.snapshot) this.snapshot = applyEvent(this.snapshot, event);
        this.setStatus('resyncing');
        this.watch(this.options.timeoutMs ?? 6000, '重新同步超时，尚未收到完整数据基线。');
        return;
      }
      if (this.pendingIds.includes(event.event_id) || this.snapshot?.meta.seen.has(event.event_id)) return;
      this.lastEventId = event.event_id;
      if (!this.snapshot) {
        if (event.type === 'state') this.pendingState = event.data;
        else if (event.type === 'timeline') this.pendingTimeline = event.data;
        else if (event.type !== 'heartbeat') throw new Error('实时更新早于完整基线，请重新连接。');
        this.pendingIds.push(event.event_id);
        if (!this.pendingState || !this.pendingTimeline) return;
        this.snapshot = createLiveSnapshot(this.pendingState, this.pendingTimeline);
        this.snapshot.meta.seen = new Set(this.pendingIds);
        this.pendingIds = [];
        this.pendingState = null;
        this.pendingTimeline = null;
      } else {
        this.snapshot = applyEvent(this.snapshot, event);
      }
      if (this.snapshot.awaitingBaseline) return;
      // The caller also sends SSE comment keepalives, which EventSource handles
      // internally without dispatching an event. Silence in named events is
      // therefore not evidence that this connection has failed.
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      if (this.options.staleTimeoutMs !== undefined) {
        this.watch(this.options.staleTimeoutMs, '实时连接长时间没有消息，当前改为录制回放。');
      }
      this.setStatus('live');
      // Heartbeats only establish transport liveness; they are not observations.
      if (event.type !== 'heartbeat') this.options.onSnapshot(this.snapshot);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : '无法读取实时数据。');
    }
  }

  async loadMore(url: string): Promise<void> {
    if (this.closed || !this.snapshot || this.snapshot.awaitingBaseline) return;
    const request = new AbortController();
    this.pageRequests.add(request);
    try {
      const response = await fetch(url, { method: 'GET', signal: request.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('历史时间线暂时无法加载。');
      const page: unknown = await response.json();
      assertTimeline(page);
      if (this.closed || !this.snapshot || this.snapshot.awaitingBaseline) return;
      this.snapshot = mergeTimelinePage(this.snapshot, page);
      this.options.onSnapshot(this.snapshot);
    } finally {
      this.pageRequests.delete(request);
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.close();
    this.setStatus('offline');
    this.options.onError(reason);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.stream?.close();
    this.stream = null;
    for (const request of this.pageRequests) request.abort();
    this.pageRequests.clear();
  }
}
