import { createHmac } from "node:crypto";
import type { CheckResult } from "../../shared/schema.js";
import { credentialLocator, type DemoConfig } from "./config.js";

// Match the pinned kernel's venue identity. Never accept an environment-supplied origin.
export const TESTNET_READ_ORIGIN = "https://demo-fapi.binance.com";

/** Internal result; no credential, URLs, response bodies, headers or signatures. */
export interface PreflightResult {
  ok: boolean;
  result: CheckResult;
  reason: string;
  code: string;
  positionMode: "ONE_WAY" | "HEDGE" | "UNKNOWN";
  marginMode: "CROSS" | "ISOLATED" | "UNKNOWN";
  leverage: number | null;
  balanceUsdt: string | null;
  observedAt: string;
}

class ReadFailure extends Error {
  constructor(readonly code: string, message: string, readonly result: CheckResult = "UNKNOWN") { super(message); }
}

type Row = Record<string, unknown>;
function row(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}

function decimalBalance(value: unknown): { text: string; enough: boolean } | undefined {
  if (typeof value !== "string" || value.length > 256 || !/^[+-]?[0-9]+(?:\.[0-9]+)?$/.test(value)) return undefined;
  const negative = value.startsWith("-");
  const [whole, fractional = ""] = value.replace(/^[+-]/, "").split(".");
  const coefficient = BigInt(`${whole}${fractional}`) * (negative ? -1n : 1n);
  return { text: value, enough: coefficient >= 100n * 10n ** BigInt(fractional.length) };
}

/** Exactly three signed GETs, no retries and no exchange setting/order writes. */
export async function runPreflight(config: DemoConfig,
  options: { fetch?: typeof globalThis.fetch; now?: () => number } = {}): Promise<PreflightResult> {
  const now = options.now ?? Date.now;
  const fetchRead = options.fetch ?? globalThis.fetch;
  const result: PreflightResult = {
    ok: false, result: "UNKNOWN", reason: "测试网前置事实尚未确认", code: "PREFLIGHT_UNKNOWN",
    positionMode: "UNKNOWN", marginMode: "UNKNOWN", leverage: null, balanceUsdt: null,
    observedAt: new Date(now()).toISOString(),
  };
  const locator = credentialLocator(config.credentialId);
  const key = config.environment[`BINANCE_API_KEY_${locator}`];
  const secret = config.environment[`BINANCE_API_SECRET_${locator}`];
  if (!key || !secret) return { ...result, result: "FAIL", code: "PREFLIGHT_CREDENTIALS", reason: "测试网只读检查缺少账户密钥字段" };

  const read = async (path: "/fapi/v1/positionSide/dual" | "/fapi/v2/positionRisk" | "/fapi/v2/account"): Promise<unknown> => {
    const params = new URLSearchParams();
    if (path === "/fapi/v2/positionRisk") params.set("symbol", "BTCUSDT");
    params.set("timestamp", String(now()));
    params.set("recvWindow", "5000");
    params.set("signature", createHmac("sha256", secret).update(params.toString()).digest("hex"));
    let response: Response;
    try {
      response = await fetchRead(`${TESTNET_READ_ORIGIN}${path}?${params}`, {
        method: "GET", headers: { "X-MBX-APIKEY": key }, redirect: "error",
        signal: AbortSignal.timeout(Math.min(config.phaseTimeoutMs, 10_000)),
      });
    } catch { throw new ReadFailure("PREFLIGHT_READ_UNAVAILABLE", "测试网只读账户请求未能完成"); }
    let body: unknown;
    try { body = await response.json(); }
    catch {
      if (!response.ok) throw new ReadFailure(`PREFLIGHT_HTTP_${response.status}`,
        `测试网只读账户请求被拒绝（HTTP ${response.status}）`, "FAIL");
      throw new ReadFailure("PREFLIGHT_INVALID_RESPONSE", `测试网只读接口返回无效内容（HTTP ${response.status}）`);
    }
    const apiCode = row(body)?.code;
    const actualCode = typeof apiCode === "number" && Number.isSafeInteger(apiCode) ? apiCode : undefined;
    if (!response.ok || (actualCode !== undefined && actualCode < 0)) {
      const suffix = actualCode === undefined ? "" : `，交易所代码 ${actualCode}`;
      throw new ReadFailure(actualCode === undefined ? `PREFLIGHT_HTTP_${response.status}` : `BINANCE_${actualCode}`,
        `测试网只读账户请求被拒绝（HTTP ${response.status}${suffix}）`, "FAIL");
    }
    return body;
  };

  try {
    const mode = row(await read("/fapi/v1/positionSide/dual"));
    if (typeof mode?.dualSidePosition !== "boolean")
      throw new ReadFailure("PREFLIGHT_MODE_UNKNOWN", "测试网返回缺少明确的持仓模式");
    result.positionMode = mode.dualSidePosition ? "HEDGE" : "ONE_WAY";
    const risk = await read("/fapi/v2/positionRisk");
    if (!Array.isArray(risk)) throw new ReadFailure("PREFLIGHT_POSITION_UNKNOWN", "测试网返回缺少持仓设置数组");
    const btc = risk.map(row).filter((value) => value?.symbol === "BTCUSDT");
    if (btc.length !== 1 || !btc[0]) throw new ReadFailure("PREFLIGHT_POSITION_UNKNOWN", "无法唯一确认 BTCUSDT 的持仓设置");
    const position = btc[0];
    if (position.marginType === "cross") result.marginMode = "CROSS";
    else if (position.marginType === "isolated") result.marginMode = "ISOLATED";
    if (typeof position.leverage === "string" && /^[1-9][0-9]*$/.test(position.leverage) && Number.isSafeInteger(Number(position.leverage)))
      result.leverage = Number(position.leverage);
    const account = row(await read("/fapi/v2/account"));
    if (!Array.isArray(account?.assets)) throw new ReadFailure("PREFLIGHT_BALANCE_UNKNOWN", "测试网返回缺少资产余额");
    const usdt = account.assets.map(row).filter((value) => value?.asset === "USDT");
    const balance = usdt.length === 1 ? decimalBalance(usdt[0]?.walletBalance) : undefined;
    if (!balance) throw new ReadFailure("PREFLIGHT_BALANCE_UNKNOWN", "无法唯一确认 USDT 钱包余额");
    result.balanceUsdt = balance.text;
    result.observedAt = new Date(now()).toISOString();

    if (result.positionMode !== "ONE_WAY" || position.positionSide !== "BOTH")
      return { ...result, result: "FAIL", code: "PREFLIGHT_ONE_WAY_REQUIRED", reason: "请先由账户所有者手动设置 One-way 持仓模式" };
    if (result.marginMode === "UNKNOWN" || result.leverage === null)
      throw new ReadFailure("PREFLIGHT_POSITION_UNKNOWN", "测试网未返回明确的 BTCUSDT 保证金模式和杠杆" );
    if (result.marginMode !== "CROSS")
      return { ...result, result: "FAIL", code: "PREFLIGHT_CROSS_REQUIRED", reason: "请先由账户所有者手动设置 BTCUSDT 全仓保证金" };
    if (result.leverage !== 1)
      return { ...result, result: "FAIL", code: "PREFLIGHT_1X_REQUIRED", reason: "请先由账户所有者手动设置 BTCUSDT 杠杆为 1x" };
    if (!balance.enough)
      return { ...result, result: "FAIL", code: "PREFLIGHT_BALANCE_REQUIRED", reason: "场景前提未满足：USDT 钱包余额须至少为 100" };
    return { ...result, ok: true, result: "PASS", code: "PREFLIGHT_PASSED", reason: "只读检查已确认 One-way、BTCUSDT 全仓 1x 及至少 100 USDT 钱包余额" };
  } catch (error) {
    if (!(error instanceof ReadFailure)) throw error;
    return { ...result, result: error.result, code: error.code, reason: error.message };
  }
}
