import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CredentialVault } from "../electron/credentials.js";
import { selectLocalCredentials } from "../electron/localCredentialImport.js";

const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`cipher:${value}`, "utf8"),
  decryptString: (value) => value.toString("utf8").replace(/^cipher:/, "")
};

test("credential vault persists ciphertext, restores keys, and never returns values", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-credentials-"));
  const filePath = path.join(folder, "credentials.json");
  t.after(() => fs.rm(folder, { recursive: true, force: true }));

  const environment = { OPENROUTER_API_KEY: "environment-fallback" };
  const vault = new CredentialVault({ filePath, environment, storage });
  const saved = await vault.set("openrouter", "private-openrouter-key");
  assert.equal(environment.OPENROUTER_API_KEY, "private-openrouter-key");
  assert.equal(saved.providers.find((item) => item.id === "openrouter")?.source, "secure-storage");
  assert.equal(JSON.stringify(saved).includes("private-openrouter-key"), false);
  assert.equal((await fs.readFile(filePath, "utf8")).includes("private-openrouter-key"), false);

  const restoredEnvironment = {};
  const restored = new CredentialVault({ filePath, environment: restoredEnvironment, storage });
  await restored.load();
  assert.equal(restoredEnvironment.OPENROUTER_API_KEY, "private-openrouter-key");

  await vault.clear("openrouter");
  assert.equal(environment.OPENROUTER_API_KEY, "environment-fallback");
});

test("local build provisioning imports supported aliases but never OpenRouter", () => {
  const selected = selectLocalCredentials({
    QWEN_API_KEY: "private-qwen-key",
    KIMI_API_KEY: "private-kimi-key",
    DEEPSEEK_API_KEY: "private-deepseek-key",
    PUBLIC_COM_SECRET: "private-public-secret",
    PUBLIC_COM_ACCOUNT_ID: "public-account-123",
    OPENROUTER_API_KEY: "must-never-be-imported"
  });
  assert.deepEqual(selected.map((item) => item.providerId), ["qwen", "kimi", "deepseek", "public", "public-account"]);
  assert.equal(selected.some((item) => item.value === "must-never-be-imported"), false);
});
