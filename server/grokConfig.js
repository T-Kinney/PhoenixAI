/**
 * Grok 4.7 is the current xAI flagship. PhoenixAI uses that id for both the
 * Grok Build ACP daemon and the direct `api.x.ai` provider. The API key stays
 * in process env / the Windows credential vault — never in git.
 */

export const DEFAULT_GROK_MODEL = "grok-4.7";
export const XAI_API_BASE_URL = "https://api.x.ai/v1";
export const XAI_STATIC_MODELS = Object.freeze([
  "grok-4.7",
  "grok-4.6",
  "grok-code-fast",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4",
  "grok-4-fast-reasoning",
  "grok-4-fast-non-reasoning"
]);

export function resolveGrokModel(env = process.env) {
  const override = String(env.GROK_MODEL || env.XAI_MODEL || "").trim();
  return override || DEFAULT_GROK_MODEL;
}

export function resolveXaiApiKey(env = process.env) {
  const key = String(env.XAI_API_KEY || env.GROK_API_KEY || "").trim();
  return key || null;
}

/**
 * Launch options for `grok agent serve`.
 *
 * An API key is the supported way to bill Grok 4.7 on `api.x.ai`. When a key is
 * present we inject it into the child and do NOT set GROK_DISABLE_API_KEY_AUTH
 * — that kill switch forces SuperGrok session auth and is why a wired key was
 * previously ignored. Without a key we keep session auth so a signed-in Grok
 * Build install still works.
 */
export function grokDaemonLaunchOptions({
  cwd,
  model = resolveGrokModel(),
  effort = "high",
  env = process.env
} = {}) {
  const apiKey = resolveXaiApiKey(env);
  const childEnv = {};
  if (apiKey) {
    childEnv.XAI_API_KEY = apiKey;
    childEnv.GROK_API_KEY = apiKey;
  }
  const extraArgs = [];
  if (model) extraArgs.push("--model", model);
  if (effort) extraArgs.push("--effort", effort);
  return {
    cwd,
    model,
    extraArgs,
    env: childEnv,
    forceSessionAuth: !apiKey,
    usingApiKey: Boolean(apiKey),
    authMode: apiKey ? "api-key" : "subscription"
  };
}
