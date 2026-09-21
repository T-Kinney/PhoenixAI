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
import { GrokAcpClient, UPDATE_KINDS, DANGEROUS_OPTION_IDS } from "./client.js";
import { WorkflowTracker, isWorkflowUpdate, workflowsFromCommands } from "./workflows.js";
import { buildPromptBlocks } from "./attachments.js";
import { MemoryStore } from "../memory/store.js";
import { buildRecoveryEnvelope, parseRecoveryEnvelope, visibleRecoveryUpdate } from "./continuity.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// A spawned child process cannot read from inside app.asar, so in a packaged
// build this must resolve to the unpacked copy (see build.asarUnpack).
const MEMORY_MCP = path.join(HERE, "..", "memory", "mcpServer.js")
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const REVIEW_MCP = path.join(HERE, "reviewMcpServer.js")
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const MARKET_DATA_MCP = path.join(HERE, "marketDataMcpServer.js")
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
const GROK_HARNESS_ID = "grok-build-local";

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

function updateText(update) {
  const content = update?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((item) => item?.text ?? "").join("");
  return content?.text ?? "";
}

function updateRole(kind) {
  if (kind === UPDATE_KINDS.USER_MESSAGE) return "user";
  if (kind === UPDATE_KINDS.MESSAGE || kind === UPDATE_KINDS.THOUGHT) return "assistant";
  if (kind === UPDATE_KINDS.TOOL_CALL || kind === UPDATE_KINDS.TOOL_UPDATE) return "tool";
  return "system";
}

export function normalizeBilling(raw) {
  if (!raw || typeof raw !== "object") return null;
  const config = raw.config && typeof raw.config === "object" ? raw.config : raw;
  const number = (value) => {
    const candidate = value && typeof value === "object" ? (value.val ?? value.value) : value;
    if (candidate == null || candidate === "") return null;
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const directRemaining = number(config.remainingPercent ?? config.creditRemainingPercent
    ?? config.remaining_percent ?? raw.remainingPercent ?? raw.remaining_percent);
  const directUsed = number(config.creditUsagePercent ?? config.credit_usage_percent
    ?? raw.creditUsagePercent ?? raw.credit_usage_percent);
  const usedPercent = directUsed != null
    ? Math.min(100, Math.max(0, directUsed))
    : directRemaining != null ? Math.min(100, Math.max(0, 100 - directRemaining)) : null;
  const remainingPercent = directRemaining != null
    ? Math.min(100, Math.max(0, directRemaining))
    : usedPercent == null ? null : Math.max(0, 100 - usedPercent);
  const monthlyLimit = number(raw.monthlyLimit ?? raw.monthly_limit ?? config.monthlyLimit ?? config.monthly_limit);
  const used = number(raw.used ?? config.used);
  const legacyRemaining = Number.isFinite(monthlyLimit) && Number.isFinite(used)
    ? Math.max(0, monthlyLimit - used)
    : null;
  const period = raw.currentPeriod ?? config.currentPeriod ?? null;
  return {
    available: true,
    subscriptionTier: raw.subscriptionTier ?? raw.subscription_tier
      ?? config.subscriptionTier ?? config.subscription_tier ?? null,
    usedPercent,
    remainingPercent,
    currentPeriod: period ? {
      type: period.type ?? null,
      start: period.start ?? null,
      end: period.end ?? null
    } : null,
    monthlyLimit: Number.isFinite(monthlyLimit) ? monthlyLimit : null,
    used: Number.isFinite(used) ? used : null,
    remaining: legacyRemaining,
    onDemandCap: number(raw.onDemandCap ?? raw.on_demand_cap ?? config.onDemandCap ?? config.on_demand_cap),
    onDemandUsed: number(raw.onDemandUsed ?? raw.on_demand_used ?? config.onDemandUsed ?? config.on_demand_used),
    prepaidBalance: raw.prepaidBalance ?? config.prepaidBalance ?? null,
    updatedAt: new Date().toISOString()
  };
}

export class SessionManager extends EventEmitter {
  #daemon = null;
  #client = null;
  #clients = new Map();       // registry harness id -> connected ACP client
  #harnessConnecting = new Map();
  #bindings = new Map();      // threadId -> { sessionId, cwd, harnessId }
  #toolCalls = new Map();     // threadId -> Map(toolCallId -> state)
  #attached = new Set();      // sessionIds already loaded on the CURRENT client
  #permissions = new Map();   // permissionId -> { respond, optionIds, timer }
  #permissionSeq = 0;
  #connecting = null;
  #ensuring = new Map();   // threadId -> in-flight ensureSession
  #saveChain = Promise.resolve();
  #idleTimer = null;
  #activeTurns = 0;
  #environmentRefreshRequested = false;
  #workflows = new WorkflowTracker();
  #availableCommands = [];
  #billing = null;
  #memoryStore = null;

  constructor({
    statePath,
    defaultCwd = process.cwd(),
    approvalMode = "ask",
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
    spendingSafety = null,
    spendLedgerPath = null,
    // Extra MCP servers, same shape as the ACP `mcpServers` entries.
    extraMcpServers = [],
    grokClient = null
  } = {}) {
    super();
    this.statePath = statePath;
    this.defaultCwd = defaultCwd;
    // "ask" prompts for every action; "auto" answers allow-once on the user's
    // behalf. Auto never selects allow_always: that flips a persistent switch
    // inside the agent that outlives this setting, so turning auto-approve off
    // again would not actually restore prompting.
    this.approvalMode = approvalMode;
    this.memoryDbPath = memoryDbPath;
    this.playbookPath = playbookPath;
    this.idleReleaseMs = idleReleaseMs;
    this.reasoningEffort = reasoningEffort;
    this.spendingSafety = spendingSafety;
    this.spendLedgerPath = spendLedgerPath;
    this.extraMcpServers = extraMcpServers;
    this.grokClient = grokClient;
    if (memoryDbPath) {
      try { this.#memoryStore = new MemoryStore(memoryDbPath).open(); }
      catch (error) { this.lastMemoryError = error; }
    }
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
    const reviewerEnv = [];
    if (process.versions.electron) reviewerEnv.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
    if (this.spendingSafety?.paidCloudCallsEnabled === true && this.spendLedgerPath) {
      const qwenCloudKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
      for (const name of ["DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "DASHSCOPE_API_KEY"]) {
        const value = name === "DASHSCOPE_API_KEY" ? qwenCloudKey
          : name === "MOONSHOT_API_KEY" ? (process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY)
            : process.env[name];
        if (value) reviewerEnv.push({ name, value });
      }
      reviewerEnv.push({ name: "PHOENIX_SPENDING_SAFETY", value: JSON.stringify(this.spendingSafety) });
      reviewerEnv.push({ name: "PHOENIX_SPEND_LEDGER_PATH", value: this.spendLedgerPath });
    }
    if (project && reviewerEnv.some((item) => ["DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "DASHSCOPE_API_KEY"].includes(item.name))) {
      servers.push({
        name: "multi-model-review",
        command: process.execPath,
        args: [REVIEW_MCP, "--project", project],
        env: reviewerEnv
      });
    }
    const publicSecret = process.env.PUBLIC_COM_SECRET || process.env.PUBLIC_API_SECRET_KEY;
    const publicAccount = process.env.PUBLIC_COM_ACCOUNT_ID || process.env.PUBLIC_DEFAULT_ACCOUNT_ID;
    if (publicSecret && publicAccount) {
      const env = [
        { name: "PUBLIC_COM_SECRET", value: publicSecret },
        { name: "PUBLIC_COM_ACCOUNT_ID", value: publicAccount }
      ];
      if (process.versions.electron) env.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
      const args = [MARKET_DATA_MCP];
      if (this.statePath) args.push("--audit", path.join(path.dirname(this.statePath), "market-data-audit.jsonl"));
      servers.push({ name: "market-data-readonly", command: process.execPath, args, env });
    }
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
    if (this.#activeTurns > 0 || this.#permissions.size > 0) return;
    if (this.#environmentRefreshRequested) {
      this.#environmentRefreshRequested = false;
      Promise.resolve().then(() => this.releaseIdle()).catch(() => {});
      return;
    }
    if (!this.idleReleaseMs) return;
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
    if (this.#permissions.size > 0) return { released: false, reason: "permission pending" };
    const client = this.#client;
    this.#client = null;
    this.#attached.clear();
    await client?.stop().catch(() => {});
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((item) => item.stop().catch(() => {})));
    await this.#daemon?.stop().catch(() => {});
    this.emit("released", { reason: "idle" });
    return { released: true };
  }

  /** Refresh MCP/provider environment as soon as doing so cannot interrupt work. */
  async refreshEnvironment() {
    if (this.#activeTurns > 0 || this.#permissions.size > 0) {
      this.#environmentRefreshRequested = true;
      return { released: false, deferred: true, reason: "agent busy" };
    }
    return this.releaseIdle();
  }

  async setSpendingSafety(spendingSafety, spendLedgerPath = this.spendLedgerPath) {
    this.spendingSafety = spendingSafety;
    this.spendLedgerPath = spendLedgerPath;
    return this.refreshEnvironment();
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
      connectedHarnesses: [
        ...(this.#client?.running ? [GROK_HARNESS_ID] : []),
        ...[...this.#clients.entries()].filter(([, client]) => client.running).map(([id]) => id)
      ],
      authMode: this.authMode,
      threads: [...this.#bindings.keys()],
      pendingPermissions: [...this.#permissions.keys()],
      workflows: this.#workflows.active().length,
      activeTurns: this.#activeTurns
    };
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      for (const [threadId, binding] of Object.entries(parsed?.bindings ?? {})) {
        this.#bindings.set(threadId, { harnessId: GROK_HARNESS_ID, ...binding });
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
    if (this.grokClient) {
      const client = typeof this.grokClient === "function" ? await this.grokClient() : this.grokClient;
      this.#adoptGrokClient(client);
      return this.status;
    }
    if (!this.#daemon) {
      this.#daemon = new GrokDaemon({ cwd: this.defaultCwd });
      this.#daemon.on("stderr", (text) => this.emit("daemon-output", text));
      this.#daemon.on("exit", (info) => this.emit("daemon-exit", info));
      this.#daemon.on("error", (e) => this.emit("daemon-error", e));
    }
    await this.#daemon.start();

    const client = await this.#daemon.connect({ cwd: this.defaultCwd });
    this.#adoptGrokClient(client);
    return this.status;
  }

  #adoptGrokClient(client) {
    client.on("update", (sessionId, update, meta) => this.#onUpdate(GROK_HARNESS_ID, sessionId, update, meta));
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
  }

  async #connectHarness(harnessId, launch) {
    if (harnessId === GROK_HARNESS_ID) {
      await this.connect();
      return this.#client;
    }
    const existing = this.#clients.get(harnessId);
    if (existing?.running) return existing;
    const inflight = this.#harnessConnecting.get(harnessId);
    if (inflight) return inflight;
    if (!launch?.command || !Array.isArray(launch.args)) {
      const error = new Error(`No approved launch specification for '${harnessId}'.`);
      error.status = 400;
      throw error;
    }
    const promise = (async () => {
      const client = new GrokAcpClient({
        transport: "stdio",
        command: launch.command,
        args: launch.args,
        cwd: this.defaultCwd,
        env: launch.env ?? {}
      });
      client.on("update", (sessionId, update, meta) => this.#onUpdate(harnessId, sessionId, update, meta));
      client.on("permission", (request, respond) => this.#onPermission(request, respond));
      client.on("notify", (method, params) => this.emit("notify", { harnessId, method, params }));
      client.on("stderr", (text) => this.emit("daemon-output", `[${harnessId}] ${text}`));
      client.on("closed", (info) => {
        if (this.#clients.get(harnessId) !== client) return;
        this.#clients.delete(harnessId);
        for (const key of [...this.#attached]) {
          if (key.startsWith(`${harnessId}:`)) this.#attached.delete(key);
        }
        this.emit("disconnected", { harnessId, ...info });
      });
      await client.start();
      this.#clients.set(harnessId, client);
      this.emit("connected", { ...this.status, harnessId });
      return client;
    })().finally(() => this.#harnessConnecting.delete(harnessId));
    this.#harnessConnecting.set(harnessId, promise);
    return promise;
  }

  #threadForSession(harnessId, sessionId) {
    for (const [threadId, binding] of this.#bindings) {
      if ((binding.harnessId ?? GROK_HARNESS_ID) === harnessId && binding.sessionId === sessionId) return threadId;
    }
    return null;
  }

  #onUpdate(harnessId, sessionId, update, meta) {
    const threadId = this.#threadForSession(harnessId, sessionId);
    const isReplay = Boolean(meta?.isReplay);
    const kind = update?.sessionUpdate;
    const recovery = kind === UPDATE_KINDS.USER_MESSAGE ? parseRecoveryEnvelope(updateText(update)) : null;
    if (threadId && recovery) {
      const binding = this.#bindings.get(threadId);
      if (binding?.recoveryPending) {
        this.#bindings.set(threadId, { ...binding, recoveryPending: false });
        this.#save();
      }
    }
    const publicUpdate = recovery ? visibleRecoveryUpdate(update, updateText) : update;

    // Replay is already present in the append-only store. Recording it again
    // on every reconnect would multiply the transcript indefinitely.
    if (threadId && kind && kind !== UPDATE_KINDS.USER_MESSAGE && !isReplay && this.#memoryStore) {
      const binding = this.#bindings.get(threadId);
      try {
        this.#memoryStore.appendEvent({
          threadId,
          sessionId,
          kind,
          role: updateRole(kind),
          text: updateText(update),
          payload: update,
          provider: harnessId,
          project: binding?.cwd ?? null
        });
      } catch (error) {
        this.lastMemoryError = error;
      }
    }

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
        const merged = perThread.get(id);
        if (/memory_recall|memory_check_failures/i.test(`${merged.title ?? ""} ${merged.kind ?? ""}`)
            && /completed|done/i.test(merged.status ?? "")) {
          const text = (merged.content ?? []).map((item) =>
            item?.text ?? item?.content?.text ?? (typeof item?.content === "string" ? item.content : "")
          ).filter(Boolean).join("\n");
          if (text) this.emit("memory-recall", {
            threadId,
            hits: [{ kind: /failure/i.test(merged.title ?? "") ? "failure" : "recall", text }]
          });
        }
      }
    }

    this.emit("update", { threadId, sessionId, harnessId, update: publicUpdate, isReplay, meta });
  }

  // --- permissions --------------------------------------------------------

  #onPermission(request, respond) {
    // Grok prepends `enable-always-approve` for some client identities, at
    // index 0 with kind allow_once. Strip anything that changes global agent
    // behavior rather than answering the question asked.
    const options = (request?.options ?? []).filter((o) => !DANGEROUS_OPTION_IDS.has(o.optionId));
    const id = `perm_${++this.#permissionSeq}`;

    // Unattended mode is intentionally narrow: answer only the one-time safe
    // grant the agent actually offered. Persistent/global grants remain
    // impossible, and a request without allow_once still reaches the user.
    if (this.approvalMode === "auto") {
      const option = options.find((item) => item.kind === "allow_once");
      if (option) {
        respond(option.optionId);
        this.emit("permission-auto", {
          id,
          ...request,
          options,
          optionId: option.optionId
        });
        this.emit("permission-resolved", { id, optionId: option.optionId, automatic: true });
        this.#touch();
        return;
      }
    }

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

  /** Fetch Grok Build's authoritative shared usage pool. */
  async billingStatus({ force = false, connect = true } = {}) {
    if (!force && this.#billing) return this.#billing;
    if (!this.#client?.running && !connect) {
      return this.#billing ?? { available: false, updatedAt: null };
    }
    if (!this.#client?.running) await this.connect();
    try {
      this.#billing = normalizeBilling(await this.#client.billing());
      if (this.#billing) this.emit("billing", this.#billing);
      return this.#billing ?? { available: false };
    } catch (error) {
      return { available: false, error: error.message, updatedAt: new Date().toISOString() };
    }
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

  bindingFor(threadId) {
    const binding = this.#bindings.get(threadId);
    if (!binding) return null;
    return {
      threadId,
      sessionId: binding.sessionId,
      harnessId: binding.harnessId ?? GROK_HARNESS_ID,
      cwd: binding.cwd
    };
  }

  transcriptFor(threadId) {
    try { return this.#memoryStore?.conversationForThread(threadId) ?? []; }
    catch (error) { this.lastMemoryError = error; return []; }
  }

  async attachThread(threadId, projectPath, options = {}) {
    const existing = this.#bindings.get(threadId);
    if (existing?.harnessId && existing.harnessId !== GROK_HARNESS_ID && !options.launch) {
      return {
        sessionId: existing.sessionId,
        harnessId: existing.harnessId,
        resumed: false,
        deferred: true,
        recoveryPending: Boolean(existing.recoveryPending),
        transcript: this.transcriptFor(threadId)
      };
    }
    const { sessionId, harnessId, resumed, recoveryPending } = await this.ensureSession(threadId, projectPath, options);
    return {
      sessionId,
      harnessId,
      resumed,
      recoveryPending: Boolean(recoveryPending),
      transcript: this.transcriptFor(threadId)
    };
  }

  capabilitiesFor(project = null) {
    return {
      mcpServers: this.mcpServersFor(project).map((server) => ({ name: server.name })),
      commands: this.#availableCommands.map((command) => ({
        name: command.name ?? command.command ?? command.id ?? String(command),
        description: command.description ?? command.help ?? null
      })),
      approvalMode: this.approvalMode,
      reasoningEffort: this.reasoningEffort
    };
  }

  /**
   * Bind a thread to a session. `session/load` REPLAYS the whole conversation,
   * so it runs only when reattaching — never per prompt, which would make
   * traffic O(n²) and duplicate tool-call content on every turn.
   */
  async ensureSession(threadId, projectPath, { harnessId = GROK_HARNESS_ID, launch = null } = {}) {
    // Single-flight per thread: concurrent callers share one resolution, or two
    // sessions get created and the first is orphaned mid-stream.
    const inflight = this.#ensuring.get(threadId);
    if (inflight) return inflight;
    const promise = this.#doEnsureSession(threadId, projectPath, { harnessId, launch })
      .finally(() => this.#ensuring.delete(threadId));
    this.#ensuring.set(threadId, promise);
    return promise;
  }

  async #doEnsureSession(threadId, projectPath, { harnessId, launch }) {
    if (typeof threadId !== "string" || !threadId.trim()) {
      const error = new Error("threadId is required.");
      error.status = 400;
      throw error;
    }
    const client = await this.#connectHarness(harnessId, launch);
    const cwd = projectPath || this.defaultCwd;
    const existing = this.#bindings.get(threadId);

    if (existing?.sessionId && (existing.harnessId ?? GROK_HARNESS_ID) !== harnessId) {
      const error = new Error(`This chat is bound to '${existing.harnessId ?? GROK_HARNESS_ID}'. Start a new chat to use '${harnessId}'.`);
      error.status = 409;
      throw error;
    }
    const attachmentKey = existing?.sessionId ? `${harnessId}:${existing.sessionId}` : null;

    if (existing?.sessionId) {
      if (this.#attached.has(attachmentKey)) {
        return { sessionId: existing.sessionId, resumed: true, client, harnessId, recoveryPending: existing.recoveryPending === true };
      }
      try {
        // Replay rebuilds tool-call state; clear first or it doubles.
        this.#toolCalls.delete(threadId);
        await client.loadSession(existing.sessionId, {
          cwd: existing.cwd || cwd,
          mcpServers: this.mcpServersFor(projectPath ?? null)
        });
        this.#attached.add(attachmentKey);
        return { sessionId: existing.sessionId, resumed: true, client, harnessId, recoveryPending: existing.recoveryPending === true };
      } catch (error) {
        // Only a genuinely missing session justifies discarding the binding.
        // Treating a timeout or transport blip as "gone" silently destroys the
        // user's conversation and overwrites it on disk.
        if (!/not found|unknown session|no such session/i.test(error.message || "")) {
          throw error;
        }
      }
    }

    const sessionId = await client.newSession({
      cwd,
      mcpServers: this.mcpServersFor(projectPath ?? null),
      meta: this.#sessionMeta()
    });
    const recoveryPending = Boolean(existing?.sessionId && this.transcriptFor(threadId).length);
    this.#bindings.set(threadId, { sessionId, cwd, harnessId, ...(recoveryPending ? { recoveryPending: true } : {}) });
    this.#attached.add(`${harnessId}:${sessionId}`);
    this.#toolCalls.delete(threadId);
    await this.#save();
    return { sessionId, resumed: false, client, harnessId, recoveryPending };
  }

  /**
   * Start a turn and return immediately. The turn's completion arrives on the
   * update stream — holding an HTTP request open for a multi-minute agent run
   * makes the endpoint unusable from a browser.
   */
  async startPrompt(threadId, text, {
    projectPath = null, attachments = [], harnessId = GROK_HARNESS_ID, launch = null
  } = {}) {
    const ensured = await this.ensureSession(threadId, projectPath, { harnessId, launch });
    const { sessionId, resumed, client, recoveryPending } = ensured;
    const recoveryTranscript = recoveryPending ? this.transcriptFor(threadId) : [];

    // Store the user's intent before handing it to an external process. If the
    // harness crashes before echoing user_message_chunk, the request remains
    // recoverable and searchable.
    try {
      this.#memoryStore?.appendEvent({
        threadId,
        sessionId,
        kind: "user_prompt",
        role: "user",
        text,
        payload: attachments.length ? { attachmentNames: attachments.map((item) => item.name) } : null,
        provider: harnessId,
        project: projectPath
      });
    } catch (error) {
      this.lastMemoryError = error;
    }

    // Attachments are converted against the LIVE agent's declared capabilities,
    // so the same file becomes an inline image on an agent that takes images
    // and a staged path on one that does not.
    const promptText = recoveryPending ? buildRecoveryEnvelope(recoveryTranscript, text) : text;
    let payload = promptText;
    let notes = [];
    if (attachments.length) {
      const built = await buildPromptBlocks(promptText, attachments, {
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
      .then((result) => {
        const binding = this.#bindings.get(threadId);
        if (binding?.sessionId === sessionId && binding.recoveryPending) {
          this.#bindings.set(threadId, { ...binding, recoveryPending: false });
          this.#save();
        }
        done();
        this.emit("turn-complete", { threadId, sessionId, result });
        if (harnessId === GROK_HARNESS_ID) this.billingStatus({ force: true }).catch(() => {});
      })
      .catch((error) => { done(); this.emit("turn-error", {
        threadId,
        sessionId,
        message: error.message,
        // Quota exhaustion is a decision point, not a malfunction.
        quota: /usage limit|balance exhausted|plan limit|rate limit/i.test(error.message || "")
      }); });
    return { sessionId, harnessId, resumed, accepted: true, attachments: notes };
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
    const harnessId = binding.harnessId ?? GROK_HARNESS_ID;
    const client = harnessId === GROK_HARNESS_ID ? this.#client : this.#clients.get(harnessId);
    client?.cancel(binding.sessionId);
    return { ok: true };
  }

  async unbind(threadId) {
    const binding = this.#bindings.get(threadId);
    if (binding?.sessionId) this.#attached.delete(`${binding.harnessId ?? GROK_HARNESS_ID}:${binding.sessionId}`);
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
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    await Promise.all(clients.map((client) => client.stop().catch(() => {})));
    await this.#daemon?.stop().catch(() => {});
    await this.#saveChain.catch(() => {});
    this.#memoryStore?.close();
  }
}
