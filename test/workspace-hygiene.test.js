import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("startup removes install artifacts, backs them up, and keeps one empty chat per project", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-workspace-state-"));
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-workspace-project-"));
  t.after(async () => {
    await fs.rm(state, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  const now = Date.now();
  const validProject = { id: "project_valid", name: "Valid", path: projectPath };
  const installProject = {
    id: "project_desktop_client",
    name: "app.asar",
    path: "C:\\Program Files\\PhoenixAI\\resources\\app.asar"
  };
  const threads = [
    { id: "thread_new", projectId: validProject.id, title: "New chat", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() },
    { id: "thread_old", projectId: validProject.id, title: "New chat", createdAt: new Date(now - 60_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString() },
    { id: "thread_install", projectId: installProject.id, title: "Replicate Codex + Claude Code", createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }
  ];
  await fs.mkdir(path.join(state, "messages"), { recursive: true });
  await fs.writeFile(path.join(state, "projects.json"), JSON.stringify([validProject, installProject]));
  await fs.writeFile(path.join(state, "threads.json"), JSON.stringify(threads));
  for (const thread of threads) await fs.writeFile(path.join(state, "messages", `${thread.id}.json`), "[]");

  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  const api = await import(`../server/api.js?workspace-hygiene=${Date.now()}`);
  const cleanup = await api.cleanupWorkspaceState();

  assert.deepEqual(cleanup.removedProjectIds, [installProject.id]);
  assert.deepEqual(new Set(cleanup.removedThreadIds), new Set(["thread_old", "thread_install"]));
  const workspace = await api.getWorkspaceState();
  assert.deepEqual(workspace.projects.map((project) => project.id), [validProject.id]);
  assert.deepEqual(workspace.threads.map((thread) => thread.id), ["thread_new"]);
  const backup = JSON.parse(await fs.readFile(path.join(state, "workspace-migration-backup.json"), "utf8"));
  assert.equal(backup.migrations.at(-1).projects[0].id, installProject.id);
});

test("new chat reuses an empty conversation and the first prompt gives it a useful title", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-title-state-"));
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-title-project-"));
  t.after(async () => {
    await fs.rm(state, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  });
  const project = { id: "project_titles", name: "Titles", path: projectPath };
  await fs.mkdir(path.join(state, "messages"), { recursive: true });
  await fs.writeFile(path.join(state, "projects.json"), JSON.stringify([project]));
  await fs.writeFile(path.join(state, "threads.json"), "[]");

  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  const api = await import(`../server/api.js?workspace-titles=${Date.now()}`);
  const first = await api.createThread({ projectId: project.id });
  const reused = await api.createThread({ projectId: project.id });
  assert.equal(reused.reused, true);
  assert.equal(reused.thread.id, first.thread.id);

  const titled = await api.noteThreadPrompt(first.thread.id, "Review the payment integration for hidden production risks and regressions.");
  assert.equal(titled.title, "Review the payment integration for hidden production risks…");
  const next = await api.createThread({ projectId: project.id });
  assert.equal(next.reused, false);
  assert.notEqual(next.thread.id, first.thread.id);
});
