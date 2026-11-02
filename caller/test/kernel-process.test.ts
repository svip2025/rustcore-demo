import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DemoConfig } from "../src/config.js";
import { KernelProcessError, ManagedKernel } from "../src/kernel-process.js";

function config(directory: string): DemoConfig {
  return {
    envFile: join(directory, "env"), credentialId: "9001", grpcAddress: "127.0.0.1:50051",
    kernelBinary: process.execPath, kernelDbFile: join(directory, "kernel.db"), callerDbFile: join(directory, "caller.db"),
    lockFile: join(directory, "round.lock"), holdMs: 1000, phaseTimeoutMs: 2000,
    source: { kind: "TESTNET", label: "测试网" }, build: { caller_commit: "unknown", rustcore_commit: "unknown" },
    environment: { ENGINE_LIVE_ENABLED: "0", ENGINE_STAGE_MAX: "demo", RUSTCORE_GRPC_ADDR: "127.0.0.1:50051",
      RUSTCORE_DB_URL: `sqlite://${join(directory, "kernel.db")}` }, connectOnly: false,
  };
}

async function waitUntil(condition: () => boolean) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > 3000) throw new Error("test child did not reach its expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("restart SIGKILLs only the owned child and starts a new one with identical env and database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-managed-"));
  const marker = join(directory, "starts.jsonl");
  const settings = config(directory);
  const oldParentValue = process.env.BINANCE_VENUE_UNVALIDATED_TEST;
  process.env.BINANCE_VENUE_UNVALIDATED_TEST = "mainnet";
  const program = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, JSON.stringify({db:process.env.RUSTCORE_DB_URL,live:process.env.ENGINE_LIVE_ENABLED,unexpected:process.env.BINANCE_VENUE_UNVALIDATED_TEST??null})+'\\n'); setInterval(()=>{},1000);`;
  const kernel = new ManagedKernel(settings, { args: ["-e", program] });
  try {
    await kernel.start();
    const firstPid = kernel.processId;
    const firstExit = kernel.waitForExit();
    await waitUntil(() => existsSync(marker));
    await kernel.start();
    assert.equal(kernel.processId, firstPid);
    await kernel.restart();
    assert.deepEqual(await firstExit, { code: null, signal: "SIGKILL" });
    assert.notEqual(kernel.processId, firstPid);
    await waitUntil(() => readFileSync(marker, "utf8").trim().split("\n").length === 2);
    const starts = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
    assert.deepEqual(starts[0], starts[1]);
    assert.deepEqual(starts[0], { db: settings.environment.RUSTCORE_DB_URL, live: "0", unexpected: null });
    await kernel.stop();
    assert.equal(kernel.isRunning, false);
  } finally {
    await kernel.stop();
    if (oldParentValue === undefined) delete process.env.BINANCE_VENUE_UNVALIDATED_TEST;
    else process.env.BINANCE_VENUE_UNVALIDATED_TEST = oldParentValue;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("connect-only mode neither adopts nor signals an externally started process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-connect-only-"));
  const external = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const externalExit = new Promise<void>((resolve) => { external.once("exit", () => resolve()); });
  const kernel = new ManagedKernel({ ...config(directory), connectOnly: true });
  try {
    await kernel.start();
    assert.equal(kernel.processId, undefined);
    assert.equal(kernel.isRunning, false);
    await assert.rejects(kernel.restart(), (error: unknown) => error instanceof KernelProcessError && error.code === "KERNEL_NOT_MANAGED");
    await assert.rejects(kernel.waitForExit(), (error: unknown) => error instanceof KernelProcessError && error.code === "KERNEL_NOT_MANAGED");
    await kernel.stop();
    assert.equal(external.exitCode, null);
    assert.equal(external.signalCode, null);
  } finally {
    external.kill("SIGTERM");
    await externalExit;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unavailable executable fails with a public-safe error, and unowned restart is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-missing-"));
  const settings = { ...config(directory), kernelBinary: join(directory, "secret-internal-name") };
  const kernel = new ManagedKernel(settings);
  try {
    await assert.rejects(kernel.restart(), (error: unknown) => error instanceof KernelProcessError && error.code === "KERNEL_NOT_MANAGED");
    await assert.rejects(kernel.start(), (error: unknown) => {
      assert.ok(error instanceof KernelProcessError);
      assert.equal(error.code, "KERNEL_START_FAILED");
      assert.equal(error.message.includes(directory), false);
      assert.doesNotMatch(error.message, /secret-internal-name|ENOENT/);
      return true;
    });
    assert.equal(kernel.isRunning, false);
    await kernel.stop();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("waitForExit reports the actual exit code of the child without restarting automatically", async () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-child-exit-"));
  const kernel = new ManagedKernel(config(directory), { args: ["-e", "process.exit(7)"] });
  try {
    await kernel.start();
    assert.deepEqual(await kernel.waitForExit(), { code: 7, signal: null });
    assert.equal(kernel.isRunning, false);
    assert.equal(kernel.processId, undefined);
  } finally {
    await kernel.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
