import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

test("project tools stay bound to the thread and checkpoints restore tracked and untracked files", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-project-tools-"));
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-project-state-"));
  t.after(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  });

  git(fixture, "init");
  git(fixture, "config", "user.email", "phoenix-test@example.invalid");
  git(fixture, "config", "user.name", "Phoenix Test");
  await fs.writeFile(path.join(fixture, "tracked.txt"), "base\n");
  git(fixture, "add", "tracked.txt");
  git(fixture, "commit", "-m", "fixture");

  process.env.AGENTCC_DATA_DIR = state;
  process.env.AGENTCC_STATE_DIR = state;
  const api = await import(`../server/api.js?project-tools=${Date.now()}`);
  const { project } = await api.addProject({ path: fixture });
  const { thread } = await api.createThread({ projectId: project.id, title: "Recovery test" });

  await fs.writeFile(path.join(fixture, "tracked.txt"), "changed content\n");
  await fs.mkdir(path.join(fixture, ".agents", "skills", "demo"), { recursive: true });
  await fs.writeFile(path.join(fixture, ".agents", "skills", "demo", "SKILL.md"), "# Demo\n");

  const search = await api.searchThreadProject(thread.id, { query: "changed content" });
  assert.equal(search.matches[0]?.path, "tracked.txt");
  const skills = await api.listThreadProjectSkills(thread.id);
  assert.equal(skills.skills[0]?.file, ".agents/skills/demo/SKILL.md");

  process.env.OPENAI_API_KEY = "must-not-reach-terminal";
  const command = await api.runThreadProjectCommand(thread.id, {
    command: "node --version"
  });
  assert.equal(command.ok, true);
  assert.match(command.stdout.trim(), /^v\d+/);

  const { checkpoint } = await api.createThreadCheckpoint(thread.id, { name: "Before cleanup" });
  assert.equal(checkpoint.untrackedFiles.some((file) => file.path.endsWith("SKILL.md")), true);
  await assert.rejects(
    api.restoreThreadCheckpoint(thread.id, checkpoint.id),
    (error) => error.status === 409
  );

  await fs.writeFile(path.join(fixture, "tracked.txt"), "base\n");
  await fs.rm(path.join(fixture, ".agents"), { recursive: true, force: true });
  assert.equal(git(fixture, "status", "--short").trim(), "");

  await api.restoreThreadCheckpoint(thread.id, checkpoint.id);
  assert.equal((await fs.readFile(path.join(fixture, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"), "changed content\n");
  assert.equal(await fs.readFile(path.join(fixture, ".agents", "skills", "demo", "SKILL.md"), "utf8"), "# Demo\n");
});
