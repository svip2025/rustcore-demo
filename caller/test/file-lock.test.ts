import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ScenarioFailure } from "../src/facts.js";
import { acquireFileLock, type FileLock } from "../src/file-lock.js";

const busy = (error: unknown) => error instanceof ScenarioFailure && error.code === "SCENARIO_ALREADY_RUNNING";

async function holderOwnsLock(child: ChildProcess, marker: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline)
      throw new Error("test holder did not acquire its lock");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("two holders compete for one native lock, and release permits a new holder", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-file-lock-"));
  const file = join(directory, "scenario.lock");
  let first: FileLock | undefined;
  let next: FileLock | undefined;
  try {
    first = await acquireFileLock(file);
    await assert.rejects(acquireFileLock(file), busy);
    await first.release();
    await first.release();
    first = undefined;
    assert.equal(existsSync(file), true);
    next = await acquireFileLock(file);
    await assert.rejects(acquireFileLock(file), busy);
  } finally {
    await first?.release();
    await next?.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paths with spaces and shell metacharacters remain literal flock arguments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-file-lock-literal-"));
  const file = join(directory, "round ' ; $ literal.lock");
  let lock: FileLock | undefined;
  try {
    lock = await acquireFileLock(file);
    assert.equal(existsSync(file), true);
    await assert.rejects(acquireFileLock(file), busy);
  } finally {
    await lock?.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SIGKILL of the holding Node process closes the pipe and releases the native lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-file-lock-death-"));
  const file = join(directory, "scenario.lock");
  const marker = join(directory, "holder-state");
  const modulePath = fileURLToPath(new URL("../src/file-lock.ts", import.meta.url));
  const program = `const {acquireFileLock}=require(${JSON.stringify(modulePath)}); acquireFileLock(process.argv[1]).then(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'OWNED');setInterval(()=>{},1000);});`;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const holder = spawn(process.execPath, ["--require", "tsx/cjs", "-e", program, file], {
    stdio: "ignore", env: environment,
  });
  const holderExit = new Promise<void>((resolve) => { holder.once("close", () => resolve()); });
  let next: FileLock | undefined;
  try {
    await holderOwnsLock(holder, marker);
    await assert.rejects(acquireFileLock(file), busy);
    holder.kill("SIGKILL");
    await holderExit;
    assert.equal(holder.signalCode, "SIGKILL");
    // EOF propagation to the orphaned flock/cat is asynchronous; only the test waits for it.
    const deadline = Date.now() + 3000;
    while (next === undefined) {
      try { next = await acquireFileLock(file); }
      catch (error) {
        if (!busy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    await assert.rejects(acquireFileLock(file), busy);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    await holderExit;
    await next?.release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lock startup errors expose a clear code without internal paths or OS stderr", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-file-lock-errors-"));
  try {
    const path = join(directory, "private-hostname", "missing-parent", "scenario.lock");
    await assert.rejects(acquireFileLock(path), (error: unknown) => {
      assert.ok(error instanceof ScenarioFailure);
      assert.equal(error.code, "SCENARIO_LOCK_FAILED");
      assert.equal(error.message.includes(directory), false);
      assert.doesNotMatch(error.message, /private-hostname|No such file|flock:/);
      return true;
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
