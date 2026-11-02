import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadDemoConfig } from '../caller/src/config.js';
import { prepareStore } from '../caller/src/bootstrap.js';
import { acquireFileLock } from '../caller/src/file-lock.js';
import { ManagedKernel } from '../caller/src/kernel-process.js';
import { openLocalControl } from '../caller/src/local-control.js';
import { CallerRuntime } from '../caller/src/runtime.js';
import { ScenarioRunner } from '../caller/src/scenario.js';
import { DemoStore } from '../caller/src/store.js';

process.umask(0o077);
try {
  const config = loadDemoConfig();
  for (const path of [config.callerDbFile, config.kernelDbFile, config.lockFile]) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const instance = await acquireFileLock(`${config.callerDbFile}.instance.lock`);
  const store = new DemoStore(config.callerDbFile, { source: config.source, build: config.build });
  prepareStore(store, config);
  const runtime = new CallerRuntime(config, store, new ManagedKernel(config));
  const runner = new ScenarioRunner(runtime);
  const server = await openLocalControl(`${config.callerDbFile}.sock`, runner, store);
  console.log(JSON.stringify({ event: 'caller_ready', source: config.source, build: config.build, reason: '等待本机场景命令；首轮前检查测试网账户设置' }));
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    server.close(); await runtime.stop(); store.close(); await instance.release(); process.exit(0);
  };
  process.on('SIGINT', () => { void stop(); });
  process.on('SIGTERM', () => { void stop(); });
} catch (error) {
  console.error(JSON.stringify({ event: 'caller_start_failed', code: error && typeof error === 'object' && 'code' in error ? error.code : 'CALLER_START_FAILED' }));
  process.exitCode = 1;
}
