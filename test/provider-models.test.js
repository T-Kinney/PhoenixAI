import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("strict model readiness never disguises an authorization failure as a static catalog", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-provider-state-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.XAI_API_KEY = "test-xai-key";
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "forbidden" } }), {
    status: 403,
    headers: { "content-type": "application/json" }
  });

  const api = await import(`../server/api.js?strict-models=${Date.now()}`);
  await assert.rejects(
    api.listProviderModels("xai", { allowFallback: false }),
    /forbidden/
  );
  const fallback = await api.listProviderModels("xai", { allowFallback: true });
  assert.equal(fallback.models.length > 0, true);
  assert.equal(fallback.models.every((model) => model.source === "static"), true);
});

test("OpenRouter generation is blocked before any network request", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-openrouter-block-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.OPENROUTER_API_KEY = "configured-but-blocked";
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("{}"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const api = await import(`../server/api.js?openrouter-block=${Date.now()}`);
  await assert.rejects(
    api.testProvider({ providerId: "openrouter", model: "anything", prompt: "do work" }),
    (error) => error.code === "OPENROUTER_BLOCKED"
  );
  assert.equal(fetches, 0);
});

test("QWEN_API_KEY is accepted as a host-only alias for QwenCloud", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-qwen-alias-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const oldQwen = process.env.QWEN_API_KEY;
  const oldDashscope = process.env.DASHSCOPE_API_KEY;
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.QWEN_API_KEY = "alias-test-key";
  delete process.env.DASHSCOPE_API_KEY;
  t.after(() => {
    if (oldQwen === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = oldQwen;
    if (oldDashscope === undefined) delete process.env.DASHSCOPE_API_KEY;
    else process.env.DASHSCOPE_API_KEY = oldDashscope;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.authorization, "Bearer alias-test-key");
    return new Response(JSON.stringify({ data: [{ id: "qwen3.8-max" }, { id: "deepseek-v4-pro-0813" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const api = await import(`../server/api.js?qwen-alias=${Date.now()}`);
  const result = await api.listProviderModels("qwen", { allowFallback: false });
  assert.deepEqual(result.models.map((model) => model.id), ["deepseek-v4-pro-0813", "qwen3.8-max"]);
});

test("QwenCloud pay-as-you-go generation stays locked before fetch", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-qwen-locked-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.DASHSCOPE_API_KEY = "configured-qwencloud-key";
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; return new Response("{}"); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const api = await import(`../server/api.js?qwen-locked=${Date.now()}`);
  await assert.rejects(
    api.testProvider({ providerId: "qwen", model: "qwen3.8-max", prompt: "do paid work" }),
    (error) => error.code === "PAID_CALLS_LOCKED"
  );
  assert.equal(fetches, 0);
});

test("KIMI_API_KEY aliases Moonshot and exposes read-only balance", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-kimi-alias-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const oldKimi = process.env.KIMI_API_KEY;
  const oldMoonshot = process.env.MOONSHOT_API_KEY;
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.KIMI_API_KEY = "kimi-alias-test-key";
  delete process.env.MOONSHOT_API_KEY;
  t.after(() => {
    if (oldKimi === undefined) delete process.env.KIMI_API_KEY;
    else process.env.KIMI_API_KEY = oldKimi;
    if (oldMoonshot === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = oldMoonshot;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers.authorization, "Bearer kimi-alias-test-key");
    if (String(url).endsWith("/users/me/balance")) {
      return new Response(JSON.stringify({ status: true, data: {
        available_balance: 10, cash_balance: 10, voucher_balance: 0
      } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [{ id: "kimi-k3" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const api = await import(`../server/api.js?kimi-alias=${Date.now()}`);
  const models = await api.listProviderModels("kimi", { allowFallback: false });
  assert.deepEqual(models.models.map((model) => model.id), ["kimi-k3"]);
  const balance = await api.getProviderBalance("kimi");
  assert.equal(balance.availableBalanceUsd, 10);
});

test("DeepSeek direct exposes V4 models and its prepaid balance without generation", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-deepseek-direct-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const oldDeepSeek = process.env.DEEPSEEK_API_KEY;
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.DEEPSEEK_API_KEY = "deepseek-direct-test-key";
  t.after(() => {
    if (oldDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldDeepSeek;
  });
  const originalFetch = globalThis.fetch;
  let generationRequests = 0;
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(options.headers.authorization, "Bearer deepseek-direct-test-key");
    if (String(url).endsWith("/user/balance")) {
      return new Response(JSON.stringify({
        is_available: true,
        balance_infos: [{
          currency: "USD", total_balance: "10.00", granted_balance: "0.00", topped_up_balance: "10.00"
        }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (String(url).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-v4-flash" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    generationRequests += 1;
    return new Response("{}", { status: 500 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const api = await import(`../server/api.js?deepseek-direct=${Date.now()}`);
  const models = await api.listProviderModels("deepseek", { allowFallback: false });
  assert.deepEqual(models.models.map((model) => model.id), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  const balance = await api.getProviderBalance("deepseek");
  assert.equal(balance.available, true);
  assert.equal(balance.availableBalanceUsd, 10);
  assert.equal(balance.cashBalanceUsd, 10);
  assert.equal(balance.grantedBalanceUsd, 0);
  assert.equal(generationRequests, 0);
});
