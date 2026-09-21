import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../server/acp/sessionManager.js";
import { SpendGuard, sanitizeSpendingSafety } from "../server/spendGuard.js";

async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-spend-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let instant = new Date("2026-08-20T12:00:00.000Z");
  return {
    guard: new SpendGuard({ ledgerPath: path.join(folder, "ledger.json"), now: () => instant }),
    advance(ms) { instant = new Date(instant.getTime() + ms); }
  };
}

const enabledPolicy = sanitizeSpendingSafety({
  paidCloudCallsEnabled: true,
  dailyBudgetUsd: 1,
  perRequestBudgetUsd: 0.5,
  maxOutputTokens: 256,
  maxRequestsPerHour: 2
});

test("paid providers and OpenRouter fail closed by default", async (t) => {
  const { guard } = await fixture(t);
  await assert.rejects(
    guard.reserve({ providerId: "deepseek", prompt: "review", maxOutputTokens: 100, policy: {} }),
    (error) => error.code === "PAID_CALLS_LOCKED"
  );
  await assert.rejects(
    guard.reserve({ providerId: "openrouter", prompt: "review", maxOutputTokens: 100, policy: enabledPolicy }),
    (error) => error.code === "OPENROUTER_BLOCKED"
  );
});

test("one shared ledger enforces concurrency and hourly request caps", async (t) => {
  const { guard } = await fixture(t);
  const first = await guard.reserve({ providerId: "deepseek", prompt: "review", maxOutputTokens: 100, policy: enabledPolicy });
  await assert.rejects(
    guard.reserve({ providerId: "kimi", prompt: "review", maxOutputTokens: 100, policy: enabledPolicy }),
    (error) => error.code === "PAID_CONCURRENCY"
  );
  await guard.settle(first, { outcome: "completed" });
  const second = await guard.reserve({ providerId: "kimi", prompt: "review", maxOutputTokens: 100, policy: enabledPolicy });
  await guard.settle(second, { outcome: "completed" });
  await assert.rejects(
    guard.reserve({ providerId: "qwen", prompt: "review", maxOutputTokens: 100, policy: enabledPolicy }),
    (error) => error.code === "PAID_RATE_LIMIT"
  );
  const status = await guard.status(enabledPolicy);
  assert.equal(status.today.requestsLastHour, 2);
  assert.equal(status.today.activePaidRequests, 0);
  assert.equal(status.today.chargedOrReservedUsd > 0, true);
});

test("paid review credentials are withheld unless the host unlocks spending", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-session-spend-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const old = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY
  };
  process.env.DEEPSEEK_API_KEY = "direct-review-key";
  process.env.OPENROUTER_API_KEY = "must-never-be-forwarded";
  t.after(() => {
    if (old.DEEPSEEK_API_KEY === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = old.DEEPSEEK_API_KEY;
    if (old.OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = old.OPENROUTER_API_KEY;
  });

  const manager = new SessionManager({ statePath: path.join(folder, "sessions.json") });
  assert.equal(manager.mcpServersFor(folder).some((server) => server.name === "multi-model-review"), false);

  manager.spendingSafety = enabledPolicy;
  manager.spendLedgerPath = path.join(folder, "ledger.json");
  const review = manager.mcpServersFor(folder).find((server) => server.name === "multi-model-review");
  assert.ok(review);
  assert.equal(review.env.some((item) => item.name === "DEEPSEEK_API_KEY"), true);
  assert.equal(review.env.some((item) => item.name === "OPENROUTER_API_KEY"), false);
});
