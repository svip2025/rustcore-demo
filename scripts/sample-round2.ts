import { appendFile, chmod, readlink, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDemoConfig } from '../caller/src/config.js';
import { CoreRpc } from '../caller/src/grpc.js';
import { processIdentity, sampleResources } from '../caller/src/observability.js';
import { Round2Schedule } from '../caller/src/round2-schedule.js';
import { requestFaultControl } from '../caller/src/fault-control.js';

process.umask(0o077);
let schedule: Round2Schedule | undefined, rpc: CoreRpc | undefined;
try {
  const args = process.argv.slice(2);
  const take = (name: string) => {
    const at = args.indexOf(name), value = args[at + 1];
    if (at < 0 || !value || value.startsWith('--')) throw new Error('ARGUMENT_REQUIRED');
    args.splice(at, 2); return value;
  };
  const state = take('--state'), output = take('--output'), pidText = take('--kernel-pid');
  if (!isAbsolute(state) || !isAbsolute(output) || !/^(auto|0|[1-9]\d*)$/.test(pidText)) throw new Error('ARGUMENT_INVALID');
  const config = loadDemoConfig(args);
  let pid = Number(pidText);
  if (pidText === 'auto') {
    pid = 0;
    try {
      if (config.kernelMode === 'child') {
        const status = await requestFaultControl(`${config.callerDbFile}.fault.sock`, { command: 'status' }, { timeoutMs: 5_000 });
        if (typeof status.kernel_process_id === 'number' && Number.isSafeInteger(status.kernel_process_id)) pid = status.kernel_process_id;
      } else {
        const value = await promisify(execFile)('/usr/bin/systemctl', ['show', '--property=MainPID', '--value', 'rustcore.service'],
          { timeout: 5_000, maxBuffer: 1024, shell: false });
        if (/^[1-9]\d*$/.test(value.stdout.trim())) pid = Number(value.stdout.trim());
      }
    } catch { /* Other metrics still sample when process identity is unavailable. */ }
  }
  if ([config.kernelDbFile, config.callerDbFile, config.lockFile, state].includes(output)) throw new Error('INDEPENDENT_OUTPUT_REQUIRED');
  let identity: Awaited<ReturnType<typeof processIdentity>> | null = null;
  if (pid > 1) {
    try {
      identity = await processIdentity(pid);
      if (await realpath(await readlink(`/proc/${pid}/exe`)) !== await realpath(config.kernelBinary)) identity = null;
    } catch { identity = null; }
  }
  schedule = new Round2Schedule(state);
  if (schedule.claimSample(Date.now())) {
    rpc = new CoreRpc({ address: config.grpcAddress, protoDir: fileURLToPath(new URL('../rustcore/proto/', import.meta.url)),
      ...(config.environment.RUSTCORE_GRPC_AUTH_TOKEN ? { token: config.environment.RUSTCORE_GRPC_AUTH_TOKEN } : {}) });
    const sample = await sampleResources({ kernel: identity, kernelDbFile: config.kernelDbFile, callerDbFile: config.callerDbFile,
      credentialId: config.credentialId, rpc });
    await appendFile(output, JSON.stringify(sample) + '\n', { mode: 0o600 }); await chmod(output, 0o600);
    console.log(JSON.stringify({ event: 'hourly_sample_retained', sampled_at: sample.sampled_at, unavailable_fields: sample.reasons }));
  }
} catch {
  console.error(JSON.stringify({ event: 'hourly_sample_failed', code: 'SAMPLE_NOT_COMPLETED' })); process.exitCode = 1;
} finally { rpc?.close(); schedule?.close(); }
