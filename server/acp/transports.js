/**
 * ACP transports.
 *
 * Both carry newline-delimited JSON-RPC 2.0. The client is written against this
 * interface so stdio and WebSocket share one message-handling path.
 *
 *   open()               - connect/spawn; rejects on failure
 *   send(payloadObject)  - serialize and write one message
 *   close()              - tear down (still reports an intentional close)
 *   onMessage(fn)        - fn(parsedMessage)
 *   onClose(fn)          - fn({ code, signal|reason, intentional })
 *   onError(fn)          - fn(Error)
 *   onStderr(fn)         - fn(text)   (stdio only; no-op for ws)
 *
 * Close is ALWAYS reported, including when we initiated it. Swallowing it left
 * the client unable to fail its pending promises on shutdown.
 */

import { spawn } from "node:child_process";
import readline from "node:readline";

class BaseTransport {
  constructor() {
    this._onMessage = () => {};
    this._onClose = () => {};
    this._onError = () => {};
    this._onStderr = () => {};
  }
  onMessage(fn) { this._onMessage = fn; return this; }
  onClose(fn) { this._onClose = fn; return this; }
  onError(fn) { this._onError = fn; return this; }
  onStderr(fn) { this._onStderr = fn; return this; }

  /** Parse one inbound line and hand it up. Non-JSON noise goes to stderr. */
  _ingestLine(line) {
    const text = String(line).trim();
    if (!text) return;
    try {
      this._onMessage(JSON.parse(text));
    } catch {
      this._onStderr(`${text}\n`);
    }
  }
}

/** Spawns `grok agent … stdio` and speaks over its stdin/stdout. */
export class StdioTransport extends BaseTransport {
  #proc = null;
  #rl = null;
  #closing = false;
  #ended = false;

  constructor({ bin, args, cwd, env = {} }) {
    super();
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
  }

  open() {
    return new Promise((resolve, reject) => {
      let settled = false;

      this.#proc = spawn(this.bin, this.args, {
        cwd: this.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.env }
      });

      // A failed spawn (bad path) emits "error" then "close" and never "exit".
      // Both must settle open() or start() hangs forever.
      this.#proc.on("error", (e) => {
        this._onError(e);
        if (!settled) { settled = true; reject(e); }
        this.#end({ code: null, signal: null });
      });

      const onGone = (code, signal) => {
        if (!settled) {
          settled = true;
          reject(new Error(`grok exited during startup (code=${code} signal=${signal})`));
        }
        this.#end({ code, signal });
      };
      this.#proc.on("exit", onGone);
      this.#proc.on("close", onGone);

      // Writing to a dead child raises EPIPE as an unhandled stream error,
      // which would take down the host process.
      this.#proc.stdin.on("error", (e) => this._onError(e));

      this.#proc.stderr.setEncoding("utf8");
      this.#proc.stderr.on("data", (t) => this._onStderr(t));

      this.#rl = readline.createInterface({ input: this.#proc.stdout });
      this.#rl.on("line", (l) => this._ingestLine(l));

      // spawn() is async; "spawn" fires once the child is actually running.
      this.#proc.once("spawn", () => {
        if (!settled) { settled = true; resolve(); }
      });
    });
  }

  #end(info) {
    if (this.#ended) return;
    this.#ended = true;
    this._onClose({ ...info, intentional: this.#closing });
  }

  send(payload) {
    const stdin = this.#proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    return stdin.write(`${JSON.stringify(payload)}\n`);
  }

  close() {
    this.#closing = true;
    const proc = this.#proc;
    try {
      this.#rl?.close();
      if (proc?.stdin?.writable) proc.stdin.end();
    } catch { /* best effort */ }
    if (!proc) return;
    proc.kill();
    // kill() on Windows leaves grok's bash/MCP grandchildren orphaned.
    if (process.platform === "win32" && proc.pid) {
      try {
        const tk = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"],
                         { windowsHide: true, stdio: "ignore" });
        tk.on("error", () => {});
      } catch { /* best effort */ }
    }
  }
}

/**
 * Connects to an already-running `grok agent serve` over WebSocket.
 *
 * Auth: the server accepts `Authorization: Bearer <secret>` or a `server-key`
 * query param. Node's native WebSocket cannot set headers, so we use the query
 * param — acceptable on a loopback bind with a per-launch random secret. The
 * URL is built privately so it cannot be logged by reaching for a getter.
 */
export class WebSocketTransport extends BaseTransport {
  #ws = null;
  #closing = false;
  #ended = false;

  constructor({ host = "127.0.0.1", port, secret }) {
    super();
    this.host = host;
    this.port = port;
    this.#secret = secret;
  }

  #secret = null;

  #url() {
    return `ws://${this.host}:${this.port}/ws?server-key=${encodeURIComponent(this.#secret)}`;
  }

  /** Safe to log: no secret. */
  get endpoint() {
    return `ws://${this.host}:${this.port}/ws`;
  }

  open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.#ws = new WebSocket(this.#url());

      this.#ws.onopen = () => { settled = true; resolve(); };

      this.#ws.onerror = () => {
        // undici fires onerror on ordinary teardown, so a close we initiated is
        // not a fault. The event carries no detail; a pre-open failure is almost
        // always a bad secret or a daemon that is not listening.
        if (this.#closing) return;
        const error = new Error("WebSocket failed (bad secret or daemon not listening)");
        if (settled) this._onError(error);
        else { settled = true; reject(error); }
      };

      this.#ws.onclose = (ev) => {
        if (this.#ended) return;
        this.#ended = true;
        this._onClose({
          code: ev?.code ?? null,
          reason: ev?.reason ?? "",
          intentional: this.#closing
        });
      };

      // One message per frame in practice; split defensively.
      this.#ws.onmessage = (ev) => String(ev.data).split("\n").forEach((l) => this._ingestLine(l));
    });
  }

  send(payload) {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#ws.send(JSON.stringify(payload));
    // Report backpressure so callers can throttle a chatty run.
    return this.#ws.bufferedAmount < 1_000_000;
  }

  close() {
    this.#closing = true;
    try { this.#ws?.close(); } catch { /* best effort */ }
    // A socket that never opened may never fire onclose.
    if (!this.#ended) {
      this.#ended = true;
      this._onClose({ code: null, reason: "client closed", intentional: true });
    }
  }
}
