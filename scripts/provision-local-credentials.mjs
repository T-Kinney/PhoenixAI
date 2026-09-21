import { app, safeStorage } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { CredentialVault } from "../electron/credentials.js";
import { selectLocalCredentials } from "../electron/localCredentialImport.js";

app.disableHardwareAcceleration();
app.setName("PhoenixAI");

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.resolve(process.env.PHOENIX_LOCAL_ENV_PATH || path.join(projectRoot, ".env"));

async function run() {
  let parsed;
  try {
    parsed = parse(await fs.readFile(envPath));
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.log("Local credential provisioning skipped: .env was not found.");
      return;
    }
    throw error;
  }

  const credentials = selectLocalCredentials(parsed);
  if (!credentials.length) {
    console.log("Local credential provisioning skipped: no supported provider keys were found.");
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Windows credential encryption is unavailable; refusing to copy plaintext keys.");
  }

  const filePath = path.join(app.getPath("appData"), "PhoenixAI", "data", "credentials.json");
  const vault = new CredentialVault({ filePath, environment: {}, storage: safeStorage });
  await vault.load();
  for (const credential of credentials) {
    await vault.set(credential.providerId, credential.value);
  }

  const status = vault.status();
  const imported = credentials.map(({ providerId }) => providerId);
  const missing = imported.filter((providerId) =>
    status.providers.find((provider) => provider.id === providerId)?.source !== "secure-storage");
  if (missing.length) throw new Error(`Encrypted credential verification failed for: ${missing.join(", ")}`);
  console.log(`Provisioned ${imported.length} encrypted local credentials: ${imported.join(", ")}.`);
  console.log("OpenRouter was not imported. No plaintext credentials were added to the installer.");
}

app.whenReady()
  .then(run)
  .catch((error) => {
    console.error(`Local credential provisioning failed: ${error.message}`);
    process.exitCode = 1;
  })
  // Electron's graceful quit can discard process.exitCode on Windows. Use an
  // explicit exit so release scripts joined with `&&` stop if provisioning
  // fails instead of silently building an installer with stale credentials.
  .finally(() => app.exit(process.exitCode || 0));
