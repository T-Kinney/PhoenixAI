import fs from "node:fs/promises";
import path from "node:path";

export const CREDENTIAL_PROVIDERS = Object.freeze([
  { id: "xai", name: "xAI API", envName: "XAI_API_KEY" },
  { id: "openrouter", name: "OpenRouter", envName: "OPENROUTER_API_KEY" },
  { id: "qwen", name: "QwenCloud / Model Studio", envName: "DASHSCOPE_API_KEY" },
  { id: "kimi", name: "Kimi direct", envName: "MOONSHOT_API_KEY" },
  { id: "deepseek", name: "DeepSeek direct", envName: "DEEPSEEK_API_KEY" },
  { id: "public", name: "Public.com personal secret", envName: "PUBLIC_COM_SECRET" },
  { id: "public-account", name: "Public.com account ID", envName: "PUBLIC_COM_ACCOUNT_ID" }
]);

const providerById = new Map(CREDENTIAL_PROVIDERS.map((provider) => [provider.id, provider]));

/**
 * DPAPI-backed provider credential storage for the packaged desktop app.
 * Ciphertext is persisted, while plaintext exists only in the Electron host's
 * environment so provider adapters and explicitly configured MCP children can
 * use it. Values are never returned to the renderer.
 */
export class CredentialVault {
  constructor({ filePath, environment = process.env, storage }) {
    this.filePath = filePath;
    this.environment = environment;
    this.storage = storage;
    this.entries = {};
    this.baseline = Object.fromEntries(CREDENTIAL_PROVIDERS.map(({ envName }) => [envName, environment[envName]]));
    this.loadErrors = [];
  }

  get available() {
    return Boolean(this.storage?.isEncryptionAvailable?.());
  }

  async load() {
    this.loadErrors = [];
    if (!this.available) return this.status();
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.entries = parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {};
    } catch (error) {
      if (error?.code !== "ENOENT") this.loadErrors.push("The encrypted credential file could not be read.");
      this.entries = {};
    }
    for (const provider of CREDENTIAL_PROVIDERS) {
      const ciphertext = this.entries[provider.id];
      if (!ciphertext) continue;
      try {
        this.environment[provider.envName] = this.storage.decryptString(Buffer.from(ciphertext, "base64"));
      } catch {
        this.loadErrors.push(`${provider.name} could not be decrypted for this Windows account.`);
      }
    }
    return this.status();
  }

  status() {
    return {
      available: this.available,
      encryption: this.available ? "os-protected" : "unavailable",
      errors: [...this.loadErrors],
      providers: CREDENTIAL_PROVIDERS.map((provider) => ({
        id: provider.id,
        name: provider.name,
        envName: provider.envName,
        configured: Boolean(this.environment[provider.envName]),
        source: this.entries[provider.id]
          ? "secure-storage"
          : this.environment[provider.envName] ? "environment" : null
      }))
    };
  }

  async set(providerId, value) {
    if (!this.available) {
      const error = new Error("Windows secure credential storage is unavailable. Use the local .env file instead.");
      error.status = 503;
      throw error;
    }
    const provider = providerById.get(String(providerId));
    if (!provider) {
      const error = new Error("Unsupported credential provider.");
      error.status = 400;
      throw error;
    }
    const secret = String(value ?? "").trim();
    if (secret.length < 8 || secret.length > 10_000) {
      const error = new Error("Credential must be between 8 and 10,000 characters.");
      error.status = 400;
      throw error;
    }
    this.entries[provider.id] = this.storage.encryptString(secret).toString("base64");
    this.environment[provider.envName] = secret;
    await this.#save();
    return this.status();
  }

  async clear(providerId) {
    const provider = providerById.get(String(providerId));
    if (!provider) {
      const error = new Error("Unsupported credential provider.");
      error.status = 400;
      throw error;
    }
    delete this.entries[provider.id];
    const fallback = this.baseline[provider.envName];
    if (fallback) this.environment[provider.envName] = fallback;
    else delete this.environment[provider.envName];
    await this.#save();
    return this.status();
  }

  async #save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify({ version: 1, entries: this.entries }, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }
}
