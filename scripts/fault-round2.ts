import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadDemoConfig } from '../caller/src/config.js';
import { requestFaultControl } from '../caller/src/fault-control.js';
import { runFaultGroup } from '../caller/src/fault-group.js';
import { acquireFileLock, type FileLock } from '../caller/src/file-lock.js';
import { row, ScenarioFailure, type Row } from '../caller/src/facts.js';
import { requestLocalRound } from '../caller/src/local-control.js';
import { Round2Schedule } from '../caller/src/round2-schedule.js';
import { isIP } from 'node:net';

const executeFile = promisify(execFile);
const networkScript = fileURLToPath(new URL('./fault-network.py', import.meta.url));
interface NetworkDependencies {
  command: (arguments_: string[]) => Promise<Row>;
  wait: (milliseconds: number) => Promise<void>;
}

/** The independent timer is installed by fault-network.py before firewall writes.
 * The finally path still explicitly removes the owned chain and verifies absence.
 */
export async function withF3Network(seconds: 60 | 300, receipt: string, dependencies: NetworkDependencies): Promise<void> {
  if (![60, 300].includes(seconds) || !isAbsolute(receipt)) throw new ScenarioFailure('F3_ARGUMENT_INVALID');
  try {
    const injected = await dependencies.command(['--inject', '--test-vps-ack', '--duration', String(seconds), '--state', receipt]);
    if (injected.injection !== 'ACTIVE') throw new ScenarioFailure('F3_INJECTION_NOT_PROVEN');
    await dependencies.wait(seconds * 1000);
  } finally {
    const cleaned = await dependencies.command(['--cleanup', receipt]);
    if (cleaned.cleanup !== 'VERIFIED') throw new ScenarioFailure('F3_CLEANUP_NOT_VERIFIED');
  }
}

export async function main(arguments_: string[]): Promise<void> {
  process.umask(0o077);
  let schedule: Round2Schedule | undefined, lock: FileLock | undefined;
  const interrupted = new AbortController();
  const onSignal = () => interrupted.abort();
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    const args = [...arguments_];
    const acknowledgement = args.indexOf('--test-vps-ack');
    if (acknowledgement < 0) throw new ScenarioFailure('TEST_VPS_ACK_REQUIRED');
    args.splice(acknowledgement, 1);
    const take = (name: string): string | undefined => {
      const at = args.indexOf(name); if (at < 0) return undefined;
      const value = args[at + 1];
      if (!value || value.startsWith('--')) throw new ScenarioFailure('FAULT_ARGUMENT_INVALID');
      args.splice(at, 2); return value;
    };
    const file = take('--state'), groupText = take('--group');
    if (!file || !isAbsolute(file) || !groupText || !/^[1-8]$/.test(groupText)) throw new ScenarioFailure('FAULT_ARGUMENT_INVALID');
    const config = loadDemoConfig(args);
    if (config.environment.DEMO_ROUND2_FAULTS !== '1' || config.kernelMode !== 'child' || config.connectOnly)
      throw new ScenarioFailure('FAULT_MODE_NOT_AUTHORIZED');
    if ([config.kernelDbFile, config.callerDbFile, config.lockFile].some(path => resolve(path) === resolve(file)))
      throw new ScenarioFailure('INDEPENDENT_SCHEDULER_DATABASE_REQUIRED');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new ScenarioFailure('PRIVATE_SCHEDULE_STATE_REQUIRED');
    lock = await acquireFileLock(`${file}.fault.lock`);
    schedule = new Round2Schedule(file); await chmod(file, 0o600);
    const group = Number(groupText);
    const result = await runFaultGroup({
      schedule, group, now: Date.now,
      command: command => requestFaultControl(`${config.callerDbFile}.fault.sock`, command),
      run: (scenario, onEvent) => requestLocalRound(`${config.callerDbFile}.sock`, 'MANUAL', onEvent, scenario),
      network: seconds => withF3Network(seconds, join(dirname(file), `${basename(file)}.f3-${randomUUID()}.json`), {
        command: async arguments_ => {
          // sudo may strip SSH_CONNECTION. Carry only its validated peer address
          // as an explicit argument so DNS can never select the operator's peer.
          const peer = process.env.SSH_CONNECTION?.split(/\s+/)[0];
          const peerArgument = arguments_[0] === '--inject' && peer && isIP(peer) ? ['--ssh-peer', peer] : [];
          const { stdout } = await executeFile('sudo', ['-n', '--', '/usr/bin/python3', networkScript, ...arguments_, ...peerArgument], {
            shell: false, timeout: 120_000, maxBuffer: 16_384,
          });
          return row(JSON.parse(stdout.trim()));
        },
        wait: milliseconds => pause(milliseconds, undefined, { signal: interrupted.signal }),
      }),
      pause: milliseconds => pause(milliseconds, undefined, { signal: interrupted.signal }),
    });
    console.log(JSON.stringify({ event: 'round2_fault_group_completed', group, ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'round2_fault_group_failed',
      code: error instanceof ScenarioFailure ? error.code : 'FAULT_GROUP_NOT_COMPLETED',
      reason: 'Read retained caller rounds and fault receipts. Automatic scheduling stays blocked until clean recovery and S1 confirmation are proved.' }));
    process.exitCode = 1;
  } finally {
    schedule?.close();
    await lock?.release();
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
