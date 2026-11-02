import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import type { DemoConfig } from "../src/config.js";
import { runPreflight, TESTNET_READ_ORIGIN } from "../src/preflight.js";

const T = Date.parse("2026-11-02T12:00:00.000Z");
const config: DemoConfig = {
  envFile: "/private/env", credentialId: "9001", grpcAddress: "127.0.0.1:50051",
  kernelBinary: "/private/rustcore", kernelMode: 'child', kernelDbFile: "/private/kernel.db", callerDbFile: "/private/caller.db",
  lockFile: "/private/round.lock", holdMs: 1000, phaseTimeoutMs: 2000, connectOnly: false,
  source: { kind: "TESTNET", label: "测试网" }, build: { caller_commit: "unknown", rustcore_commit: "unknown" },
  environment: { BINANCE_API_KEY_H39303031: "fake-private-api-key", BINANCE_API_SECRET_H39303031: "fake-private-api-secret" },
};

function fixture(changes: { mode?: unknown; risk?: unknown; account?: unknown } = {}) {
  const bodies: Record<string, unknown> = {
    "/fapi/v1/positionSide/dual": changes.mode ?? { dualSidePosition: false },
    "/fapi/v2/positionRisk": changes.risk ?? [{ symbol: "BTCUSDT", positionSide: "BOTH", marginType: "cross", leverage: "1", positionAmt: "0" }],
    "/fapi/v2/account": changes.account ?? { assets: [{ asset: "USDT", walletBalance: "100.00000000" }] },
  };
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push({ url, init });
    assert.ok(Object.hasOwn(bodies, url.pathname));
    return new Response(JSON.stringify(bodies[url.pathname]), { status: 200 });
  };
  return { fetch, requests };
}

test("preflight signs exactly the documented three GETs on the fixed testnet origin", async () => {
  const { fetch, requests } = fixture();
  const result = await runPreflight(config, { fetch, now: () => T });
  assert.equal(result.ok, true);
  assert.equal(result.result, "PASS");
  assert.equal(result.positionMode, "ONE_WAY");
  assert.equal(result.marginMode, "CROSS");
  assert.equal(result.leverage, 1);
  assert.equal(result.balanceUsdt, "100.00000000");
  assert.equal(result.observedAt, "2026-11-02T12:00:00.000Z");
  assert.deepEqual(requests.map(({ url }) => url.pathname), ["/fapi/v1/positionSide/dual", "/fapi/v2/positionRisk", "/fapi/v2/account"]);
  for (const { url, init } of requests) {
    assert.equal(url.origin, TESTNET_READ_ORIGIN);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("X-MBX-APIKEY"), "fake-private-api-key");
    const signature = url.searchParams.get("signature");
    const unsigned = new URLSearchParams(url.search);
    unsigned.delete("signature");
    assert.equal(signature, createHmac("sha256", "fake-private-api-secret").update(unsigned.toString()).digest("hex"));
    assert.equal(url.searchParams.get("timestamp"), String(T));
    assert.equal(url.searchParams.get("recvWindow"), "5000");
  }
  assert.equal(requests[1]?.url.searchParams.get("symbol"), "BTCUSDT");
  assert.doesNotMatch(JSON.stringify(result), /fake-private|signature|\/private|binancefuture\.com/);
});

test("manual mode, cross margin, 1x and funding prerequisites fail without any setting writes", async () => {
  const cases: [Parameters<typeof fixture>[0], string][] = [
    [{ mode: { dualSidePosition: true } }, "PREFLIGHT_ONE_WAY_REQUIRED"],
    [{ risk: [{ symbol: "BTCUSDT", positionSide: "BOTH", marginType: "isolated", leverage: "1" }] }, "PREFLIGHT_CROSS_REQUIRED"],
    [{ risk: [{ symbol: "BTCUSDT", positionSide: "BOTH", marginType: "cross", leverage: "2" }] }, "PREFLIGHT_1X_REQUIRED"],
    [{ account: { assets: [{ asset: "USDT", walletBalance: "99.999999999999999999999" }] } }, "PREFLIGHT_BALANCE_REQUIRED"],
  ];
  for (const [changes, code] of cases) {
    const { fetch, requests } = fixture(changes);
    const result = await runPreflight(config, { fetch, now: () => T });
    assert.equal(result.ok, false);
    assert.equal(result.result, "FAIL");
    assert.equal(result.code, code);
    assert.equal(requests.length, 3);
    assert.ok(requests.every(({ init }) => init?.method === "GET"));
  }
});

test("missing or ambiguous facts remain UNKNOWN rather than assumed to meet prerequisites", async () => {
  const cases: Parameters<typeof fixture>[0][] = [
    { mode: {} }, { risk: [] },
    { risk: [{ symbol: "BTCUSDT", positionSide: "BOTH", leverage: "1" }] },
    { account: { totalWalletBalance: "100000", assets: [] } },
    { account: { assets: [{ asset: "USDT", walletBalance: "NaN" }] } },
    { account: { assets: [{ asset: "USDT", walletBalance: "100" }, { asset: "USDT", walletBalance: "100" }] } },
  ];
  for (const changes of cases) {
    const { fetch } = fixture(changes);
    const result = await runPreflight(config, { fetch, now: () => T });
    assert.equal(result.ok, false);
    assert.equal(result.result, "UNKNOWN");
  }
});

test("exchange auth or 404 rejections retain numeric facts without leaking the response text", async () => {
  for (const status of [401, 404]) {
    let count = 0;
    const fetch: typeof globalThis.fetch = async () => {
      count++;
      return new Response(JSON.stringify({ code: -2015, msg: "fake-private-api-key /private/env private.internal signature=secret" }), { status });
    };
    const result = await runPreflight(config, { fetch, now: () => T });
    assert.equal(result.result, "FAIL");
    assert.equal(result.code, "BINANCE_-2015");
    assert.match(result.reason, new RegExp(`HTTP ${status}`));
    assert.match(result.reason, /-2015/);
    assert.equal(count, 1);
    assert.doesNotMatch(JSON.stringify(result), /fake-private|\/private|private\.internal|signature/);
  }
  const html404: typeof globalThis.fetch = async () => new Response("private HTML signature=secret", { status: 404 });
  const missing = await runPreflight(config, { fetch: html404, now: () => T });
  assert.equal(missing.result, "FAIL");
  assert.equal(missing.code, "PREFLIGHT_HTTP_404");
  assert.doesNotMatch(JSON.stringify(missing), /private HTML|signature/);
});

test("429 stops at the first GET without retries or alternate hosts", async () => {
  let count = 0;
  const fetch: typeof globalThis.fetch = async () => {
    count++;
    return new Response(JSON.stringify({ code: -1003, msg: "private response" }), { status: 429 });
  };
  const result = await runPreflight(config, { fetch, now: () => T });
  assert.equal(count, 1);
  assert.equal(result.result, "FAIL");
  assert.equal(result.code, "BINANCE_-1003");
});

test("network and invalid JSON failures expose neither signed URLs nor transport messages", async () => {
  const fetch: typeof globalThis.fetch = async () => { throw new Error("fake-private-api-key https://private.internal?signature=secret"); };
  const result = await runPreflight(config, { fetch, now: () => T });
  assert.equal(result.result, "UNKNOWN");
  assert.equal(result.code, "PREFLIGHT_READ_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /fake-private|signature|private\.internal/);
  const malformed: typeof globalThis.fetch = async () => new Response("private HTML with signature=secret", { status: 200 });
  const invalid = await runPreflight(config, { fetch: malformed, now: () => T });
  assert.equal(invalid.code, "PREFLIGHT_INVALID_RESPONSE");
  assert.doesNotMatch(JSON.stringify(invalid), /private HTML|signature/);
});
