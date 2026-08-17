/**
 * Grok Build workflow tracking.
 *
 * Workflows fan one task across many parallel subagents as a single resumable
 * background run. A run can legitimately spawn up to 1,024 agents, so surfacing
 * the budget is a cost guardrail, not decoration.
 *
 * There is NO `x.ai/workflow*` ACP namespace. Workflows reach a client through
 * three mechanisms we already consume:
 *
 *   1. DISCOVERY — saved workflows appear in `available_commands_update` with
 *      `_meta.workflowPath` and `_meta.workflowSource`.
 *   2. LAUNCH — plain `session/prompt` carrying the slash text. No dedicated RPC.
 *   3. PROGRESS — `_x.ai/session_notification` whose update is tagged
 *      `sessionUpdate: "workflow_updated"`.
 *
 * Note the casing trap: the ACP envelope is camelCase (`sessionId`, `update`,
 * `_meta`) but the workflow variant's OWN fields are snake_case (`run_id`,
 * `agent_budget`, `current_phase`). Both appear in one payload.
 *
 * `/workflows` — the run dashboard — is a TUI-only pager command that never
 * reaches the agent. A GUI has to accumulate these notifications itself, which
 * is exactly what this module is for.
 */

/** Terminal states. `cleared` means remove the run from the UI entirely. */
const TERMINAL = new Set(["complete", "failed", "interrupted", "cancelled", "cleared"]);

/** Budget ceilings from the workflow engine, for warning thresholds. */
export const WORKFLOW_LIMITS = Object.freeze({
  DEFAULT_AGENT_BUDGET: 128,
  MAX_AGENT_BUDGET: 1024,
  MAX_PARALLEL: 1024,
  MAX_PHASES: 64
});

/** True when a session update carries workflow progress. */
export function isWorkflowUpdate(update) {
  return update?.sessionUpdate === "workflow_updated";
}

/**
 * Accumulates workflow runs from the notification stream.
 *
 * Deduplication by `revision` is mandatory, not an optimization: the reference
 * client drops updates where `revision <= lastSeen`, and treats a `revision` of
 * 0 arriving after a nonzero one as a stale replay. Without this the UI
 * flickers and rows duplicate.
 */
export class WorkflowTracker {
  #runs = new Map();      // runId -> run state
  #revisions = new Map(); // runId -> highest revision seen

  /**
   * Fold one `workflow_updated` payload into tracked state.
   * @returns {{ run: object, changed: boolean, removed: boolean } | null}
   */
  ingest(update) {
    if (!isWorkflowUpdate(update)) return null;
    const runId = update.run_id;
    if (!runId) return null;

    const revision = Number(update.revision ?? 0);
    const lastSeen = this.#revisions.get(runId);

    if (lastSeen !== undefined) {
      // A zero revision after a nonzero one is a replay of stale state.
      if (revision === 0 && lastSeen > 0) return { run: this.#runs.get(runId), changed: false, removed: false };
      if (revision <= lastSeen) return { run: this.#runs.get(runId), changed: false, removed: false };
    }
    this.#revisions.set(runId, revision);

    if (update.status === "cleared") {
      const run = this.#runs.get(runId);
      this.#runs.delete(runId);
      this.#revisions.delete(runId);
      return { run, changed: true, removed: true };
    }

    const run = normalizeRun(update, this.#runs.get(runId));
    this.#runs.set(runId, run);
    return { run, changed: true, removed: false };
  }

  get runs() {
    return [...this.#runs.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }

  active() {
    return this.runs.filter((r) => !TERMINAL.has(r.status));
  }

  get(runId) {
    return this.#runs.get(runId) ?? null;
  }

  /** Forget terminal runs; the UI keeps its own history if it wants one. */
  prune() {
    for (const [id, run] of [...this.#runs]) {
      if (TERMINAL.has(run.status)) {
        this.#runs.delete(id);
        this.#revisions.delete(id);
      }
    }
  }
}

/** snake_case wire fields -> a camelCase shape the UI can render directly. */
function normalizeRun(update, previous = null) {
  const budget = Number(update.agent_budget ?? 0);
  const used = Number(update.agents_used ?? 0);

  return {
    runId: update.run_id,
    revision: Number(update.revision ?? 0),
    name: update.name ?? previous?.name ?? "workflow",
    objective: update.objective ?? previous?.objective ?? null,
    status: update.status ?? "active",
    foreground: Boolean(update.foreground),
    terminal: TERMINAL.has(update.status),

    phases: (update.phases ?? []).map((p) => ({ title: p.title, state: p.state })),
    currentPhase: update.current_phase ?? null,

    // The cost guardrail. A run may spawn up to 1,024 agents, so this belongs
    // on screen before and during a run, not buried in a detail view.
    budget: {
      total: budget,
      used,
      reserved: Number(update.agents_reserved ?? 0),
      remaining: Number(update.agents_remaining ?? 0),
      // The agent reports when its own accounting is incomplete; showing a
      // precise number then would be a lie.
      incomplete: Boolean(update.agent_usage_incomplete),
      pctUsed: budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0
    },

    elapsedMs: Number(update.elapsed_ms ?? 0),
    activeAgents: Number(update.active_agents ?? 0),
    currentAgentLabel: update.current_agent_label ?? null,

    agents: (update.agents ?? []).map((a) => ({
      agentId: a.agent_id,
      label: a.label,
      phase: a.phase,
      model: a.model,
      state: a.state,
      tokensUsed: Number(a.tokens_used ?? 0),
      durationMs: Number(a.duration_ms ?? 0)
    })),

    lastEvent: update.last_event ?? null,
    lastEventDetail: update.last_event_detail ?? null,
    lastEventTimestamp: update.last_event_timestamp ?? null,

    // Human-readable payloads; the pause message explains a budget stall.
    pauseMessage: update.pause_message ?? null,
    resultSummary: update.result_summary ?? null,

    startedAt: previous?.startedAt ?? Date.now()
  };
}

/**
 * Extract runnable workflows from an `available_commands_update`.
 *
 * A workflow is identifiable by `_meta.workflowPath`. Note the namespace
 * collision rule: a workflow whose name is already taken by a command or skill
 * is SILENTLY not advertised, logging only "workflow not advertised". Since a
 * user editing a file and seeing nothing appear has no way to diagnose that,
 * the path is surfaced so the UI can point at the file.
 */
export function workflowsFromCommands(commands = []) {
  return commands
    .filter((c) => c?._meta?.workflowPath)
    .map((c) => ({
      name: c.name,
      description: (c.description ?? "").replace(/^Workflow:\s*/, ""),
      hint: c.input?.hint ?? null,
      source: c._meta.workflowSource ?? "unknown",   // project | user | builtin
      path: c._meta.workflowPath
    }));
}

/**
 * Slash text for a workflow action.
 *
 * Workflows have no RPC — every control is a prompt. Arguments are a JSON
 * object; `objective` and `query` are the conventional keys, and bare text is
 * expanded into both by the agent.
 */
export function workflowCommand(action, { name = null, args = null, runId = null } = {}) {
  switch (action) {
    case "run":
      return name
        ? `/workflow ${name}${args ? ` ${typeof args === "string" ? args : JSON.stringify(args)}` : ""}`
        : null;
    case "pause":
    case "resume":
    case "stop":
      return `/workflow ${action}${runId ? ` ${runId}` : ""}`;
    case "save":
      return `/workflow save${name ? ` ${name}` : ""}`;
    case "deep-research":
      return `/deep-research ${typeof args === "string" ? args : (args?.query ?? "")}`;
    default:
      return null;
  }
}
