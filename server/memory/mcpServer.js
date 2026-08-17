#!/usr/bin/env node
/**
 * Memory MCP server (stdio).
 *
 * This is the keystone of the whole memory design. MCP has no concept of a
 * model — it is JSON-RPC between a client and a server, with the LLM entirely
 * on the far side. So one memory store, exposed once, is reachable by Grok
 * Build (via `mcpServers` on `session/new`), by Claude, by GPT, and by the
 * NVIDIA models, without writing a per-vendor adapter.
 *
 * That is the thing no shipped client does. Every vendor's memory is a silo:
 * Claude's lives in Anthropic's, Codex's in `~/.codex/`, Gemini's in
 * `~/.gemini/`, Grok's behind `x.ai/memory/*`. Switch models, lose everything.
 * Here the memory belongs to the project, and the models are interchangeable.
 *
 * Usage (as configured in ~/.grok/config.toml or ACP `session/new`):
 *   node server/memory/mcpServer.js --db <path> [--project <path>]
 *
 * Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, matching the
 * shape Grok Build's own ACP client uses.
 *
 * IMPORTANT: stdout is the protocol channel. Never log to it — diagnostics go
 * to stderr or they corrupt the stream.
 */

import { MemoryStore } from "./store.js";
import { Retriever, createNvidiaEmbedder } from "./retrieval.js";
import { parsePlaybook, renderPlaybook } from "./playbook.js";
import fs from "node:fs";
import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "agent-command-center-memory", version: "1.0.0" };

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
}

const dbPath = arg("db");
const defaultProject = arg("project");
const playbookPath = arg("playbook");

if (!dbPath) {
  process.stderr.write("memory mcp: --db <path> is required\n");
  process.exit(1);
}

const store = new MemoryStore(dbPath).open();
const embed = process.env.NVIDIA_API_KEY
  ? createNvidiaEmbedder({ apiKey: process.env.NVIDIA_API_KEY })
  : null;
const retriever = new Retriever({ store, embed });

/**
 * Tool surface.
 *
 * Deliberately small. The research is consistent that more retrieved context
 * is not better context, and that repository overviews — the thing most
 * memory tools happily store — measurably cost tokens without improving
 * outcomes. So there is no "dump everything about this project" tool.
 */
const TOOLS = [
  {
    name: "memory_recall",
    description:
      "Search durable project memory: decisions, constraints, measured findings, and retired approaches. " +
      "Call this BEFORE proposing an approach or re-deriving how something works. " +
      "Returns few, highly relevant entries, each tagged with how well established it is.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to know." },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["strategy", "decision", "finding", "failure", "theory", "doctrine", "constraint", "preference"] },
          description: "Optional filter by entry kind."
        },
        limit: { type: "number", description: "Max entries (default 5, cap 8)." }
      },
      required: ["query"]
    }
  },
  {
    name: "memory_check_failures",
    description:
      "Check a proposed approach against approaches already tried and RETIRED on this project. " +
      "ALWAYS call this before proposing a new strategy, gate, ranking scheme, or signal. " +
      "If it returns matches, the approach was already disproven — do not re-attempt it without new evidence.",
    inputSchema: {
      type: "object",
      properties: {
        proposal: { type: "string", description: "The approach you are considering, in one sentence." }
      },
      required: ["proposal"]
    }
  },
  {
    name: "memory_remember",
    description:
      "Record a durable finding. Use for decisions, measured results, constraints, and especially FAILURES " +
      "('we tried X, it did not work because Y'). Preserve the original certainty of the claim: if the " +
      "evidence was tentative, say so in `epistemic` — do not upgrade a hunch into a fact.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The finding, stated plainly." },
        kind: {
          type: "string",
          enum: ["decision", "finding", "failure", "constraint", "theory", "preference"],
          description: "What kind of knowledge this is."
        },
        subject: { type: "string", description: "What it is about (a strategy name, module, or concept)." },
        epistemic: {
          type: "string",
          enum: ["asserted", "hedged", "inferred", "verified"],
          description: "How certain the source was. 'hedged' for anything expressed as maybe/probably/reportedly."
        },
        receipts: { type: "string", description: "Evidence trail: run ids, files, dates." }
      },
      required: ["text", "kind"]
    }
  },
  {
    name: "memory_playbook",
    description:
      "Read the project's strategy state: what is PROVEN, MEASURED, still THEORY, and what is on the " +
      "DEAD LIST. Call this when picking up a project to understand where things stand.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Optional filter, e.g. PROVEN or DEAD." }
      }
    }
  }
];

/**
 * Grok truncates MCP tool results at 20,000 bytes (MCP_MAX_OUTPUT_BYTES),
 * silently and mid-content. A model receiving a half-cut markdown document has
 * no way to know it saw a partial view, so budget below the cap and say so
 * explicitly when trimming.
 */
const MCP_OUTPUT_BUDGET = 18_000;

function textResult(text, { omitted = 0 } = {}) {
  let body = String(text ?? "");
  if (Buffer.byteLength(body, "utf8") > MCP_OUTPUT_BUDGET) {
    // Cut on a line boundary so markdown structure survives the trim.
    const slice = Buffer.from(body, "utf8").subarray(0, MCP_OUTPUT_BUDGET).toString("utf8");
    const lastBreak = slice.lastIndexOf("\n");
    body = (lastBreak > 0 ? slice.slice(0, lastBreak) : slice) +
      "\n\n_[truncated to fit the tool-output limit — narrow the query to see more]_";
  } else if (omitted > 0) {
    body += `\n\n_[${omitted} further entr${omitted === 1 ? "y" : "ies"} not shown]_`;
  }
  return { content: [{ type: "text", text: body }] };
}

async function callTool(name, args = {}) {
  const project = args.project || defaultProject;

  if (name === "memory_recall") {
    const { memories, usedTokens } = await retriever.recall(args.query, {
      project,
      kinds: args.kinds ?? null,
      inject: Math.min(Number(args.limit) || 5, 8)
    });
    if (!memories.length) return textResult("No relevant project memory found.");
    return textResult(`${retriever.format(memories)}\n\n_(${memories.length} entries, ~${usedTokens} tokens)_`);
  }

  if (name === "memory_check_failures") {
    const check = await retriever.checkAgainstFailures(args.proposal, { project });
    if (!check.blocked) {
      return textResult("No previously retired approach matches this. Proceed.");
    }
    return textResult(
      `STOP — this was already tried and retired on this project.\n\n${check.warning}\n\n` +
      "Do not re-attempt without new evidence that changes the original finding."
    );
  }

  if (name === "memory_remember") {
    const id = store.addMemory({
      scope: "project",
      project,
      kind: args.kind,
      subject: args.subject ?? null,
      text: args.receipts ? `${args.text}\nRECEIPTS: ${args.receipts}` : args.text,
      // An agent-supplied claim starts as one observation. Promotion to
      // actionable requires independent corroboration, which is the only
      // mitigation measured to avoid both wrong-grants and false escalation.
      epistemic: args.epistemic ?? "asserted",
      observations: 1,
      provider: "mcp"
    });
    if (!id) return textResult("Nothing recorded — text and kind are required.");
    // Best-effort embedding; a missing vector degrades recall, never breaks it.
    if (embed) {
      try {
        const [vector] = await embed([args.text], { inputType: "passage" });
        if (vector?.length) store.putVector("memory", id, "nvidia/nemotron-3-embed-1b", vector);
      } catch { /* keyword search still works */ }
    }
    return textResult(`Recorded as memory #${id} (${args.kind}).`);
  }

  if (name === "memory_playbook") {
    if (playbookPath && fs.existsSync(playbookPath)) {
      const parsed = parsePlaybook(fs.readFileSync(playbookPath, "utf8"));
      const entries = args.status
        ? parsed.entries.filter((e) => String(e.status ?? "").toUpperCase().includes(args.status.toUpperCase()))
        : parsed.entries;
      return textResult(renderPlaybook({ project: project ?? "project", entries, deadList: parsed.deadList }));
    }
    const memories = store.activeMemories({ project, limit: 200 });
    if (!memories.length) return textResult("No project knowledge recorded yet.");
    const byKind = {};
    for (const m of memories) (byKind[m.kind] ??= []).push(m);
    const lines = [];
    for (const [kind, group] of Object.entries(byKind)) {
      lines.push(`## ${kind.toUpperCase()} (${group.length})`, "");
      for (const m of group) lines.push(`- ${m.text.split("\n")[0]}`);
      lines.push("");
    }
    return textResult(lines.join("\n"));
  }

  throw new Error(`Unknown tool: ${name}`);
}

// --- JSON-RPC plumbing ------------------------------------------------------

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);

async function handle(message) {
  const { id, method, params = {} } = message;
  const isRequest = id !== undefined;

  try {
    if (method === "initialize") {
      return isRequest && send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO
        }
      });
    }
    // Newer spec revisions dropped the handshake in favour of discovery.
    // Answering both keeps this usable across client versions.
    if (method === "server/discover") {
      return isRequest && send({
        jsonrpc: "2.0", id,
        result: { serverInfo: SERVER_INFO, capabilities: { tools: {} } }
      });
    }
    if (method === "notifications/initialized" || method === "initialized") return;

    if (method === "tools/list") {
      return isRequest && send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "tools/call") {
      const result = await callTool(params.name, params.arguments ?? {});
      return isRequest && send({ jsonrpc: "2.0", id, result });
    }

    if (method === "ping") {
      return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    }

    if (isRequest) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (error) {
    process.stderr.write(`memory mcp error (${method}): ${error.message}\n`);
    if (isRequest) {
      // Tool failures are reported in-band so the model can react, rather than
      // as a protocol error that aborts the call.
      send({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Memory error: ${error.message}` }], isError: true }
      });
    }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  handle(message);
});

const shutdown = () => { try { store.close(); } catch { /* ignore */ } process.exit(0); };
rl.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.stderr.write(`memory mcp ready (db=${dbPath}${defaultProject ? `, project=${defaultProject}` : ""})\n`);
