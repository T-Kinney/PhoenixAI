import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { allowedDevOrigin, projectPathForThread, safeChildEnv } from "../server/security.js";
import { normalizeBilling } from "../server/acp/sessionManager.js";

test("safeChildEnv strips unrelated credentials and keeps explicit values", () => {
  const env = safeChildEnv({ GROK_AGENT_SECRET: "launch-secret" }, {
    PATH: "C:\\bin",
    TEMP: "C:\\temp",
    AWS_SECRET_ACCESS_KEY: "must-not-leak",
    OPENAI_API_KEY: "must-not-leak"
  });
  assert.equal(env.PATH, "C:\\bin");
  assert.equal(env.GROK_AGENT_SECRET, "launch-secret");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("billing normalization reports remaining shared percentage", () => {
  const result = normalizeBilling({
    config: { creditUsagePercent: 37.5, subscriptionTier: "SuperGrok" },
    currentPeriod: { type: "weekly", start: "2026-08-17", end: "2026-08-24" }
  });
  assert.equal(result.usedPercent, 37.5);
  assert.equal(result.remainingPercent, 62.5);
  assert.equal(result.subscriptionTier, "SuperGrok");
  assert.equal(result.currentPeriod.type, "weekly");
});

test("billing normalization handles current Grok protobuf-style fields without inventing quota", () => {
  const result = normalizeBilling({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-15", end: "2026-08-22" },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 }
    },
    subscription_tier: "Free"
  });
  assert.equal(result.available, true);
  assert.equal(result.subscriptionTier, "Free");
  assert.equal(result.onDemandCap, 0);
  assert.equal(result.remainingPercent, null);
  assert.equal(result.currentPeriod.end, "2026-08-22");
});

test("loopback dev origin policy rejects hostile and lookalike origins", () => {
  assert.equal(allowedDevOrigin(), true);
  assert.equal(allowedDevOrigin("http://127.0.0.1:5173"), true);
  assert.equal(allowedDevOrigin("http://localhost:5173"), true);
  assert.equal(allowedDevOrigin("https://attacker.example"), false);
  assert.equal(allowedDevOrigin("http://127.0.0.1.attacker.example:5173"), false);
  assert.equal(allowedDevOrigin("http://127.0.0.1:5455"), false);
  assert.equal(allowedDevOrigin("http://127.0.0.1:5176", "http://127.0.0.1:5176"), true);
});

test("project path is resolved from the persisted thread binding", async () => {
  const project = path.resolve("C:\\projects\\trusted");
  const getBundle = async () => ({ thread: { id: "t1" }, project: { path: project } });
  assert.equal(await projectPathForThread("t1", getBundle), project);
  await assert.rejects(
    projectPathForThread("t1", getBundle, "C:\\projects\\other"),
    (error) => error.status === 409
  );
  await assert.rejects(
    projectPathForThread("missing", getBundle),
    (error) => error.status === 404
  );
});
