import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("unlock requires both the typed phrase and provider-side limit attestation", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-spending-config-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  const api = await import(`../server/api.js?spending-config=${Date.now()}`);

  const limits = {
    paidCloudCallsEnabled: true,
    dailyBudgetUsd: 1,
    perRequestBudgetUsd: 0.25,
    confirmation: "ENABLE PAID CLOUD CALLS"
  };
  await assert.rejects(
    api.updateSpendingSafety(limits),
    /provider spending limit or free-quota-only block/i
  );
  const status = await api.updateSpendingSafety({ ...limits, providerLimitConfirmed: true });
  assert.equal(status.policy.paidCloudCallsEnabled, true);
  assert.equal(status.policy.openRouterEnabled, false);
});
