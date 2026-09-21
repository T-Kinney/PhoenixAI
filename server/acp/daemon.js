/**
 * Grok Build daemon lifecycle.
 *
 * Runs `grok agent serve` as a managed child and hands out connected ACP
 * clients. The daemon outliving any one client is the point: the Electron UI
 * can reload, crash, or be closed and reopened while a long agent run keeps
 * going. Verified — a session survived a hard socket drop and retained
 * conversational memory after `session/load`.
 *
 * Security: binds to 127.0.0.1 with a freshly generated secret per launch. The
 * secret is never persisted and never logged; `describe()` is safe to surface.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { EventEmitter } from "node:events";
import { GrokAcpClient, DEFAULT_GROK_BIN } from "./client.js";
import { safeChildEnv } from "../security.js";

const HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 300;
const OUTPUT_TAIL_CHARS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Check whether the installed Grok Build is behind, and update it.
 *
 * xAI publishes no tags, no GitHub releases and no machine-readable changelog,
 * so the only reliable signal is npm: `@xai-official/grok` tracks the CLI
 * version. The installer is idempotent, so re-running it is the update path.
 *
 * Never runs automatically at startup — an unexpected binary swap mid-session
 * is worse than being a version behind. The app surfaces the availability and
 * the user decides.
 */
export async function checkGrokVersion(bin = DEFAULT_GROK_BIN) {
  const local = await new Promise((resolve) => {
    const proc = spawn(bin, ["--version"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (t) => { out += t; });
    proc.on("error", () => resolve(null));
    proc.on("close", () => resolve(out.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null));
    setTimeout(() => { proc.kill(); resolve(null); }, 10_000).unref?.();
  });

  let latest = null;
  try {
    const response = await fetch("https://registry.npmjs.org/@xai-official/grok/latest", {
      signal: AbortSignal.timeout(15_000)
    });
    if (response.ok) latest = (await response.json())?.version ?? null;
  } catch { /* offline; report what we know */ }

  const cmp = (a, b) => {
    const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    return 0;
  };

  return {
    installed: local,
    latest,
    updateAvailable: Boolean(local && latest && cmp(local, latest) < 0),
    // The official installer is the supported update path and is idempotent.
    command: process.platform === "win32"
      ? "irm https://x.ai/cli/install.ps1 | iex"
      : "curl -fsSL https://x.ai/cli/install.sh | bash"
  };
}

/** Ask the OS for a free port by binding to 0 and reading it back. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Readiness must be AUTHENTICATED, not a bare TCP connect.
 *
 * findFreePort binds port 0 then closes it, so there is a window where another
 * process could take the port. A plain connect would then report "ready", and
 * connect() would hand our secret to a stranger. Completing a real WebSocket
 * upgrade against /ws proves the listener is a grok agent that accepts our
 * secret — an impostor gets a 401 and fails the handshake.
 */
function isOurAgentListening(port, secret) {
  return new Promise((resolve) => {
    let ws;
    const finish = (ok) => {
      try { ws?.close(); } catch { /* best effort */ }
      resolve(ok);
    };
    try {
      ws = new WebSocket(
        `ws://${HOST}:${port}/ws?server-key=${encodeURIComponent(secret)}`
      );
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(false), 2000);
    timer.unref?.();
    ws.onopen = () => { clearTimeout(timer); finish(true); };
    ws.onerror = () => { clearTimeout(timer); finish(false); };
  });
}

/**
 * Emits: "started" ({port}) · "stderr" (text) · "exit" ({code, signal}) · "error" (Error)
 */
export class GrokDaemon extends EventEmitter {
  #proc = null;
  #port = null;
  #secret = null;
  #starting = null;
  #stopping = false;
  #outputTail = [];

  constructor({
    bin = DEFAULT_GROK_BIN,
    cwd = process.cwd(),
    env = {},
    extraArgs = [],
    model = null,
    // When true, the child is forced onto SuperGrok session auth. When an
    // XAI_API_KEY is present the host passes forceSessionAuth: false so Grok
    // 4.7 bills api.x.ai instead of the subscription pool.
    forceSessionAuth = true
  } = {}) {
    super();
    this.bin = bin;
    this.cwd = cwd;
    this.env = env;
    this.extraArgs = extraArgs;
    this.model = model;
    this.forceSessionAuth = forceSessionAuth;
  }

  get running() {
    return Boolean(this.#proc) && !this.#stopping && this.#proc.exitCode === null;
  }

  get port() {
    return this.#port;
  }

  /** Connection details minus the secret. Safe to log or send to the renderer. */
  describe() {
    return {
      running: this.running,
      host: HOST,
      port: this.#port,
      pid: this.#proc?.pid ?? null,
      cwd: this.cwd,
      model: this.model,
      authMode: this.forceSessionAuth ? "subscription" : "api-key"
    };
  }

  /**
   * Recent child output (stdout AND stderr, interleaved), for diagnosing a
   * daemon that will not come up. Capped by character count, not chunk count —
   * a single chunk can be arbitrarily large.
   */
  get outputTail() {
    return this.#outputTail.join("").slice(-OUTPUT_TAIL_CHARS);
  }

  /** Idempotent: concurrent callers share one startup. */
  async start() {
    if (this.running) return this.describe();
    if (this.#starting) return this.#starting;
    this.#starting = this.#doStart().finally(() => { this.#starting = null; });
    return this.#starting;
  }

  async #doStart() {
    this.#stopping = false;
    this.#outputTail = [];
    this.#port = await findFreePort();
    this.#secret = randomBytes(32).toString("hex");

    // Agent-level flags belong after `agent` and before the mode name; only
    // mode-specific flags follow `serve`.
    // The secret goes in the environment, NOT argv: on Windows any same-user
    // process can read a command line out of Win32_Process, and process-creation
    // telemetry captures it. `--secret` accepts GROK_AGENT_SECRET instead.
    const args = [
      "agent",
      ...this.extraArgs,
      "serve",
      "--bind", `${HOST}:${this.#port}`
    ];

    // A cwd that is not an existing directory makes spawn fail with ENOENT,
    // which reads as "grok.exe is missing" and sends you hunting the wrong bug.
    // Fall back to a directory that always exists.
    let spawnCwd = this.cwd;
    try {
      if (!statSync(spawnCwd).isDirectory()) spawnCwd = tmpdir();
    } catch {
      spawnCwd = tmpdir();
    }

    this.#proc = spawn(this.bin, args, {
      cwd: spawnCwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: (() => {
        const merged = safeChildEnv(this.env);
        // Session auth hits the SuperGrok CLI proxy. API-key auth hits
        // api.x.ai. The kill switch is only used when no XAI_API_KEY was
        // injected — otherwise Grok 4.7 would ignore the key and keep using
        // the cached grok.com token.
        if (this.forceSessionAuth) merged.GROK_DISABLE_API_KEY_AUTH = "1";
        else delete merged.GROK_DISABLE_API_KEY_AUTH;
        merged.GROK_AGENT_SECRET = this.#secret;
        return merged;
      })()
    });

    this.#proc.on("error", (e) => this.emit("error", e));
    this.#proc.on("exit", (code, signal) => {
      this.#proc = null;
      this.emit("exit", { code, signal });
    });

    for (const stream of [this.#proc.stdout, this.#proc.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (text) => {
        this.#outputTail.push(text);
        while (this.#outputTail.join("").length > OUTPUT_TAIL_CHARS * 2) this.#outputTail.shift();
        this.emit("stderr", text);
      });
    }

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.#proc) {
        throw new Error(`grok agent serve exited during startup.\n${this.outputTail.slice(-600)}`);
      }
      if (await isOurAgentListening(this.#port, this.#secret)) {
        this.emit("started", { port: this.#port });
        return this.describe();
      }
      await sleep(POLL_INTERVAL_MS);
    }

    await this.stop();
    throw new Error(
      `grok agent serve did not listen on ${HOST}:${this.#port} within ${STARTUP_TIMEOUT_MS}ms.\n` +
      this.outputTail.slice(-600)
    );
  }

  /** A connected, handshaken ACP client against this daemon. */
  async connect({ cwd = this.cwd } = {}) {
    if (!this.running) await this.start();
    const client = new GrokAcpClient({
      transport: "websocket",
      host: HOST,
      port: this.#port,
      secret: this.#secret,
      cwd
    });
    await client.start();
    return client;
  }

  async stop() {
    this.#stopping = true;
    const proc = this.#proc;
    if (!proc) return;
    proc.kill();
    // Windows does not always honor a plain kill on a console child; escalate.
    const deadline = Date.now() + 5000;
    while (proc.exitCode === null && Date.now() < deadline) await sleep(100);
    if (proc.exitCode === null && proc.pid && process.platform === "win32") {
      try {
        // spawn reports failure asynchronously via an "error" event, which a
        // try/catch cannot see — without a listener that is an uncaught
        // exception that kills the host process.
        const tk = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"],
                         { windowsHide: true, stdio: "ignore" });
        tk.on("error", () => {});
      } catch { /* best effort */ }
    }
    this.#proc = null;
    this.#secret = null;
  }
}
