import { createServer, request, type ServerOptions, type Server } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { connect as tlsConnect } from 'node:tls';
import type { Duplex } from 'node:stream';

export type KillFault = 'F1' | 'F2';
export interface FaultBoundary { fault: KillFault; phase: 'REQUEST_FORWARDED_RESPONSE_HELD'; at: string }

/** ChildProcess handle ownership, never a PID file, pkill, or a service name. */
export async function killOwnedChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('OWNED_CHILD_NOT_RUNNING');
  const exited = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CHILD_KILL_TIMEOUT')), 10_000);
    child.once('exit', (_code, signal) => {
      clearTimeout(timeout);
      if (signal === 'SIGKILL') resolve(); else reject(new Error('CHILD_NOT_SIGKILLED'));
    });
  });
  if (!child.kill('SIGKILL')) throw new Error('CHILD_KILL_FAILED');
  await exited;
}

interface ProxyOptions {
  tls: ServerOptions;
  onBoundary: (boundary: FaultBoundary) => Promise<void>;
  /** Only loopback simulation can override the hardcoded official testnet origins. */
  simulation?: { rest_origin: string; websocket_origin?: string };
}

/** TLS fault transport supported by the kernel's existing demo-only custom-CA gate.
 * Signed request paths/bodies/headers and listenKeys are never logged or returned.
 * The chosen order response cannot reach the child before onBoundary has finished.
 */
export class ControlledFaultProxy {
  readonly server: Server;
  private armed: KillFault | null = null;
  private readonly sockets = new Set<Duplex>();
  private readonly rest: URL;
  private readonly ws: URL;
  private readonly simulate: boolean;
  private failed: string | null = null;
  private consumed = false;
  private inflight = 0;

  constructor(private readonly options: ProxyOptions) {
    this.rest = new URL(options.simulation?.rest_origin ?? 'https://demo-fapi.binance.com');
    this.ws = new URL(options.simulation?.websocket_origin ?? 'wss://demo-fstream.binance.com');
    this.simulate = options.simulation !== undefined;
    if (this.simulate && (this.rest.hostname !== '127.0.0.1' || !['http:', 'https:'].includes(this.rest.protocol)
      || (options.simulation?.websocket_origin && this.ws.hostname !== '127.0.0.1'))) throw new Error('SIMULATION_MUST_BE_LOOPBACK');
    this.server = createServer(options.tls, (incoming, outgoing) => {
      void this.forward(incoming, outgoing).catch(() => { this.failed = 'PROXY_REQUEST_FAILED'; outgoing.destroy(); });
    });
    this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
    this.server.on('upgrade', (incoming, downstream, head) => {
      const upstream = tlsConnect({ host: this.ws.hostname, port: Number(this.ws.port || 443), servername: this.ws.hostname,
        rejectUnauthorized: true }, () => {
        // Preserve the raw frame stream, including exchange ping/pong and all user events.
        const headers = Object.entries(incoming.headers).filter(([key]) => key !== 'host')
          .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\r\n');
        upstream.write(`GET ${incoming.url} HTTP/1.1\r\nHost: ${this.ws.host}\r\n${headers}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(downstream); downstream.pipe(upstream);
      });
      upstream.on('error', () => { this.failed = 'PROXY_WEBSOCKET_FAILED'; downstream.destroy(); });
      downstream.on('error', () => upstream.destroy());
      downstream.on('close', () => upstream.destroy());
    });
  }
  arm(fault: KillFault): void {
    if (this.armed || this.consumed) throw new Error('FAULT_ALREADY_ARMED_OR_USED');
    this.armed = fault;
  }
  get status(): { armed: KillFault | null; consumed: boolean; failure: string | null } {
    return { armed: this.armed, consumed: this.consumed, failure: this.failed };
  }
  reset(): void {
    if (this.armed || this.inflight !== 0) throw new Error('FAULT_STILL_IN_PROGRESS');
    this.consumed = false; this.failed = null;
  }
  disarm(): void {
    if (this.inflight !== 0) throw new Error('FAULT_STILL_IN_PROGRESS');
    this.armed = null;
  }
  async listen(port = 0): Promise<number> {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PROXY_PORT');
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, '127.0.0.1', resolve); });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('PROXY_ADDRESS_UNKNOWN');
    return address.port;
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private async forward(incoming: IncomingMessage, outgoing: import('node:http').ServerResponse): Promise<void> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of incoming) {
      const buffer = Buffer.from(part as Uint8Array); size += buffer.length;
      if (size > 1_048_576) throw new Error('REQUEST_TOO_LARGE');
      parts.push(buffer);
    }
    const body = Buffer.concat(parts);
    const relative = new URL(incoming.url ?? '/', 'https://invalid.local');
    const parameters = new URLSearchParams(relative.search);
    for (const [key, value] of new URLSearchParams(body.toString())) parameters.set(key, value);
    const reduce = parameters.get('reduceOnly')?.toLowerCase() === 'true';
    const match = incoming.method === 'POST' && relative.pathname === '/fapi/v1/order'
      && parameters.get('type')?.toUpperCase() === 'MARKET' && this.armed === (reduce ? 'F2' : 'F1');
    const fault = match ? this.armed : null;
    if (fault) { this.armed = null; this.consumed = true; }
    const headers = { ...incoming.headers, host: this.rest.host };
    delete headers.connection;
    const destination = new URL(relative.pathname + relative.search, this.rest);
    const send = this.rest.protocol === 'http:' && this.simulate ? httpRequest : request;
    let boundary: Promise<void> = Promise.resolve();
    await new Promise<void>((resolve, reject) => {
      const upstream = send(destination, { method: incoming.method ?? 'GET', headers, timeout: 60_000 }, response => {
        response.pause();
        void boundary.then(() => {
          // A killed client's response is discarded; its exchange request still completes upstream.
          if (outgoing.destroyed) { response.resume(); response.once('end', resolve); return; }
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing); response.once('end', resolve);
        }, () => { response.resume(); outgoing.destroy(); reject(new Error('FAULT_BOUNDARY_FAILED')); });
      });
      upstream.on('error', () => reject(new Error('UPSTREAM_UNAVAILABLE')));
      upstream.on('timeout', () => upstream.destroy(new Error('UPSTREAM_TIMEOUT')));
      upstream.once('finish', () => {
        if (fault) {
          this.inflight++;
          boundary = this.options.onBoundary({ fault, phase: 'REQUEST_FORWARDED_RESPONSE_HELD', at: new Date().toISOString() })
            .finally(() => { this.inflight--; });
        }
        // Attach immediately, even if exchange errors before a response exists.
        void boundary.catch(() => { this.failed = 'FAULT_BOUNDARY_FAILED'; upstream.destroy(); });
      });
      upstream.end(body);
    });
  }
}
