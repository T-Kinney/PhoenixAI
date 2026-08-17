import dotenv from "dotenv";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(__dirname, "..");

const envCandidates = [
  process.env.AGENTCC_ENV_PATH,
  path.join(rootDir, ".env"),
  path.join(process.cwd(), ".env"),
  path.join(os.homedir(), ".agent-command-center", ".env"),
  "C:\\dev\\DesktopClient\\.env"
].filter(Boolean);

for (const envPath of envCandidates) {
  dotenv.config({ path: envPath, quiet: true });
}

const appStateDir = process.env.AGENTCC_STATE_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Agent Command Center");
const dataDir = process.env.AGENTCC_DATA_DIR || path.join(rootDir, "data");
const configPath = path.join(dataDir, "config.json");
const runsDir = path.join(dataDir, "runs");
const worktreesRoot = process.env.AGENTCC_WORKTREES_DIR || path.join(appStateDir, "worktrees");
const agentRunsPath = path.join(dataDir, "agent-runs.json");
const worktreeLeasesPath = path.join(dataDir, "worktree-leases.json");
const goalsPath = path.join(dataDir, "goals.json");
const loopsPath = path.join(dataDir, "loops.json");
const objectivesPath = path.join(dataDir, "objectives.json");
const messagesDir = path.join(dataDir, "messages");
const projectsPath = path.join(dataDir, "projects.json");
const threadsPath = path.join(dataDir, "threads.json");
const stripeEventsPath = path.join(dataDir, "stripe-events.jsonl");
const liveRuns = new Map();
const liveLoops = new Map();

export const defaultConfig = {
  activeProviderId: "ollama",
  activeModel: "gemma4-coder:q8",
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      kind: "messages-api",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: ["claude-fable-5", "claude-opus-4-8", "claude-sonnet-4-6"]
    },
    {
      id: "openai",
      name: "OpenAI",
      kind: "responses-api",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: ["gpt-5.5", "gpt-5", "gpt-4.1", "o4-mini"]
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      kind: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: [
        "moonshotai/kimi-k2.7-code",
        "openrouter/free",
        "openrouter/auto",
        "z-ai/glm-5",
        "z-ai/glm-5-turbo",
        "z-ai/glm-5.1"
      ]
    },
    {
      id: "kimi",
      name: "Kimi API",
      kind: "openai-compatible",
      baseUrl: "https://api.moonshot.ai/v1",
      apiKeyEnv: "MOONSHOT_API_KEY",
      models: ["kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5"]
    },
    {
      id: "lite-gateway",
      name: "LiteLLM Gateway",
      kind: "gateway",
      baseUrl: "http://127.0.0.1:4000/v1",
      apiKeyEnv: "LITELLM_API_KEY",
      models: ["frontier-coder", "balanced-coder", "free-coder", "local-coder"]
    },
    {
      id: "nvidia-nim",
      name: "NVIDIA NIM",
      kind: "openai-compatible",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKeyEnv: "NVIDIA_API_KEY",
      models: [
        "nvidia/llama-3.3-nemotron-super-49b-v1.5",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "qwen/qwen3-next-80b-a3b-instruct",
        "deepseek-ai/deepseek-v4-pro"
      ]
    },
    {
      id: "xai",
      name: "xAI Grok API",
      kind: "openai-compatible",
      baseUrl: "https://api.x.ai/v1",
      apiKeyEnv: "XAI_API_KEY",
      models: [
        "grok-4.3",
        "grok-code-fast",
        "grok-4-1-fast-reasoning",
        "grok-4-1-fast-non-reasoning",
        "grok-4",
        "grok-4-fast-reasoning",
        "grok-4-fast-non-reasoning"
      ]
    },
    {
      id: "zai-glm",
      name: "Z.ai GLM Coding Plan",
      kind: "openai-compatible",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKeyEnv: "ZAI_API_KEY",
      models: ["glm-5.2", "glm-5.2[1m]", "glm-5.1", "glm-4.7"]
    },
    {
      id: "ollama",
      name: "Ollama Local",
      kind: "local-openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKeyEnv: "OLLAMA_API_KEY",
      models: [
        "gemma4-coder:q8",
        "qwen3-coder:480b-cloud",
        "gpt-oss:120b-cloud",
        "gpt-oss:20b-cloud",
        "deepseek-v3.1:671b-cloud",
        "qwen3-coder:30b",
        "qwen2.5-coder:32b"
      ]
    },
    {
      id: "lm-studio",
      name: "LM Studio Local",
      kind: "local-openai-compatible",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKeyEnv: "LM_STUDIO_API_KEY",
      models: ["loaded-model"]
    }
  ],
  roles: [
    {
      id: "planner",
      name: "Planner",
      defaultTool: "opencode",
      model: "frontier-coder",
      instruction: "Map the system, choose the smallest viable implementation, and identify risky files before edits."
    },
    {
      id: "implementer",
      name: "Implementer",
      defaultTool: "opencode",
      model: "balanced-coder",
      instruction: "Implement the approved plan in a dedicated worktree, keeping changes scoped and testable."
    },
    {
      id: "reviewer",
      name: "Reviewer",
      defaultTool: "aider",
      model: "frontier-coder",
      instruction: "Review diffs for correctness, security, regressions, and missing tests. Do not edit unless asked."
    },
    {
      id: "tester",
      name: "Tester",
      defaultTool: "goose",
      model: "free-coder",
      instruction: "Run project checks, collect failures, and propose the narrowest fixes."
    }
  ],
  permissions: {
    defaultMode: "draft",
    allowOutsideProject: false,
    requireApprovalForNetwork: true,
    requireApprovalForDestructiveCommands: true
  }
};

const tools = [
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    role: "Primary CLI/desktop coding agent",
    install: ["npm.cmd install -g opencode-ai"],
    source: "https://opencode.ai/docs/"
  },
  {
    id: "aider",
    label: "Aider",
    command: "aider",
    role: "Precision git patching and review",
    install: ["python -m pip install aider-install", "aider-install"],
    source: "https://aider.chat/docs/"
  },
  {
    id: "goose",
    label: "Goose",
    command: "goose",
    role: "General desktop/workflow agent",
    install: ["Download goose Desktop for Windows from the official install page"],
    source: "https://goose-docs.ai/docs/getting-started/installation/"
  },
  {
    id: "litellm",
    label: "LiteLLM",
    command: "litellm",
    role: "Model gateway, routing, fallbacks, budgets",
    install: ['python -m pip install "litellm[proxy]"'],
    source: "https://docs.litellm.ai/docs/"
  },
  {
    id: "grok-build",
    label: "Grok Build",
    command: "grok",
    commands: ["grok", "grok-build"],
    role: "xAI/SuperGrok coding agent CLI with subagents, worktrees, hooks, MCP, memory, and headless runs",
    install: ['wsl bash -lc "curl -fsSL https://x.ai/cli/install.sh | bash"', "Run the xAI installer from Git Bash or WSL: curl -fsSL https://x.ai/cli/install.sh | bash"],
    source: "https://x.ai/cli"
  },
  {
    id: "cline",
    label: "Cline",
    command: "code",
    role: "VS Code agent extension",
    install: ["code --install-extension saoudrizwan.claude-dev"],
    source: "https://docs.cline.bot/getting-started/installing-cline"
  },
  {
    id: "kilo",
    label: "Kilo Code",
    command: "code",
    role: "VS Code agent extension and CLI candidate",
    install: ["code --install-extension kilocode.Kilo-Code --pre-release"],
    source: "https://kilo.ai/docs/getting-started/installing"
  },
  {
    id: "ollama",
    label: "Ollama",
    command: "ollama",
    role: "Local model runtime",
    install: ["winget install Ollama.Ollama"],
    source: "https://ollama.com/"
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    command: "lmstudio",
    role: "Local model runtime with OpenAI-compatible server",
    install: ["Download LM Studio for Windows"],
    source: "https://lmstudio.ai/"
  }
];

const providerRuntime = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    env: "ANTHROPIC_API_KEY",
    defaultModel: "claude-fable-5",
    redactedBaseUrl: "https://api.anthropic.com/v1"
  },
  nvidia: {
    id: "nvidia-nim",
    name: "NVIDIA NIM",
    env: "NVIDIA_API_KEY",
    defaultModel: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    redactedBaseUrl: "https://integrate.api.nvidia.com/v1",
    baseUrl: "https://integrate.api.nvidia.com/v1"
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    env: "OPENROUTER_API_KEY",
    defaultModel: "moonshotai/kimi-k2.7-code",
    redactedBaseUrl: "https://openrouter.ai/api/v1",
    baseUrl: "https://openrouter.ai/api/v1",
    allowAnonymousModelList: true
  },
  xai: {
    id: "xai",
    name: "xAI Grok API",
    env: "XAI_API_KEY",
    defaultModel: "grok-4.3",
    redactedBaseUrl: "https://api.x.ai/v1",
    baseUrl: "https://api.x.ai/v1"
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    env: "OPENAI_API_KEY",
    defaultModel: "gpt-5.5",
    redactedBaseUrl: "https://api.openai.com/v1"
  },
  litellm: {
    id: "lite-gateway",
    name: "LiteLLM Gateway",
    env: "LITELLM_API_KEY",
    defaultModel: "local-coder",
    redactedBaseUrl: process.env.LITELLM_URL || "http://127.0.0.1:4000/v1",
    baseUrl: process.env.LITELLM_URL || "http://127.0.0.1:4000/v1",
    requiresKey: false
  },
  kimi: {
    id: "kimi",
    name: "Kimi API",
    env: "MOONSHOT_API_KEY",
    defaultModel: "kimi-k2.7-code",
    redactedBaseUrl: "https://api.moonshot.ai/v1",
    baseUrl: "https://api.moonshot.ai/v1"
  },
  zai: {
    id: "zai-glm",
    name: "Z.ai GLM Coding Plan",
    env: "ZAI_API_KEY",
    defaultModel: "glm-5.2[1m]",
    redactedBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    baseUrl: "https://api.z.ai/api/coding/paas/v4"
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    env: "GEMINI_API_KEY",
    defaultModel: "gemini-3-pro",
    redactedBaseUrl: "https://generativelanguage.googleapis.com"
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    env: "OLLAMA_API_KEY",
    defaultModel: "gemma4-coder:q8",
    redactedBaseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434/v1",
    baseUrl: process.env.OLLAMA_URL || "http://127.0.0.1:11434/v1",
    requiresKey: false
  },
  lmstudio: {
    id: "lm-studio",
    name: "LM Studio",
    env: "LM_STUDIO_API_KEY",
    defaultModel: "loaded-model",
    redactedBaseUrl: process.env.LM_STUDIO_URL || "http://127.0.0.1:1234/v1",
    baseUrl: process.env.LM_STUDIO_URL || "http://127.0.0.1:1234/v1",
    requiresKey: false
  }
};

function runWhere(command) {
  return new Promise((resolve) => {
    const probe = os.platform() === "win32" ? "where.exe" : "which";
    execFile(probe, [command], { windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve({ installed: false, path: null });
        return;
      }
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? null;
      resolve({ installed: Boolean(first), path: first });
    });
  });
}

async function runWhereAny(commands) {
  for (const command of commands) {
    const result = await runWhere(command);
    if (result.installed) {
      return { ...result, detectedCommand: command };
    }
  }
  return { installed: false, path: null, detectedCommand: commands[0] ?? null };
}

function stableProjectName(projectPath) {
  return path.basename(projectPath) || projectPath;
}

function defaultProjectPath() {
  if (process.env.AGENTCC_DEFAULT_PROJECT) {
    return path.resolve(process.env.AGENTCC_DEFAULT_PROJECT);
  }

  // In a PACKAGED build, rootDir points inside the app bundle (the
  // resources/app.asar directory). Seeding that as a project produced a
  // phantom "app.asar" entry pointing at Program Files - not a folder anyone
  // wants an agent editing. Packaged builds start with no project instead;
  // the user adds their own.
  if (rootDir.includes(`${path.sep}app.asar`) || rootDir.includes(`${path.sep}resources${path.sep}app`)) {
    return null;
  }

  const releaseMarker = `${path.sep}release${path.sep}`;
  if (rootDir.includes(releaseMarker)) return null;

  return rootDir;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultProject() {
  const projectPath = defaultProjectPath();
  // No sensible default in a packaged build — return nothing rather than
  // inventing a project inside the installation directory.
  if (!projectPath) return null;
  return {
    id: "project_desktop_client",
    name: path.basename(projectPath),
    path: projectPath,
    createdAt: nowIso()
  };
}

function defaultThread(projectId = "project_desktop_client") {
  return {
    id: "thread_command_center",
    projectId,
    title: "Replicate Codex + Claude Code",
    state: "Active",
    summary: "Goal: build a local desktop agent command center that feels like Codex and Claude Code, supports direct folder access, multiple model providers, swarming agents, Stripe sandbox revenue workflows, and long-running project context.",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

function defaultMessages() {
  return [
    {
      id: "msg_seed_user",
      role: "user",
      content: "Build me a free-model desktop agent client that feels like Codex and Claude Code, supports long projects, direct folder access, multiple models, and agents checking one another's work.",
      createdAt: nowIso()
    },
    {
      id: "msg_seed_assistant",
      role: "assistant",
      content: "I would run this as a local shell around OpenCode, Aider, Goose, Cline/Kilo, and LiteLLM. The app owns model routing, approval boundaries, worktrees, review gates, and the unified timeline.",
      createdAt: nowIso()
    }
  ];
}

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(runsDir, { recursive: true });
  await fs.mkdir(worktreesRoot, { recursive: true });
  await fs.mkdir(messagesDir, { recursive: true });
  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
  }
  try {
    await fs.access(projectsPath);
  } catch {
    await fs.writeFile(projectsPath, JSON.stringify([defaultProject()].filter(Boolean), null, 2));
  }
  try {
    await fs.access(threadsPath);
  } catch {
    await fs.writeFile(threadsPath, JSON.stringify([defaultThread()], null, 2));
  }
  try {
    await fs.access(agentRunsPath);
  } catch {
    await fs.writeFile(agentRunsPath, JSON.stringify([], null, 2));
  }
  try {
    await fs.access(worktreeLeasesPath);
  } catch {
    await fs.writeFile(worktreeLeasesPath, JSON.stringify([], null, 2));
  }
  try {
    await fs.access(goalsPath);
  } catch {
    await fs.writeFile(goalsPath, JSON.stringify([], null, 2));
  }
  try {
    await fs.access(loopsPath);
  } catch {
    await fs.writeFile(loopsPath, JSON.stringify([], null, 2));
  }
  try {
    await fs.access(objectivesPath);
  } catch {
    await fs.writeFile(objectivesPath, JSON.stringify([], null, 2));
  }
  const seedMessagesPath = path.join(messagesDir, "thread_command_center.json");
  try {
    await fs.access(seedMessagesPath);
  } catch {
    await fs.writeFile(seedMessagesPath, JSON.stringify(defaultMessages(), null, 2));
  }
}

function mergeModelLists(defaultModels = [], savedModels = []) {
  return [...new Set([
    ...(Array.isArray(savedModels) ? savedModels : []),
    ...(Array.isArray(defaultModels) ? defaultModels : [])
  ])];
}

function mergeConfig(config) {
  const savedProviders = Array.isArray(config?.providers) ? config.providers : [];
  const defaultProviderIds = new Set(defaultConfig.providers.map((provider) => provider.id));
  const mergedProviders = defaultConfig.providers.map((provider) => {
    const saved = savedProviders.find((item) => item.id === provider.id);
    return saved ? { ...provider, ...saved, models: mergeModelLists(provider.models, saved.models) } : provider;
  });
  const customProviders = savedProviders.filter((provider) => provider.id && !defaultProviderIds.has(provider.id));

  return {
    ...defaultConfig,
    ...config,
    providers: [...mergedProviders, ...customProviders],
    roles: Array.isArray(config?.roles) && config.roles.length ? config.roles : defaultConfig.roles,
    permissions: {
      ...defaultConfig.permissions,
      ...(config?.permissions ?? {})
    }
  };
}

export async function readConfig() {
  await ensureDataFiles();
  const raw = await fs.readFile(configPath, "utf8");
  return mergeConfig(parseJsonText(raw, defaultConfig));
}

export async function writeConfig(config) {
  await ensureDataFiles();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return config;
}

async function readJsonFile(filePath, fallback) {
  await ensureDataFiles();
  try {
    return parseJsonText(await fs.readFile(filePath, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

function parseJsonText(text, fallback) {
  const clean = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!clean) return fallback;
  return JSON.parse(clean);
}

async function writeJsonFile(filePath, value) {
  await ensureDataFiles();
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
  return value;
}

function messagesPath(threadId) {
  return path.join(messagesDir, `${threadId}.json`);
}

async function readProjects() {
  const projects = await readJsonFile(projectsPath, [defaultProject()].filter(Boolean));
  const fallback = defaultProjectPath();
  return projects.map((project) => {
    const normalized = String(project.path || "");
    if (project.id === "project_desktop_client" && normalized.includes(`${path.sep}release${path.sep}`)) {
      return { ...project, name: stableProjectName(fallback), path: fallback };
    }
    return project;
  });
}

async function writeProjects(projects) {
  return writeJsonFile(projectsPath, projects);
}

async function readThreads() {
  return readJsonFile(threadsPath, [defaultThread()]);
}

async function writeThreads(threads) {
  return writeJsonFile(threadsPath, threads);
}

async function readMessages(threadId) {
  return readJsonFile(messagesPath(threadId), []);
}

async function writeMessages(threadId, messages) {
  return writeJsonFile(messagesPath(threadId), messages);
}

async function readGoals() {
  return readJsonFile(goalsPath, []);
}

async function writeGoals(goals) {
  return writeJsonFile(goalsPath, goals);
}

async function readLoops() {
  return readJsonFile(loopsPath, []);
}

async function writeLoops(loops) {
  return writeJsonFile(loopsPath, loops);
}

async function readObjectives() {
  return readJsonFile(objectivesPath, []);
}

async function writeObjectives(objectives) {
  return writeJsonFile(objectivesPath, objectives);
}

async function saveLoop(loop) {
  const loops = await readLoops();
  const next = [loop, ...loops.filter((item) => item.id !== loop.id)].slice(0, 80);
  await writeLoops(next);
  liveLoops.set(loop.id, loop);
  return loop;
}

async function updateLoop(loopId, patch) {
  const current = liveLoops.get(loopId) || (await readLoops()).find((loop) => loop.id === loopId);
  if (!current) throw new Error(`Loop not found: ${loopId}`);
  return saveLoop({ ...current, ...patch, updatedAt: nowIso() });
}

function publicGoal(goal) {
  return goal ? { ...goal } : null;
}

function publicLoop(loop) {
  return loop ? { ...loop } : null;
}

function publicObjective(objective) {
  return withObjectiveRuntimeState(objective);
}

async function activeGoalForThread(threadId) {
  const goals = await readGoals();
  return goals.find((goal) => goal.threadId === threadId && goal.status === "active") || null;
}

async function activeLoopForThread(threadId) {
  const loops = await readLoops();
  return loops.find((loop) => loop.threadId === threadId && ["queued", "running"].includes(loop.status)) || null;
}

async function activeObjectiveForThread(threadId) {
  const objectives = await readObjectives();
  return objectives.find((objective) => (
    objective.threadId === threadId && ["planned", "needs_clarity", "running", "in_progress", "needs_attention", "ready_for_delivery"].includes(objective.status)
  )) || null;
}

function touchThread(threads, threadId, patch = {}) {
  const updatedAt = nowIso();
  return threads.map((thread) => (
    thread.id === threadId ? { ...thread, ...patch, updatedAt } : thread
  ));
}

function projectSlug(projectPath) {
  return stableProjectName(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "project";
}

function summarizeMessages(messages, existingSummary = "") {
  const userMessages = messages.filter((message) => message.role === "user").slice(-8);
  const facts = userMessages
    .map((message) => message.content.trim())
    .filter(Boolean)
    .map((content) => content.length > 220 ? `${content.slice(0, 217)}...` : content);
  const durable = String(existingSummary || "")
    .split(/\nRecent user intent:/)[0]
    .trim() || "This thread is a local agent workspace conversation.";
  const uniqueFacts = [...new Set(facts)];
  return [durable, ...uniqueFacts.map((fact) => `Recent user intent: ${fact}`)]
    .join("\n")
    .slice(-3000);
}

export async function getWorkspaceState() {
  const [projects, threads] = await Promise.all([readProjects(), readThreads()]);
  const sortedThreads = [...threads].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return {
    projects,
    threads: sortedThreads,
    activeProjectId: projects[0]?.id ?? null,
    activeThreadId: sortedThreads[0]?.id ?? null
  };
}

export async function addProject(input) {
  const projectPath = String(input?.path ?? "").trim();
  if (!projectPath) {
    throw new Error("Project path is required.");
  }

  const resolved = path.resolve(projectPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a folder: ${resolved}`);
  }

  const projects = await readProjects();
  const existing = projects.find((project) => path.resolve(project.path).toLowerCase() === resolved.toLowerCase());
  if (existing) {
    const updated = projects.map((project) => (
      project.id === existing.id ? { ...project, lastOpenedAt: nowIso() } : project
    ));
    await writeProjects(updated);
    return { project: { ...existing, lastOpenedAt: nowIso() }, projects: updated };
  }

  const project = {
    id: `project_${projectSlug(resolved)}_${Date.now().toString(36)}`,
    name: stableProjectName(resolved),
    path: resolved,
    addedAt: nowIso(),
    lastOpenedAt: nowIso()
  };
  const nextProjects = [project, ...projects];
  await writeProjects(nextProjects);
  return { project, projects: nextProjects };
}

export async function createThread(input) {
  const projects = await readProjects();
  const projectId = String(input?.projectId ?? projects[0]?.id ?? "").trim();
  const project = projects.find((item) => item.id === projectId) || projects[0];
  if (!project) {
    throw new Error("Create or select a project first.");
  }

  const title = String(input?.title ?? "").trim() || `New chat in ${project.name}`;
  const thread = {
    id: makeId("thread"),
    projectId: project.id,
    title,
    state: "Active",
    summary: `Project: ${project.name}. Path: ${project.path}.`,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  const threads = await readThreads();
  await writeThreads([thread, ...threads]);
  await writeMessages(thread.id, []);
  return { thread };
}

export async function getThreadBundle(threadId) {
  const [projects, threads, config] = await Promise.all([readProjects(), readThreads(), readConfig()]);
  const thread = threads.find((item) => item.id === threadId) || threads[0];
  if (!thread) {
    return { thread: null, project: null, messages: [], context: null, activeGoal: null, activeLoop: null, activeObjective: null };
  }

  const project = projects.find((item) => item.id === thread.projectId) || projects[0] || null;
  const [messages, activeGoal, activeLoop, activeObjective] = await Promise.all([
    readMessages(thread.id),
    activeGoalForThread(thread.id),
    activeLoopForThread(thread.id),
    activeObjectiveForThread(thread.id)
  ]);
  return {
    thread,
    project,
    messages,
    activeGoal: publicGoal(activeGoal),
    activeLoop: publicLoop(activeLoop),
    activeObjective: publicObjective(activeObjective),
    context: await buildContextPack({ thread, project, messages, config, activeGoal, activeLoop, activeObjective })
  };
}

async function buildProjectContext(project) {
  if (!project?.path) {
    return {
      gitRepo: false,
      gitStatus: "No project selected.",
      files: [],
      cleanup: cleanupFindings("", []),
      summary: "No project selected."
    };
  }

  const projectPath = path.resolve(project.path);
  const stat = await fs.stat(projectPath).catch(() => null);
  if (!stat?.isDirectory()) {
    return {
      gitRepo: false,
      gitStatus: `Project path is not available: ${projectPath}`,
      files: [],
      cleanup: cleanupFindings("", []),
      summary: `Project path is not available: ${projectPath}`
    };
  }

  const gitRepo = await isGitRepo(projectPath);
  const repoRoot = gitRepo ? await gitRoot(projectPath) : "";
  const projectSpec = repoRoot ? path.relative(repoRoot, projectPath).replaceAll("\\", "/") || "." : ".";
  const scopedArgs = projectSpec === "." ? [] : ["--", projectSpec];
  const gitStatus = gitRepo
    ? await gitText(repoRoot || projectPath, ["status", "--short", "--untracked-files=all", ...scopedArgs], 8000)
    : "";
  const trackedFiles = gitRepo
    ? (await gitText(repoRoot || projectPath, ["ls-files", ...scopedArgs], 8000))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((file) => projectSpec === "." ? file : path.relative(projectSpec, file).replaceAll("\\", "/"))
      .filter((file) => file && !file.startsWith(".."))
      .slice(0, 180)
    : [];
  const files = filterContextFiles(trackedFiles.length ? trackedFiles : await listProjectFiles(projectPath, 220)).slice(0, 180);
  const cleanup = cleanupFindings(gitStatus, files);
  return {
    gitRepo,
    gitStatus: gitStatus || (gitRepo ? "Clean or no tracked status output." : "Not a git repository."),
    files,
    cleanup,
    summary: `Git repo: ${gitRepo ? "yes" : "no"}. Files sampled: ${files.length}. Untracked files: ${cleanup.untrackedCount}.`
  };
}

function filterContextFiles(files) {
  const noisy = /(^|[\\/])(\.env|node_modules|dist|build|release|coverage|\.next|\.agent-worktrees|data)([\\/]|$)/i;
  return files.filter((file) => !noisy.test(file));
}

async function buildContextPack({ thread, project, messages, config, activeGoal, activeLoop, activeObjective }) {
  const recentMessages = messages.slice(-16);
  const objectiveContext = withObjectiveRuntimeState(activeObjective);
  const projectContext = await buildProjectContext(project);
  const recentText = recentMessages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  const contextText = [
    "AGENT COMMAND CENTER CONTEXT PACK",
    `Thread: ${thread.title}`,
    `Project: ${project?.name || "No project selected"}`,
    `Path: ${project?.path || "No path selected"}`,
    `Active provider: ${config.activeProviderId}`,
    `Active model: ${config.activeModel}`,
    `Project snapshot: ${projectContext.summary}`,
    `Cleanup: ${projectContext.cleanup.recommendation}`,
    "",
    "Relevant file sample:",
    projectContext.files.slice(0, 80).join("\n") || "No files sampled.",
    "",
    "Git status:",
    projectContext.gitStatus || "No git status.",
    "",
    "Durable summary:",
    thread.summary || "No durable summary yet.",
    "",
    "Active goal:",
    activeGoal ? `${activeGoal.objective}\nStatus: ${activeGoal.status}\nMode: ${activeGoal.mode}` : "No active goal.",
    "",
    "Active loop:",
    activeLoop ? `${activeLoop.status}; iteration ${activeLoop.currentIteration || 0}/${activeLoop.maxIterations}` : "No active loop.",
    "",
    "Active objective:",
    objectiveContext
      ? [
          `${objectiveContext.title} (${objectiveContext.status})`,
          objectiveContext.spec?.objective || objectiveContext.idea,
          `Tasks: ${(objectiveContext.taskGraph || []).map((task) => `${task.id}:${task.status}`).join(", ") || "none"}`,
          `Commander /goal: ${objectiveContext.goalLedger?.selfGoal?.command || "not written"}`,
          `Agent /goals: ${(objectiveContext.goalLedger?.agentGoals || []).map((goal) => `${goal.ownerAgentId}:${goal.status}`).join(", ") || "none"}`,
          `Open discrepancies: ${(objectiveContext.reviewBoard?.discrepancies || []).filter((item) => item.status === "open").length}`,
          `Context policy: ${objectiveContext.contextPolicy?.strategy || "objective brief"}`
        ].join("\n")
      : "No active objective.",
    "",
    "Recent conversation:",
    recentText || "No messages yet."
  ].join("\n");

  return {
    strategy: "durable objective + active goal + active loop + summary + last 16 turns + project metadata",
    maxRecentMessages: 16,
    messageCount: messages.length,
    includedMessages: recentMessages.length,
    projectFileCount: projectContext.files.length,
    cleanup: projectContext.cleanup,
    approximateTokens: Math.ceil(contextText.length / 4),
    text: contextText
  };
}

async function readAgentRuns() {
  return readJsonFile(agentRunsPath, []);
}

async function writeAgentRuns(runs) {
  return writeJsonFile(agentRunsPath, runs);
}

async function saveAgentRun(run) {
  const runs = await readAgentRuns();
  const next = [run, ...runs.filter((item) => item.id !== run.id)].slice(0, 100);
  await writeAgentRuns(next);
  return run;
}

async function updateAgentRun(runId, patch) {
  const current = liveRuns.get(runId) || (await readAgentRuns()).find((run) => run.id === runId);
  if (!current) throw new Error(`Run not found: ${runId}`);
  const updated = { ...current, ...patch, updatedAt: nowIso() };
  liveRuns.set(runId, updated);
  await saveAgentRun(updated);
  return updated;
}

function publicRun(run) {
  return run ? { ...run, process: undefined } : null;
}

export async function listAgentRuns() {
  const runs = await readAgentRuns();
  return { runs: runs.map(publicRun) };
}

export async function getAgentRun(runId) {
  const run = liveRuns.get(runId) || (await readAgentRuns()).find((item) => item.id === runId);
  return { run: publicRun(run) };
}

export async function applyRunPatch(input = {}) {
  const runId = String(input.runId || "").trim();
  const stepId = String(input.stepId || "").trim();
  const patchIndex = Number(input.patchIndex || 0);
  if (!runId || !stepId) {
    throw new Error("Run id and step id are required.");
  }

  const run = liveRuns.get(runId) || (await readAgentRuns()).find((item) => item.id === runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  if (run.workspaceMode !== "worktree" || !run.worktreePath) {
    throw new Error("Patches can only be applied to managed worktree runs.");
  }

  const step = run.steps?.find((item) => item.id === stepId);
  const patch = step?.patches?.find((item) => Number(item.index) === patchIndex);
  if (!step || !patch) {
    throw new Error("Patch candidate not found.");
  }
  if (patch.applied) {
    return { run: publicRun(run), patch };
  }

  const check = await runCommand("git", ["-C", run.projectPath, "apply", "--check", patch.artifactPath], { timeoutMs: 15000 });
  if (!check.ok) {
    throw new Error((check.stderr || check.stdout || "Patch failed validation.").trim());
  }
  const apply = await runCommand("git", ["-C", run.projectPath, "apply", patch.artifactPath], { timeoutMs: 15000 });
  if (!apply.ok) {
    throw new Error((apply.stderr || apply.stdout || "Patch could not be applied.").trim());
  }
  const status = await runCommand("git", ["-C", run.projectPath, "status", "--short"], { timeoutMs: 12000 });
  const diffStat = await runCommand("git", ["-C", run.projectPath, "diff", "--stat"], { timeoutMs: 12000 });
  const updated = await updateAgentRun(run.id, {
    patchAppliedAt: nowIso(),
    gitStatusAfterPatch: status.stdout || status.stderr,
    diffStatAfterPatch: diffStat.stdout || diffStat.stderr,
    steps: run.steps.map((item) => item.id === stepId ? {
      ...item,
      patches: (item.patches || []).map((candidate) => (
        Number(candidate.index) === patchIndex
          ? {
              ...candidate,
              applied: true,
              appliedAt: nowIso(),
              applyCommand: apply.command,
              applyOutput: (apply.stdout || apply.stderr || "").trim(),
              gitStatus: status.stdout || status.stderr,
              diffStat: diffStat.stdout || diffStat.stderr
            }
          : candidate
      ))
    } : item)
  });

  const updatedStep = updated.steps.find((item) => item.id === stepId);
  const updatedPatch = updatedStep?.patches?.find((item) => Number(item.index) === patchIndex);
  return { run: publicRun(updated), patch: updatedPatch };
}

function parseGitStatus(statusText) {
  return String(statusText || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const tabIndex = line.indexOf("\t");
      if (tabIndex > 0 && tabIndex <= 3) {
        return {
          status: line.slice(0, tabIndex).trim(),
          file: line.slice(tabIndex + 1).trim()
        };
      }
      const status = line.slice(0, 2).trim() || line.slice(0, 2);
      const file = line.slice(3).trim();
      return { status, file };
    });
}

function untrackedFilesFromStatus(statusText) {
  return parseGitStatus(statusText)
    .filter((item) => item.status === "??")
    .map((item) => item.file)
    .filter(Boolean);
}

async function prepareWorktreeDiff(run) {
  if (!run?.worktreePath || !run?.projectPath || !run?.sourceProjectPath) {
    throw new Error("This run does not have a managed worktree diff to review.");
  }
  const worktreeStat = await fs.stat(run.projectPath).catch(() => null);
  const sourceStat = await fs.stat(run.sourceProjectPath).catch(() => null);
  if (!worktreeStat?.isDirectory() || !sourceStat?.isDirectory()) {
    throw new Error("Source project or managed worktree folder is missing.");
  }

  const sourceStatus = await runCommand("git", ["-C", run.sourceProjectPath, "status", "--short", "--untracked-files=all"], { timeoutMs: 12000 });
  const worktreeStatus = await runCommand("git", ["-C", run.projectPath, "status", "--short", "--untracked-files=all"], { timeoutMs: 12000 });
  const untracked = untrackedFilesFromStatus(worktreeStatus.stdout || "");
  if (untracked.length) {
    const addIntent = await runCommand("git", ["-C", run.projectPath, "add", "-N", "--", ...untracked.slice(0, 120)], { timeoutMs: 20000 });
    if (!addIntent.ok) {
      throw new Error(addIntent.stderr || addIntent.stdout || "Could not include untracked files in the merge preview.");
    }
  }

  const diff = await runCommand("git", ["-C", run.projectPath, "diff", "--binary", "HEAD", "--"], { timeoutMs: 30000 });
  if (!diff.ok) {
    throw new Error(diff.stderr || diff.stdout || "Could not generate worktree diff.");
  }
  const diffText = diff.stdout || "";
  const diffStat = await runCommand("git", ["-C", run.projectPath, "diff", "--stat", "HEAD", "--"], { timeoutMs: 12000 });
  const nameStatus = await runCommand("git", ["-C", run.projectPath, "diff", "--name-status", "HEAD", "--"], { timeoutMs: 12000 });
  const patchPath = diffText.trim()
    ? await writeRunArtifact(run.id, "merge-gate.patch", diffText.endsWith("\n") ? diffText : `${diffText}\n`)
    : null;
  const sourceDirty = Boolean((sourceStatus.stdout || "").trim());
  const hasDiff = Boolean(diffText.trim());
  const check = hasDiff
    ? await runCommand("git", ["-C", run.sourceProjectPath, "apply", "--check", patchPath], { timeoutMs: 20000 })
    : { ok: false, stdout: "", stderr: "No worktree diff to merge." };

  return {
    runId: run.id,
    title: run.title,
    sourceProjectPath: run.sourceProjectPath,
    worktreePath: run.projectPath,
    worktreeLeaseId: run.worktreeLeaseId || null,
    sourceStatus: sourceStatus.stdout || sourceStatus.stderr || "",
    worktreeStatus: worktreeStatus.stdout || worktreeStatus.stderr || "",
    changedFiles: parseGitStatus(nameStatus.stdout || worktreeStatus.stdout || ""),
    diffStat: diffStat.stdout || diffStat.stderr || "",
    diffText,
    diffPreview: diffText.length > 60000 ? `${diffText.slice(0, 60000)}\n\n... diff preview truncated ...` : diffText,
    patchPath,
    hasDiff,
    sourceDirty,
    canApply: Boolean(hasDiff && check.ok),
    canMerge: Boolean(hasDiff && check.ok && !sourceDirty && run.mergeGate?.status !== "merged"),
    checkOutput: (check.stdout || check.stderr || "").trim(),
    warning: sourceDirty
      ? "Source project has uncommitted changes. Merge is blocked until the source is clean or an explicit force option is added later."
      : !hasDiff ? "Managed worktree has no diff to merge."
        : check.ok ? "Patch validates against the source project."
          : "Patch does not apply cleanly to the source project.",
    merged: run.mergeGate?.status === "merged",
    mergedAt: run.mergeGate?.mergedAt || null
  };
}

export async function getRunMergeGate(runId) {
  const run = liveRuns.get(runId) || (await readAgentRuns()).find((item) => item.id === runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  const gate = await prepareWorktreeDiff(run);
  return { run: publicRun(run), gate };
}

async function markObjectiveTaskMerged(run, gate, archiveResult = null) {
  if (!run.objectiveId || !run.objectiveTaskId) return null;
  const objectives = await readObjectives();
  const objective = objectives.find((item) => item.id === run.objectiveId);
  const task = objective?.taskGraph?.find((item) => item.id === run.objectiveTaskId);
  if (!objective || !task) return null;
  const updated = await updateObjectiveTask(run.objectiveId, run.objectiveTaskId, (current) => ({
    ...current,
    status: "merged",
    runStatus: run.status,
    runSummary: "Worktree diff merged into the source project.",
    mergedAt: gate.mergedAt,
    mergeGate: {
      status: "merged",
      mergedAt: gate.mergedAt,
      sourceProjectPath: run.sourceProjectPath,
      worktreePath: run.projectPath,
      patchPath: gate.patchPath,
      sourceStatusAfterMerge: gate.sourceStatusAfterMerge,
      sourceDiffStatAfterMerge: gate.sourceDiffStatAfterMerge,
      archiveResult
    }
  }));
  return publicObjective(updated);
}

export async function mergeRunToSource(input = {}) {
  const runId = String(input.runId || "").trim();
  if (!runId) {
    throw new Error("Run id is required.");
  }
  let run = liveRuns.get(runId) || (await readAgentRuns()).find((item) => item.id === runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }
  if (run.mergeGate?.status === "merged") {
    return { run: publicRun(run), gate: run.mergeGate, objective: null };
  }

  const gate = await prepareWorktreeDiff(run);
  if (!gate.hasDiff) {
    throw new Error("Managed worktree has no diff to merge.");
  }
  if (gate.sourceDirty && input.allowDirtySource !== true) {
    throw new Error("Source project has uncommitted changes. Commit, stash, or clean the source before merging.");
  }
  if (!gate.canApply) {
    throw new Error(gate.checkOutput || "Patch does not apply cleanly to the source project.");
  }

  const apply = await runCommand("git", ["-C", run.sourceProjectPath, "apply", gate.patchPath], { timeoutMs: 30000 });
  if (!apply.ok) {
    throw new Error(apply.stderr || apply.stdout || "Could not apply worktree diff to the source project.");
  }
  const sourceStatusAfter = await runCommand("git", ["-C", run.sourceProjectPath, "status", "--short", "--untracked-files=all"], { timeoutMs: 12000 });
  const sourceDiffStatAfter = await runCommand("git", ["-C", run.sourceProjectPath, "diff", "--stat", "HEAD", "--"], { timeoutMs: 12000 });
  const mergedAt = nowIso();
  let archiveResult = null;
  if (input.archiveLease === true && run.worktreeLeaseId) {
    archiveResult = await archiveWorktreeLease(run.worktreeLeaseId).catch((error) => ({ error: error.message }));
  }

  const mergeGate = {
    ...gate,
    status: "merged",
    mergedAt,
    sourceStatusAfterMerge: sourceStatusAfter.stdout || sourceStatusAfter.stderr || "",
    sourceDiffStatAfterMerge: sourceDiffStatAfter.stdout || sourceDiffStatAfter.stderr || "",
    applyCommand: apply.command,
    applyOutput: (apply.stdout || apply.stderr || "").trim(),
    archiveResult
  };
  run = await updateAgentRun(run.id, {
    mergeGate,
    mergedAt,
    status: run.status === "failed" ? run.status : "merged"
  });
  const objective = await markObjectiveTaskMerged(run, mergeGate, archiveResult);
  return { run: publicRun(run), gate: mergeGate, objective };
}

export async function mergeObjectiveTaskToSource(input = {}) {
  const objectiveId = String(input.objectiveId || "").trim();
  const taskId = String(input.taskId || "").trim();
  const objective = (await readObjectives()).find((item) => item.id === objectiveId);
  const task = objective?.taskGraph?.find((item) => item.id === taskId);
  if (!objective || !task) {
    throw new Error("Objective task not found.");
  }
  if (!task.runId) {
    throw new Error("This task has no managed run to merge.");
  }
  return mergeRunToSource({ ...input, runId: task.runId });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      shell: false,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
    }, options.timeoutMs || 20000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, command: [command, ...args].join(" "), stdout, stderr: error.message, exitCode: null, ms: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, command: [command, ...args].join(" "), stdout, stderr, exitCode: code, ms: Date.now() - startedAt });
    });
  });
}

async function isGitRepo(projectPath) {
  const result = await runCommand("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], { timeoutMs: 8000 });
  return result.ok && result.stdout.trim() === "true";
}

async function readWorktreeLeases() {
  return readJsonFile(worktreeLeasesPath, []);
}

async function writeWorktreeLeases(leases) {
  return writeJsonFile(worktreeLeasesPath, leases);
}

function pathKey(value) {
  return path.resolve(String(value || "")).toLowerCase();
}

function shortHash(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 10);
}

function worktreeObjectiveKey({ projectPath, threadId, title, prompt }) {
  const source = String(title || prompt || threadId || "agent-objective").trim();
  return `${slugify(source)}-${shortHash(`${pathKey(projectPath)}:${threadId || source}`)}`;
}

function worktreeProjectKey(projectPath) {
  return `${projectSlug(projectPath)}-${shortHash(pathKey(projectPath))}`;
}

function publicLease(lease) {
  return lease ? { ...lease } : null;
}

async function directoryExists(dir) {
  const stat = await fs.stat(dir).catch(() => null);
  return Boolean(stat?.isDirectory());
}

async function gitText(projectPath, args, timeoutMs = 10000) {
  const result = await runCommand("git", ["-C", projectPath, ...args], { timeoutMs });
  return result.ok ? result.stdout.trim() : "";
}

async function gitRoot(projectPath) {
  return gitText(projectPath, ["rev-parse", "--show-toplevel"], 8000);
}

async function hydrateLease(lease) {
  const exists = await directoryExists(lease.path);
  const executionPath = lease.executionPath || lease.path;
  const gitStatus = exists ? await gitText(executionPath, ["status", "--short", "--untracked-files=all"], 10000) : "";
  const diffStat = exists ? await gitText(executionPath, ["diff", "--stat"], 10000) : "";
  return {
    ...lease,
    executionPath,
    exists,
    gitStatus,
    diffStat,
    dirty: Boolean(gitStatus.trim() || diffStat.trim())
  };
}

async function saveWorktreeLease(lease) {
  const leases = await readWorktreeLeases();
  const next = [lease, ...leases.filter((item) => item.id !== lease.id)].slice(0, 80);
  await writeWorktreeLeases(next);
  return lease;
}

export async function listWorktreeLeases(input = {}) {
  const leases = await readWorktreeLeases();
  const projectPath = input?.projectPath ? pathKey(input.projectPath) : null;
  const filtered = projectPath
    ? leases.filter((lease) => pathKey(lease.sourceProjectPath) === projectPath)
    : leases;
  const hydrated = await Promise.all(filtered.map(hydrateLease));
  hydrated.sort((a, b) => new Date(b.lastUsedAt || b.createdAt) - new Date(a.lastUsedAt || a.createdAt));
  return { leases: hydrated.map(publicLease) };
}

export async function ensureWorktreeLease(input = {}) {
  const sourceProjectPath = path.resolve(String(input.projectPath || "").trim());
  const stat = await fs.stat(sourceProjectPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Select a valid project folder before creating a worktree: ${sourceProjectPath}`);
  }
  if (!await isGitRepo(sourceProjectPath)) {
    throw new Error("Managed worktrees require the selected project to be a Git repository.");
  }

  const repoRoot = await gitRoot(sourceProjectPath);
  const projectSubdir = path.relative(repoRoot, sourceProjectPath);
  const objectiveKey = worktreeObjectiveKey({
    projectPath: sourceProjectPath,
    threadId: input.threadId,
    title: input.title,
    prompt: input.prompt
  });
  const projectKey = worktreeProjectKey(sourceProjectPath);
  const leasePath = path.join(worktreesRoot, projectKey, objectiveKey);
  const executionPath = projectSubdir ? path.join(leasePath, projectSubdir) : leasePath;
  const leases = await readWorktreeLeases();
  const existing = leases.find((lease) => (
    lease.objectiveKey === objectiveKey
    && pathKey(lease.sourceProjectPath) === pathKey(sourceProjectPath)
    && lease.status !== "archived"
  ));

  const baseBranch = await gitText(repoRoot, ["branch", "--show-current"], 8000) || "detached";
  const baseCommit = await gitText(repoRoot, ["rev-parse", "HEAD"], 8000);
  let lease = existing || {
    id: makeId("lease"),
    objectiveKey,
    projectKey,
    sourceProjectPath,
    path: leasePath,
    title: String(input.title || input.prompt || "Managed worktree").trim().slice(0, 120),
    threadIds: [],
    runIds: [],
    status: "active",
    createdAt: nowIso()
  };

  await fs.mkdir(path.dirname(leasePath), { recursive: true });
  const exists = await directoryExists(leasePath);
  let created = false;
  let createCommand = null;
  if (!exists) {
    const result = await runCommand("git", ["-C", repoRoot, "worktree", "add", "--detach", leasePath, "HEAD"], { timeoutMs: 60000 });
    createCommand = result.command;
    if (!result.ok) {
      throw new Error(result.stderr || result.stdout || "Git worktree creation failed.");
    }
    created = true;
  }

  const threadIds = new Set([...(lease.threadIds || [])]);
  if (input.threadId) threadIds.add(input.threadId);
  const runIds = new Set([...(lease.runIds || [])]);
  if (input.runId) runIds.add(input.runId);

  lease = {
    ...lease,
    path: leasePath,
    executionPath,
    sourceProjectPath,
    repoRoot,
    projectSubdir,
    baseBranch,
    baseCommit,
    threadIds: [...threadIds],
    runIds: [...runIds],
    status: "active",
    lastUsedAt: nowIso(),
    updatedAt: nowIso(),
    createCommand: createCommand || lease.createCommand || null
  };
  await saveWorktreeLease(lease);
  return { lease: publicLease(await hydrateLease(lease)), created };
}

export async function archiveWorktreeLease(leaseId) {
  const leases = await readWorktreeLeases();
  const lease = leases.find((item) => item.id === leaseId);
  if (!lease) {
    throw new Error(`Worktree lease not found: ${leaseId}`);
  }
  const updated = {
    ...lease,
    status: "archived",
    archivedAt: nowIso(),
    updatedAt: nowIso(),
    archiveNote: "Archived in Agent Command Center. Files are retained until an explicit cleanup/removal action is approved."
  };
  await writeWorktreeLeases([updated, ...leases.filter((item) => item.id !== leaseId)]);
  return { lease: publicLease(await hydrateLease(updated)) };
}

function textIncludesAny(text, terms) {
  const lower = String(text || "").toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function titleFromIdea(idea) {
  const firstLine = String(idea || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "New Objective";
  return firstLine
    .replace(/^build\s+/i, "")
    .replace(/^create\s+/i, "")
    .slice(0, 88);
}

function sentenceFromIdea(idea) {
  const text = String(idea || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.endsWith(".") ? text : `${text}.`;
}

function providerConfigured(provider) {
  if (!provider) return false;
  if (["ollama", "lm-studio", "lite-gateway"].includes(provider.id)) return true;
  if (String(provider.kind || "").includes("local")) return true;
  if (!provider.apiKeyEnv) return true;
  return hasEnv(provider.apiKeyEnv);
}

function pickRoute(config, preferredProviderIds, modelNeedles = []) {
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const active = providers.find((provider) => provider.id === config.activeProviderId);
  const preferred = preferredProviderIds
    .map((id) => providers.find((provider) => provider.id === id))
    .filter(Boolean);
  const pool = [...preferred, active, ...providers].filter(Boolean);
  const seen = new Set();
  const deduped = pool.filter((provider) => {
    if (seen.has(provider.id)) return false;
    seen.add(provider.id);
    return true;
  });
  const provider = deduped.find(providerConfigured) || deduped[0] || active || providers[0] || {};
  const models = Array.isArray(provider.models) ? provider.models : [];
  const lowerNeedles = modelNeedles.map((needle) => String(needle).toLowerCase());
  const model = models.find((item) => lowerNeedles.some((needle) => String(item).toLowerCase().includes(needle)))
    || (provider.id === active?.id ? config.activeModel : null)
    || models[0]
    || config.activeModel
    || "default";
  return {
    providerId: provider.id || "unknown",
    providerName: provider.name || provider.id || "Unknown",
    model,
    configured: providerConfigured(provider)
  };
}

function classifyIdea(idea) {
  const lower = String(idea || "").toLowerCase();
  return {
    revenue: textIncludesAny(lower, ["money", "revenue", "stripe", "payment", "subscription", "saas", "sell", "customer", "pricing", "checkout", "invoice"]),
    backtest: textIncludesAny(lower, ["backtest", "trading", "stock", "crypto", "sports", "kalshi", "prediction market", "bet", "odds", "portfolio", "strategy"]),
    automation: textIncludesAny(lower, ["agent", "automation", "scrape", "browser", "workflow", "email", "crm", "lead", "outreach"]),
    app: textIncludesAny(lower, ["app", "platform", "dashboard", "desktop", "website", "client", "tool", "extension"]),
    ai: textIncludesAny(lower, ["ai", "llm", "model", "agent", "swarm", "rag", "context", "prompt"])
  };
}

function buildClarifyingQuestions(idea, flags) {
  const words = String(idea || "").trim().split(/\s+/).filter(Boolean);
  const questions = [];
  const lower = String(idea || "").toLowerCase();
  if (words.length < 18) {
    questions.push("What exact user or business problem should this solve first?");
  }
  if (!textIncludesAny(lower, ["for ", "users", "customers", "creators", "developers", "businesses", "traders", "teams", "students", "agencies"])) {
    questions.push("Who is the first target user, and what are they already paying for or doing manually?");
  }
  if (!flags.revenue) {
    questions.push("How should this make money: subscription, one-time purchase, services, leads, affiliate, usage-based, or internal automation?");
  }
  if (!textIncludesAny(lower, ["success", "metric", "goal", "deliver", "launch", "mvp", "backtest", "stripe", "test"])) {
    questions.push("What would count as a successful first delivery within one focused build cycle?");
  }
  if (flags.backtest && !textIncludesAny(lower, ["data", "historical", "source", "odds", "prices", "csv", "api"])) {
    questions.push("What historical data source or API should the backtest use?");
  }
  return questions.slice(0, 5);
}

function buildAgentPlan(config, flags) {
  const frontier = pickRoute(config, ["zai-glm", "xai", "nvidia-nim", "ollama", "lite-gateway", "kimi", "openrouter", "anthropic", "openai"], ["glm-5.2", "grok-4.3", "grok-4", "qwen3", "nemotron", "gemma4", "kimi-k2.7", "fable", "gpt-5.5"]);
  const cheapCoder = pickRoute(config, ["nvidia-nim", "ollama", "lite-gateway", "lm-studio", "xai", "kimi", "openrouter"], ["qwen3", "gemma4", "nemotron", "coder", "grok-code", "kimi-k2.7", "free"]);
  const reviewer = pickRoute(config, ["xai", "nvidia-nim", "ollama", "zai-glm", "kimi", "anthropic", "openai"], ["grok-4.3", "grok-4", "nemotron", "gemma4", "glm-5.2", "kimi-k2.7", "fable", "gpt-5.5"]);
  const cheapGeneral = pickRoute(config, ["nvidia-nim", "ollama", "lite-gateway", "lm-studio", "xai", "openrouter"], ["qwen", "gemma4", "free", "gpt-oss", "nemotron", "grok-code"]);

  return [
    {
      id: "planner",
      name: "Planner",
      responsibility: "Turn the idea into a scoped technical plan, decide the repo strategy, and maintain the durable objective brief.",
      providerId: frontier.providerId,
      providerName: frontier.providerName,
      model: frontier.model,
      configured: frontier.configured,
      costTier: "premium-controller",
      reason: "Use the strongest available model for product judgment, architecture, and long-context continuity."
    },
    {
      id: "implementer",
      name: "Implementer",
      responsibility: "Make focused code changes in a managed worktree and leave a clean diff.",
      providerId: cheapCoder.providerId,
      providerName: cheapCoder.providerName,
      model: cheapCoder.model,
      configured: cheapCoder.configured,
      costTier: "low-cost-coder",
      reason: "Use a cheaper coding route for most implementation tokens while keeping work isolated."
    },
    {
      id: "reviewer",
      name: "Reviewer",
      responsibility: "Review the diff, call out regressions, missing tests, messy files, and risky assumptions.",
      providerId: reviewer.providerId,
      providerName: reviewer.providerName,
      model: reviewer.model,
      configured: reviewer.configured,
      costTier: "selective-frontier",
      reason: "Use a stronger model only at gates where a mistake would cost more than the review."
    },
    {
      id: "tester",
      name: "Tester",
      responsibility: "Run build checks, smoke tests, and any domain-specific backtests or simulations.",
      providerId: cheapGeneral.providerId,
      providerName: cheapGeneral.providerName,
      model: cheapGeneral.model,
      configured: cheapGeneral.configured,
      costTier: "low-cost-verifier",
      reason: "Use inexpensive routes for repetitive test interpretation and log triage."
    },
    {
      id: "scout",
      name: flags.revenue ? "Revenue Scout" : "Research Scout",
      responsibility: flags.revenue
        ? "Find the fastest monetizable slice, pricing hypothesis, and validation path."
        : "Research constraints, dependencies, and market signals before build work expands.",
      providerId: cheapGeneral.providerId,
      providerName: cheapGeneral.providerName,
      model: cheapGeneral.model,
      configured: cheapGeneral.configured,
      costTier: "cheap-research",
      reason: "Keep exploratory research on a low-cost route."
    }
  ];
}

function buildTaskGraph({ clarityRequired, flags }) {
  const tasks = [
    {
      id: "clarity-gate",
      phase: "intake",
      title: "Resolve the objective brief",
      agentId: "planner",
      status: clarityRequired ? "needs_input" : "planned",
      dependsOn: [],
      acceptanceCriteria: [
        "Target user is named.",
        "First valuable outcome is explicit.",
        "Revenue path or non-revenue purpose is explicit.",
        "Constraints and no-go areas are recorded."
      ],
      workspaceMode: "draft"
    },
    {
      id: "opportunity-scan",
      phase: "strategy",
      title: flags.revenue ? "Validate the money path" : "Validate feasibility and usefulness",
      agentId: "scout",
      status: "planned",
      dependsOn: ["clarity-gate"],
      acceptanceCriteria: flags.revenue
        ? ["Competitor or substitute list exists.", "Pricing hypothesis exists.", "One testable offer is defined."]
        : ["Key dependencies are listed.", "Known blockers are listed.", "The smallest useful deliverable is defined."],
      workspaceMode: "draft"
    },
    {
      id: "repo-survey",
      phase: "engineering",
      title: "Map the repository and select the implementation lane",
      agentId: "planner",
      status: "planned",
      dependsOn: ["clarity-gate"],
      acceptanceCriteria: [
        "Relevant files and entry points are listed.",
        "Existing patterns are identified.",
        "A managed worktree lease is selected for code edits."
      ],
      workspaceMode: "draft"
    },
    {
      id: "mvp-build",
      phase: "engineering",
      title: "Build the smallest shippable slice",
      agentId: "implementer",
      status: "planned",
      dependsOn: ["repo-survey", "opportunity-scan"],
      acceptanceCriteria: [
        "Code changes are isolated in a managed worktree.",
        "No unrelated refactors or broad cleanup are mixed into the feature.",
        "User-facing behavior is demonstrable."
      ],
      workspaceMode: "worktree"
    },
    {
      id: "evaluation",
      phase: "verification",
      title: flags.backtest ? "Backtest and verify results" : "Run checks and smoke tests",
      agentId: "tester",
      status: "planned",
      dependsOn: ["mvp-build"],
      acceptanceCriteria: flags.backtest
        ? ["Historical assumptions are documented.", "Backtest output includes pass/fail metrics.", "Risk and overfitting notes are recorded."]
        : ["Build or lint command passes where available.", "Primary workflow smoke test is captured.", "Failures are converted into follow-up tasks."],
      workspaceMode: "worktree"
    },
    {
      id: "cleanup-review",
      phase: "review",
      title: "Review diff, cleanup, and technical debt",
      agentId: "reviewer",
      status: "planned",
      dependsOn: ["evaluation"],
      acceptanceCriteria: [
        "Every new file is intentional.",
        "Temporary artifacts are outside the repo or explicitly approved.",
        "Dead code, duplicate files, and generated clutter are identified.",
        "The merge recommendation is explicit."
      ],
      workspaceMode: "worktree"
    },
    {
      id: "delivery",
      phase: "delivery",
      title: flags.revenue ? "Package, demo, and prepare revenue test" : "Package, demo, and hand off",
      agentId: "planner",
      status: "planned",
      dependsOn: ["cleanup-review"],
      acceptanceCriteria: flags.revenue
        ? ["Demo path is documented.", "Stripe/test payment path is defined if needed.", "Launch checklist includes next revenue experiment."]
        : ["Demo path is documented.", "Known limitations are listed.", "Next best tasks are ranked."],
      workspaceMode: "draft"
    }
  ];
  return tasks;
}

function buildEvalPlan(flags) {
  const evals = [
    {
      id: "build-check",
      name: "Build and static checks",
      type: "engineering",
      command: "Detect project package manager, then run the smallest available build/lint/test command.",
      status: "planned",
      reason: "Catch integration failures before review."
    },
    {
      id: "browser-smoke",
      name: "Primary workflow smoke test",
      type: "product",
      command: "Open the app or demo surface and verify the key workflow manually or with browser automation.",
      status: "planned",
      reason: "Confirm the product behavior, not just code correctness."
    },
    {
      id: "cleanup-audit",
      name: "Repository hygiene audit",
      type: "quality",
      command: "Inspect git status, untracked files, temp files, duplicate files, and generated artifacts before merge.",
      status: "planned",
      reason: "Prevent long-run agents from leaving messy project folders."
    }
  ];

  if (flags.backtest) {
    evals.splice(1, 0, {
      id: "historical-backtest",
      name: "Historical backtest",
      type: "backtest",
      command: "Run the strategy against historical data, record assumptions, hit rate, drawdown, sample size, and failure cases.",
      status: "planned",
      reason: "Money systems need evidence before launch or automation."
    });
  }

  if (flags.revenue) {
    evals.push({
      id: "stripe-sandbox",
      name: "Stripe sandbox payment path",
      type: "revenue",
      command: "Use Stripe test mode to verify checkout, webhook receipt, fulfillment trigger, and failure handling.",
      status: "planned",
      reason: "Revenue features are not done until money movement is tested safely."
    });
  }

  if (flags.ai) {
    evals.push({
      id: "model-review",
      name: "Model-vs-model review",
      type: "ai-review",
      command: "Ask a separate reviewer route to critique the plan, diff, tests, and hidden assumptions.",
      status: "planned",
      reason: "Use model disagreement to catch blind spots before delivery."
    });
  }

  return evals;
}

function taskComplete(task) {
  return ["complete", "changes_applied", "merged"].includes(task?.status);
}

function buildGoalLedgerForObjective(objective, createdAt = nowIso()) {
  const tasks = objective.taskGraph || [];
  const agents = objective.agents || [];
  const objectiveText = objective.spec?.objective || objective.idea || objective.title;
  const selfGoal = objective.goalLedger?.selfGoal || {
    id: "self-goal",
    ownerAgentId: "main-llm",
    ownerName: "Command Center",
    title: `Commander goal: ${objective.title}`,
    command: `/goal ${objectiveText}`,
    objective: objectiveText,
    successCriteria: [
      "Maintain the durable objective brief.",
      "Delegate scoped /goal commands to every deployed agent.",
      "Compare agent work against acceptance criteria and review findings.",
      "Convert discrepancies into explicit rework tasks before delivery."
    ],
    status: "active",
    createdAt
  };

  const existingAgentGoals = new Map((objective.goalLedger?.agentGoals || []).map((goal) => [goal.ownerAgentId, goal]));
  const agentGoals = agents.map((agent) => {
    const assignedTasks = tasks.filter((task) => task.agentId === agent.id);
    const existing = existingAgentGoals.get(agent.id) || {};
    const taskList = assignedTasks.map((task) => task.title).join("; ") || "Support the objective when called.";
    return {
      id: existing.id || `agent-goal-${agent.id}`,
      ownerAgentId: agent.id,
      ownerName: agent.name,
      title: existing.title || `${agent.name} goal`,
      command: existing.command || `/goal As ${agent.name}, ${agent.responsibility} Objective: ${objectiveText}`,
      objective: existing.objective || agent.responsibility,
      assignedTasks: assignedTasks.map((task) => task.id),
      taskSummary: taskList,
      successCriteria: existing.successCriteria || [
        "Own only the assigned task lane.",
        "Report blockers, assumptions, and cleanup risks.",
        "Produce evidence that acceptance criteria were met.",
        "Hand off discrepancies in a format that can become rework."
      ],
      status: existing.status || "planned",
      createdAt: existing.createdAt || createdAt
    };
  });

  return {
    policy: "The commander writes a self /goal, every deployed agent receives a scoped /goal, and reviewer/tester discrepancies become rework before delivery.",
    selfGoal,
    agentGoals
  };
}

function goalStatusForAgent(goal, objective) {
  const tasks = (objective.taskGraph || []).filter((task) => (goal.assignedTasks || []).includes(task.id));
  const openDiscrepancy = (objective.reviewBoard?.discrepancies || []).some((item) => (
    item.status === "open" && item.ownerAgentId === goal.ownerAgentId
  ));
  if (openDiscrepancy) return "needs_rework";
  if (!tasks.length) return goal.status || "planned";
  if (tasks.some((task) => ["starting", "running"].includes(task.status))) return "running";
  if (tasks.some((task) => task.status === "needs_attention")) return "needs_attention";
  if (tasks.every(taskComplete)) return "complete";
  if (tasks.some(taskComplete)) return "in_progress";
  return goal.status || "planned";
}

function withObjectiveRuntimeState(objective) {
  if (!objective) return null;
  const goalLedger = buildGoalLedgerForObjective(objective, objective.createdAt || nowIso());
  const selfStatus = ["ready_for_delivery", "complete"].includes(objective.status)
    ? "complete"
    : ["running", "in_progress"].includes(objective.status) ? "running"
      : objective.status === "needs_attention" ? "needs_attention"
        : "active";
  const nextObjective = {
    ...objective,
    goalLedger: {
      ...goalLedger,
      selfGoal: {
        ...goalLedger.selfGoal,
        status: selfStatus
      },
      agentGoals: goalLedger.agentGoals.map((goal) => ({
        ...goal,
        status: goalStatusForAgent(goal, objective)
      }))
    },
    reviewBoard: {
      protocol: [
        "Reviewer and tester agents compare the work against the objective, assigned /goal, diff, tests, and cleanup policy.",
        "Every disagreement, regression risk, missing test, messy file, or unresolved blocker is written as a discrepancy.",
        "Open discrepancies are converted into planned rework tasks owned by the most appropriate agent."
      ],
      discrepancies: objective.reviewBoard?.discrepancies || [],
      reworkTasks: objective.reviewBoard?.reworkTasks || []
    }
  };
  return nextObjective;
}

function reviewTextFromRun(run) {
  return (run?.steps || [])
    .flatMap((step) => [
      `${step.name || step.id}: ${step.status || "unknown"}`,
      step.output,
      step.error
    ])
    .filter(Boolean)
    .join("\n");
}

function parseReviewDiscrepancies({ objective, task, run }) {
  const text = reviewTextFromRun(run);
  if (!text.trim()) return [];
  if (/\b(no|none|zero)\s+(open\s+)?(discrepanc|issues?|findings?|blockers?|regressions?)/i.test(text)) {
    return [];
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .filter((line) => line && !/^discrepanc(?:y|ies)\s*:?$/i.test(line));
  const issueLines = lines.filter((line) => (
    /\b(discrepanc|issue|risk|missing|fail|failed|failure|blocker|regression|cleanup|debt|unresolved|rework|bug)\b/i.test(line)
    && !/\b(no|none|zero)\s+(discrepanc|issues?|findings?|blockers?)/i.test(line)
  )).slice(0, 8);

  return issueLines.map((line, index) => {
    const severityMatch = line.match(/\[(critical|high|medium|low|p[0-3])\]/i);
    const severity = severityMatch ? severityMatch[1].toLowerCase() : /critical|regression|security|data loss/i.test(line)
      ? "high"
      : /missing|failed|blocker/i.test(line) ? "medium" : "low";
    const ownerMatch = line.match(/\bowner\s*=\s*([a-z0-9_-]+)/i);
    const ownerAgentId = ownerMatch?.[1] || (task.agentId === "tester" ? "implementer" : "implementer");
    const protocolMatch = line.match(/::\s*([\s\S]*?)(?:\s+->\s+|\s+=>\s+)([\s\S]*)$/);
    const split = line.split(/\s+->\s+|\s+=>\s+|::/);
    const rawTitle = protocolMatch?.[1] || split[0] || line;
    const rawRework = protocolMatch?.[2] || split.slice(1).join(" -> ");
    const title = rawTitle
      .replace(/\[(critical|high|medium|low|p[0-3])\]/ig, "")
      .replace(/\bowner\s*=\s*[a-z0-9_-]+/ig, "")
      .trim()
      .slice(0, 120);
    const suggestedRework = (rawRework || `Resolve this finding and re-run the relevant checks for ${task.title}.`).slice(0, 260);
    const fingerprint = crypto.createHash("sha1").update(`${objective.id}:${task.id}:${run.id}:${line}`).digest("hex").slice(0, 10);
    return {
      id: `disc_${fingerprint}`,
      status: "open",
      severity,
      title: title || `Review finding ${index + 1}`,
      evidence: line,
      suggestedRework,
      ownerAgentId,
      sourceTaskId: task.id,
      sourceRunId: run.id,
      reviewerAgentId: task.agentId,
      createdAt: nowIso()
    };
  });
}

function reworkTaskForDiscrepancy(discrepancy) {
  return {
    id: `rework-${discrepancy.id}`,
    phase: "rework",
    title: `Rework: ${discrepancy.title}`,
    agentId: discrepancy.ownerAgentId || "implementer",
    status: "planned",
    dependsOn: [discrepancy.sourceTaskId].filter(Boolean),
    acceptanceCriteria: [
      discrepancy.suggestedRework,
      "The discrepancy is explicitly addressed.",
      "Reviewer/tester evidence is updated after the fix.",
      "No unrelated cleanup or broad refactor is mixed into this rework."
    ],
    workspaceMode: "worktree",
    discrepancyId: discrepancy.id
  };
}

function buildObjectivePlan({ idea, project, threadId, projectId, config }) {
  const flags = classifyIdea(idea);
  const questions = buildClarifyingQuestions(idea, flags);
  const clarityRequired = questions.length > 0;
  const title = titleFromIdea(idea);
  const now = nowIso();
  const objectiveSentence = sentenceFromIdea(idea);
  const agents = buildAgentPlan(config, flags);
  const taskGraph = buildTaskGraph({ clarityRequired, flags });
  const evalPlan = buildEvalPlan(flags);
  const revenueModel = flags.revenue
    ? "Start with the smallest paid validation path, then wire Stripe test mode before any live money flow."
    : "Revenue path is not specified yet; clarify before building paid features.";

  return {
    id: makeId("objective"),
    threadId: threadId || null,
    projectId: projectId || project?.id || null,
    projectPath: project?.path || null,
    title,
    idea,
    status: clarityRequired ? "needs_clarity" : "planned",
    clarity: {
      required: clarityRequired,
      questions,
      assumptions: [
        "Use managed worktrees for code edits by default.",
        "Prefer low-cost or free model routes for repetitive work.",
        "Use frontier models only for planning, arbitration, and final review.",
        "Ask before paid API-heavy runs, destructive cleanup, deployment, or live payment changes."
      ]
    },
    spec: {
      objective: objectiveSentence || `Build ${title}.`,
      targetUsers: "To be confirmed in the clarity gate.",
      revenueModel,
      constraints: [
        `Project folder: ${project?.path || "not selected"}`,
        "Keep run artifacts outside the source repo unless intentionally promoted.",
        "No broad deletes or repository cleanup without explicit approval.",
        "Every long run must end with tests, cleanup findings, and delivery notes."
      ],
      successCriteria: [
        "A working MVP slice exists or the blocker is explicit.",
        "The system records what changed, what was tested, and what remains.",
        "A reviewer model checks the result before merge or delivery.",
        flags.revenue ? "A Stripe sandbox or comparable revenue validation path is documented." : "A next-step value test is documented."
      ],
      risks: [
        "Scope can expand faster than the context budget unless milestones stay small.",
        "Direct provider APIs may change model availability, pricing, or rate limits.",
        "Agent-generated clutter can accumulate unless every run includes cleanup review.",
        flags.backtest ? "Backtests can overfit or rely on weak historical data." : null,
        flags.revenue ? "Payment and customer data flows must stay in test mode until reviewed." : null
      ].filter(Boolean)
    },
    agents,
    taskGraph,
    evalPlan,
    goalLedger: buildGoalLedgerForObjective({
      title,
      idea,
      spec: { objective: objectiveSentence || `Build ${title}.` },
      agents,
      taskGraph,
      createdAt: now
    }, now),
    reviewBoard: {
      protocol: [
        "Main LLM writes and maintains the commander /goal.",
        "Each deployed agent receives a scoped /goal before work begins.",
        "Reviewer/tester agents document discrepancies as evidence-backed rework items.",
        "Open discrepancies block clean delivery until rework is planned or explicitly waived."
      ],
      discrepancies: [],
      reworkTasks: []
    },
    delivery: {
      checklist: [
        "Objective brief is current.",
        "Agent roles and model routes are selected.",
        "Worktree lease is active for code edits.",
        "Tests/evals are run or blockers are recorded.",
        "Cleanup report is reviewed.",
        "Demo, launch, or handoff notes are written."
      ],
      artifacts: [],
      definitionOfDone: [
        "User can run or inspect the delivered system.",
        "The repo is cleaner or at least no messier than the starting state.",
        "The next money-making or validation experiment is clear."
      ]
    },
    contextPolicy: {
      strategy: "durable objective brief + active goal + active loop + last 16 turns + project metadata",
      checkpointEveryIterations: 1,
      handoffRequires: ["objective", "decisions", "changed files", "tests", "cleanup findings", "next actions"],
      maxRecentMessages: 16,
      memoryRule: "Update durable summaries at each loop boundary so new model calls do not depend only on chat history."
    },
    createdAt: now,
    updatedAt: now
  };
}

function objectiveLoopInstruction(objective) {
  const objectiveState = withObjectiveRuntimeState(objective);
  const tasks = (objective.taskGraph || [])
    .map((task) => `- [${task.status}] ${task.title}: ${(task.acceptanceCriteria || []).join("; ")}`)
    .join("\n");
  const evals = (objective.evalPlan || [])
    .map((item) => `- ${item.name}: ${item.command}`)
    .join("\n");
  const goals = [
    `Commander: ${objectiveState.goalLedger?.selfGoal?.command}`,
    ...(objectiveState.goalLedger?.agentGoals || []).map((goal) => `${goal.ownerName}: ${goal.command}`)
  ].filter(Boolean).join("\n");
  return [
    "Operate as the Agent Command Center objective loop.",
    "Do not drift from the objective brief. Ask for clarification if a gate is blocked.",
    "Use managed worktrees for code edits. Keep artifacts outside the source repo unless intentionally promoted.",
    "Every iteration must advance one task, run or define verification, and report cleanup risks.",
    "Maintain the commander /goal, assign each agent its scoped /goal, and convert review discrepancies into rework tasks.",
    "",
    `Objective: ${objective.spec?.objective || objective.idea}`,
    "",
    "Goal ledger:",
    goals || "No delegated goals recorded yet.",
    "",
    "Task graph:",
    tasks || "- No tasks recorded.",
    "",
    "Evaluation plan:",
    evals || "- No evals recorded.",
    "",
    "Review protocol:",
    (objectiveState.reviewBoard?.protocol || []).map((item) => `- ${item}`).join("\n"),
    "",
    "Delivery definition:",
    (objective.delivery?.definitionOfDone || []).map((item) => `- ${item}`).join("\n")
  ].join("\n");
}

export async function listObjectives(input = {}) {
  const objectives = await readObjectives();
  const filtered = objectives.filter((objective) => {
    if (input.threadId && objective.threadId !== input.threadId) return false;
    if (input.projectId && objective.projectId !== input.projectId) return false;
    if (input.status && objective.status !== input.status) return false;
    return true;
  });
  return { objectives: filtered.map(publicObjective) };
}

export async function getObjective(objectiveId) {
  const objective = (await readObjectives()).find((item) => item.id === objectiveId);
  return { objective: publicObjective(objective) };
}

export async function planObjective(input = {}) {
  const idea = String(input.idea || input.objective || "").trim();
  if (!idea) {
    throw new Error("Objective idea is required.");
  }

  const [projects, config] = await Promise.all([readProjects(), readConfig()]);
  let project = null;
  if (input.projectPath) {
    const resolved = path.resolve(String(input.projectPath));
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`Select a valid project folder before planning: ${resolved}`);
    }
    project = projects.find((item) => path.resolve(item.path).toLowerCase() === resolved.toLowerCase())
      || { id: input.projectId || null, name: stableProjectName(resolved), path: resolved };
  } else if (input.projectId) {
    project = projects.find((item) => item.id === input.projectId) || null;
  } else {
    project = projects[0] || null;
  }

  if (!project?.path) {
    throw new Error("Select a project folder before planning an objective.");
  }

  const objective = buildObjectivePlan({
    idea,
    project,
    threadId: input.threadId,
    projectId: input.projectId || project.id,
    config
  });
  const objectives = await readObjectives();
  await writeObjectives([objective, ...objectives.filter((item) => item.id !== objective.id)].slice(0, 100));
  return { objective: publicObjective(objective) };
}

export async function startObjectiveLoop(input = {}) {
  const objectiveId = String(input.objectiveId || "").trim();
  if (!objectiveId) {
    throw new Error("Objective id is required.");
  }
  const objectives = await readObjectives();
  const objective = objectives.find((item) => item.id === objectiveId);
  if (!objective) {
    throw new Error(`Objective not found: ${objectiveId}`);
  }
  if (objective.status === "needs_clarity" && input.force !== true) {
    throw new Error("This objective still needs clarity. Answer the clarity questions or re-plan with more detail before starting a loop.");
  }

  const startedAt = nowIso();
  const { goal, loop } = await startGoalLoop({
    threadId: objective.threadId,
    projectId: objective.projectId,
    projectPath: objective.projectPath,
    title: objective.title,
    objective: objective.spec?.objective || objective.idea,
    instruction: objectiveLoopInstruction(objective),
    maxIterations: input.maxIterations || 4,
    workspaceMode: input.workspaceMode || "worktree",
    roles: ["planner", "implementer", "reviewer", "tester"]
  });

  const updated = {
    ...objective,
    status: "running",
    goalId: goal.id,
    loopId: loop.id,
    startedAt,
    updatedAt: nowIso()
  };
  await writeObjectives([updated, ...objectives.filter((item) => item.id !== objective.id)]);
  return { objective: publicObjective(updated), goal: publicGoal(goal), loop: publicLoop(loop) };
}

export async function resolveObjectiveClarity(input = {}) {
  const objectiveId = String(input.objectiveId || "").trim();
  const answers = String(input.answers || "").trim();
  if (!objectiveId) {
    throw new Error("Objective id is required.");
  }
  if (!answers) {
    throw new Error("Clarity answers are required.");
  }

  const objectives = await readObjectives();
  const objective = objectives.find((item) => item.id === objectiveId);
  if (!objective) {
    throw new Error(`Objective not found: ${objectiveId}`);
  }

  const updated = {
    ...objective,
    status: "planned",
    clarity: {
      ...(objective.clarity || {}),
      required: false,
      answeredAt: nowIso(),
      answers
    },
    taskGraph: (objective.taskGraph || []).map((task) => (
      task.id === "clarity-gate"
        ? { ...task, status: "complete", output: answers, updatedAt: nowIso() }
        : task
    )),
    updatedAt: nowIso()
  };
  await writeObjectives([updated, ...objectives.filter((item) => item.id !== objective.id)]);
  return { objective: publicObjective(updated) };
}

export async function listGoals(input = {}) {
  const goals = await readGoals();
  const filtered = goals.filter((goal) => {
    if (input.threadId && goal.threadId !== input.threadId) return false;
    if (input.projectId && goal.projectId !== input.projectId) return false;
    if (input.status && goal.status !== input.status) return false;
    return true;
  });
  return { goals: filtered.map(publicGoal) };
}

export async function createGoal(input = {}) {
  const objective = String(input.objective || "").trim();
  if (!objective) {
    throw new Error("Goal objective is required.");
  }

  const goals = await readGoals();
  const threadId = input.threadId || null;
  const now = nowIso();
  const nextGoals = goals.map((goal) => (
    threadId && goal.threadId === threadId && goal.status === "active"
      ? { ...goal, status: "superseded", supersededAt: now, updatedAt: now }
      : goal
  ));
  const goal = {
    id: makeId("goal"),
    threadId,
    projectId: input.projectId || null,
    projectPath: input.projectPath || null,
    objective,
    title: String(input.title || objective).trim().slice(0, 120),
    mode: input.mode || "goal",
    status: "active",
    loopCount: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeGoals([goal, ...nextGoals].slice(0, 100));
  return { goal: publicGoal(goal) };
}

export async function listLoops(input = {}) {
  const loops = await readLoops();
  const filtered = loops.filter((loop) => {
    if (input.threadId && loop.threadId !== input.threadId) return false;
    if (input.goalId && loop.goalId !== input.goalId) return false;
    if (input.status && loop.status !== input.status) return false;
    return true;
  });
  return { loops: filtered.map(publicLoop) };
}

export async function getLoop(loopId) {
  const loop = liveLoops.get(loopId) || (await readLoops()).find((item) => item.id === loopId);
  return { loop: publicLoop(loop) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunTerminal(runId, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { run } = await getAgentRun(runId);
    if (!run || ["complete", "failed", "needs_attention"].includes(run.status)) {
      return run;
    }
    await sleep(2000);
  }
  return (await getAgentRun(runId)).run;
}

function summarizeRunForLoop(run) {
  if (!run) return "Run did not return a final state.";
  const failed = run.steps?.filter((step) => step.status === "failed").map((step) => `${step.name}: ${step.error}`).join("; ");
  const completed = run.steps?.filter((step) => step.status === "complete").map((step) => step.name).join(", ");
  if (failed) return `Run ${run.status}. Failures: ${failed}`;
  return `Run ${run.status}. Completed: ${completed || "none"}.`;
}

async function runGoalLoop(loop) {
  try {
    let current = await updateLoop(loop.id, { status: "running", startedAt: nowIso() });
    let priorResult = "No previous iteration.";

    for (let index = 1; index <= current.maxIterations; index += 1) {
      current = liveLoops.get(loop.id) || current;
      if (["stopping", "stopped", "failed", "complete"].includes(current.status)) break;

      const iteration = {
        index,
        status: "running",
        startedAt: nowIso(),
        runId: null,
        summary: null
      };
      const iterations = [...(current.iterations || []).filter((item) => item.index !== index), iteration];
      current = await updateLoop(loop.id, { currentIteration: index, iterations });

      const runPrompt = [
        `/loop iteration ${index}/${current.maxIterations}`,
        `Goal: ${current.objective}`,
        `Loop instruction: ${current.instruction}`,
        `Previous iteration result: ${priorResult}`,
        "",
        "Make measurable progress. Keep changes scoped. Preserve project hygiene. Report exactly what changed or what blocked progress."
      ].join("\n");

      const { run } = await startAgentRun({
        threadId: current.threadId,
        title: `${current.title} - loop ${index}`,
        prompt: runPrompt,
        projectPath: current.projectPath,
        mode: current.agentMode,
        workspaceMode: current.workspaceMode,
        roles: current.roles
      });

      current = liveLoops.get(loop.id) || current;
      current = await updateLoop(loop.id, {
        iterations: (current.iterations || []).map((item) => (
          item.index === index ? { ...item, runId: run.id } : item
        ))
      });

      const finalRun = await waitForRunTerminal(run.id);
      priorResult = summarizeRunForLoop(finalRun);
      current = liveLoops.get(loop.id) || current;
      const terminalStatus = finalRun?.status === "complete" ? "complete" : "needs_attention";
      current = await updateLoop(loop.id, {
        iterations: (current.iterations || []).map((item) => (
          item.index === index
            ? { ...item, status: terminalStatus, finishedAt: nowIso(), runStatus: finalRun?.status || "unknown", summary: priorResult }
            : item
        ))
      });

      if (terminalStatus !== "complete") {
        await updateLoop(loop.id, { status: "needs_attention", finishedAt: nowIso(), summary: priorResult });
        return;
      }
    }

    current = liveLoops.get(loop.id) || current;
    await updateLoop(loop.id, {
      status: "complete",
      finishedAt: nowIso(),
      summary: priorResult
    });
  } catch (error) {
    await updateLoop(loop.id, {
      status: "failed",
      error: error.message,
      finishedAt: nowIso()
    });
  }
}

export async function startGoalLoop(input = {}) {
  const threadId = input.threadId || null;
  const existingGoal = input.goalId
    ? (await readGoals()).find((goal) => goal.id === input.goalId)
    : threadId ? await activeGoalForThread(threadId) : null;
  const objective = String(input.objective || existingGoal?.objective || "").trim();
  if (!objective) {
    throw new Error("Create a /goal first, or provide an objective after /loop.");
  }

  const projectPath = path.resolve(String(input.projectPath || existingGoal?.projectPath || "").trim());
  const stat = await fs.stat(projectPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Select a valid project folder before starting a loop: ${projectPath}`);
  }

  let goal = existingGoal;
  if (!goal) {
    goal = (await createGoal({
      threadId,
      projectId: input.projectId,
      projectPath,
      objective,
      title: input.title || objective,
      mode: "loop"
    })).goal;
  }

  const maxIterations = Math.max(1, Math.min(12, Number(input.maxIterations || 3)));
  const loop = {
    id: makeId("loop"),
    goalId: goal.id,
    threadId,
    projectId: input.projectId || goal.projectId || null,
    projectPath,
    title: String(input.title || goal.title || objective).trim().slice(0, 120),
    objective,
    instruction: String(input.instruction || "Continue until the goal is materially advanced, then stop with a concise report.").trim(),
    maxIterations,
    currentIteration: 0,
    agentMode: input.agentMode || input.mode || "swarm",
    workspaceMode: input.workspaceMode || "worktree",
    roles: Array.isArray(input.roles) && input.roles.length ? input.roles : ["planner", "implementer", "reviewer", "tester"],
    status: "queued",
    iterations: [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await saveLoop(loop);
  const goals = await readGoals();
  await writeGoals(goals.map((item) => (
    item.id === goal.id ? { ...item, loopCount: (item.loopCount || 0) + 1, updatedAt: nowIso() } : item
  )));
  runGoalLoop(loop);
  return { loop: publicLoop(loop), goal: publicGoal(goal) };
}

function completeTaskStatuses() {
  return new Set(["complete", "changes_applied", "merged"]);
}

function taskIsComplete(task) {
  return completeTaskStatuses().has(task?.status);
}

function deriveObjectiveStatus(objective) {
  const tasks = objective.taskGraph || [];
  if (objective.clarity?.required && tasks.some((task) => task.id === "clarity-gate" && task.status === "needs_input")) {
    return "needs_clarity";
  }
  if (tasks.some((task) => ["starting", "running"].includes(task.status))) {
    return "running";
  }
  if (tasks.some((task) => task.status === "needs_attention")) {
    return "needs_attention";
  }
  if (tasks.length && tasks.every(taskIsComplete)) {
    return "ready_for_delivery";
  }
  if (tasks.some(taskIsComplete)) {
    return "in_progress";
  }
  return objective.status === "needs_clarity" ? "needs_clarity" : "planned";
}

async function saveObjective(objective) {
  const objectives = await readObjectives();
  const updated = { ...objective, status: deriveObjectiveStatus(objective), updatedAt: nowIso() };
  await writeObjectives([updated, ...objectives.filter((item) => item.id !== updated.id)].slice(0, 100));
  return updated;
}

async function updateObjectiveTask(objectiveId, taskId, updater) {
  const objectives = await readObjectives();
  const objective = objectives.find((item) => item.id === objectiveId);
  if (!objective) {
    throw new Error(`Objective not found: ${objectiveId}`);
  }
  const task = objective.taskGraph?.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const nextTask = typeof updater === "function" ? updater(task, objective) : { ...task, ...updater };
  const nextObjective = {
    ...objective,
    taskGraph: objective.taskGraph.map((item) => item.id === taskId ? nextTask : item)
  };
  return saveObjective(nextObjective);
}

function blockingDependencies(objective, task) {
  const tasks = objective.taskGraph || [];
  return (task.dependsOn || []).filter((dependencyId) => {
    const dependency = tasks.find((item) => item.id === dependencyId);
    return !taskIsComplete(dependency);
  });
}

function nextRunnableTask(objective) {
  return (objective.taskGraph || []).find((task) => (
    !["complete", "changes_applied", "merged", "running", "starting", "needs_input"].includes(task.status)
    && blockingDependencies(objective, task).length === 0
  ));
}

function roleIdsForObjectiveTask(task) {
  if (task.agentId === "implementer") return ["implementer"];
  if (task.agentId === "reviewer") return ["reviewer"];
  if (task.agentId === "tester") return ["tester"];
  return ["planner"];
}

function buildObjectiveTaskPrompt(objective, task) {
  const objectiveState = withObjectiveRuntimeState(objective);
  const assignedGoal = objectiveState.goalLedger?.agentGoals?.find((goal) => goal.ownerAgentId === task.agentId);
  const dependencies = (task.dependsOn || []).join(", ") || "none";
  const criteria = (task.acceptanceCriteria || []).map((item) => `- ${item}`).join("\n") || "- No criteria recorded.";
  const evals = (objectiveState.evalPlan || [])
    .map((item) => `- ${item.name}: ${item.command}`)
    .join("\n");
  const openDiscrepancies = (objectiveState.reviewBoard?.discrepancies || [])
    .filter((item) => item.status === "open" && (!item.ownerAgentId || item.ownerAgentId === task.agentId || task.agentId === "reviewer"))
    .map((item) => `- [${item.severity}] ${item.title}: ${item.suggestedRework}`)
    .join("\n");
  const patchGuidance = task.agentId === "implementer"
    ? [
        "",
        "Patch candidate protocol:",
        "- If you have enough information to implement, return a unified git diff in a fenced ```diff block.",
        "- Keep the diff narrow and inside the selected worktree.",
        "- Do not include broad file deletion, generated junk, secrets, or unrelated refactors.",
        "- If you need more file contents, say exactly which files to inspect instead of inventing a patch."
      ].join("\n")
    : "";
  const reviewProtocol = ["reviewer", "tester"].includes(task.agentId)
    ? [
        "",
        "Discrepancy protocol:",
        "- Compare work against the commander /goal, your agent /goal, task acceptance criteria, diff, tests, and cleanup policy.",
        "- If problems exist, include a DISCREPANCIES section using this format:",
        "- [high|medium|low] owner=implementer :: concise finding -> concrete rework required",
        "- If no problems exist, write: DISCREPANCIES: none.",
        "- Discrepancies should become rework tasks, so make them specific enough to assign."
      ].join("\n")
    : "";

  return [
    `Objective: ${objectiveState.spec?.objective || objectiveState.idea}`,
    `Objective status: ${objectiveState.status}`,
    `Commander /goal: ${objectiveState.goalLedger?.selfGoal?.command || `/goal ${objectiveState.spec?.objective || objectiveState.idea}`}`,
    `Your assigned /goal: ${assignedGoal?.command || `/goal Own the ${task.agentId} lane for this objective.`}`,
    `Task id: ${task.id}`,
    `Task title: ${task.title}`,
    `Phase: ${task.phase}`,
    `Agent lane: ${task.agentId}`,
    `Dependencies: ${dependencies}`,
    "",
    "Acceptance criteria:",
    criteria,
    "",
    "Open discrepancies assigned to this lane:",
    openDiscrepancies || "- None.",
    "",
    "Evaluation plan:",
    evals || "- No objective eval plan recorded.",
    "",
    "Repository hygiene rules:",
    "- Keep generated notes and scratch artifacts in Agent Command Center run artifacts unless they belong in source.",
    "- Every new file must be justified.",
    "- Call out cleanup candidates and technical debt before delivery.",
    "- Do not claim commands were run unless the runner output proves it.",
    patchGuidance,
    reviewProtocol
  ].filter(Boolean).join("\n");
}

function flattenRunPatches(run) {
  return (run?.steps || []).flatMap((step) => (
    (step.patches || []).map((patch) => ({
      ...patch,
      stepId: step.id,
      stepName: step.name
    }))
  ));
}

async function taskRunDiffStat(run) {
  if (!run?.worktreeExecutionPath && !run?.projectPath) return null;
  const target = run.worktreeExecutionPath || run.projectPath;
  const diffStat = await runCommand("git", ["-C", target, "diff", "--stat"], { timeoutMs: 12000 });
  return (diffStat.stdout || diffStat.stderr || "").trim();
}

async function monitorObjectiveTask(objectiveId, taskId, runId) {
  try {
    const finalRun = await waitForRunTerminal(runId);
    const runSummary = summarizeRunForLoop(finalRun);
    const patches = flattenRunPatches(finalRun);
    const diffStat = await taskRunDiffStat(finalRun);
    await updateObjectiveTask(objectiveId, taskId, (task) => ({
      ...task,
      status: finalRun?.status === "complete" ? "complete" : "needs_attention",
      runStatus: finalRun?.status || "unknown",
      runSummary,
      patchCandidates: patches,
      artifacts: (finalRun?.steps || []).map((step) => step.artifactPath).filter(Boolean),
      worktreePath: finalRun?.worktreeExecutionPath || finalRun?.worktreePath || null,
      diffStat,
      finishedAt: nowIso()
    }));
    if (["reviewer", "tester"].includes((await readObjectives()).find((item) => item.id === objectiveId)?.taskGraph?.find((item) => item.id === taskId)?.agentId)) {
      await reconcileObjectiveReview({ objectiveId, sourceTaskId: taskId }).catch(() => null);
    }
  } catch (error) {
    await updateObjectiveTask(objectiveId, taskId, (task) => ({
      ...task,
      status: "needs_attention",
      runStatus: "failed",
      runSummary: error.message,
      finishedAt: nowIso()
    }));
  }
}

export async function startObjectiveTask(input = {}) {
  const objectiveId = String(input.objectiveId || "").trim();
  const taskId = String(input.taskId || "").trim();
  if (!objectiveId || !taskId) {
    throw new Error("Objective id and task id are required.");
  }

  const objectives = await readObjectives();
  const objective = objectives.find((item) => item.id === objectiveId);
  if (!objective) {
    throw new Error(`Objective not found: ${objectiveId}`);
  }
  const task = objective.taskGraph?.find((item) => item.id === taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status === "needs_input" && input.force !== true) {
    throw new Error("This task is waiting for clarity input before it can run.");
  }
  if (["starting", "running"].includes(task.status)) {
    throw new Error("This task is already running.");
  }
  const blockedBy = blockingDependencies(objective, task);
  if (blockedBy.length && input.force !== true) {
    throw new Error(`Complete dependencies first: ${blockedBy.join(", ")}`);
  }

  const startingAt = nowIso();
  await updateObjectiveTask(objectiveId, taskId, {
    ...task,
    status: "starting",
    startedAt: startingAt,
    runStatus: "queued",
    runSummary: null
  });

  try {
    const { run } = await startAgentRun({
      threadId: objective.threadId,
      title: `${objective.title} - ${task.title}`,
      prompt: buildObjectiveTaskPrompt(objective, task),
      projectPath: objective.projectPath,
      mode: "solo",
      workspaceMode: task.workspaceMode === "worktree" ? "worktree" : "draft",
      roles: roleIdsForObjectiveTask(task),
      objectiveId,
      objectiveTaskId: taskId,
      patchMode: task.agentId === "implementer" ? "candidate" : "off"
    });
    const updated = await updateObjectiveTask(objectiveId, taskId, (current) => ({
      ...current,
      status: "running",
      runId: run.id,
      runStatus: run.status,
      worktreePath: run.worktreeExecutionPath || run.worktreePath || null,
      startedAt: startingAt
    }));
    monitorObjectiveTask(objectiveId, taskId, run.id);
    return { objective: publicObjective(updated), run: publicRun(run), task: updated.taskGraph.find((item) => item.id === taskId) };
  } catch (error) {
    await updateObjectiveTask(objectiveId, taskId, (current) => ({
      ...current,
      status: "needs_attention",
      runStatus: "failed",
      runSummary: error.message,
      finishedAt: nowIso()
    }));
    throw error;
  }
}

export async function startNextObjectiveTask(input = {}) {
  const objectiveId = String(input.objectiveId || "").trim();
  const objective = (await readObjectives()).find((item) => item.id === objectiveId);
  if (!objective) {
    throw new Error(`Objective not found: ${objectiveId}`);
  }
  const task = nextRunnableTask(objective);
  if (!task) {
    throw new Error("No runnable task is available. Resolve blockers or review completed tasks.");
  }
  return startObjectiveTask({ ...input, taskId: task.id });
}

export async function reconcileObjectiveReview(input = {}) {
  const objectiveId = String(input.objectiveId || "").trim();
  if (!objectiveId) {
    throw new Error("Objective id is required.");
  }
  const objectives = await readObjectives();
  const objective = objectives.find((item) => item.id === objectiveId);
  if (!objective) {
    throw new Error(`Objective not found: ${objectiveId}`);
  }

  const runs = await readAgentRuns();
  const sourceTaskId = String(input.sourceTaskId || "").trim();
  const reviewTasks = (objective.taskGraph || []).filter((task) => (
    ["reviewer", "tester"].includes(task.agentId)
    && task.runId
    && (!sourceTaskId || task.id === sourceTaskId)
  ));
  const existingDiscrepancies = objective.reviewBoard?.discrepancies || [];
  const existingIds = new Set(existingDiscrepancies.map((item) => item.id));
  const newDiscrepancies = reviewTasks.flatMap((task) => {
    const run = liveRuns.get(task.runId) || runs.find((item) => item.id === task.runId);
    if (!run) return [];
    return parseReviewDiscrepancies({ objective, task, run }).filter((item) => !existingIds.has(item.id));
  });

  const existingTaskIds = new Set((objective.taskGraph || []).map((task) => task.id));
  const reworkTasks = newDiscrepancies
    .map(reworkTaskForDiscrepancy)
    .filter((task) => !existingTaskIds.has(task.id));
  const nextReviewBoard = {
    ...(withObjectiveRuntimeState(objective).reviewBoard || {}),
    discrepancies: [...existingDiscrepancies, ...newDiscrepancies],
    reworkTasks: [
      ...(objective.reviewBoard?.reworkTasks || []),
      ...reworkTasks.map((task) => ({
        id: task.id,
        discrepancyId: task.discrepancyId,
        ownerAgentId: task.agentId,
        status: task.status,
        title: task.title,
        createdAt: nowIso()
      }))
    ]
  };
  const updated = await saveObjective({
    ...objective,
    goalLedger: withObjectiveRuntimeState(objective).goalLedger,
    reviewBoard: nextReviewBoard,
    taskGraph: [...(objective.taskGraph || []), ...reworkTasks]
  });
  return {
    objective: publicObjective(updated),
    discrepancies: newDiscrepancies,
    reworkTasks
  };
}

export async function applyObjectiveTaskPatch(input = {}) {
  const objectiveId = String(input.objectiveId || "").trim();
  const taskId = String(input.taskId || "").trim();
  const objectives = await readObjectives();
  const objective = objectives.find((item) => item.id === objectiveId);
  const task = objective?.taskGraph?.find((item) => item.id === taskId);
  if (!objective || !task) {
    throw new Error("Objective task not found.");
  }
  if (!task.runId) {
    throw new Error("This task does not have a run with patch candidates.");
  }

  const { run, patch } = await applyRunPatch({
    runId: task.runId,
    stepId: input.stepId,
    patchIndex: input.patchIndex
  });
  const updated = await updateObjectiveTask(objectiveId, taskId, (current) => ({
    ...current,
    status: "changes_applied",
    runStatus: run.status,
    patchCandidates: (current.patchCandidates || []).map((candidate) => (
      candidate.stepId === patch.stepId && Number(candidate.index) === Number(patch.index)
        ? { ...candidate, ...patch }
        : candidate
    )),
    diffStat: patch.diffStat || run.diffStatAfterPatch || current.diffStat,
    runSummary: "Patch applied to managed worktree. Review the diff before merging.",
    updatedAt: nowIso()
  }));
  return { objective: publicObjective(updated), run, patch };
}

async function listProjectFiles(projectPath, limit = 220) {
  const ignored = new Set([".git", "node_modules", "dist", "build", "release", ".next", "coverage", ".agent-worktrees"]);
  const files = [];
  async function visit(dir, depth) {
    if (files.length >= limit || depth > 4) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= limit || ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(projectPath, full);
      if (entry.isDirectory()) {
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(rel);
      }
    }
  }
  await visit(projectPath, 0);
  return files;
}

function cleanupFindings(statusText, files) {
  const lines = statusText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const untracked = lines.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
  const suspiciousPattern = /(^|[\\/])(tmp|temp|scratch|debug|backup|old|copy|untitled|test-output|output)([\\/.-]|$)|\.(bak|tmp|old|orig|log)$/i;
  const suspicious = [...new Set([...untracked, ...files].filter((file) => suspiciousPattern.test(file)))].slice(0, 80);
  return {
    untrackedCount: untracked.length,
    untracked: untracked.slice(0, 80),
    suspicious,
    recommendation: suspicious.length
      ? "Review these files before merging. Move durable artifacts into docs/tests, delete disposable files only after approval, and keep generated run artifacts in app data."
      : "No obvious scratch/temporary files were detected. Continue storing run artifacts outside the project unless they are intended source files."
  };
}

async function writeRunArtifact(runId, fileName, content) {
  const dir = path.join(runsDir, runId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content);
  return filePath;
}

function artifactMarkdown(title, body) {
  return `# ${title}\n\n${body.trim()}\n`;
}

function looksLikeUnifiedDiff(text) {
  const value = String(text || "").trim();
  return value.includes("diff --git ")
    || (/^---\s+\S+/m.test(value) && /^\+\+\+\s+\S+/m.test(value) && /^@@\s/m.test(value));
}

function extractPatchCandidates(text) {
  const value = String(text || "");
  const candidates = [];
  const fenced = value.matchAll(/```(?:diff|patch)?\s*([\s\S]*?)```/gi);
  for (const match of fenced) {
    const body = String(match[1] || "").trim();
    if (looksLikeUnifiedDiff(body)) {
      candidates.push(body);
    }
  }

  if (candidates.length === 0) {
    const rawStart = value.indexOf("diff --git ");
    if (rawStart >= 0) {
      const raw = value.slice(rawStart).trim();
      if (looksLikeUnifiedDiff(raw)) {
        candidates.push(raw);
      }
    }
  }

  return candidates.slice(0, 5);
}

async function writePatchCandidates(run, step, text) {
  const diffs = extractPatchCandidates(text);
  const patches = [];
  for (const [index, diff] of diffs.entries()) {
    const artifactPath = await writeRunArtifact(run.id, `${step.id}-patch-${index + 1}.diff`, diff.endsWith("\n") ? diff : `${diff}\n`);
    const check = await runCommand("git", ["-C", run.projectPath, "apply", "--check", artifactPath], { timeoutMs: 15000 });
    patches.push({
      index,
      stepId: step.id,
      artifactPath,
      canApply: check.ok,
      applied: false,
      checkCommand: check.command,
      checkOutput: (check.stdout || check.stderr || "").trim(),
      error: check.ok ? null : (check.stderr || check.stdout || "Patch did not pass git apply --check.").trim()
    });
  }
  return patches;
}

async function executeAgentStep({ run, step, prompt }) {
  const startedAt = nowIso();
  await updateAgentRun(run.id, {
    steps: run.steps.map((item) => item.id === step.id ? { ...item, status: "running", startedAt } : item)
  });

  try {
    const result = await callRunModelWithFallbacks(run, prompt);
    const routeLine = `Route: ${result.provider} / ${result.model}`;
    const artifactPath = await writeRunArtifact(run.id, `${step.id}.md`, artifactMarkdown(step.name, `${routeLine}\n\n${result.text || "No text returned."}`));
    const patches = run.patchMode && run.patchMode !== "off"
      ? await writePatchCandidates(run, step, result.text || "")
      : [];
    const updated = liveRuns.get(run.id);
    await updateAgentRun(run.id, {
      steps: updated.steps.map((item) => item.id === step.id ? {
        ...item,
        status: "complete",
        finishedAt: nowIso(),
        providerId: result.provider,
        routedModel: result.model,
        output: result.text || "No text returned.",
        artifactPath,
        patches
      } : item)
    });
  } catch (error) {
    const updated = liveRuns.get(run.id);
    await updateAgentRun(run.id, {
      steps: updated.steps.map((item) => item.id === step.id ? {
        ...item,
        status: "failed",
        finishedAt: nowIso(),
        error: error.message
      } : item)
    });
  }
}

function runModelRoutes(run) {
  const routes = [{ providerId: run.providerId, model: run.model, reason: "selected route" }];
  if (hasEnv("NVIDIA_API_KEY") && run.providerId !== "nvidia-nim") {
    routes.push({
      providerId: "nvidia-nim",
      model: "qwen/qwen3-next-80b-a3b-instruct",
      reason: "free NVIDIA coding fallback"
    });
  }
  if (hasEnv("OPENROUTER_API_KEY") && run.providerId !== "openrouter") {
    routes.push({
      providerId: "openrouter",
      model: "qwen/qwen3-coder-next",
      reason: "low-cost OpenRouter coding fallback"
    });
  }
  return routes;
}

async function callRunModelWithFallbacks(run, prompt) {
  const errors = [];
  for (const route of runModelRoutes(run)) {
    try {
      return await testProvider({
        providerId: route.providerId,
        model: route.model,
        prompt,
        maxTokens: 1400
      });
    } catch (error) {
      errors.push(`${route.providerId}/${route.model}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

function chatRoutes(config) {
  const selectedProvider = config.providers.find((provider) => provider.id === config.activeProviderId);
  const routes = [];
  if (selectedProvider && config.activeModel) {
    routes.push({
      providerId: selectedProvider.id,
      model: config.activeModel,
      reason: "selected chat route"
    });
  }
  const ollama = config.providers.find((provider) => provider.id === "ollama");
  if (ollama && !routes.some((route) => route.providerId === "ollama" && route.model === "gemma4-coder:q8")) {
    routes.push({
      providerId: "ollama",
      model: ollama.models?.includes("gemma4-coder:q8") ? "gemma4-coder:q8" : (ollama.models?.[0] || "gemma4-coder:q8"),
      reason: "private local fallback"
    });
  }
  if (hasEnv("NVIDIA_API_KEY") && !routes.some((route) => route.providerId === "nvidia-nim")) {
    routes.push({
      providerId: "nvidia-nim",
      model: "qwen/qwen3-next-80b-a3b-instruct",
      reason: "free NVIDIA fallback"
    });
  }
  if (hasEnv("XAI_API_KEY") && !routes.some((route) => route.providerId === "xai")) {
    routes.push({
      providerId: "xai",
      model: "grok-4.3",
      reason: "xAI Grok fallback"
    });
  }
  return routes;
}

async function callChatWithFallbacks(config, prompt) {
  const errors = [];
  for (const route of chatRoutes(config)) {
    try {
      const result = await testProvider({
        providerId: route.providerId,
        model: route.model,
        prompt,
        maxTokens: 1200
      });
      return { ...result, routeReason: route.reason, fallbackErrors: errors };
    } catch (error) {
      errors.push(`${route.providerId}/${route.model}: ${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

async function runAgentPipeline(run) {
  try {
    const projectPath = run.projectPath;
    const gitRepo = await isGitRepo(projectPath);
    const gitStatus = gitRepo
      ? await runCommand("git", ["-C", projectPath, "status", "--short", "--untracked-files=all"], { timeoutMs: 12000 })
      : { ok: false, stdout: "", stderr: "Not a git repository." };
    const files = gitRepo
      ? (await runCommand("git", ["-C", projectPath, "ls-files"], { timeoutMs: 12000 })).stdout.split(/\r?\n/).filter(Boolean).slice(0, 220)
      : await listProjectFiles(projectPath);
    const cleanup = cleanupFindings(gitStatus.stdout, files);
    const snapshot = {
      sourceProjectPath: run.sourceProjectPath || projectPath,
      executionPath: projectPath,
      workspaceMode: run.workspaceMode,
      worktreeLeaseId: run.worktreeLeaseId || null,
      worktreePath: run.worktreePath || null,
      gitRepo,
      gitStatus: gitStatus.stdout || gitStatus.stderr,
      files,
      cleanup
    };
    const snapshotPath = await writeRunArtifact(run.id, "project-snapshot.json", JSON.stringify(snapshot, null, 2));
    let current = await updateAgentRun(run.id, {
      status: "running",
      snapshotPath,
      cleanup,
      steps: run.steps.map((step) => step.id === "preflight" ? {
        ...step,
        status: "complete",
        finishedAt: nowIso(),
        output: `Scanned ${files.length} files. Git repo: ${gitRepo ? "yes" : "no"}. Untracked files: ${cleanup.untrackedCount}.`,
        artifactPath: snapshotPath
      } : step)
    });

    const commonContext = [
      `Task: ${run.prompt}`,
      `Source project path: ${run.sourceProjectPath || projectPath}`,
      `Execution path: ${projectPath}`,
      `Mode: ${run.mode}`,
      `Workspace mode: ${run.workspaceMode || "draft"}`,
      run.worktreePath ? `Managed worktree: ${run.worktreePath}` : "",
      `Files sampled:\n${files.slice(0, 140).join("\n")}`,
      `Git status:\n${gitStatus.stdout || gitStatus.stderr}`,
      `Cleanup policy: do not create scratch files in the project root; do not delete files automatically; propose cleanup in cleanup-report.md; keep run artifacts in app data.`
    ].filter(Boolean).join("\n\n");

    const roleSteps = current.steps.filter((step) => step.agentRole);
    for (const step of roleSteps) {
      current = liveRuns.get(run.id);
      const prompt = [
        commonContext,
        "",
        `You are the ${step.name}.`,
        step.instruction,
        "",
        "Return practical output. Include files you would touch, risks, tests, and cleanup/technical-debt notes. Do not invent completed edits."
      ].join("\n");
      await executeAgentStep({ run: current, step, prompt });
    }

    current = liveRuns.get(run.id);
    const cleanupBody = [
      `Source project: ${run.sourceProjectPath || projectPath}`,
      `Execution path: ${projectPath}`,
      `Workspace mode: ${run.workspaceMode || "draft"}`,
      run.worktreePath ? `Managed worktree: ${run.worktreePath}` : "",
      `Git repo: ${gitRepo ? "yes" : "no"}`,
      `Untracked files: ${cleanup.untrackedCount}`,
      "",
      "Suspicious or cleanup-candidate files:",
      cleanup.suspicious.length ? cleanup.suspicious.map((file) => `- ${file}`).join("\n") : "- None detected",
      "",
      "Policy:",
      "- No files were deleted automatically.",
      "- Temporary run artifacts were stored outside the project.",
      "- Before merging or ending a long run, reviewer should confirm every new file is intentional.",
      "",
      `Recommendation: ${cleanup.recommendation}`
    ].filter(Boolean).join("\n");
    const cleanupPath = await writeRunArtifact(run.id, "cleanup-report.md", artifactMarkdown("Cleanup Report", cleanupBody));
    current = await updateAgentRun(run.id, {
      steps: current.steps.map((step) => step.id === "cleanup" ? {
        ...step,
        status: "complete",
        finishedAt: nowIso(),
        output: cleanup.recommendation,
        artifactPath: cleanupPath
      } : step)
    });

    const failed = current.steps.some((step) => step.status === "failed");
    await updateAgentRun(run.id, {
      status: failed ? "needs_attention" : "complete",
      finishedAt: nowIso()
    });
  } catch (error) {
    await updateAgentRun(run.id, {
      status: "failed",
      error: error.message,
      finishedAt: nowIso()
    });
  }
}

export async function startAgentRun(input) {
  const config = await readConfig();
  const sourceProjectPath = path.resolve(String(input?.projectPath ?? "").trim());
  const stat = await fs.stat(sourceProjectPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Select a valid project folder before starting a run: ${sourceProjectPath}`);
  }

  const selectedRoleIds = Array.isArray(input.roles) && input.roles.length ? input.roles : ["planner", "implementer", "reviewer", "tester"];
  const selectedRoles = config.roles.filter((role) => selectedRoleIds.includes(role.id));
  const prompt = String(input?.prompt ?? "").trim() || "Inspect this project and recommend the next implementation step.";
  const workspaceMode = input?.workspaceMode || "draft";
  let executionPath = sourceProjectPath;
  let lease = null;
  const run = {
    id: makeId("run"),
    threadId: input.threadId || null,
    title: String(input?.title ?? "").trim() || prompt.slice(0, 80),
    prompt,
    sourceProjectPath,
    projectPath: sourceProjectPath,
    mode: input?.mode || "swarm",
    workspaceMode,
    objectiveId: input?.objectiveId || null,
    objectiveTaskId: input?.objectiveTaskId || null,
    patchMode: input?.patchMode || "off",
    providerId: config.activeProviderId,
    model: config.activeModel,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: nowIso(),
    cleanupPolicy: "Run artifacts stay in app data. Deletions and broad cleanup require explicit approval.",
    steps: [
      { id: "preflight", name: "Preflight", status: "queued", instruction: "Inspect project state and capture a baseline." },
      ...selectedRoles.map((role) => ({
        id: role.id,
        name: role.name,
        status: "queued",
        agentRole: role.id,
        tool: role.defaultTool,
        model: role.model,
        instruction: role.instruction
      })),
      { id: "cleanup", name: "Cleanup Steward", status: "queued", instruction: "Identify clutter, generated files, untracked files, and technical-debt risks." }
    ]
  };

  if (workspaceMode === "worktree") {
    const result = await ensureWorktreeLease({
      projectPath: sourceProjectPath,
      threadId: input.threadId,
      title: run.title,
      prompt,
      runId: run.id
    });
    lease = result.lease;
    executionPath = lease.executionPath || lease.path;
    run.projectPath = executionPath;
    run.worktreeLeaseId = lease.id;
    run.worktreePath = lease.path;
    run.worktreeExecutionPath = executionPath;
    run.worktreeCreated = result.created;
    run.cleanupPolicy = "Managed worktree run. Source project is untouched until you review and approve a diff/merge. Worktree cleanup is archived, not deleted, unless explicitly approved.";
  } else if (workspaceMode === "local") {
    run.cleanupPolicy = "Direct local run. Use only for trusted edits; destructive cleanup remains approval-gated.";
  } else {
    run.cleanupPolicy = "Draft run. Agents inspect and produce artifacts, but implementation should move to a managed worktree before broad edits.";
  }

  liveRuns.set(run.id, run);
  await saveAgentRun(run);
  runAgentPipeline(run);
  return { run: publicRun(run) };
}

function parseSlashCommand(content) {
  const match = String(content || "").trim().match(/^\/(goal|loop|clarify)\b\s*([\s\S]*)$/i);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    body: String(match[2] || "").trim()
  };
}

function parseLoopBody(body) {
  const text = String(body || "").trim();
  const match = text.match(/^(\d{1,2})\s+([\s\S]+)$/);
  if (!match) {
    return { maxIterations: 3, objective: text };
  }
  return {
    maxIterations: Number(match[1]),
    objective: match[2].trim()
  };
}

async function appendAssistantControlMessage({ thread, messages, threads, content }) {
  const assistantMessage = {
    id: makeId("msg"),
    role: "assistant",
    content,
    createdAt: nowIso()
  };
  const nextMessages = [...messages, assistantMessage];
  const nextThreads = touchThread(threads, thread.id, {
    summary: summarizeMessages(nextMessages, thread.summary)
  });
  await Promise.all([writeMessages(thread.id, nextMessages), writeThreads(nextThreads)]);
}

export async function appendThreadMessage(threadId, input) {
  const content = String(input?.content ?? "").trim();
  if (!content) {
    throw new Error("Message content is required.");
  }

  const respond = input?.respond !== false;
  const [threads, bundle, config] = await Promise.all([readThreads(), getThreadBundle(threadId), readConfig()]);
  const thread = bundle.thread;
  if (!thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const userMessage = {
    id: makeId("msg"),
    role: "user",
    content,
    createdAt: nowIso()
  };
  let messages = [...bundle.messages, userMessage];
  let updatedThreads = touchThread(threads, thread.id, {
    title: thread.title || content.slice(0, 64),
    summary: summarizeMessages(messages, thread.summary)
  });
  await Promise.all([writeMessages(thread.id, messages), writeThreads(updatedThreads)]);

  const slash = parseSlashCommand(content);
  if (slash) {
    let assistantContent;
    try {
      if (slash.command === "goal") {
        if (!slash.body) {
          throw new Error("Use /goal followed by the objective you want the system to keep pursuing.");
        }
        const { goal } = await createGoal({
          threadId: thread.id,
          projectId: bundle.project?.id,
          projectPath: bundle.project?.path,
          objective: slash.body,
          title: slash.body
        });
        let objectiveNote = "";
        try {
          const planned = await planObjective({
            threadId: thread.id,
            projectId: bundle.project?.id,
            projectPath: bundle.project?.path,
            objective: slash.body
          });
          objectiveNote = `\n\nObjective planned: ${planned.objective.title}\nStatus: ${planned.objective.status}\nAgent goals: ${(planned.objective.goalLedger?.agentGoals || []).length}`;
        } catch (error) {
          objectiveNote = `\n\nObjective planning is waiting on a valid project folder: ${error.message}`;
        }
        assistantContent = `Goal set: ${goal.objective}\n\nI will include this objective in the durable context pack for this thread.${objectiveNote}\n\nIf the objective asks clarity questions, answer with /clarify followed by the target user, success criteria, and any constraints.`;
      } else if (slash.command === "clarify") {
        const activeObjective = await activeObjectiveForThread(thread.id);
        if (!activeObjective) {
          throw new Error("There is no active objective to clarify.");
        }
        const { objective } = await resolveObjectiveClarity({
          objectiveId: activeObjective.id,
          answers: slash.body
        });
        assistantContent = `Clarity captured for: ${objective.title}\n\nStatus: ${objective.status}\nThe clarity gate is complete. You can now start the objective loop or run the next agent task.`;
      } else {
        const parsed = parseLoopBody(slash.body);
        const activeGoal = await activeGoalForThread(thread.id);
        const objective = parsed.objective || activeGoal?.objective || "";
        const { loop } = await startGoalLoop({
          threadId: thread.id,
          projectId: bundle.project?.id,
          projectPath: bundle.project?.path,
          objective,
          maxIterations: parsed.maxIterations,
          workspaceMode: input?.workspaceMode || "worktree"
        });
        assistantContent = `Loop started: ${loop.objective}\n\nIterations: ${loop.maxIterations}\nWorkspace mode: ${loop.workspaceMode}\nStatus: ${loop.status}`;
      }
    } catch (error) {
      assistantContent = `I saved the command, but could not run it: ${error.message}`;
    }
    await appendAssistantControlMessage({ thread, messages, threads: updatedThreads, content: assistantContent });
    return getThreadBundle(thread.id);
  }

  if (respond) {
    const refreshedThread = updatedThreads.find((item) => item.id === thread.id) || thread;
    const [activeGoal, activeLoop, activeObjective] = await Promise.all([
      activeGoalForThread(thread.id),
      activeLoopForThread(thread.id),
      activeObjectiveForThread(thread.id)
    ]);
    const context = await buildContextPack({ thread: refreshedThread, project: bundle.project, messages, config, activeGoal, activeLoop, activeObjective });
    const prompt = [
      "You are Agent Command Center, a local desktop coding-agent coordinator.",
      "Use the context pack to answer with continuity. Be concise, practical, and explicit about next steps.",
      "If the user asks to build a system, propose a /goal and the first objective loop step.",
      "Always mention cleanup, verification, and whether work should happen in a managed worktree.",
      "",
      context.text,
      "",
      `Latest user message: ${content}`
    ].join("\n");

    let assistantContent;
    let assistantMeta = null;
    try {
      const result = await callChatWithFallbacks(config, prompt);
      assistantContent = result.text || "The selected model returned no text.";
      assistantMeta = {
        providerId: result.provider,
        model: result.model,
        routeReason: result.routeReason,
        fallbackErrors: result.fallbackErrors || [],
        usage: result.usage || null
      };
    } catch (error) {
      assistantContent = `I saved your message, but the selected model could not respond: ${error.message}`;
      assistantMeta = { error: error.message };
    }

    const assistantMessage = {
      id: makeId("msg"),
      role: "assistant",
      content: assistantContent,
      meta: assistantMeta,
      createdAt: nowIso()
    };
    messages = [...messages, assistantMessage];
    updatedThreads = touchThread(updatedThreads, thread.id, {
      summary: summarizeMessages(messages, refreshedThread.summary)
    });
    await Promise.all([writeMessages(thread.id, messages), writeThreads(updatedThreads)]);
  }

  return getThreadBundle(thread.id);
}

export async function getToolsStatus() {
  const statuses = await Promise.all(tools.map(async (tool) => ({ ...tool, ...(await runWhereAny(tool.commands || [tool.command])) })));
  return { tools: statuses };
}

function hasEnv(name) {
  return Boolean(process.env[name] && process.env[name].trim());
}

function stripeWebhookPort() {
  return Number(process.env.ACC_STRIPE_WEBHOOK_PORT || 8787);
}

export function getStripeStatus() {
  return {
    mode: process.env.STRIPE_MODE || "test",
    publishableConfigured: hasEnv("STRIPE_PUBLISHABLE_KEY"),
    secretConfigured: hasEnv("STRIPE_SECRET_KEY"),
    webhookSecretConfigured: hasEnv("STRIPE_WEBHOOK_SECRET"),
    webhookUrl: `http://127.0.0.1:${stripeWebhookPort()}/stripe/webhook`,
    webhookPort: stripeWebhookPort()
  };
}

function parseStripeSignatureHeader(header) {
  return String(header || "")
    .split(",")
    .map((part) => part.split("="))
    .reduce((acc, [key, value]) => {
      if (!key || !value) return acc;
      acc[key] = acc[key] || [];
      acc[key].push(value);
      return acc;
    }, {});
}

function timingSafeEqualHex(left, right) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyStripeWebhook(rawBody, signatureHeader) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured.");
  }

  const parsed = parseStripeSignatureHeader(signatureHeader);
  const timestamp = parsed.t?.[0];
  const signatures = parsed.v1 || [];
  if (!timestamp || signatures.length === 0) {
    throw new Error("Missing Stripe webhook signature.");
  }

  const signedPayload = `${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
  const matched = signatures.some((signature) => timingSafeEqualHex(expected, signature));
  if (!matched) {
    throw new Error("Stripe webhook signature verification failed.");
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (Number.isFinite(ageSeconds) && ageSeconds > 300) {
    throw new Error("Stripe webhook signature timestamp is too old.");
  }
}

async function appendStripeEvent(event) {
  await ensureDataFiles();
  const row = {
    receivedAt: new Date().toISOString(),
    id: event.id,
    type: event.type,
    livemode: Boolean(event.livemode),
    object: event.data?.object?.object || null,
    objectId: event.data?.object?.id || null,
    amountTotal: event.data?.object?.amount_total ?? event.data?.object?.amount ?? null,
    currency: event.data?.object?.currency || null
  };
  await fs.appendFile(stripeEventsPath, `${JSON.stringify(row)}\n`);
  return row;
}

export async function handleStripeWebhook(rawBody, signatureHeader) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || "");
  verifyStripeWebhook(body, signatureHeader);
  const event = JSON.parse(body.toString("utf8"));
  const recorded = await appendStripeEvent(event);
  return { received: true, event: recorded };
}

export function getProviderStatus() {
  return {
    providers: Object.values(providerRuntime).map((provider) => ({
      id: provider.id,
      name: provider.name,
      apiKeyEnv: provider.env,
      configured: provider.requiresKey === false || hasEnv(provider.env),
      defaultModel: provider.defaultModel,
      baseUrl: provider.redactedBaseUrl
    }))
  };
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 52) || "agent-task";
}

function quote(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '\\"')}"`;
}

function buildToolCommand({ tool, model, prompt, workdir }) {
  const safePrompt = quote(prompt);
  if (tool === "aider") {
    return `cd ${quote(workdir)}; aider --model openai/${model} --message ${safePrompt}`;
  }
  if (tool === "goose") {
    return `cd ${quote(workdir)}; goose run --text ${safePrompt}`;
  }
  if (tool === "grok-build") {
    return `cd ${quote(workdir)}; grok -p ${safePrompt}`;
  }
  if (tool === "cline" || tool === "kilo") {
    return `Open ${quote(workdir)} in VS Code and run the ${tool === "cline" ? "Cline" : "Kilo Code"} task from the extension panel.`;
  }
  return `cd ${quote(workdir)}; opencode --model ${model} ${safePrompt}`;
}

export async function planRun(input) {
  const config = await readConfig();
  const taskTitle = input.title?.trim() || "Untitled task";
  const taskSlug = slugify(taskTitle);
  const projectPath = input.projectPath?.trim() || "<project-path>";
  const selectedRoleIds = Array.isArray(input.roles) && input.roles.length ? input.roles : ["planner", "implementer", "reviewer"];
  const selectedRoles = config.roles.filter((role) => selectedRoleIds.includes(role.id));
  const worktreeRoot = path.join(projectPath, ".agent-worktrees");
  const prompt = input.prompt?.trim() || "No prompt supplied yet.";
  const mode = input.mode || "swarm";
  const phases = [
    {
      name: "Preflight",
      commands: [
        `git -C ${quote(projectPath)} status --short`,
        `git -C ${quote(projectPath)} branch --show-current`,
        "Confirm provider keys are available as environment variables before launching agents."
      ]
    }
  ];

  if (mode === "swarm") {
    phases.push({
      name: "Isolated Worktrees",
      commands: selectedRoles.map((role) => {
        const wt = path.join(worktreeRoot, `${taskSlug}-${role.id}`);
        return `git -C ${quote(projectPath)} worktree add ${quote(wt)} -b ${quote(`agent/${taskSlug}-${role.id}`)}`;
      })
    });
  }

  phases.push({
    name: "Agent Runs",
    commands: selectedRoles.map((role) => {
      const workdir = mode === "swarm" ? path.join(worktreeRoot, `${taskSlug}-${role.id}`) : projectPath;
      const rolePrompt = [
        `Task: ${taskTitle}`,
        `Role: ${role.name}`,
        `Instruction: ${role.instruction}`,
        `User request: ${prompt}`
      ].join("\n\n");
      return buildToolCommand({
        tool: role.defaultTool,
        model: role.model,
        prompt: rolePrompt,
        workdir
      });
    })
  });

  phases.push({
    name: "Consolidation",
    commands: [
      "Compare each agent worktree diff.",
      "Apply the best implementation into the main working copy.",
      "Run tests, lint, type checks, and a final model-vs-model review.",
      "Commit only after the reviewer and tester roles agree on the result."
    ]
  });

  const runbook = {
    id: `${Date.now()}-${taskSlug}`,
    createdAt: new Date().toISOString(),
    title: taskTitle,
    mode,
    provider: config.providers.find((provider) => provider.id === config.activeProviderId) ?? config.providers[0],
    roles: selectedRoles,
    phases
  };
  await ensureDataFiles();
  await fs.writeFile(path.join(runsDir, `${runbook.id}.json`), JSON.stringify(runbook, null, 2));
  return runbook;
}

function normalizeTestPrompt(value) {
  const prompt = String(value ?? "").trim();
  return prompt || "Reply in one sentence: Agent Command Center API wiring is working.";
}

export async function callAnthropic({ prompt, model, maxTokens = 180 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: model || providerRuntime.anthropic.defaultModel,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: normalizeTestPrompt(prompt) }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Anthropic request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    provider: "anthropic",
    model: data.model || model || providerRuntime.anthropic.defaultModel,
    text: data.content?.map((part) => part.text).filter(Boolean).join("\n") || "",
    usage: data.usage || null
  };
}

export async function callNvidia({ prompt, model, maxTokens = 180 }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not configured.");
  }

  const selectedModel = model || process.env.NVIDIA_MODEL || providerRuntime.nvidia.defaultModel;
  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "user", content: normalizeTestPrompt(prompt) }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.detail || `NVIDIA request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    provider: "nvidia-nim",
    model: data.model || selectedModel,
    text: data.choices?.[0]?.message?.content || "",
    usage: data.usage || null
  };
}

function trimBaseUrl(baseUrl) {
  return String(baseUrl ?? "").replace(/\/+$/, "");
}

function findRuntime(providerId) {
  return Object.values(providerRuntime).find((provider) => provider.id === providerId);
}

async function resolveProvider(providerId) {
  const config = await readConfig();
  const configuredProvider = config.providers.find((provider) => provider.id === providerId);
  const runtime = findRuntime(providerId);
  if (!configuredProvider && !runtime) {
    throw new Error(`Unsupported provider '${providerId}'.`);
  }

  return {
    id: providerId,
    name: configuredProvider?.name || runtime?.name || providerId,
    baseUrl: trimBaseUrl(configuredProvider?.baseUrl || runtime?.baseUrl || runtime?.redactedBaseUrl),
    env: configuredProvider?.apiKeyEnv || runtime?.env,
    defaultModel: configuredProvider?.models?.[0] || runtime?.defaultModel,
    staticModels: configuredProvider?.models || [],
    requiresKey: runtime?.requiresKey !== false,
    allowAnonymousModelList: Boolean(runtime?.allowAnonymousModelList)
  };
}

function providerHeaders(provider, { json = false, allowMissingKey = false } = {}) {
  const headers = {};
  const apiKey = provider.env ? process.env[provider.env] : "";
  if (json) {
    headers["content-type"] = "application/json";
  }
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  } else if (provider.requiresKey && !allowMissingKey) {
    throw new Error(`${provider.env} is not configured.`);
  }
  if (provider.id === "openrouter") {
    headers["HTTP-Referer"] = "https://agent-command-center.local";
    headers["X-Title"] = "Agent Command Center";
  }
  return headers;
}

function modelLabel(model) {
  return model.name || model.id;
}

function staticModelList(provider) {
  return {
    provider: provider.id,
    models: provider.staticModels.map((id) => ({
      id,
      displayName: id,
      source: "static"
    }))
  };
}

function collectChatCompletionText(data) {
  const content = data.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => part.text || part.content || "").filter(Boolean).join("\n");
  }
  return "";
}

export async function callOpenAICompatible({ providerId, prompt, model, maxTokens = 180 }) {
  const provider = await resolveProvider(providerId);
  const selectedModel = model || provider.defaultModel;
  if (!selectedModel) {
    throw new Error(`No model selected for ${provider.name}.`);
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: providerHeaders(provider, { json: true }),
    body: JSON.stringify({
      model: selectedModel,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [{ role: "user", content: normalizeTestPrompt(prompt) }]
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.detail || `${provider.name} request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    provider: provider.id,
    model: data.model || selectedModel,
    text: collectChatCompletionText(data),
    usage: data.usage || null
  };
}

export async function listOpenAICompatibleModels(providerId) {
  const provider = await resolveProvider(providerId);
  const allowMissingKey = provider.allowAnonymousModelList || !provider.requiresKey;

  try {
    const response = await fetch(`${provider.baseUrl}/models`, {
      headers: providerHeaders(provider, { allowMissingKey })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.detail || `${provider.name} models request failed with HTTP ${response.status}`;
      throw new Error(message);
    }
    return {
      provider: provider.id,
      models: (data.data || [])
        .filter((model) => typeof model.id === "string")
        .sort((a, b) => Number(b.created || 0) - Number(a.created || 0) || a.id.localeCompare(b.id))
        .map((model) => ({
          id: model.id,
          displayName: modelLabel(model),
          ownedBy: model.owned_by || null,
          contextLength: model.context_length || null,
          pricing: model.pricing || null,
          created: model.created || null
        }))
    };
  } catch (error) {
    if (provider.staticModels.length) {
      return staticModelList(provider);
    }
    throw error;
  }
}

function collectOpenAIText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((part) => part.text || part.value || "")
    .filter(Boolean)
    .join("\n");
}

export async function callOpenAI({ prompt, model, maxTokens = 180 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const selectedModel = model || providerRuntime.openai.defaultModel;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: selectedModel,
      input: normalizeTestPrompt(prompt),
      max_output_tokens: maxTokens
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return {
    provider: "openai",
    model: data.model || selectedModel,
    text: collectOpenAIText(data),
    usage: data.usage || null
  };
}

export async function listAnthropicModels() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }

  const response = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `Anthropic models request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return {
    provider: "anthropic",
    models: (data.data || []).map((model) => ({
      id: model.id,
      displayName: model.display_name || model.id,
      createdAt: model.created_at || null
    }))
  };
}

export async function listOpenAIModels() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenAI models request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return {
    provider: "openai",
    models: (data.data || [])
      .filter((model) => typeof model.id === "string")
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((model) => ({
        id: model.id,
        displayName: model.id,
        ownedBy: model.owned_by || null
      }))
  };
}

export async function listNvidiaModels() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not configured.");
  }

  const response = await fetch("https://integrate.api.nvidia.com/v1/models", {
    headers: {
      authorization: `Bearer ${apiKey}`
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || data?.detail || `NVIDIA models request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return {
    provider: "nvidia-nim",
    models: (data.data || []).map((model) => ({
      id: model.id,
      displayName: model.id,
      ownedBy: model.owned_by || null
    }))
  };
}

function pricePerMillion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric * 1_000_000;
}

function scoutReason(model) {
  const id = model.id.toLowerCase();
  const name = String(model.name || "").toLowerCase();
  if (id.includes("kimi-k2.7")) return "latest long-horizon coding";
  if (id.includes("glm-5")) return "GLM agentic coding family";
  if (id.includes("free")) return "zero-token-cost route";
  if (id.includes("auto")) return "automatic model router";
  if (id.includes("qwen") && name.includes("coder")) return "coding specialist";
  if (id.includes("deepseek")) return "cost-effective reasoning/coding";
  return "watchlist match";
}

export async function scoutModels() {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `OpenRouter scout failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  const watch = /(kimi-k2\.7|kimi-k2\.6|glm-5|openrouter\/free|openrouter\/auto|qwen.*coder|deepseek|gpt-oss)/i;
  const models = (data.data || [])
    .filter((model) => watch.test(`${model.id} ${model.name || ""}`))
    .sort((a, b) => Number(b.created || 0) - Number(a.created || 0))
    .slice(0, 24)
    .map((model) => ({
      id: model.id,
      name: model.name || model.id,
      providerId: "openrouter",
      contextLength: model.context_length || null,
      promptPerMillion: pricePerMillion(model.pricing?.prompt),
      completionPerMillion: pricePerMillion(model.pricing?.completion),
      created: model.created || null,
      reason: scoutReason(model)
    }));

  return {
    source: "openrouter",
    checkedAt: new Date().toISOString(),
    models
  };
}

export async function listProviderModels(providerId) {
  if (providerId === "anthropic") return listAnthropicModels();
  if (providerId === "openai") return listOpenAIModels();
  if (providerId === "nvidia-nim") return listNvidiaModels();
  if (["openrouter", "xai", "kimi", "zai-glm", "ollama", "lm-studio", "lite-gateway"].includes(providerId)) return listOpenAICompatibleModels(providerId);
  throw new Error(`Unsupported provider '${providerId}'.`);
}

export async function testProvider(body) {
  const providerId = String(body?.providerId ?? "").trim();
  const model = String(body?.model ?? "").trim();
  const prompt = normalizeTestPrompt(body?.prompt);
  const maxTokens = Number(body?.maxTokens || body?.max_tokens || 180);
  if (providerId === "anthropic") return callAnthropic({ prompt, model, maxTokens });
  if (providerId === "openai") return callOpenAI({ prompt, model, maxTokens });
  if (providerId === "nvidia-nim") return callNvidia({ prompt, model, maxTokens });
  if (["openrouter", "xai", "kimi", "zai-glm", "ollama", "lm-studio", "lite-gateway"].includes(providerId)) {
    return callOpenAICompatible({ providerId, prompt, model, maxTokens });
  }
  throw new Error(`Unsupported provider '${providerId}'.`);
}
