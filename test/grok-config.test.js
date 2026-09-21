import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GROK_MODEL, XAI_STATIC_MODELS, grokDaemonLaunchOptions, resolveGrokModel, resolveXaiApiKey } from "../server/grokConfig.js";
import { SpendGuard } from "../server/spendGuard.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Grok 4.7 is the default model and leads the static xAI catalog", () => {
  assert.equal(DEFAULT_GROK_MODEL, "grok-4.7");
  assert.equal(XAI_STATIC_MODELS[0], "grok-4.7");
  assert.equal(resolveGrokModel({}), "grok-4.7");
  assert.equal(resolveGrokModel({ GROK_MODEL: "grok-4.6" }), "grok-4.6");
});

test("XAI_API_KEY wins over GROK_API_KEY and is injected into the daemon child", () => {
  const withKey = grokDaemonLaunchOptions({
    cwd: "C:\\dev\\DesktopClient",
    env: { XAI_API_KEY: "xai-test-key", GROK_API_KEY: "ignored" }
  });
  assert.equal(withKey.forceSessionAuth, false);
  assert.equal(withKey.usingApiKey, true);
  assert.equal(withKey.authMode, "api-key");
  assert.equal(withKey.env.XAI_API_KEY, "xai-test-key");
  assert.equal(withKey.env.GROK_API_KEY, "xai-test-key");
  assert.deepEqual(withKey.extraArgs, ["--model", "grok-4.7", "--effort", "high"]);
  assert.equal(resolveXaiApiKey({ GROK_API_KEY: "xai-alias" }), "xai-alias");
});

test("without an API key the daemon still forces SuperGrok session auth", () => {
  const session = grokDaemonLaunchOptions({ cwd: "/", env: {} });
  assert.equal(session.forceSessionAuth, true);
  assert.equal(session.usingApiKey, false);
  assert.equal(session.env.XAI_API_KEY, undefined);
  assert.equal(session.authMode, "subscription");
});

test("xAI home-key inference is allowed while other paid providers stay locked", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-xai-home-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "xai-home-test";
  t.after(() => {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  });
  const guard = new SpendGuard({ ledgerPath: path.join(folder, "ledger.json") });
  const allowed = await guard.reserve({
    providerId: "xai",
    prompt: "hello",
    maxOutputTokens: 64,
    policy: { paidCloudCallsEnabled: false, dailyBudgetUsd: 0, perRequestBudgetUsd: 0 }
  });
  assert.equal(allowed.paid, true);
  assert.equal(allowed.providerId, "xai");
  await guard.settle(allowed, { outcome: "completed" });
  await assert.rejects(
    guard.reserve({
      providerId: "deepseek",
      prompt: "hello",
      maxOutputTokens: 64,
      policy: {}
    }),
    (error) => error.code === "PAID_CALLS_LOCKED"
  );
});
