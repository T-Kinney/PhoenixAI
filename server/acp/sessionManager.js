/**
 * Session manager: binds Agent Command Center threads to Grok Build sessions.
 *
 * One daemon serves every project — `session/new` takes its own `cwd`, so there
 * is no reason to run a process per project. Thread→session bindings persist to
 * disk so closing and reopening the app reattaches to live work.
 *
 * Everything host-agnostic lives here so the Electron app and the dev server
 * behave identically. In particular PERMISSION CORRELATION is here, not in the
 * Electron host: the ACP `respond` callback is a live function that cannot
 * cross an IPC boundary, so hosts answer by id instead. Keeping that mapping
 * host-side is what previously left the dev server unable to approve anything.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import { GrokDaemon } from "./daemon.js";
import { UPDATE_KINDS, DANGEROUS_OPTION_IDS } from "./client.js";
import { WorkflowTracker, isWorkflowUpdate, workflowsFromCommands } from "./workflows.js";
import { buildPromptBlocks } from "./attachments.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A spawned child process cannot read from inside app.asar, so in a packaged
// build this must resolve to the unpacked copy (see build.asarUnpack).
const MEMORY_MCP = path.join(HERE, "..", "memory", "mcpServer.js")
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const PERMISSION_TTL_MS = 10 * 60 * 1000;

/**
 * Tear the agent down after this long with no activity.
 *
 * A long-lived `grok agent serve` holds a port, memory, and its own child
 * processes indefinitely. Bindings persist to disk and `session/load` replays
 * from the agent's own store, so nothing is lost by releasing an idle daemon —
 * the next prompt transparently reconnects. Set to 0 to disable.
 */
const IDLE_RELEASE_MS = 5 * 60 * 1000;

/**
 * ACP `tool_call_update` is a PATCH keyed by toolCallId, not a full snapshot.
 * Undefined fields are dropped so a later partial update cannot erase a field
 * an earlier one set.
 */
function mergeToolCall(existing, patch) {
  const next = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key === "content" && Array.isArray(value)) {
      next.content = [...(existing?.content ?? []), ...value];
    } else {
      next[key] = value;
    }
  }
  return next;
}

export class SessionManager extends EventEmitter {
  #daemon = null;
  #client = null;
  #bindings = new Map();      // threadId -> { sessionId, cwd }
  #toolCalls = new Map();     // threadId -> Map(toolCallId -> state)
  #attached = new Set();      // sessionIds already loaded on the CURRENT client
  #permissions = new Map();   // permissionId -> { respond, optionIds, timer }
  #permissionSeq = 0;
  #connecting = null;
  #ensuring = new Map();   // threadId -> in-flight ensureSession
  #saveChain = Promise.resolve();
  #idleTimer = null;
  #activeTurns = 0;
  #workflows = new WorkflowTracker();
  #availableCommands = [];

  constructor({
    statePath,
    defaultCwd = process.cwd(),
    // Path to the memory database. When set, the memory MCP server is attached
    // to every session — which is the ONLY mechanism by which our knowledge
    // store reaches the agent's tool loop. Without it the memory layer exists
    // but the model can never consult it.
    memoryDbPath = null,
    playbookPath = null,
    idleReleaseMs = IDLE_RELEASE_MS,
    // grok-build 1.0.5+ accepts a reasoning-effort hint at session start.
    // Explicit here beats the model catalog default.
    reasoningEffort = null,
    // Extra MCP servers, same shape as the ACP `mcpServers` entries.
    extraMcpServers = []
  } = {}) {
    super();
    this.statePath = statePath;
    this.defaultCwd = defaultCwd;
    this.memoryDbPath = memoryDbPath;
    this.playbookPath = playbookPath;
    this.idleReleaseMs = idleReleaseMs;
    this.reasoningEffort = reasoningEffort;
    this.extraMcpServers = extraMcpServers;
  }

  /**
   * MCP servers handed to the agent at session start.
   *
   * MCP has no concept of a model, so the same server definition works for
   * Grok, Claude, Codex, Gemini and every other ACP harness. This is what makes
   * the memory vendor-neutral rather than one more per-agent silo.
   */
  mcpServersFor(project) {
    const servers = [...this.extraMcpServers];
    if (this.memoryDbPath) {
      const args = [MEMORY_MCP, "--db", this.memoryDbPath];
      if (project) args.push("--project", project);
      if (this.playbookPath) args.push("--playbook", this.playbookPath);
      // ACP `EnvVariable` is {name, value} — verified against the official SDK
      // types, not assumed.
      const env = [];

      // CRITICAL for the packaged app: under Electron, process.execPath is the
      // Electron binary, so spawning it with a script path launches a SECOND
      // Electron app instead of running Node. The agent spawns this process,
      // not us, so we cannot set the flag ourselves — it has to travel in the
      // env we hand over.
      if (process.versions.electron) {
        env.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
      }

      // Embeddings are free on NIM, so semantic recall costs nothing and never
      // touches a paid quota.
      if (process.env.NVIDIA_API_KEY) {
        env.push({ name: "NVIDIA_API_KEY", value: process.env.NVIDIA_API_KEY });
      }

      servers.unshift({
        name: "project-memory",
        command: process.execPath,   // absolute, as the spec requires
        args,
        env
      });
    }
    return servers;
  }

  /**
   * Restart the idle countdown. Never armed while a turn is in flight or a
   * permission is outstanding — releasing then would kill live work or strand
   * a dialog the user is looking at.
   */
  #touch() {
    if (this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
    if (!this.idleReleaseMs || this.#activeTurns > 0 || this.#permissions.size > 0) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#activeTurns > 0 || this.#permissions.size > 0) return;
      this.emit("idle-release", { afterMs: this.idleReleaseMs });
      // Bindings are on disk and the agent replays its own history, so the next
      // prompt reconnects transparently.
      this.releaseIdle().catch(() => {});
    }, this.idleReleaseMs);
    this.#idleTimer.unref?.();
  }

  /** Drop the agent connection and daemon, keeping all persisted state. */
  async releaseIdle() {
    if (this.#activeTurns > 0) return { released: false, reason: "turn in flight" };
    const client = this.#client;
    this.#client = null;
    this.#attached.clear();
    await client?.stop().catch(() => {});
    await this.#daemon?.stop().catch(() => {});
    this.emit("released", { reason: "idle" });
    return { released: true };
  }

  /**
   * `_meta` for session creation.
   *
   * Only the first parseable `startupHints` object is honored — the agent takes
   * it whole rather than merging field by field, so it must be complete.
   */
  #sessionMeta() {
    const meta = {
      startupHints: {
        // A GUI has no TTY; saying so stops the agent waiting on terminal-only
        // affordances.
        nonInteractive: true
      }
    };
    if (this.reasoningEffort) meta.reasoningEffort = this.reasoningEffort;
    return meta;
  }

  /** Auth plane in use, so the UI can state it rather than leave it inferred. */
  get authMode() {
    const ids = (this.#client?.authMethods ?? []).map((m) => m.id);
    if (ids.includes("cached_token")) return "subscription";
    return ids[0] ?? "unknown";
  }

  get status() {
    return {
      daemon: this.#daemon?.describe() ?? { running: false },
      connected: Boolean(this.#client?.running),
      authMode: this.authMode,
      threads: [...this.#bindings.keys()],
      pendingPermissions: [...this.#permissions.keys()],
      workflows: this.#workflows.active().length
    };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      for (const [threadId, binding] of Object.entries(parsed?.bindings ?? {})) {
        this.#bindings.set(threadId, binding);
      }
    } catch {
      // Absent or unreadable. Starting empty is correct either way.
    }
  }

  /** Serialized and atomic: concurrent writers cannot interleave or truncate. */
  #save() {
    const next = this.#saveChain.then(async () => {
      const payload = JSON.stringify({ bindings: Object.fromEntries(this.#bindings) }, null, 2);
      const tmp = `${this.statePath}.tmp`;
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(tmp, payload, "utf8");
      await fs.rename(tmp, this.statePath);
    }).catch((error) => {
      // EventEmitter rethrows "error" when nothing is listening, which would
      // reject this link and poison every future save with the ORIGINAL error.
      if (this.listenerCount("error") > 0) this.emit("error", error);
      else this.lastSaveError = error;
    });
    // Always continue from a RESOLVED link so one failure cannot disable
    // persistence permanently.
    this.#saveChain = next.then(() => {}, () => {});
    return next;
  }

  async connect() {
    if (this.#client?.running) return this.status;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#doConnect().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  async #doConnect() {
    if (!this.#daemon) {
      this.#daemon = new GrokDaemon({ cwd: this.defaultCwd });
      this.#daemon.on("stderr", (text) => this.emit("daemon-output", text));
      this.#daemon.on("exit", (info) => this.emit("daemon-exit", info));
      this.#daemon.on("error", (e) => this.emit("daemon-error", e));
    }
    await this.#daemon.start();

    const client = await this.#daemon.connect({ cwd: this.defaultCwd });
    client.on("update", (sessionId, update, meta) => this.#onUpdate(sessionId, update, meta));
    client.on("permission", (req, respond) => this.#onPermission(req, respond));
    client.on("notify", (method, params) => this.emit("notify", { method, params }));
    client.on("closed", (info) => {
      // A late close from a superseded client must not tear down a fresh one.
      if (this.#client !== client) return;
      this.#client = null;
      this.#attached.clear();
      this.#expirePermissions("agent disconnected");
      this.emit("disconnected", info);
    });

    this.#client = client;
    this.#attached.clear();
    this.#touch();
    this.emit("connected", this.status);
    return this.status;
  }

  #threadForSession(sessionId) {
    for (const [threadId, binding] of this.#bindings) {
      if (binding.sessionId === sessionId) return threadId;
    }
    return null;
  }

  #onUpdate(sessionId, update, meta) {
    const threadId = this.#threadForSession(sessionId);
    const isReplay = Boolean(meta?.isReplay);
    const kind = update?.sessionUpdate;

    // Workflow progress arrives on the extension rail as an ordinary session
    // update. The TUI's /workflows dashboard never reaches the agent, so a GUI
    // has to accumulate these itself.
    if (isWorkflowUpdate(update)) {
      const result = this.#workflows.ingest(update);
      if (result?.changed) {
        this.emit("workflow", {
          threadId, sessionId, run: result.run, removed: result.removed
        });
        // A run holding the daemon open is not idle, even between turns.
        if (!result.removed && !result.run?.terminal) this.#touch();
      }
      return;
    }

    // Saved workflows are advertised as slash commands; keep the list so the
    // UI can offer them without a round-trip.
    if (kind === UPDATE_KINDS.COMMANDS) {
      this.#availableCommands = update.availableCommands ?? update.commands ?? [];
      this.emit("commands", {
        threadId,
        commands: this.#availableCommands,
        workflows: workflowsFromCommands(this.#availableCommands)
      });
    }

    if (threadId && (kind === UPDATE_KINDS.TOOL_CALL || kind === UPDATE_KINDS.TOOL_UPDATE)) {
      const id = update.toolCallId ?? update.id;
      if (id) {
        if (!this.#toolCalls.has(threadId)) this.#toolCalls.set(threadId, new Map());
        const perThread = this.#toolCalls.get(threadId);
        perThread.set(id, mergeToolCall(perThread.get(id), {
          id,
          title: update.title,
          kind: update.kind,
          status: update.status,
          content: update.content,
          locations: update.locations
        }));
      }
    }

    this.emit("update", { threadId, sessionId, update, isReplay, meta });
  }

  // --- permissions --------------------------------------------------------

  #onPermission(request, respond) {
    // Grok prepends `enable-always-approve` for some client identities, at
    // index 0 with kind allow_once. Strip anything that changes global agent
    // behavior rather than answering the question asked.
    const options = (request?.options ?? []).filter((o) => !DANGEROUS_OPTION_IDS.has(o.optionId));
    const id = `perm_${++this.#permissionSeq}`;

    let settled = false;
    const settle = (optionId) => {
      if (settled) return false;      // a turn cancel and a click can race
      settled = true;
      const entry = this.#permissions.get(id);
      if (entry?.timer) clearTimeout(entry.timer);
      this.#permissions.delete(id);
      respond(optionId ?? null);
      this.emit("permission-resolved", { id, optionId: optionId ?? null });
      return true;
    };

    const timer = setTimeout(() => settle(null), PERMISSION_TTL_MS);
    timer.unref?.();

    this.#permissions.set(id, {
      settle,
      timer,
      sessionId: request?.sessionId ?? null,
      optionIds: new Set(options.map((o) => o.optionId)),
      payload: { id, ...request, options }
    });

    // If no host is listening, decline cleanly rather than letting the agent
    // block for the full TTL waiting on an approval nobody can give.
    if (this.listenerCount("permission") === 0) {
      settle(null);
      return;
    }
    this.emit("permission", { id, ...request, options });
  }

  /**
   * Answer a permission request by id. Only ids the agent actually offered are
   * accepted — a renderer must not be able to name a filtered-out option, which
   * is how `enable-always-approve` would otherwise get through.
   */
  respondToPermission(id, optionId) {
    const entry = this.#permissions.get(id);
    if (!entry) return { ok: false, reason: "unknown or already-answered request" };
    if (optionId != null && !entry.optionIds.has(optionId)) {
      return { ok: false, reason: `option '${optionId}' was not offered` };
    }
    entry.settle(optionId ?? null);
    return { ok: true };
  }

  /** Outstanding requests, so a newly opened window can be re-shown the backlog. */
  pendingPermissions() {
    return [...this.#permissions.values()].map((e) => e.payload);
  }

  /** Settle outstanding permissions; scoped to one session when given. */
  #expirePermissions(reason, sessionId = null) {
    for (const [, entry] of [...this.#permissions]) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      entry.settle(null);
    }
    if (reason) this.emit("permissions-cleared", { reason, sessionId });
  }

  // --- authentication -----------------------------------------------------

  /**
   * Account state for the UI. Reports whether a login is needed and — because
   * this project handles proprietary trading code — whether coding data is
   * being retained for training.
   */
  async authStatus() {
    await this.connect();
    try {
      const info = await this.#client.authInfo();
      return {
        authenticated: Boolean(info?.methodId),
        methodId: info?.methodId ?? null,
        email: info?.email ?? null,
        teamName: info?.teamName ?? null,
        dataRetentionOptOut: Boolean(info?.codingDataRetentionOptOut),
        authMode: this.authMode,
        availableMethods: this.#client.authMethods
      };
    } catch (error) {
      return {
        authenticated: false,
        error: error.message,
        authMode: this.authMode,
        availableMethods: this.#client?.authMethods ?? []
      };
    }
  }

  /**
   * Start an interactive login and return the URL to open.
   *
   * Sequencing matters and is not obvious:
   *  - `authenticate` blocks for the ENTIRE login (the agent bounds it at
   *    ~600s), and its response IS the completion signal. It must not be
   *    awaited here.
   *  - `x.ai/auth/get_url` is ONE-SHOT: if no interactive attempt is registered
   *    yet it returns nulls immediately rather than waiting. Calling it once
   *    right behind `authenticate` therefore usually yields nothing, so it has
   *    to be polled the way the reference client does.
   */
  async beginLogin(methodId = null) {
    await this.connect();
    const client = this.#client;

    // Never assume `grok.com`: an enterprise install advertises `oidc` instead,
    // and naming the wrong one returns `unsupported auth method`.
    const interactive = methodId
      || client.authMethods.map((m) => m.id).find((id) => id !== "cached_token")
      || "grok.com";

    const completion = client.authenticate(interactive)
      .then((result) => {
        this.emit("auth-complete", { methodId: interactive, result });
        return result;
      })
      .catch((error) => {
        this.emit("auth-error", { methodId: interactive, message: error.message });
        throw error;
      });
    completion.catch(() => {});   // completion is observed via events

    // Poll for the URL, matching the reference client's cadence.
    let urlInfo = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      urlInfo = await client.authUrl().catch(() => null);
      if (urlInfo?.auth_url) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    return {
      started: true,
      methodId: interactive,
      authUrl: urlInfo?.auth_url ?? null,
      // `mode` is authoritative (loopback | command | device);
      // `external_provider` is kept only for older clients.
      mode: urlInfo?.mode ?? null,
      externalProvider: Boolean(urlInfo?.external_provider)
    };
  }

  async submitAuthCode(code) {
    await this.connect();
    return this.#client.submitAuthCode(String(code ?? ""));
  }

  async cancelLogin() {
    if (!this.#client?.running) return { cancelled: false };
    return this.#client.cancelAuth().catch(() => ({ cancelled: false }));
  }

  async logout() {
    if (!this.#client?.running) return { ok: false, reason: "not connected" };
    const result = await this.#client.logout();
    this.#attached.clear();
    return result;
  }

  // --- workflows ----------------------------------------------------------

  /** All tracked runs, newest first. */
  workflowRuns() {
    return this.#workflows.runs;
  }

  /** Saved workflows advertised by the agent. */
  availableWorkflows() {
    return workflowsFromCommands(this.#availableCommands);
  }

  /** Drop terminal runs from the tracker. */
  pruneWorkflows() {
    this.#workflows.prune();
    return { ok: true };
  }

  // --- sessions -----------------------------------------------------------

  toolCallsFor(threadId) {
    return [...(this.#toolCalls.get(threadId)?.values() ?? [])];
  }

  /**
   * Bind a thread to a session. `session/load` REPLAYS the whole conversation,
   * so it runs only when reattaching — never per prompt, which would make
   * traffic O(n²) and duplicate tool-call content on every turn.
   */
  async ensureSession(threadId, projectPath) {
    // Single-flight per thread: concurrent callers share one resolution, or two
    // sessions get created and the first is orphaned mid-stream.
    const inflight = this.#ensuring.get(threadId);
    if (inflight) return inflight;
    const promise = this.#doEnsureSession(threadId, projectPath)
      .finally(() => this.#ensuring.delete(threadId));
    this.#ensuring.set(threadId, promise);
    return promise;
  }

  async #doEnsureSession(threadId, projectPath) {
    if (typeof threadId !== "string" || !threadId.trim()) {
      const error = new Error("threadId is required.");
      error.status = 400;
      throw error;
    }
    await this.connect();
    const cwd = projectPath || this.defaultCwd;
    const existing = this.#bindings.get(threadId);

    if (existing?.sessionId) {
      if (this.#attached.has(existing.sessionId)) {
        return { sessionId: existing.sessionId, resumed: true };
      }
      try {
        // Replay rebuilds tool-call state; clear first or it doubles.
        this.#toolCalls.delete(threadId);
        await this.#client.loadSession(existing.sessionId, {
          cwd: existing.cwd || cwd,
          mcpServers: this.mcpServersFor(projectPath ?? null)
        });
        this.#attached.add(existing.sessionId);
        return { sessionId: existing.sessionId, resumed: true };
      } catch (error) {
        // Only a genuinely missing session justifies discarding the binding.
        // Treating a timeout or transport blip as "gone" silently destroys the
        // user's conversation and overwrites it on disk.
        if (!/not found|unknown session|no such session/i.test(error.message || "")) {
          throw error;
        }
      }
    }

    const sessionId = await this.#client.newSession({
      cwd,
      mcpServers: this.mcpServersFor(projectPath ?? null),
      meta: this.#sessionMeta()
    });
    this.#bindings.set(threadId, { sessionId, cwd });
    this.#attached.add(sessionId);
    this.#toolCalls.delete(threadId);
    await this.#save();
    return { sessionId, resumed: false };
  }

  /**
   * Start a turn and return immediately. The turn's completion arrives on the
   * update stream — holding an HTTP request open for a multi-minute agent run
   * makes the endpoint unusable from a browser.
   */
  async startPrompt(threadId, text, { projectPath = null, attachments = [] } = {}) {
    const { sessionId, resumed } = await this.ensureSession(threadId, projectPath);
    const client = this.#client;

    // Attachments are converted against the LIVE agent's declared capabilities,
    // so the same file becomes an inline image on an agent that takes images
    // and a staged path on one that does not.
    let payload = text;
    let notes = [];
    if (attachments.length) {
      const built = await buildPromptBlocks(text, attachments, {
        capabilities: client.promptCapabilities(),
        stagingDir: this.#attachmentDir()
      });
      payload = built.blocks;
      notes = built.notes;
    }

    this.#activeTurns += 1;
    this.#touch();
    const done = () => { this.#activeTurns = Math.max(0, this.#activeTurns - 1); this.#touch(); };
    client.prompt(sessionId, payload)
      .then((result) => { done(); this.emit("turn-complete", { threadId, sessionId, result }); })
      .catch((error) => { done(); this.emit("turn-error", {
        threadId,
        sessionId,
        message: error.message,
        // Quota exhaustion is a decision point, not a malfunction.
        quota: /usage limit|balance exhausted|plan limit|rate limit/i.test(error.message || "")
      }); });
    return { sessionId, resumed, accepted: true, attachments: notes };
  }

  /**
   * Where attached files are written when the agent will not take their bytes
   * inline. Kept beside the session state, never inside the user's project — an
   * attachment must not litter the repo the agent is working in.
   */
  #attachmentDir() {
    return path.join(path.dirname(this.statePath), "attachments");
  }

  cancel(threadId) {
    const binding = this.#bindings.get(threadId);
    if (!binding?.sessionId) return { ok: false, reason: "thread has no session" };
    // Scoped: cancelling thread A must not auto-deny thread B's open approval.
    this.#expirePermissions("turn cancelled", binding.sessionId);
    this.#client?.cancel(binding.sessionId);
    return { ok: true };
  }

  async unbind(threadId) {
    const binding = this.#bindings.get(threadId);
    if (binding?.sessionId) this.#attached.delete(binding.sessionId);
    this.#bindings.delete(threadId);
    this.#toolCalls.delete(threadId);
    await this.#save();
    return { ok: true };
  }

  async shutdown() {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#expirePermissions("shutting down");
    await this.#client?.stop().catch(() => {});
    this.#client = null;
    await this.#daemon?.stop().catch(() => {});
    await this.#saveChain.catch(() => {});
  }
}
