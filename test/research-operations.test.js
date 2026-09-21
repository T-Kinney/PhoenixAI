import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ResearchOperations } from "../server/researchOperations.js";

test("alert scanning is source-attributed and triggers only on a fresh transition", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-alerts-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const project = { id: "project_one", path: folder };
  const operations = new ResearchOperations({ dataDir: path.join(folder, "state"), now: () => Date.parse("2026-09-02T16:00:00Z") });
  await operations.createAlert({ symbol: "SPY", type: "EQUITY", condition: "last_above", threshold: 600 }, project);
  const marketData = { quotes: async () => ({ source: "Fixture", retrievedAt: "2026-09-02T16:00:00Z", freshness: { stale: false, ageSeconds: 1 }, data: { quotes: [{ instrument: { symbol: "SPY", type: "EQUITY" }, last: "640", lastTimestamp: "2026-09-02T15:59:59Z", outcome: "SUCCESS" }] } }) };
  const first = await operations.scanAlerts(project, marketData);
  const second = await operations.scanAlerts(project, marketData);
  assert.equal(first.triggered.length, 1);
  assert.equal(second.triggered.length, 0);
  assert.equal(first.evidence.source, "Fixture");
  assert.equal((await operations.listSignalEvents(project.id))[0].freshness.stale, false);
});

test("a stale matching observation cannot consume the next fresh alert transition", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-alert-stale-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const project = { id: "project_one", path: folder };
  let currentTime = Date.parse("2026-09-02T16:00:00Z");
  const operations = new ResearchOperations({ dataDir: path.join(folder, "state"), now: () => currentTime });
  await operations.createAlert({ symbol: "SPY", condition: "last_above", threshold: 600 }, project);
  const marketData = { quotes: async () => ({ source: "Fixture", retrievedAt: new Date(currentTime).toISOString(), data: { quotes: [{ instrument: { symbol: "SPY", type: "EQUITY" }, last: "640", lastTimestamp: currentTime === Date.parse("2026-09-02T16:00:00Z") ? "2026-09-02T14:00:00Z" : "2026-09-02T16:00:01Z", outcome: "SUCCESS" }] } }) };
  const stale = await operations.scanAlerts(project, marketData);
  currentTime += 2_000;
  const fresh = await operations.scanAlerts(project, marketData);
  assert.equal(stale.triggered.length, 0);
  assert.equal(fresh.triggered.length, 1);
});

test("paper fills are idempotent, use the adverse quote side, and enforce hard limits", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-paper-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const project = { id: "project_one", path: folder };
  const operations = new ResearchOperations({ dataDir: path.join(folder, "state"), now: () => Date.parse("2026-09-02T16:00:00Z") });
  await operations.createPaperAccount({ initialCashUsd: 10_000, risk: { maxOrderNotionalPct: 20, maxPositionPct: 25, slippageBps: 10, commissionPerFillUsd: 1 } }, project);
  const evidence = { source: "Fixture", retrievedAt: "2026-09-02T15:59:59Z", freshness: { stale: false, ageSeconds: 1, asOf: "2026-09-02T15:59:59Z" }, data: { quotes: [{ instrument: { symbol: "SPY", type: "EQUITY" }, bid: "99", ask: "100" }] } };
  const buy = await operations.simulatePaperFill({ symbol: "SPY", type: "EQUITY", side: "BUY", quantity: 10, idempotencyKey: "buy-1" }, project, evidence);
  const duplicate = await operations.simulatePaperFill({ symbol: "SPY", type: "EQUITY", side: "BUY", quantity: 10, idempotencyKey: "buy-1" }, project, evidence);
  const rejected = await operations.simulatePaperFill({ symbol: "SPY", type: "EQUITY", side: "BUY", quantity: 100, idempotencyKey: "buy-too-large" }, project, evidence);
  const sell = await operations.simulatePaperFill({ symbol: "SPY", type: "EQUITY", side: "SELL", quantity: 5, idempotencyKey: "sell-1" }, project, evidence);
  assert.equal(buy.event.status, "filled");
  assert.equal(buy.event.fillPrice, 100.1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(rejected.event.status, "rejected");
  assert.match(rejected.event.rejectionReasons.join(" "), /order-notional|position/i);
  assert.equal(sell.event.fillPrice, 98.901);
  assert.equal(sell.state.positions[0].quantity, 5);
  assert.equal(sell.state.fills.length, 2);
  assert.equal(sell.state.account.liveTrading, false);
});

test("paper execution rejects stale evidence and cannot create a short position", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-paper-safe-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const project = { id: "project_one", path: folder };
  const operations = new ResearchOperations({ dataDir: path.join(folder, "state") });
  await operations.createPaperAccount({ initialCashUsd: 10_000 }, project);
  const evidence = { source: "Fixture", retrievedAt: new Date().toISOString(), freshness: { stale: true, ageSeconds: 500 }, data: { quotes: [{ instrument: { symbol: "SPY", type: "EQUITY" }, bid: "99", ask: "100" }] } };
  const stale = await operations.simulatePaperFill({ symbol: "SPY", type: "EQUITY", side: "BUY", quantity: 1, idempotencyKey: "stale" }, project, evidence);
  const short = await operations.simulatePaperFill({ symbol: "SPY", type: "EQUITY", side: "SELL", quantity: 1, idempotencyKey: "short" }, project, { ...evidence, freshness: { stale: false, ageSeconds: 1 } });
  assert.match(stale.event.rejectionReasons.join(" "), /not fresh/i);
  assert.match(short.event.rejectionReasons.join(" "), /short selling is disabled/i);
  assert.equal((await operations.paperState(project.id)).fills.length, 0);
});
