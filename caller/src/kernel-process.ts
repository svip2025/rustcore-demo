import { spawn, type ChildProcess } from "node:child_process";
import type { DemoConfig } from "./config.js";

export interface KernelExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export class KernelProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KernelProcessError";
  }
}

interface OwnedProcess {
  child: ChildProcess;
  exit: Promise<KernelExit>;
  exited: boolean;
}

/** A child handle is the only authority to signal a process. No PID-file lookup or pkill. */
export class ManagedKernel {
  private owned: OwnedProcess | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly environment: Record<string, string>;
  private readonly args: readonly string[];

  constructor(private readonly config: DemoConfig, options: { args?: readonly string[] } = {}) {
    // Do not inherit process.env, including unrelated BINANCE_* variables.
    this.environment = { ...config.environment };
    this.args = [...(options.args ?? [])];
  }

  get isRunning(): boolean { return this.owned !== undefined && !this.owned.exited; }
  get processId(): number | undefined { return this.isRunning ? this.owned?.child.pid : undefined; }

  start(): Promise<void> {
    return this.serialized(() => this.startOwned());
  }

  restart(): Promise<void> {
    return this.serialized(async () => {
      if (this.config.connectOnly || this.owned === undefined)
        throw new KernelProcessError("KERNEL_NOT_MANAGED", "当前内核未由 caller 启动，无法执行重启");
      await this.terminateOwned("SIGKILL");
      await this.startOwned();
    });
  }

  stop(): Promise<void> {
    return this.serialized(async () => {
      if (this.config.connectOnly || this.owned === undefined) return;
      await this.terminateOwned("SIGTERM");
    });
  }

  waitForExit(): Promise<KernelExit> {
    if (this.config.connectOnly || this.owned === undefined)
      return Promise.reject(new KernelProcessError("KERNEL_NOT_MANAGED", "当前内核未由 caller 启动，无法等待子进程退出"));
    return this.owned.exit;
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async startOwned(): Promise<void> {
    if (this.config.connectOnly || this.isRunning) return;
    let child: ChildProcess;
    try {
      child = spawn(this.config.kernelBinary, [...this.args], {
        env: { ...this.environment }, shell: false, stdio: "ignore",
      });
    } catch {
      throw new KernelProcessError("KERNEL_START_FAILED", "无法启动受管内核");
    }
    let resolveExit!: (status: KernelExit) => void;
    const record: OwnedProcess = {
      child, exited: false,
      exit: new Promise<KernelExit>((resolve) => { resolveExit = resolve; }),
    };
    this.owned = record;
    child.once("exit", (code, signal) => {
      record.exited = true;
      resolveExit({ code, signal });
    });
    await new Promise<void>((resolve, reject) => {
      let spawned = false;
      child.once("spawn", () => { spawned = true; resolve(); });
      child.on("error", () => {
        if (spawned) return;
        record.exited = true;
        resolveExit({ code: null, signal: null });
        reject(new KernelProcessError("KERNEL_START_FAILED", "无法启动受管内核"));
      });
    });
    // The gRPC adapter must independently wait for readiness; spawn is not a health check.
  }

  private async terminateOwned(signal: NodeJS.Signals): Promise<void> {
    const record = this.owned;
    if (record === undefined || record.exited) return;
    let signalled = false;
    try { signalled = record.child.kill(signal); }
    catch { throw new KernelProcessError("KERNEL_STOP_FAILED", "无法停止 caller 的内核子进程"); }
    if (!signalled && !record.exited)
      throw new KernelProcessError("KERNEL_STOP_FAILED", "无法停止 caller 的内核子进程");
    if (await this.exitsWithin(record, this.config.phaseTimeoutMs)) return;
    if (signal !== "SIGKILL" && !record.exited) {
      try { record.child.kill("SIGKILL"); }
      catch { throw new KernelProcessError("KERNEL_STOP_FAILED", "无法停止 caller 的内核子进程"); }
      if (await this.exitsWithin(record, this.config.phaseTimeoutMs)) return;
    }
    throw new KernelProcessError("KERNEL_STOP_TIMEOUT", "等待内核子进程退出超时");
  }

  private async exitsWithin(record: OwnedProcess, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        record.exit.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
