import { spawn } from "node:child_process";
import { ScenarioFailure } from "./facts.js";

export interface FileLock {
  release(): Promise<void>;
}

/** Keep the lock file: unlinking it can let another process lock a different inode. */
export function acquireFileLock(path: string): Promise<FileLock> {
  return new Promise<FileLock>((resolve, reject) => {
    const failure = () => new ScenarioFailure("SCENARIO_LOCK_FAILED", "无法获取或保持场景文件锁");
    let child: ReturnType<typeof spawn>;
    try {
      // The path is an argument, never part of the shell program. EOF also follows parent death.
      child = spawn("flock", ["-n", "-E", "73", "--", path, "sh", "-c", "printf LOCKED; cat >/dev/null"], {
        stdio: ["pipe", "pipe", "ignore"], shell: false,
      });
    } catch { reject(failure()); return; }

    let acquired = false;
    let closed = false;
    let banner = "";
    let released: Promise<void> | undefined;
    let resolveExit!: (status: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => { resolveExit = done; });

    child.on("error", () => { if (!acquired) reject(failure()); });
    // Busy/startup exits may close stdin before close delivers the actual flock exit status.
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("error", () => { if (!acquired) { child.stdin?.destroy(); reject(failure()); } });
    child.once("close", (code, signal) => {
      closed = true;
      resolveExit({ code, signal });
      if (!acquired) reject(code === 73
        ? new ScenarioFailure("SCENARIO_ALREADY_RUNNING", "已有实例持有场景文件锁")
        : failure());
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (acquired) return;
      banner += chunk.toString("utf8");
      if (banner === "LOCKED") {
        acquired = true;
        resolve({
          release(): Promise<void> {
            released ??= (async () => {
              if (closed) throw failure();
              child.stdin?.end();
              const status = await exit;
              if (status.code !== 0 || status.signal !== null) throw failure();
            })();
            return released;
          },
        });
      } else if (!"LOCKED".startsWith(banner)) {
        child.stdin?.destroy();
        reject(failure());
      }
    });
  });
}
