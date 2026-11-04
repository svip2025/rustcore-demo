import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { httpSettings, loadDemoConfig } from '../caller/src/config.js';
import { prepareStore } from '../caller/src/bootstrap.js';
import { acquireFileLock } from '../caller/src/file-lock.js';
import { createKernel } from '../caller/src/systemd-kernel.js';
import { openLocalControl } from '../caller/src/local-control.js';
import { CallerRuntime } from '../caller/src/runtime.js';
import { ScenarioRunner } from '../caller/src/scenario.js';
import { DemoStore } from '../caller/src/store.js';
import { createReadOnlyApp } from '../caller/src/http.js';
import { runPreflight } from '../caller/src/preflight.js';
import { prepareFaultTransport, FaultController, openFaultControl } from '../caller/src/fault-control.js';
import { ManagedKernel } from '../caller/src/kernel-process.js';

process.umask(0o077);
let shutdown: (() => Promise<void>) | undefined;
try {
  let config = loadDemoConfig();
  const http = httpSettings(config);
  for (const path of [config.callerDbFile, config.lockFile, ...(config.kernelMode === 'child' ? [config.kernelDbFile] : [])])
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const instance = await acquireFileLock(`${config.callerDbFile}.instance.lock`);
  let store: DemoStore | undefined;
  let runtime: CallerRuntime | undefined;
  let api: ReturnType<typeof createReadOnlyApp> | undefined;
  let listener: ServerType | undefined;
  let control: Awaited<ReturnType<typeof openLocalControl>> | undefined;
  let faultTransport: Awaited<ReturnType<typeof prepareFaultTransport>>;
  let faultControl: Awaited<ReturnType<typeof openFaultControl>> | undefined;
  let stopping: Promise<void> | undefined;
  shutdown = () => stopping ??= (async () => {
    api?.close();
    const closed = listener ? new Promise<void>(resolve => listener!.close(() => resolve())) : Promise.resolve();
    control?.close();
    faultControl?.close();
    await runtime?.stop();
    await faultTransport?.proxy.close();
    await closed;
    store?.close();
    await instance.release();
  })();
  store = new DemoStore(config.callerDbFile, { source: config.source, build: config.build });
  prepareStore(store, config);
  faultTransport = await prepareFaultTransport(config);
  if (faultTransport) config = faultTransport.config;
  const kernel = createKernel(config);
  runtime = new CallerRuntime(config, store, kernel);
  const runner = new ScenarioRunner(runtime);
  if (faultTransport) {
    if (!(kernel instanceof ManagedKernel)) throw new Error('FAULT_KERNEL_NOT_OWNED');
    const faultController = new FaultController(runtime, runner, kernel, faultTransport.proxy);
    faultTransport.setBoundaryHandler(event => faultController.onBoundary(event));
    faultControl = await openFaultControl(`${config.callerDbFile}.fault.sock`, faultController);
  }
  const proxyIp = (c: Context): string => {
    const remote = getConnInfo(c).remote.address ?? 'unknown';
    const supplied = c.req.header('x-real-ip');
    return http.trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && supplied && isIP(supplied)
      ? supplied : remote;
  };
  api = createReadOnlyApp(store, { ...(http.allowedOrigin ? { allowedOrigin: http.allowedOrigin } : {}), resolveIp: proxyIp });
  listener = serve({ fetch: api.app.fetch, hostname: http.hostname, port: http.port });
  await new Promise<void>((resolve, reject) => {
    listener!.once('error', reject);
    if (listener!.listening) resolve(); else listener!.once('listening', resolve);
  });
  const stop = () => { void shutdown!().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const checked = await runPreflight(config);
  if (checked.ok) {
    runtime.settings = { positionMode: checked.positionMode, marginMode: checked.marginMode, leverage: checked.leverage };
    await runtime.start();
    console.log(JSON.stringify({ event: 'caller_background_started', build: config.build }));
  } else console.error(JSON.stringify({ event: 'startup_preflight_failed', code: checked.code, reason: checked.reason }));
  control = await openLocalControl(`${config.callerDbFile}.sock`, runner, store);
  console.log(JSON.stringify({ event: 'caller_ready', source: config.source, build: config.build,
    reason: '只读接口与本机场景通道已就绪；开仓准入仍由内核判定' }));
} catch (error) {
  console.error(JSON.stringify({ event: 'caller_start_failed', code: error && typeof error === 'object' && 'code' in error ? error.code : 'CALLER_START_FAILED' }));
  await shutdown?.();
  process.exitCode = 1;
}
