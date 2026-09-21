import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PublicMarketData } from "../server/publicMarketData.js";

function response(status, body, headers = {}) {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => String(name).toLowerCase() === "content-length" ? (headers.contentLength ?? String(Buffer.byteLength(raw))) : null },
    text: async () => raw
  };
}

test("Public market data exposes only allowlisted read operations and caches quotes", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-market-data-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const calls = [];
  let currentTime = Date.parse("2026-09-02T16:00:00Z");
  const environment = { PUBLIC_COM_SECRET: "personal-secret", PUBLIC_COM_ACCOUNT_ID: "account_123" };
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, authorization: init.headers.authorization, body: init.body });
    if (url.endsWith("/personal/access-tokens")) return response(200, { accessToken: "short-lived-access-token" });
    if (url.endsWith("/quotes")) return response(200, { quotes: [{ instrument: { symbol: "SPY", type: "EQUITY" }, bid: "640.10", ask: "640.12", bidTimestamp: "2026-09-02T15:59:58Z" }] });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const service = new PublicMarketData({
    environment,
    fetchImpl,
    auditPath: path.join(folder, "audit.jsonl"),
    now: () => currentTime
  });

  assert.deepEqual(service.status().safety, { readOnly: true, accountData: false, portfolioData: false, orders: false, preflight: false });
  const first = await service.quotes({ symbol: "spy", type: "equity" });
  currentTime += 1_000;
  const cached = await service.quotes({ symbol: "SPY", type: "EQUITY" });

  assert.equal(first.cache.hit, false);
  assert.equal(first.freshness.stale, false);
  assert.equal(cached.cache.hit, true);
  assert.equal(calls.length, 2, "one auth call and one quote call expected");
  assert.equal(calls.some((call) => /order|portfolio|preflight/i.test(call.url)), false);
  assert.equal((await fs.readFile(path.join(folder, "audit.jsonl"), "utf8")).includes("personal-secret"), false);
  delete environment.PUBLIC_COM_SECRET;
  await assert.rejects(service.quotes({ symbol: "SPY", type: "EQUITY" }), /not configured/i);
});

test("Public market data rejects unsafe inputs before network access", async () => {
  let calls = 0;
  const service = new PublicMarketData({
    environment: { PUBLIC_COM_SECRET: "personal-secret", PUBLIC_COM_ACCOUNT_ID: "account_123" },
    fetchImpl: async () => { calls += 1; return response(500, {}); }
  });

  await assert.rejects(service.quotes({ symbol: "SPY/../../orders", type: "EQUITY" }), /invalid market symbol/i);
  await assert.rejects(service.optionChain({ symbol: "SPY", expirationDate: "not-a-date" }), /YYYY-MM-DD/i);
  await assert.rejects(service.optionChain({ symbol: "SPY", expirationDate: "2026-02-31" }), /real YYYY-MM-DD/i);
  await assert.rejects(service.bars({ symbol: "SPY", period: "ARBITRARY" }), /unsupported bar period/i);
  assert.equal(calls, 0);
  assert.equal(typeof service.placeOrder, "undefined");
  assert.equal(typeof service.getPortfolio, "undefined");
});

test("Public market data labels stale provider timestamps without inventing freshness", async () => {
  const now = Date.parse("2026-09-02T16:00:00Z");
  const fetchImpl = async (url) => url.endsWith("/personal/access-tokens")
    ? response(200, { accessToken: "short-lived-access-token" })
    : response(200, { quotes: [{ instrument: { symbol: "SPY", type: "EQUITY" }, last: "639", lastTimestamp: "2026-09-02T15:00:00Z" }] });
  const service = new PublicMarketData({
    environment: { PUBLIC_COM_SECRET: "personal-secret", PUBLIC_COM_ACCOUNT_ID: "account_123" }, fetchImpl, now: () => now
  });
  const result = await service.quotes({ symbol: "SPY" });
  assert.equal(result.freshness.stale, true);
  assert.equal(result.freshness.ageSeconds, 3600);
  assert.match(result.freshness.reason, /market may be closed|delayed/i);
});
