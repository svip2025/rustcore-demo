import { execFile } from 'node:child_process';
import type { DemoConfig } from './config.js';
import { KernelProcessError, ManagedKernel } from './kernel-process.js';

interface CommandOptions {
  timeout: number;
  maxBuffer: number;
  shell: false;
  env: NodeJS.ProcessEnv;
}
type Command = (file: string, args: readonly string[], options: CommandOptions) => Promise<void>;
const execute: Command = (file, args, options) => new Promise<void>((resolve, reject) => {
  execFile(file, [...args], options, error => { if (error) reject(error); else resolve(); });
});

/** Control only the single independent unit authorized by the deployment sudoers rule. */
export class SystemdKernel {
  private active = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly command: Command;

  constructor(private readonly config: Pick<DemoConfig, 'connectOnly' | 'phaseTimeoutMs'>,
    options: { command?: Command } = {}) {
    this.command = options.command ?? execute;
  }

  /** Last successful control observation; public RPC reads remain the liveness authority. */
  get isRunning(): boolean { return this.active; }

  private serialized(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private options(): CommandOptions {
    return { timeout: this.config.phaseTimeoutMs, maxBuffer: 16_384, shell: false,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', SYSTEMD_PAGER: 'cat' } };
  }

  start(): Promise<void> {
    return this.serialized(async () => {
      if (this.config.connectOnly) return;
      try {
        await this.command('/usr/bin/systemctl', ['is-active', '--quiet', 'rustcore.service'], this.options());
        this.active = true;
      } catch {
        this.active = false;
        throw new KernelProcessError('KERNEL_SERVICE_NOT_ACTIVE', '独立内核服务尚未 active，caller 不会代为启动服务');
      }
    });
  }

  restart(): Promise<void> {
    return this.serialized(async () => {
      if (this.config.connectOnly)
        throw new KernelProcessError('KERNEL_NOT_MANAGED', 'connect-only 模式不允许重启内核服务');
      this.active = false;
      try {
        await this.command('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'restart', 'rustcore.service'], this.options());
        this.active = true;
      } catch {
        throw new KernelProcessError('KERNEL_SERVICE_RESTART_FAILED', '独立内核服务重启未确认完成，等待公开接口观察');
      }
    });
  }

  /** The independently supervised service outlives caller shutdown. */
  async stop(): Promise<void> { await this.queue; }
}

export function createKernel(config: DemoConfig): ManagedKernel | SystemdKernel {
  return config.kernelMode === 'systemd' ? new SystemdKernel(config) : new ManagedKernel(config);
}
