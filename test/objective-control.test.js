import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("objectives assign the requested model lanes and record safe control boundaries", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-objective-control-"));
  const project = path.join(state, "project");
  await fs.mkdir(project);
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.XAI_API_KEY = "test-xai";
  process.env.MOONSHOT_API_KEY = "test-kimi";
  process.env.DEEPSEEK_API_KEY = "test-deepseek";
  process.env.DASHSCOPE_API_KEY = "test-qwen";
  t.after(() => fs.rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const api = await import(`../server/api.js?objective-control=${Date.now()}`);
  const { objective } = await api.planObjective({
    idea: "Build a stock strategy research lab with historical backtests for traders, a clear success metric, and no live orders.",
    projectPath: project,
    projectId: "project_test",
    threadId: "thread_test"
  });

  assert.equal(objective.control.commander.id, "grok-build-local");
  assert.equal(objective.control.operatingMode, "research");
  assert.equal(objective.control.execution.liveTrading, "disabled");
  assert.equal(objective.control.execution.orderPlacement, "disabled");
  assert.equal(objective.control.approvals.merge, "human-required");
  assert.equal(objective.control.routeEnforcement, "locked-per-agent");

  const routes = Object.fromEntries(objective.agents.map((agent) => [agent.id, agent]));
  assert.equal(routes.implementer.providerId, "kimi");
  assert.equal(routes.implementer.model, "kimi-k2.7-code");
  assert.equal(routes.reviewer.providerId, "deepseek");
  assert.equal(routes.reviewer.model, "deepseek-v4-pro");
  assert.equal(routes.tester.providerId, "qwen");
  assert.equal(routes.implementer.routePolicy, "locked");

  const audit = await api.listObjectiveEvents(objective.id);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].type, "objective.planned");
  assert.equal(audit.events[0].objectiveId, objective.id);
  assert.equal(JSON.stringify(audit.events).includes("test-kimi"), false);
});

test("agent runs preserve an exact per-role provider route instead of the global chat model", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-objective-route-"));
  const project = path.join(state, "project");
  await fs.mkdir(project);
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  delete process.env.NVIDIA_API_KEY;
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const api = await import(`../server/api.js?objective-route=${Date.now()}`);
  const { run } = await api.startAgentRun({
    projectPath: project,
    roles: ["reviewer"],
    workspaceMode: "draft",
    roleRoutes: {
      reviewer: { providerId: "deepseek", model: "deepseek-v4-pro", locked: true }
    }
  });

  const reviewer = run.steps.find((step) => step.agentRole === "reviewer");
  assert.equal(run.providerId, "deepseek");
  assert.equal(run.model, "deepseek-v4-pro");
  assert.equal(run.routeLocked, true);
  assert.equal(reviewer.providerId, "deepseek");
  assert.equal(reviewer.model, "deepseek-v4-pro");
  assert.equal(reviewer.routeLocked, true);
});

test("one objective reuses one isolated worktree across implementation and review", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-objective-worktree-"));
  const project = path.join(state, "project");
  await fs.mkdir(project);
  await exec("git", ["init"], { cwd: project });
  await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
  await exec("git", ["config", "user.name", "Phoenix Test"], { cwd: project });
  await fs.writeFile(path.join(project, "README.md"), "# Fixture\n");
  await exec("git", ["add", "README.md"], { cwd: project });
  await exec("git", ["commit", "-m", "fixture"], { cwd: project });
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.AGENTCC_WORKTREES_DIR = path.join(state, "worktrees");
  t.after(() => fs.rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const api = await import(`../server/api.js?objective-worktree=${Date.now()}`);
  const first = await api.ensureWorktreeLease({
    projectPath: project,
    threadId: "thread_one",
    title: "Kimi implementation",
    objectiveKey: "objective_shared",
    runId: "run_implement"
  });
  const second = await api.ensureWorktreeLease({
    projectPath: project,
    threadId: "thread_one",
    title: "DeepSeek review",
    objectiveKey: "objective_shared",
    runId: "run_review"
  });

  assert.equal(second.lease.id, first.lease.id);
  assert.equal(second.lease.path, first.lease.path);
  assert.deepEqual(new Set(second.lease.runIds), new Set(["run_implement", "run_review"]));
});

test("tester lanes run deterministic project checks before model interpretation", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-objective-verify-"));
  const project = path.join(state, "project");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({
    scripts: { test: "node -e \"process.exit(process.env.DEEPSEEK_API_KEY ? 2 : 0)\"" }
  }));
  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  process.env.DEEPSEEK_API_KEY = "must-not-reach-tests";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "Verification evidence reviewed." } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await fs.rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const api = await import(`../server/api.js?objective-verify=${Date.now()}`);
  const started = await api.startAgentRun({
    projectPath: project,
    roles: ["tester"],
    workspaceMode: "draft",
    roleRoutes: { tester: { providerId: "ollama", model: "fixture-model", locked: true } }
  });
  let run = started.run;
  for (let attempt = 0; attempt < 40 && !["complete", "failed", "needs_attention"].includes(run.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = (await api.getAgentRun(run.id)).run;
  }

  assert.equal(run.verification?.status, "passed", JSON.stringify(run, null, 2));
  assert.equal(run.verification.results[0].name, "npm run test");
  assert.equal(run.verification.results[0].exitCode, 0);
  assert.equal(run.steps.find((step) => step.id === "verification").status, "complete");
});
