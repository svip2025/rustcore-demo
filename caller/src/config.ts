import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { BuildInfo, DataSource } from "../../shared/schema.js";

export interface DemoConfig {
  envFile: string;
  credentialId: string;
  grpcAddress: string;
  kernelBinary: string;
  kernelDbFile: string;
  callerDbFile: string;
  lockFile: string;
  holdMs: number;
  phaseTimeoutMs: number;
  source: DataSource;
  build: BuildInfo;
  /** Private values; never serialize this object into HTTP, SSE or recordings. */
  environment: Readonly<Record<string, string>>;
  connectOnly: boolean;
}

export function httpSettings(config: DemoConfig): {
  hostname: string; port: number; allowedOrigin?: string; trustProxy: boolean;
} {
  const bind = config.environment.DEMO_HTTP_ADDR ?? '127.0.0.1:8787';
  const match = /^(127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(bind);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 || bind === config.grpcAddress)
    fail('CONFIG_HTTP', 'DEMO_HTTP_ADDR 必须使用独立 loopback 和有效端口');
  const proxy = config.environment.DEMO_TRUST_PROXY ?? '0';
  if (proxy !== '0' && proxy !== '1') fail('CONFIG_HTTP', 'DEMO_TRUST_PROXY 必须为 0 或 1');
  const allowedOrigin = config.environment.DEMO_PUBLIC_ORIGIN;
  return { hostname: match[1] === '[::1]' ? '::1' : '127.0.0.1', port: Number(match[2]),
    ...(allowedOrigin ? { allowedOrigin } : {}), trustProxy: proxy === '1' };
}

/** Messages deliberately contain field names, never values, paths or OS errors. */
export class ConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function fail(code: string, message: string): never {
  throw new ConfigError(code, message);
}

export function credentialLocator(credentialId: string): string {
  return `H${Buffer.from(credentialId, "utf8").toString("hex").toUpperCase()}`;
}

/** Literal KEY=VALUE or KEY="VALUE" only. No interpolation, shell or escape evaluation. */
export function parseEnvironmentFile(contents: string): Record<string, string> {
  const environment: Record<string, string> = Object.create(null) as Record<string, string>;
  if (contents.includes("\0")) fail("ENV_SYNTAX", "环境文件包含无效文本");
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) fail("ENV_SYNTAX", "环境文件仅支持 KEY=VALUE 或双引号文本");
    const name = match[1]!;
    let value = match[2]!;
    if (Object.hasOwn(environment, name)) fail("ENV_DUPLICATE", `环境字段重复：${name}`);
    if (value.startsWith('"')) {
      if (value.length < 2 || !value.endsWith('"') || value.slice(1, -1).includes('"'))
        fail("ENV_SYNTAX", `环境字段双引号无效：${name}`);
      value = value.slice(1, -1);
    } else if (value.includes('"') || value.startsWith("'")) {
      fail("ENV_SYNTAX", `环境字段仅支持简单文本或双引号：${name}`);
    }
    environment[name] = value;
  }
  return environment;
}

function readPrivateEnvironment(file: string): Record<string, string> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600)
      fail("ENV_PERMISSIONS", "环境文件必须为权限 600 的普通文件");
    return parseEnvironmentFile(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    return fail("ENV_UNREADABLE", "无法读取环境文件");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function required(environment: Record<string, string>, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") fail("CONFIG_MISSING", `缺少环境字段：${name}`);
  return value;
}

function absoluteFile(value: string, name: string): string {
  if (!isAbsolute(value) || value.includes("\0") || value.endsWith("/"))
    fail("CONFIG_PATH", `环境字段必须为绝对文件路径：${name}`);
  return resolve(value);
}

function duration(environment: Record<string, string>, name: string, fallback: number): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    fail("CONFIG_DURATION", `环境字段必须为正整数毫秒：${name}`);
  return Number(value);
}

function commit(environment: Record<string, string>, name: string): string {
  const value = environment[name] ?? "unknown";
  if (value !== "unknown" && !/^[0-9a-f]{7,40}$/i.test(value))
    fail("CONFIG_BUILD", `环境字段必须为提交标识：${name}`);
  return value;
}

export function loadDemoConfig(argv: readonly string[] = process.argv.slice(2)): DemoConfig {
  let envFile = "/etc/rustcore-demo/env";
  let connectOnly = false;
  let envSeen = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--env" && !envSeen && argv[index + 1] && !argv[index + 1]!.startsWith("--")) {
      envFile = resolve(argv[++index]!);
      envSeen = true;
    } else if (argument === "--connect-only" && !connectOnly) {
      connectOnly = true;
    } else fail("CONFIG_ARGUMENT", "仅支持 --env <文件> 和 --connect-only 参数");
  }
  const environment = readPrivateEnvironment(envFile);
  if (required(environment, "ENGINE_LIVE_ENABLED") !== "0")
    fail("CONFIG_MAINNET", "ENGINE_LIVE_ENABLED 必须为 0");
  if (required(environment, "ENGINE_STAGE_MAX") !== "demo")
    fail("CONFIG_STAGE", "ENGINE_STAGE_MAX 必须为 demo");
  const credentialId = environment.DEMO_CREDENTIAL_ID ?? "9001";
  if (credentialId !== "9001" && credentialId !== "9002")
    fail("CONFIG_CREDENTIAL", "DEMO_CREDENTIAL_ID 必须选择演示账户 9001 或 9002");
  const locator = credentialLocator(credentialId);
  const venueName = `BINANCE_VENUE_${locator}`;
  if (required(environment, venueName) !== "testnet")
    fail("CONFIG_VENUE", `${venueName} 必须为 testnet`);
  required(environment, `BINANCE_API_KEY_${locator}`);
  required(environment, `BINANCE_API_SECRET_${locator}`);
  for (const [name, value] of Object.entries(environment)) {
    if ((name === "BINANCE_VENUE" || name.startsWith("BINANCE_VENUE_")) && value !== "testnet")
      fail("CONFIG_VENUE", `${name} 必须为 testnet`);
    if (name.startsWith("BINANCE_FAULT_PROXY_"))
      fail("CONFIG_ROUTE", "演示环境不允许 BINANCE_FAULT_PROXY 配置");
  }
  for (const [name, expected, legacy] of [
    ["BINANCE_FUTURES_BASE_URL", "https://demo-fapi.binance.com", "https://testnet.binancefuture.com"],
    ["BINANCE_FUTURES_WS_BASE_URL", "wss://demo-fstream.binance.com", "wss://stream.binancefuture.com"],
  ] as const) {
    if (environment[name] !== undefined && environment[name] !== expected && environment[name] !== legacy)
      fail("CONFIG_ROUTE", `${name} 必须匹配固定内核测试网地址`);
  }

  const grpcAddress = environment.RUSTCORE_GRPC_ADDR ?? "127.0.0.1:50051";
  const address = /^(?:127\.0\.0\.1|\[::1\]):([0-9]+)$/.exec(grpcAddress);
  if (!address || Number(address[1]) < 1 || Number(address[1]) > 65535)
    fail("CONFIG_GRPC", "RUSTCORE_GRPC_ADDR 必须使用 loopback 和有效端口");
  const dbUrl = environment.RUSTCORE_DB_URL ?? "sqlite:///var/lib/rustcore-demo/rustcore.db";
  if (!dbUrl.startsWith("sqlite:///") || /[?#]/.test(dbUrl))
    fail("CONFIG_DATABASE", "RUSTCORE_DB_URL 必须为独立 SQLite 文件");
  const kernelDbFile = absoluteFile(dbUrl.slice("sqlite://".length), "RUSTCORE_DB_URL");
  const callerDbFile = absoluteFile(environment.DEMO_CALLER_DB_FILE ?? "/var/lib/rustcore-demo/caller.db", "DEMO_CALLER_DB_FILE");
  const lockFile = absoluteFile(environment.DEMO_LOCK_FILE ?? resolve(dirname(callerDbFile), "scenario.lock"), "DEMO_LOCK_FILE");
  if (new Set([kernelDbFile, callerDbFile, lockFile]).size !== 3)
    fail("CONFIG_DATABASE", "内核数据库、caller 数据库和场景锁必须使用不同文件");
  environment.RUSTCORE_GRPC_ADDR = grpcAddress;
  environment.RUSTCORE_DB_URL = `sqlite://${kernelDbFile}`;
  return {
    envFile, credentialId, grpcAddress,
    kernelBinary: absoluteFile(environment.DEMO_KERNEL_BINARY ?? resolve("rustcore/target/release/rustcore"), "DEMO_KERNEL_BINARY"),
    kernelDbFile, callerDbFile, lockFile,
    holdMs: duration(environment, "DEMO_HOLD_MS", 180_000),
    phaseTimeoutMs: duration(environment, "DEMO_PHASE_TIMEOUT_MS", 120_000),
    source: { kind: "TESTNET", label: "Binance USDⓈ-M 测试网" },
    build: { caller_commit: commit(environment, "DEMO_CALLER_COMMIT"), rustcore_commit: commit(environment, "DEMO_RUSTCORE_COMMIT") },
    environment: Object.freeze(environment), connectOnly,
  };
}
