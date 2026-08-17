/**
 * ACP (Agent Client Protocol) client for Grok Build.
 *
 * The agent owns its tool loop and streams structured events back; we render
 * them and answer its permission requests. Works over stdio or WebSocket.
 *
 * Protocol reference: xai-org/grok-build docs/user-guide/15-agent-mode.md
 * plus agentclientprotocol.com.
 *
 * Wire notes verified against the Grok source:
 *  - Base ACP methods (session/update, session/request_permission) are NOT
 *    prefixed. The `_` prefix is the ACP spec's reserved extension namespace,
 *    so x.ai extensions arrive as `_x.ai/...`. Both rails carry session
 *    updates; we normalize them into one "update" event.
 *  - session/cancel is a notification (no id), per the prompt-turn spec.
 *  - Replayed history is marked `_meta.isReplay` on the notification params,
 *    NOT inside `update` — so the meta must be surfaced or a reconnect
 *    re-renders the whole conversation as fresh output.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StdioTransport, WebSocketTransport } from "./transports.js";

export const DEFAULT_GROK_BIN = path.join(os.homedir(), ".grok", "bin", "grok.exe");

const PROTOCOL_VERSION = 1;

/** Requests with no natural bound. A prompt turn can legitimately run for ages. */
// A long conversation can take a while to replay; a timeout here was being
// misread as "session missing" and silently destroying the user's history.
const UNBOUNDED_METHODS = new Set(["session/prompt", "session/load", "authenticate"]);
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Streamed update kinds. The full base set is 10; several are undocumented. */
export const UPDATE_KINDS = Object.freeze({
  MESSAGE: "agent_message_chunk",
  THOUGHT: "agent_thought_chunk",
  TOOL_CALL: "tool_call",
  TOOL_UPDATE: "tool_call_update",
  PLAN: "plan",
  USER_MESSAGE: "user_message_chunk",
  COMMANDS: "available_commands_update",
  SESSION_INFO: "session_info_update",
  CURRENT_MODE: "current_mode_update",
  CONFIG_OPTION: "config_option_update"
});

/** Permission option kinds, in the order a UI should present them. */
export const PERMISSION_KINDS = Object.freeze({
  ALLOW_ALWAYS: "allow_always",
  ALLOW_ONCE: "allow_once",
  REJECT_ONCE: "reject_once",
  REJECT_ALWAYS: "reject_always"
});

/**
 * Option ids that change global agent behavior rather than answering the
 * question asked. Grok prepends `enable-always-approve` at index 0 with kind
 * `allow_once` for clients identifying as a desktop/TUI client — so any UI that
 * auto-selects "the first allow_once" would silently enable global YOLO mode.
 * We never advertise such a clientIdentifier, but guard anyway.
 */
export const DANGEROUS_OPTION_IDS = Object.freeze(new Set(["enable-always-approve"]));

export class AcpError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    this.data = data;
  }
}

/** True for methods that carry a session update on either rail. */
function isSessionUpdateMethod(method) {
  const bare = method.startsWith("_") ? method.slice(1) : method;
  return bare === "session/update"
    || bare === "x.ai/session/update"
    || bare === "x.ai/session_notification";
}

/**
 * Emits:
 *   "update"     (sessionId, update, meta)  - streamed updates from both rails
 *   "permission" (request, respond)         - respond(optionId | responseObj | null)
 *   "notify"     (method, params)           - other agent notifications
 *   "request"    (method, params, respond)  - unhandled agent->client request
 *   "stderr"     (text)
 *   "closed"     ({ code, signal|reason, intentional })
 *   "error"      (Error)
 */
export class GrokAcpClient extends EventEmitter {
  #transport = null;
  #nextId = 1;
  #pending = new Map();
  #openPermissions = new Map();
  #closed = false;
  // Incremented per start(). Callbacks captured by an older generation are
  // ignored, so a superseded transport closing late cannot tear down a healthy
  // replacement.
  #generation = 0;

  constructor({
    transport = "stdio",
    bin = DEFAULT_GROK_BIN,
    cwd = process.cwd(),
    model = null,
    // Ask mode by default. alwaysApprove suppresses permission prompts, which
    // forfeits the main reason to put a GUI in front of this.
    alwaysApprove = false,
    env = {},
    extraArgs = [],
    host = "127.0.0.1",
    port = null,
    secret = null,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    // Generic ACP harness: an explicit command/args pair from the registry.
    // When set, `bin` and the Grok-specific arg building are bypassed.
    command = null,
    args = []
  } = {}) {
    super();
    this.transportKind = transport;
    this.bin = bin;
    this.cwd = cwd;
    this.model = model;
    this.alwaysApprove = alwaysApprove;
    this.env = env;
    this.extraArgs = extraArgs;
    this.host = host;
    this.port = port;
    this.secret = secret;
    this.requestTimeoutMs = requestTimeoutMs;
    this.command = command;
    this.args = args;
    this.initializeResult = null;
    this.lastError = null;
  }

  get running() {
    return Boolean(this.#transport) && !this.#closed;
  }

  /** Auth methods the agent advertised, if any. */
  get authMethods() {
    return this.initializeResult?.authMethods ?? [];
  }

  #buildStdioArgs() {
    // An explicit command means a registry harness (Claude, Codex, Gemini CLI,
    // Cline, goose, opencode...). Those publish their own launch args, so we
    // pass them through untouched rather than imposing Grok's flag shape.
    if (this.command) return [...this.args];

    // Grok Build: agent-level flags go after `agent` and BEFORE the mode name;
    // only mode-specific flags follow the mode.
    const args = ["agent"];
    if (this.model) args.push("--model", this.model);
    if (this.alwaysApprove) args.push("--always-approve");
    args.push(...this.extraArgs, "stdio");
    return args;
  }

  /** Open the transport and complete the ACP handshake. */
  async start() {
    if (this.#transport) throw new AcpError("Client already started.");
    const generation = ++this.#generation;
    this.#closed = false;

    // A registry harness is launched via npx or an installed binary; only the
    // default local-Grok path can be existence-checked up front.
    if (this.transportKind !== "websocket" && !this.command && !fs.existsSync(this.bin)) {
      throw new AcpError(
        `Grok Build binary not found at ${this.bin}. ` +
        `Install it with: irm https://x.ai/cli/install.ps1 | iex`
      );
    }

    const transport =
      this.transportKind === "websocket"
        ? new WebSocketTransport({ host: this.host, port: this.port, secret: this.secret })
        : new StdioTransport({
            bin: this.command ?? this.bin,
            args: this.#buildStdioArgs(),
            cwd: this.cwd,
            env: this.env
          });

    transport
      .onMessage((m) => this.#handleMessage(m))
      .onStderr((t) => this.emit("stderr", t))
      // EventEmitter throws on an unhandled "error". Record it, surface it if
      // anyone is listening, but never take down the host process.
      .onError((e) => {
        this.lastError = e;
        if (this.listenerCount("error") > 0) this.emit("error", e);
      })
      // A superseded transport closing late must not tear down a healthy
      // replacement: without the generation check, a failed start followed by a
      // successful retry gets killed when the ORIGINAL child finally exits.
      // Nulling #transport here (rather than in stop()) keeps the client
      // restartable while still failing every pending promise exactly once.
      .onClose((info) => {
        if (generation !== this.#generation) return;
        this.#closed = true;
        this.#transport = null;
        this.#failAllPending(new AcpError(`ACP transport closed (code=${info?.code ?? "?"})`));
        this.emit("closed", info);
      });

    this.#transport = transport;

    try {
      await transport.open();
      this.initializeResult = await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          // false => the agent performs its own file IO and terminals. Setting
          // these true means it delegates those calls to us, which we would
          // then have to implement and gate.
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false
        }
      });
      return this.initializeResult;
    } catch (error) {
      // Leave the client reusable rather than wedged in a half-started state.
      this.#generation += 1;          // orphan this transport's callbacks
      try { transport.close(); } catch { /* best effort */ }
      this.#transport = null;
      this.#closed = false;
      throw error;
    }
  }

  async newSession({ cwd = this.cwd, mcpServers = [], meta = null } = {}) {
    const params = { cwd, mcpServers };
    if (meta) params._meta = meta;
    const result = await this.request("session/new", params);
    if (!result?.sessionId) {
      throw new AcpError("session/new did not return a sessionId.", { data: result });
    }
    return result.sessionId;
  }

  /**
   * Re-attach to an existing session. Note this REPLAYS the session from disk;
   * the resulting updates carry `_meta.isReplay` and a UI must suppress or
   * distinguish them or it will re-render the whole conversation.
   */
  async loadSession(sessionId, { cwd = this.cwd, mcpServers = [] } = {}) {
    return this.request("session/load", { sessionId, cwd, mcpServers });
  }

  /** Send a prompt; resolves when the turn ends. Content streams via "update". */
  async prompt(sessionId, text) {
    return this.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }]
    });
  }

  /**
   * Cancel a turn. The spec requires the client to answer every outstanding
   * permission request with the `cancelled` outcome, or the agent waits forever.
   */
  /**
   * Invoke an x.ai extension method.
   *
   * Extension methods MUST carry the leading `_` on the wire — the ACP decoder
   * rejects them as method_not_found otherwise — but callers name them without
   * it, matching the documentation.
   */
  ext(method, params = {}) {
    const wire = method.startsWith("_") ? method : `_${method}`;
    return this.request(wire, params);
  }

  // --- authentication -----------------------------------------------------
  // Without these a logged-out user gets an opaque `auth_required` from
  // session/new and no way to recover from inside the app.

  /** Begin login with one of the ids from `authMethods`. */
  authenticate(methodId) {
    return this.request("authenticate", { methodId });
  }

  /**
   * The URL the user must visit. Resolves only once the agent has one, so call
   * it alongside authenticate() rather than awaiting them in series.
   * Returns { auth_url, mode, external_provider }.
   */
  authUrl() {
    return this.ext("x.ai/auth/get_url");
  }

  /** Submit the code from a device-code flow. */
  submitAuthCode(code) {
    return this.ext("x.ai/auth/submit_code", { code });
  }

  cancelAuth(requestSeq = null) {
    return this.ext("x.ai/auth/cancel", requestSeq == null ? {} : { request_seq: requestSeq });
  }

  logout() {
    return this.ext("x.ai/auth/logout", {});
  }

  /**
   * Account identity and, usefully, `codingDataRetentionOptOut` — so the app
   * can show whether prompts and traces are being retained for training rather
   * than making the user check the terminal.
   */
  authInfo() {
    return this.ext("x.ai/auth/info");
  }

  checkSubscription() {
    return this.ext("x.ai/auth/check_subscription");
  }

  cancel(sessionId) {
    for (const [id, entry] of this.#openPermissions) {
      if (entry.sessionId && entry.sessionId !== sessionId) continue;
      this.#transport?.send({
        jsonrpc: "2.0",
        id,
        result: { outcome: { outcome: "cancelled" } }
      });
      this.#openPermissions.delete(id);
    }
    this.notify("session/cancel", { sessionId });
  }

  request(method, params = {}) {
    if (!this.running) return Promise.reject(new AcpError("Client is not running."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      const settle = (fn) => (value) => {
        if (timer) clearTimeout(timer);
        this.#pending.delete(id);
        fn(value);
      };
      const entry = { resolve: settle(resolve), reject: settle(reject), method };
      this.#pending.set(id, entry);

      if (!UNBOUNDED_METHODS.has(method) && this.requestTimeoutMs > 0) {
        timer = setTimeout(() => {
          entry.reject(new AcpError(`ACP request '${method}' timed out after ${this.requestTimeoutMs}ms.`));
        }, this.requestTimeoutMs);
        timer.unref?.();
      }

      try {
        this.#transport.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        entry.reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.running) return;
    try {
      this.#transport.send({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.lastError = error;
    }
  }

  async stop() {
    const transport = this.#transport;
    if (!transport || this.#closed) return;
    // Do NOT null #transport here — the close handler needs to run so pending
    // promises are rejected rather than left hanging. It nulls it for us.
    transport.close();
  }

  #handleMessage(message) {
    // Response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.#pending.get(message.id);
      if (!entry) return;
      if (message.error) {
        entry.reject(new AcpError(message.error.message || "ACP request failed", {
          code: message.error.code,
          data: message.error.data
        }));
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) this.#handleIncoming(message);
  }

  #handleIncoming(message) {
    const { method, params = {}, id } = message;
    const isRequest = id !== undefined;
    // One JSON-RPC id gets exactly one response. A turn cancel and a user
    // click can otherwise both answer the same permission request.
    let replied = false;
    const reply = (result) => {
      if (!isRequest || replied) return;
      replied = true;
      this.#transport?.send({ jsonrpc: "2.0", id, result });
    };

    // Session updates arrive on both the base and the `_x.ai/` extension rail.
    if (isSessionUpdateMethod(method)) {
      this.emit("update", params.sessionId, params.update ?? params, params._meta ?? null);
      return;
    }

    // Tool approval — the hook the GUI's dialog hangs off.
    if (method === "session/request_permission") {
      if (this.listenerCount("permission") === 0) {
        // "Nobody can approve this" is a clean user rejection, not a protocol
        // error. Returning an error surfaces a confusing method-not-found.
        reply({ outcome: { outcome: "cancelled" } });
        return;
      }
      if (isRequest) this.#openPermissions.set(id, { sessionId: params.sessionId });

      /**
       * Accepts either an option id string, a fully-formed response object, or
       * null/false to cancel. Callers reasonably reach for both shapes, and
       * silently nesting one inside the other turned a deny into a malformed
       * allow — so both are handled explicitly.
       */
      const respond = (arg) => {
        if (isRequest) this.#openPermissions.delete(id);
        if (arg && typeof arg === "object") {
          return reply(arg.outcome ? arg : { outcome: arg });
        }
        return reply(arg
          ? { outcome: { outcome: "selected", optionId: String(arg) } }
          : { outcome: { outcome: "cancelled" } });
      };

      this.emit("permission", params, respond);
      return;
    }

    if (!isRequest) {
      this.emit("notify", method, params);
      return;
    }
    if (this.listenerCount("request") === 0) {
      this.#transport?.send({
        jsonrpc: "2.0", id,
        error: { code: -32601, message: `Unhandled ACP method: ${method}` }
      });
      return;
    }
    this.emit("request", method, params, reply);
  }

  #failAllPending(error) {
    for (const [, entry] of this.#pending) entry.reject(error);
    this.#pending.clear();
    this.#openPermissions.clear();
  }
}
