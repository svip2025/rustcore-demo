import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, credentialLocator, httpSettings, loadDemoConfig, parseEnvironmentFile } from "../src/config.js";

function fixture(fn: (file: string, directory: string, write: (changes?: Record<string, string | undefined>) => void) => void) {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-config-"));
  const file = join(directory, "env");
  const base: Record<string, string> = {
    ENGINE_LIVE_ENABLED: "0", ENGINE_STAGE_MAX: "demo",
    BINANCE_VENUE_H39303031: "testnet", BINANCE_API_KEY_H39303031: "fake-key-private",
    BINANCE_API_SECRET_H39303031: "fake-secret-private",
  };
  const write = (changes: Record<string, string | undefined> = {}) => {
    const values = { ...base, ...changes };
    writeFileSync(file, Object.entries(values).filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}="${value}"`).join("\n"), { mode: 0o600 });
    chmodSync(file, 0o600);
  };
  try { write(); fn(file, directory, write); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function configError(action: () => unknown, code: string): ConfigError {
  try { action(); } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error("expected a configuration error");
}

test('HTTP defaults to independent loopback and only explicitly trusts a local proxy', () => {
  fixture((file, _directory, write) => {
    assert.deepEqual(httpSettings(loadDemoConfig(['--env', file])), { hostname: '127.0.0.1', port: 8787, trustProxy: false });
    write({ DEMO_HTTP_ADDR: '[::1]:8088', DEMO_PUBLIC_ORIGIN: 'https://demo.example.com', DEMO_TRUST_PROXY: '1' });
    assert.deepEqual(httpSettings(loadDemoConfig(['--env', file])), { hostname: '::1', port: 8088, allowedOrigin: 'https://demo.example.com', trustProxy: true });
    for (const value of ['0.0.0.0:8787', '127.0.0.1:50051', '127.0.0.1:0']) {
      write({ DEMO_HTTP_ADDR: value });
      configError(() => httpSettings(loadDemoConfig(['--env', file])), 'CONFIG_HTTP');
    }
  });
});

test("literal environment parsing never expands variables or executes shell text", () => {
  const directory = mkdtempSync(join(tmpdir(), "rustcore-config-literal-"));
  try {
    const marker = join(directory, "executed");
    const parsed = parseEnvironmentFile(`# comment\r\nA=plain\nB="$(touch ${marker}) $HOME \\n"\nC=abc#literal\n`);
    assert.equal(parsed.A, "plain");
    assert.equal(parsed.B, `$(touch ${marker}) $HOME \\n`);
    assert.equal(parsed.C, "abc#literal");
    assert.equal(existsSync(marker), false);
    configError(() => parseEnvironmentFile("export A=secret"), "ENV_SYNTAX");
    configError(() => parseEnvironmentFile("A=one\nA=two"), "ENV_DUPLICATE");
    configError(() => parseEnvironmentFile('A="unterminated'), "ENV_SYNTAX");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a 600 explicit environment yields dedicated databases and only validated file values", () => {
  fixture((file) => {
    const config = loadDemoConfig(["--env", file]);
    assert.equal(config.credentialId, "9001");
    assert.equal(config.grpcAddress, "127.0.0.1:50051");
    assert.equal(config.environment.ENGINE_LIVE_ENABLED, "0");
    assert.equal(config.environment.RUSTCORE_DB_URL, `sqlite://${config.kernelDbFile}`);
    assert.notEqual(config.kernelDbFile, config.callerDbFile);
    assert.equal(config.source.kind, "TESTNET");
    assert.equal(config.build.caller_commit, "unknown");
    assert.equal(config.holdMs, 180_000);
    assert.equal(config.phaseTimeoutMs, 120_000);
    assert.equal(config.connectOnly, false);
    assert.ok(Object.isFrozen(config.environment));
    assert.equal(Object.hasOwn(config.environment, "HOME"), false);
  });
});

test("the second local credential, loopback IPv6, timing and build values can be explicit", () => {
  fixture((file, directory, write) => {
    write({ DEMO_CREDENTIAL_ID: "9002", BINANCE_VENUE_H39303032: "testnet",
      BINANCE_API_KEY_H39303032: "fake-second-key", BINANCE_API_SECRET_H39303032: "fake-second-secret",
      RUSTCORE_GRPC_ADDR: "[::1]:50052", RUSTCORE_DB_URL: `sqlite://${join(directory, "kernel.db")}`,
      DEMO_CALLER_DB_FILE: join(directory, "caller.db"), DEMO_LOCK_FILE: join(directory, "round.lock"),
      DEMO_KERNEL_BINARY: process.execPath, DEMO_HOLD_MS: "1000", DEMO_PHASE_TIMEOUT_MS: "2000",
      DEMO_CALLER_COMMIT: "abcdef1234567", DEMO_RUSTCORE_COMMIT: "1234567abcdef" });
    const config = loadDemoConfig(["--env", file, "--connect-only"]);
    assert.equal(config.credentialId, "9002");
    assert.equal(credentialLocator("9002"), "H39303032");
    assert.equal(config.grpcAddress, "[::1]:50052");
    assert.equal(config.holdMs, 1000);
    assert.equal(config.phaseTimeoutMs, 2000);
    assert.equal(config.kernelBinary, process.execPath);
    assert.equal(config.build.caller_commit, "abcdef1234567");
    assert.equal(config.connectOnly, true);
  });
});

test("authorized current and legacy testnet routes are accepted without accepting arbitrary origins", () => {
  for (const [rest, websocket] of [
    ["https://demo-fapi.binance.com", "wss://demo-fstream.binance.com"],
    ["https://testnet.binancefuture.com", "wss://stream.binancefuture.com"],
  ]) fixture((file, _directory, write) => {
    write({ BINANCE_FUTURES_BASE_URL: rest!, BINANCE_FUTURES_WS_BASE_URL: websocket! });
    assert.equal(loadDemoConfig(["--env", file]).source.kind, "TESTNET");
  });
});

test("missing keys identify the field without exposing secrets, paths or OS detail", () => {
  fixture((file, directory, write) => {
    write({ BINANCE_API_SECRET_H39303031: undefined });
    const error = configError(() => loadDemoConfig(["--env", file]), "CONFIG_MISSING");
    assert.match(error.message, /BINANCE_API_SECRET_H39303031/);
    assert.doesNotMatch(error.message, /fake-key-private|fake-secret-private/);
    assert.equal(error.message.includes(directory), false);
    const absent = configError(() => loadDemoConfig(["--env", join(directory, "absent")]), "ENV_UNREADABLE");
    assert.equal(absent.message.includes(directory), false);
    assert.doesNotMatch(absent.message, /ENOENT/);
  });
});

test("permissions, symlinks and ambiguous CLI input are rejected before configuration use", () => {
  fixture((file, directory) => {
    chmodSync(file, 0o644);
    configError(() => loadDemoConfig(["--env", file]), "ENV_PERMISSIONS");
    chmodSync(file, 0o600);
    symlinkSync(file, join(directory, "link"));
    configError(() => loadDemoConfig(["--env", join(directory, "link")]), "ENV_UNREADABLE");
    configError(() => loadDemoConfig(["--env"]), "CONFIG_ARGUMENT");
    configError(() => loadDemoConfig(["--env", file, "--env", file]), "CONFIG_ARGUMENT");
  });
});

test("live stages, remote listeners, route overrides and shared database paths cannot pass", () => {
  const cases: [Record<string, string>, string][] = [
    [{ ENGINE_LIVE_ENABLED: "1" }, "CONFIG_MAINNET"],
    [{ ENGINE_STAGE_MAX: "live" }, "CONFIG_STAGE"],
    [{ BINANCE_VENUE_H39303031: "mainnet" }, "CONFIG_VENUE"],
    [{ BINANCE_VENUE_H39303032: "mainnet" }, "CONFIG_VENUE"],
    [{ DEMO_CREDENTIAL_ID: "9003" }, "CONFIG_CREDENTIAL"],
    [{ RUSTCORE_GRPC_ADDR: "0.0.0.0:50051" }, "CONFIG_GRPC"],
    [{ RUSTCORE_GRPC_ADDR: "private.internal:50051" }, "CONFIG_GRPC"],
    [{ RUSTCORE_GRPC_ADDR: "127.0.0.1:0" }, "CONFIG_GRPC"],
    [{ BINANCE_FUTURES_BASE_URL: "https://fapi.binance.com" }, "CONFIG_ROUTE"],
    [{ BINANCE_FUTURES_BASE_URL: "https://unknown.invalid" }, "CONFIG_ROUTE"],
    [{ BINANCE_FAULT_PROXY_REST_BASE_URL: "http://127.0.0.1:1" }, "CONFIG_ROUTE"],
    [{ RUSTCORE_DB_URL: "sqlite://./shared.db" }, "CONFIG_DATABASE"],
    [{ RUSTCORE_DB_URL: "mysql://private.internal/other" }, "CONFIG_DATABASE"],
    [{ RUSTCORE_DB_URL: "sqlite:///var/lib/rustcore-demo/caller.db" }, "CONFIG_DATABASE"],
    [{ DEMO_HOLD_MS: "0" }, "CONFIG_DURATION"],
  ];
  fixture((file, _directory, write) => {
    for (const [changes, code] of cases) {
      write(changes);
      const error = configError(() => loadDemoConfig(["--env", file]), code);
      assert.doesNotMatch(error.message, /private\.internal|fake-key-private|fake-secret-private/);
    }
  });
});
