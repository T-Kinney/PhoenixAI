import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryStore } from "../server/memory/store.js";
import { SessionManager } from "../server/acp/sessionManager.js";
import {
  buildRecoveryEnvelope,
  conversationFromEvents,
  parseRecoveryEnvelope,
  visibleRecoveryUpdate
} from "../server/acp/continuity.js";

test("durable ACP events reconstruct complete user and assistant turns", () => {
  const transcript = conversationFromEvents([
    { kind: "user_prompt", text: "Build the feature" },
    { kind: "agent_message_chunk", text: "I will " },
    { kind: "tool_call", text: "ignored tool detail" },
    { kind: "agent_message_chunk", text: "do that." },
    { kind: "user_prompt", text: "Continue" },
    { kind: "agent_message_chunk", text: "Done." }
  ]);
  assert.deepEqual(transcript, [
    { role: "user", text: "Build the feature" },
    { role: "assistant", text: "I will do that." },
    { role: "user", text: "Continue" },
    { role: "assistant", text: "Done." }
  ]);
});

test("recovery envelopes remain hidden from the visible conversation", () => {
  const wrapped = buildRecoveryEnvelope([{ role: "user", text: "Earlier request" }], "Current request");
  const parsed = parseRecoveryEnvelope(wrapped);
  assert.equal(parsed.currentUserMessage, "Current request");
  assert.deepEqual(parsed.transcript, [{ role: "user", text: "Earlier request" }]);
  const visible = visibleRecoveryUpdate({
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: wrapped }
  }, (update) => update.content.text);
  assert.equal(visible.content.text, "Current request");
});

test("bounded recovery keeps the newest complete turns and reports truncation", () => {
  const wrapped = buildRecoveryEnvelope([
    { role: "user", text: "oldest".repeat(20) },
    { role: "assistant", text: "middle".repeat(20) },
    { role: "user", text: "newest" }
  ], "continue", 1_100);
  const parsed = parseRecoveryEnvelope(wrapped);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.transcript.at(-1).text, "newest");
  assert.equal(parsed.transcript.some((turn) => turn.text.startsWith("oldest")), false);
});

test("a missing Grok session is replaced and receives the local transcript on the next prompt", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-continuity-"));
  const statePath = path.join(folder, "acp-sessions.json");
  const memoryPath = path.join(folder, "memory.db");
  await fs.writeFile(statePath, JSON.stringify({
    bindings: { thread_1: { sessionId: "missing-session", cwd: folder, harnessId: "grok-build-local" } }
  }), "utf8");

  const store = new MemoryStore(memoryPath).open();
  store.appendEvent({ threadId: "thread_1", kind: "user_prompt", role: "user", text: "Original task" });
  store.appendEvent({ threadId: "thread_1", kind: "agent_message_chunk", role: "assistant", text: "Original answer" });
  store.close();

  class MockClient extends EventEmitter {
    running = true;
    prompts = [];
    async loadSession() { throw new Error("unknown session"); }
    async newSession() { return "replacement-session"; }
    promptCapabilities() { return {}; }
    async prompt(sessionId, payload) {
      this.prompts.push({ sessionId, payload });
      this.emit("update", sessionId, {
        sessionUpdate: "user_message_chunk", content: { type: "text", text: payload }
      }, {});
      this.emit("update", sessionId, {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Recovered answer" }
      }, {});
      return {};
    }
    async stop() { this.running = false; }
  }

  const client = new MockClient();
  const manager = new SessionManager({
    statePath,
    memoryDbPath: memoryPath,
    grokClient: client,
    idleReleaseMs: 0
  });
  t.after(async () => {
    await manager.shutdown();
    await fs.rm(folder, { recursive: true, force: true });
  });
  await manager.load();

  const attached = await manager.attachThread("thread_1", folder);
  assert.equal(attached.sessionId, "replacement-session");
  assert.equal(attached.recoveryPending, true);
  assert.deepEqual(attached.transcript, [
    { role: "user", text: "Original task" },
    { role: "assistant", text: "Original answer" }
  ]);

  const publicUpdates = [];
  manager.on("update", (event) => publicUpdates.push(event.update));
  await manager.startPrompt("thread_1", "Continue from there", { projectPath: folder });
  const recovery = parseRecoveryEnvelope(client.prompts[0].payload);
  assert.equal(recovery.currentUserMessage, "Continue from there");
  assert.deepEqual(recovery.transcript, attached.transcript);
  assert.equal(publicUpdates[0].content.text, "Continue from there");
});
