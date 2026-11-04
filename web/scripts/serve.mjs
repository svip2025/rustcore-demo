import { createServer, request as httpRequest } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const apiPaths = new Set(['/api/health', '/api/state', '/api/timeline', '/api/stream']);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };

/** A fixed literal loopback target; no DNS, arbitrary paths, or credentials. */
export function parseProxyTarget(value) {
  if (!value) return null;
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/?$/.exec(value);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('DEMO_API_PROXY must be an explicit loopback URL: http://127.0.0.1:<port>.');
  }
  return new URL(value);
}

function proxyRead(request, response, target, url) {
  const headers = { accept: url.pathname === '/api/stream' ? 'text/event-stream' : 'application/json' };
  if (url.pathname === '/api/stream' && typeof request.headers['last-event-id'] === 'string') {
    headers['last-event-id'] = request.headers['last-event-id'];
  }
  // Forward only the public cursor and fixed Accept header. Browser Origin,
  // cookies, authorization, host and proxy identity headers never reach caller.
  const upstream = httpRequest({ hostname: target.hostname, port: target.port || 80, method: 'GET', path: url.pathname + url.search, headers });
  const deadline = setTimeout(() => upstream.destroy(new Error('Caller connection timed out.')), 10000);
  const cancel = () => { clearTimeout(deadline); upstream.destroy(); };
  response.on('close', cancel);
  request.on('aborted', cancel);
  upstream.on('response', (incoming) => {
    clearTimeout(deadline);
    response.statusCode = incoming.statusCode ?? 502;
    response.setHeader('Content-Type', incoming.headers['content-type'] ?? 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (incoming.headers['retry-after']) response.setHeader('Retry-After', incoming.headers['retry-after']);
    if (url.pathname === '/api/stream') response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    incoming.on('error', () => response.destroy());
    // pipe preserves backpressure and sends every SSE chunk as it arrives.
    incoming.pipe(response);
  });
  upstream.on('error', () => {
    clearTimeout(deadline);
    if (response.destroyed) return;
    if (response.headersSent) { response.destroy(); return; }
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Caller unavailable\n');
  });
  upstream.end();
}

export async function createPreviewServer({ root = defaultRoot, proxyTarget = null } = {}) {
  const target = proxyTarget instanceof URL ? parseProxyTarget(proxyTarget.href) : parseProxyTarget(proxyTarget);
  const rootReal = await realpath(root);
  const config = JSON.parse(await readFile(resolve(rootReal, 'config.json'), 'utf8'));
  const connectOrigin = config.api_base?.startsWith('https://') ? ` ${new URL(config.api_base).origin}` : '';
  const csp = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'${connectOrigin}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'`;
  return createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', csp);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-cache');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed\n');
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        if (apiPaths.has(url.pathname) && request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
          response.end();
          return;
        }
        if (!target || !apiPaths.has(url.pathname)) throw new Error('No read-only API route');
        proxyRead(request, response, target, url);
        return;
      }
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes('\0')) throw new Error('Invalid path');
      const path = resolve(rootReal, `.${pathname === '/' ? '/index.html' : pathname}`);
      const targetReal = await realpath(path);
      const pathFromRoot = relative(rootReal, targetReal);
      if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..' || pathFromRoot.startsWith(sep)) throw new Error('Invalid path');
      if (!(await stat(targetReal)).isFile()) throw new Error('Not a file');
      response.writeHead(200, { 'Content-Type': mime[extname(targetReal)] ?? 'application/octet-stream' });
      if (request.method === 'HEAD') response.end();
      else response.end(await readFile(targetReal));
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : 'Not found\n');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  const server = await createPreviewServer({ proxyTarget: process.env.DEMO_API_PROXY ?? null });
  server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
