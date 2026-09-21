const LOCAL_CREDENTIAL_SOURCES = Object.freeze([
  { providerId: "xai", envNames: ["XAI_API_KEY"] },
  { providerId: "qwen", envNames: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"] },
  { providerId: "kimi", envNames: ["MOONSHOT_API_KEY", "KIMI_API_KEY"] },
  { providerId: "deepseek", envNames: ["DEEPSEEK_API_KEY"] },
  { providerId: "public", envNames: ["PUBLIC_COM_SECRET", "PUBLIC_API_SECRET_KEY"] },
  { providerId: "public-account", envNames: ["PUBLIC_COM_ACCOUNT_ID", "PUBLIC_DEFAULT_ACCOUNT_ID"] }
]);

/**
 * Selects only providers PhoenixAI is allowed to provision automatically.
 * OpenRouter is intentionally absent because inference is hard-blocked and the
 * account may carry an unexpected balance. Values are returned only to the
 * trusted Electron process and must never be logged.
 */
export function selectLocalCredentials(values = {}) {
  const selected = [];
  for (const source of LOCAL_CREDENTIAL_SOURCES) {
    const value = source.envNames
      .map((name) => String(values[name] ?? "").trim())
      .find((candidate) => candidate.length >= 8);
    if (value) selected.push({ providerId: source.providerId, value });
  }
  return selected;
}
