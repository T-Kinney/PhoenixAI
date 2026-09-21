import path from "node:path";

/**
 * Environment variables that a child process needs in order to run, without
 * inheriting API keys and application secrets from PhoenixAI's process.
 */
const CHILD_ENV_ALLOWLIST = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)", "USERNAME", "USERDOMAIN", "LOGONSERVER",
  "SHELL", "LANG", "LC_ALL", "TERM", "COLORTERM", "NO_COLOR",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY",
  "HTTPS_PROXY", "NO_PROXY"
]);

/** Copy only operating-system/runtime variables, then add explicit overrides. */
export function safeChildEnv(overrides = {}, source = process.env) {
  const result = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    if (value == null) continue;
    if (CHILD_ENV_ALLOWLIST.has(name.toUpperCase())) result[name] = String(value);
  }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value == null) delete result[name];
    else result[name] = String(value);
  }
  return result;
}

/** Exact dev origins allowed to call the loopback API from a browser. */
export function allowedDevOrigin(origin, extraOrigin = process.env.PHOENIX_DEV_ORIGIN) {
  if (!origin) return true; // curl, Electron, and same-origin server calls
  if (extraOrigin && origin === extraOrigin) return true;
  try {
    const url = new URL(origin);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.protocol === "http:"
      && url.port === "5173";
  } catch {
    return false;
  }
}

/**
 * Resolve a prompt's working directory from the persisted thread/project link.
 * The renderer's path is only a consistency assertion; it is never authority.
 */
export async function projectPathForThread(threadId, getThreadBundle, assertedPath = null) {
  const bundle = await getThreadBundle(threadId);
  if (!bundle?.thread || bundle.thread.id !== threadId || !bundle?.project?.path) {
    const error = new Error("Thread is not bound to an available project folder.");
    error.status = 404;
    throw error;
  }
  const trusted = path.resolve(bundle.project.path);
  if (assertedPath && path.resolve(assertedPath) !== trusted) {
    const error = new Error("The requested folder does not match this thread's project.");
    error.status = 409;
    throw error;
  }
  return trusted;
}
