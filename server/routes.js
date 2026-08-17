/**
 * Single source of truth for the HTTP API.
 *
 * Previously every route was written twice — once as an Express handler in
 * server/index.js and once as a hand-rolled regex branch in electron/main.js —
 * so each new endpoint cost two edits and could silently drift between the
 * browser and desktop builds. Both hosts now consume this one table.
 *
 * A route is:
 *   method   "GET" | "POST"
 *   path     "/api/threads/:threadId/messages"  (":name" captures one segment)
 *   handler  async ({ params, body, query }) => value
 *
 * The handler's return value is serialized as JSON. Throwing produces a 502
 * with { error: message } unless the error carries a `status`.
 */

import * as api from "./api.js";
import { HarnessRegistry } from "./acp/harnesses.js";
import { workflowCommand } from "./acp/workflows.js";
import { checkGrokVersion } from "./acp/daemon.js";

// One shared registry: the catalogue is identical for every caller and the
// fetch is cached with an offline fallback.
const harnessRegistry = new HarnessRegistry();

/** Compile "/api/x/:id" into a matcher. */
function compile(path) {
  const names = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  // Case-insensitive so /API/HEALTH does not fall out of the API namespace
  // and get served index.html by the desktop host's static fallback.
  return { regex: new RegExp(`^${source}/?$`, "i"), names };
}

/**
 * Build the route table. `deps` carries host-provided capabilities that differ
 * between Electron and the dev server (native dialogs, the ACP session manager).
 */
export function buildRoutes(deps = {}) {
  const { selectFolder = null, sessions = null } = deps;

  const routes = [
    // --- workspace -------------------------------------------------------
    ["GET",  "/api/health",    async () => ({ ok: true, ts: new Date().toISOString() })],
    ["GET",  "/api/tools",     async () => api.getToolsStatus()],
    ["GET",  "/api/workspace", async () => api.getWorkspaceState()],
    ["POST", "/api/projects",  async ({ body }) => api.addProject(body)],
    ["POST", "/api/projects/select-folder", async () => {
      if (!selectFolder) {
        const error = new Error("Folder picker is only available in the desktop app.");
        error.status = 501;
        throw error;
      }
      return selectFolder();
    }],

    // --- threads ---------------------------------------------------------
    ["POST", "/api/threads", async ({ body }) => api.createThread(body)],
    ["GET",  "/api/threads/:threadId", async ({ params }) => api.getThreadBundle(params.threadId)],
    // NOTE: positional (threadId, input) — passing a single merged object made
    // every message 502 and took all slash commands with it.
    ["POST", "/api/threads/:threadId/messages",
      async ({ params, body }) => api.appendThreadMessage(params.threadId, body)],

    // --- config / providers ----------------------------------------------
    ["GET",  "/api/config", async () => api.readConfig()],
    ["POST", "/api/config", async ({ body }) => api.writeConfig(body)],
    ["GET",  "/api/providers/status", async () => api.getProviderStatus()],
    ["GET",  "/api/stripe/status",    async () => api.getStripeStatus()],
    ["GET",  "/api/models/scout",     async () => api.scoutModels()],
    ["GET",  "/api/providers/:providerId/models",
      async ({ params }) => api.listProviderModels(params.providerId)],
    ["POST", "/api/providers/test", async ({ body }) => api.testProvider(body)],

    // --- runs -------------------------------------------------------------
    ["POST", "/api/runs/plan",  async ({ body }) => api.planRun(body)],
    ["GET",  "/api/runs",       async () => api.listAgentRuns()],
    ["POST", "/api/runs/start", async ({ body }) => api.startAgentRun(body)],
    ["GET",  "/api/runs/:runId/merge-gate", async ({ params }) => api.getRunMergeGate(params.runId)],
    ["POST", "/api/runs/:runId/merge",
      async ({ params, body }) => api.mergeRunToSource({ ...body, runId: params.runId })],
    ["GET",  "/api/runs/:runId", async ({ params }) => api.getAgentRun(params.runId)],

    // --- worktrees ---------------------------------------------------------
    ["GET",  "/api/worktrees", async ({ query }) => api.listWorktreeLeases(query)],
    ["POST", "/api/worktrees/ensure", async ({ body }) => api.ensureWorktreeLease(body)],
    ["POST", "/api/worktrees/:leaseId/archive",
      async ({ params }) => api.archiveWorktreeLease(params.leaseId)],

    // --- objectives / goals / loops ---------------------------------------
    ["GET",  "/api/objectives", async ({ query }) => api.listObjectives(query)],
    ["POST", "/api/objectives/plan", async ({ body }) => api.planObjective(body)],
    ["POST", "/api/objectives/:objectiveId/start",
      async ({ params, body }) => api.startObjectiveLoop({ ...body, objectiveId: params.objectiveId })],
    ["POST", "/api/objectives/:objectiveId/clarity",
      async ({ params, body }) => api.resolveObjectiveClarity({ ...body, objectiveId: params.objectiveId })],
    ["POST", "/api/objectives/:objectiveId/tasks/next",
      async ({ params, body }) => api.startNextObjectiveTask({ ...body, objectiveId: params.objectiveId })],
    ["POST", "/api/objectives/:objectiveId/review/reconcile",
      async ({ params, body }) => api.reconcileObjectiveReview({ ...body, objectiveId: params.objectiveId })],
    ["POST", "/api/objectives/:objectiveId/tasks/:taskId/start",
      async ({ params, body }) =>
        api.startObjectiveTask({ ...body, objectiveId: params.objectiveId, taskId: params.taskId })],
    ["POST", "/api/objectives/:objectiveId/tasks/:taskId/patches/apply",
      async ({ params, body }) =>
        api.applyObjectiveTaskPatch({ ...body, objectiveId: params.objectiveId, taskId: params.taskId })],
    ["POST", "/api/objectives/:objectiveId/tasks/:taskId/merge",
      async ({ params, body }) =>
        api.mergeObjectiveTaskToSource({ ...body, objectiveId: params.objectiveId, taskId: params.taskId })],
    ["GET",  "/api/objectives/:objectiveId", async ({ params }) => api.getObjective(params.objectiveId)],

    ["GET",  "/api/goals", async ({ query }) => api.listGoals(query)],
    ["POST", "/api/goals", async ({ body }) => api.createGoal(body)],
    ["GET",  "/api/loops", async ({ query }) => api.listLoops(query)],
    ["POST", "/api/loops/start", async ({ body }) => api.startGoalLoop(body)],
    ["GET",  "/api/loops/:loopId", async ({ params }) => api.getLoop(params.loopId)]
  ];

  // --- agent (ACP) --------------------------------------------------------
  // Only mounted when the host supplies a session manager, so the dev server
  // can run without spawning an agent daemon.
  if (sessions) {
    const requireThreadId = (value) => {
      if (typeof value !== "string" || !value.trim()) {
        const error = new Error("threadId is required and must be a non-empty string.");
        error.status = 400;
        throw error;
      }
      return value;
    };

    routes.push(
      ["GET",  "/api/agent/status", async () => sessions.status],
      ["POST", "/api/agent/connect", async () => sessions.connect()],

      // Returns as soon as the turn is ACCEPTED. Holding the request open for
      // the whole run made this unusable from a browser — a turn can take
      // minutes. Completion arrives on the event stream.
      ["POST", "/api/agent/prompt", async ({ body }) =>
        sessions.startPrompt(requireThreadId(body.threadId), String(body.text ?? ""), {
          projectPath: body.projectPath,
          // [{name, data}] with data base64. Converted to ACP content blocks
          // against the live agent's declared capabilities.
          attachments: Array.isArray(body.attachments) ? body.attachments : []
        })],

      ["POST", "/api/agent/cancel",
        async ({ body }) => sessions.cancel(requireThreadId(body.threadId))],

      // Host-agnostic permission reply, so the dev server has the same
      // capability as the desktop app rather than silently auto-denying.
      ["POST", "/api/agent/permission",
        async ({ body }) => sessions.respondToPermission(body.id, body.optionId ?? null)],

      ["GET",  "/api/agent/permissions",
        async () => ({ pending: sessions.pendingPermissions() })],

      // --- auth ---
      // A logged-out user previously got an opaque `auth_required` from
      // session/new with no way to recover from inside the app.
      ["GET",  "/api/agent/auth", async () => sessions.authStatus()],
      ["POST", "/api/agent/auth/login",
        async ({ body }) => sessions.beginLogin(body.methodId || "grok.com")],
      ["POST", "/api/agent/auth/code",
        async ({ body }) => sessions.submitAuthCode(body.code)],
      ["POST", "/api/agent/auth/cancel", async () => sessions.cancelLogin()],
      ["POST", "/api/agent/auth/logout", async () => sessions.logout()],

      // --- agent version ---
      // Surfaced rather than auto-applied: swapping the agent binary mid-session
      // is worse than running a version behind.
      ["GET", "/api/agent/version", async () => checkGrokVersion()],

      // --- workflows ---
      // Workflows have no RPC: every control is slash text sent as a prompt.
      // The TUI's /workflows dashboard never reaches the agent, so the run list
      // is accumulated here from the notification stream.
      ["GET",  "/api/workflows", async () => ({
        available: sessions.availableWorkflows(),
        runs: sessions.workflowRuns()
      })],
      ["POST", "/api/workflows/run", async ({ body }) =>
        sessions.startPrompt(requireThreadId(body.threadId),
          workflowCommand("run", { name: body.name, args: body.args }) ?? "",
          { projectPath: body.projectPath })],
      ["POST", "/api/workflows/control", async ({ body }) =>
        sessions.startPrompt(requireThreadId(body.threadId),
          workflowCommand(body.action, { runId: body.runId, name: body.name }) ?? "",
          { projectPath: body.projectPath })],
      ["POST", "/api/workflows/prune", async () => sessions.pruneWorkflows()],

      // --- harnesses ---
      // ACP is model-agnostic, so the same client drives every registry agent.
      // These expose the catalogue rather than leaving it unreachable code.
      ["GET",  "/api/harnesses", async () => {
        await harnessRegistry.load();
        return {
          platform: (await import("./acp/harnesses.js")).platformKey(),
          ...harnessRegistry.catalogue()
        };
      }],
      ["GET",  "/api/harnesses/ready", async () => {
        await harnessRegistry.load();
        return { agents: harnessRegistry.readyToRun() };
      }],
      ["GET",  "/api/harnesses/:agentId/launch", async ({ params }) => {
        await harnessRegistry.load();
        const launch = harnessRegistry.resolveLaunch(params.agentId);
        if (!launch) {
          const error = new Error(`No launch spec for '${params.agentId}'.`);
          error.status = 404;
          throw error;
        }
        return launch;
      }],
      ["POST", "/api/harnesses/refresh", async () => {
        const agents = await harnessRegistry.load({ force: true });
        return { count: agents.length };
      }],

      ["GET",  "/api/agent/tool-calls/:threadId",
        async ({ params }) => ({ toolCalls: sessions.toolCallsFor(params.threadId) })]
    );
  }

  return routes.map(([method, path, handler]) => ({
    method,
    path,
    handler,
    ...compile(path)
  }));
}

/** Find the route matching a method+pathname, with captured params. */
export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.regex.exec(pathname);
    if (!match) continue;
    const params = {};
    try {
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
    } catch {
      const error = new Error("Malformed URL parameter encoding.");
      error.status = 400;
      throw error;
    }
    return { route, params };
  }
  return null;
}
