#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline";
import { SpendGuard, sanitizeSpendingSafety } from "../spendGuard.js";

const exec = promisify(execFile);
const PROTOCOL_VERSION = "2025-11-25";
const SERVER_INFO = { name: "phoenix-multi-model-review", version: "1.0.0" };

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const project = arg("project", process.cwd());
const FAMILIES = {
  deepseek: {
    direct: { id: "deepseek-direct", baseUrl: "https://api.deepseek.com/v1", key: "DEEPSEEK_API_KEY" },
    prefer: [/deepseek.*v4.*pro/i, /deepseek.*v4.*flash/i, /deepseek-v4/i, /deepseek/i]
  },
  kimi: {
    direct: { id: "kimi-direct", baseUrl: "https://api.moonshot.ai/v1", key: "MOONSHOT_API_KEY" },
    // This MCP tool reviews code diffs, so the coding specialist is the safe
    // default. Grok can explicitly request kimi-k3 for system-wide or
    // long-horizon architecture reviews.
    prefer: [/^kimi-k2\.7-code$/i, /kimi.*k2\.7.*code/i, /kimi.*k3/i, /kimi.*code/i, /kimi-k2\.7/i, /kimi/i]
  },
  qwen: {
    direct: { id: "qwencloud", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", key: "DASHSCOPE_API_KEY" },
    prefer: [/qwen3\.8/i, /qwen3\.7.*coder/i, /qwen3\.7/i, /qwen.*coder/i, /qwen/i]
  }
};

const MODEL_STUDIO = {
  id: "qwencloud", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", key: "DASHSCOPE_API_KEY"
};
const spendingSafety = sanitizeSpendingSafety(JSON.parse(process.env.PHOENIX_SPENDING_SAFETY || "{}"));
const spendGuard = process.env.PHOENIX_SPEND_LEDGER_PATH
  ? new SpendGuard({ ledgerPath: process.env.PHOENIX_SPEND_LEDGER_PATH })
  : null;

const TOOLS = [{
  name: "review_with_model",
  description:
    "Ask an independent Qwen, Kimi, or DeepSeek model to adversarially review the current project diff. " +
    "Use after implementation and before declaring work complete. The reviewer is read-only and receives a bounded diff.",
  inputSchema: {
    type: "object",
    properties: {
      provider: { type: "string", enum: ["qwen", "kimi", "deepseek"] },
      model: { type: "string", description: "Optional exact model id. Kimi defaults to kimi-k2.7-code for diff review; request kimi-k3 for architecture and long-horizon review." },
      route: { type: "string", enum: ["auto", "qwencloud", "direct"], description: "Optional billing route. Auto uses Kimi direct for Kimi and QwenCloud for DeepSeek; choose direct to charge the DeepSeek account. OpenRouter is never used." },
      task: { type: "string", description: "What was changed and what the reviewer should challenge." },
      maxTokens: { type: "number", description: "Response cap (default 1200, hard maximum 2000)." }
    },
    required: ["provider", "task"]
  }
}];

async function git(args) {
  try {
    const { stdout } = await exec("git", ["-C", project, ...args], {
      windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024
    });
    return stdout;
  } catch (error) {
    return `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
  }
}

function availableBackends(provider, requestedRoute = "auto") {
  const family = FAMILIES[provider];
  const direct = process.env[family.direct.key] ? [family.direct] : [];
  const qwenCloud = provider !== "qwen" && process.env[MODEL_STUDIO.key] ? [MODEL_STUDIO] : [];
  // Kimi's own key is the expected direct route. DeepSeek is intentionally
  // hosted through the user's QwenCloud account unless direct is requested.
  const candidates = provider === "kimi" ? [...direct, ...qwenCloud] : [...qwenCloud, ...direct];
  if (requestedRoute === "auto") return candidates;
  const wanted = requestedRoute === "direct" ? family.direct.id
    : requestedRoute === "qwencloud" ? MODEL_STUDIO.id : null;
  return candidates.filter((backend) => backend.id === wanted);
}

async function discoverModel(provider, backend, requested) {
  const family = FAMILIES[provider];
  if (requested) {
    if (!family.prefer.some((pattern) => pattern.test(requested))) {
      throw new Error(`Requested model '${requested}' does not match the ${provider} review family.`);
    }
    return requested;
  }
  const key = process.env[backend.key];
  const response = await fetch(`${backend.baseUrl}/models`, {
    headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`${provider} model discovery returned HTTP ${response.status}`);
  const data = await response.json();
  const models = (data.data ?? []).filter((item) => typeof item.id === "string");
  for (const pattern of family.prefer) {
    const matches = models.filter((item) => pattern.test(item.id));
    matches.sort((a, b) => Number(b.created ?? 0) - Number(a.created ?? 0)
      || b.id.localeCompare(a.id, undefined, { numeric: true }));
    if (matches[0]) return matches[0].id;
  }
  throw new Error(`${backend.id} returned no model matching the ${provider} family.`);
}

async function review(args) {
  const family = FAMILIES[args.provider];
  if (!family) throw new Error("Unsupported review provider.");
  const route = String(args.route ?? "auto");
  const backend = availableBackends(args.provider, route)[0];
  if (!backend) {
    throw new Error(`No ${route === "auto" ? "QwenCloud or direct" : route} credential is configured for ${args.provider}.`);
  }
  if (!spendGuard || !spendingSafety.paidCloudCallsEnabled) {
    throw new Error("Paid review agents are locked by the host spending policy.");
  }
  const apiKey = process.env[backend.key];
  const model = await discoverModel(args.provider, backend, String(args.model ?? "").trim());
  const [status, diff, staged] = await Promise.all([
    git(["status", "--short", "--untracked-files=all"]),
    git(["diff", "--no-ext-diff", "--"]),
    git(["diff", "--cached", "--no-ext-diff", "--"])
  ]);
  const context = `STATUS\n${status}\n\nWORKTREE DIFF\n${diff}\n\nSTAGED DIFF\n${staged}`.slice(0, 70_000);
  const prompt = [
    "You are an independent adversarial code reviewer. Do not praise or rewrite the implementation.",
    "Find correctness bugs, security flaws, regressions, missing tests, unsafe assumptions, and product gaps.",
    "Rank findings by severity. Cite filenames and concrete evidence. Say 'No blocking findings' only if warranted.",
    `TASK\n${String(args.task).slice(0, 8_000)}`,
    `PROJECT DIFF (read-only snapshot)\n${context || "No git diff was available."}`
  ].join("\n\n");
  const reservation = await spendGuard.reserve({
    providerId: args.provider,
    prompt,
    maxOutputTokens: Number(args.maxTokens) || 1200,
    policy: spendingSafety
  });
  try {
  const response = await fetch(`${backend.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: reservation.maxOutputTokens,
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message ?? `${args.provider} review through ${backend.id} returned HTTP ${response.status}`);
  await spendGuard.settle(reservation, {
    actualCostUsd: Number.isFinite(Number(data?.usage?.cost)) ? Number(data.usage.cost) : null,
    outcome: "completed",
    usage: data.usage
  });
  const content = data.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : String(content ?? "");
  return { content: [{ type: "text", text: `Reviewer: ${args.provider}/${model} via ${backend.id}\n\n${text}` }] };
  } catch (error) {
    await spendGuard.settle(reservation, { outcome: "failed-or-unknown" }).catch(() => {});
    throw error;
  }
}

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
async function handle(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  try {
    if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    if (method === "server/discover") return send({ jsonrpc: "2.0", id, result: { serverInfo: SERVER_INFO, capabilities: { tools: {} } } });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call" && params.name === "review_with_model") {
      return send({ jsonrpc: "2.0", id, result: await review(params.arguments ?? {}) });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `Review error: ${error.message}` }] } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { try { handle(JSON.parse(line)); } catch { /* ignore malformed protocol input */ } });
