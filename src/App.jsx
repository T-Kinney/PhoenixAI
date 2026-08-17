import {
  Activity,
  Bot,
  Brain,
  Check,
  ChevronDown,
  Clipboard,
  Code2,
  Command,
  Cpu,
  FileDiff,
  FolderOpen,
  GitBranch,
  Hammer,
  History,
  KeyRound,
  Layers3,
  MessageSquare,
  Mic,
  Monitor,
  PanelLeft,
  Play,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Repeat2,
  Target,
  Workflow,
  X,
  Zap
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAgentSession } from "./useAgentSession.js";
import { PermissionDialog, ToolCallStream, ThoughtPanel, AgentStatusBar } from "./AgentPanels.jsx";

const navItems = [
  { id: "chat", label: "Threads", icon: MessageSquare },
  { id: "objectives", label: "Objectives", icon: Target },
  { id: "agents", label: "Agents", icon: Workflow },
  { id: "worktrees", label: "Worktrees", icon: GitBranch },
  { id: "review", label: "Review", icon: FileDiff },
  { id: "models", label: "Models", icon: Cpu },
  { id: "tools", label: "Tools", icon: Hammer },
  { id: "revenue", label: "Revenue", icon: KeyRound },
  { id: "settings", label: "Settings", icon: Settings }
];

const liveModelProviderIds = new Set(["anthropic", "openai", "nvidia-nim", "openrouter", "xai", "kimi", "zai-glm", "ollama", "lm-studio"]);

const sampleThreads = [
  { title: "Replicate Claude Code + Codex", project: "agent-command-center", state: "Active", accent: "green" },
  { title: "Wire NVIDIA NIM gateway", project: "model-router", state: "Draft", accent: "amber" },
  { title: "Evaluate GLM 5.2 against Fable", project: "benchmarks", state: "Queued", accent: "slate" },
  { title: "Browser + desktop automation", project: "mcp-lab", state: "Idea", accent: "blue" }
];

const activityItems = [
  ["planner", "Mapped repo and selected worktree strategy", "12s"],
  ["implementer", "Ready to apply patch after approval", "now"],
  ["reviewer", "Waiting for diff", "idle"],
  ["tester", "Checks queued", "idle"]
];

const defaultDraft = {
  title: "Replicate the Codex and Claude desktop agent experience",
  projectPath: "",
  prompt: "",
  mode: "swarm",
  workspaceMode: "draft",
  roles: ["planner", "implementer", "reviewer", "tester"]
};

function classNames(...parts) {
  return parts.filter(Boolean).join(" ");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (error) {
      const snippet = text.replace(/\s+/g, " ").slice(0, 160);
      throw new Error(`${path} returned invalid JSON: ${error.message}. Response: ${snippet}`);
    }
  }
  if (!response.ok) {
    throw new Error(data?.error || `${response.status} ${response.statusText}`);
  }
  return data;
}

function StatusDot({ ok, tone = "ok" }) {
  return <span className={classNames("dot", ok ? "dotOk" : `dot${tone[0].toUpperCase()}${tone.slice(1)}`)} />;
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="iconButton"
      title="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check size={15} /> : <Clipboard size={15} />}
    </button>
  );
}

function ProviderName({ config }) {
  const provider = config?.providers?.find((item) => item.id === config.activeProviderId);
  return (
    <span className="providerButtonText">
      <span>{provider?.name ?? "LiteLLM Gateway"}</span>
      {config?.activeModel && <small>{config.activeModel}</small>}
    </span>
  );
}

function CommandLine({ value }) {
  return (
    <div className="commandLine">
      <code>{value}</code>
      <CopyButton value={value} />
    </div>
  );
}

function AppRail({ activeView, setActiveView }) {
  return (
    <aside className="appRail">
      <div className="railLogo">
        <Sparkles size={18} />
      </div>
      <nav className="railNav">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={classNames("railButton", activeView === item.id && "active")}
              title={item.label}
              onClick={() => setActiveView(item.id)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </nav>
      <button className="railButton bottom" title="Command menu">
        <Command size={18} />
      </button>
    </aside>
  );
}

function ThreadList({ tools }) {
  const installed = tools.filter((tool) => tool.installed).length;
  return (
    <aside className="threadPane">
      <div className="threadHeader">
        <div>
          <h1>Command Center</h1>
          <p>Local agent workspace</p>
        </div>
        <button className="smallIconButton" title="New thread">
          <Plus size={16} />
        </button>
      </div>
      <label className="searchBox">
        <Search size={15} />
        <input placeholder="Search threads" />
      </label>
      <div className="sectionLabel">Projects</div>
      <div className="projectPicker">
        <FolderOpen size={16} />
        <div>
          <strong>agent-command-center</strong>
          <span>C:\Users\tkinn\Documents\Codex</span>
        </div>
        <ChevronDown size={16} />
      </div>
      <div className="sectionLabel">Recent Threads</div>
      <div className="threadList">
        {sampleThreads.map((thread, index) => (
          <button key={thread.title} className={classNames("threadItem", index === 0 && "selected")}>
            <span className={classNames("threadAccent", thread.accent)} />
            <span className="threadTitle">{thread.title}</span>
            <span className="threadMeta">
              {thread.project} · {thread.state}
            </span>
          </button>
        ))}
      </div>
      <div className="stackHealth">
        <div>
          <span>Toolchain</span>
          <strong>
            {installed}/{tools.length || 8}
          </strong>
        </div>
        <div>
          <span>Mode</span>
          <strong>Draft</strong>
        </div>
      </div>
    </aside>
  );
}

function WorkspaceThreadList({
  tools,
  workspace,
  activeProjectId,
  activeThreadId,
  onChooseFolder,
  onNewThread,
  onSelectThread
}) {
  const installed = tools.filter((tool) => tool.installed).length;
  const [query, setQuery] = useState("");
  const projects = workspace?.projects ?? [];
  const threads = workspace?.threads ?? [];
  const activeProject = projects.find((project) => project.id === activeProjectId) || projects[0];
  const visibleThreads = threads.filter((thread) => (
    `${thread.title} ${thread.state}`.toLowerCase().includes(query.toLowerCase())
  ));

  return (
    <aside className="threadPane">
      <div className="threadHeader">
        <div>
          <h1>Command Center</h1>
          <p>Local agent workspace</p>
        </div>
        <button className="smallIconButton" title="New thread" onClick={onNewThread}>
          <Plus size={16} />
        </button>
      </div>
      <label className="searchBox">
        <Search size={15} />
        <input placeholder="Search threads" value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="sectionLabel">Projects</div>
      <button className="projectPicker" onClick={onChooseFolder}>
        <FolderOpen size={16} />
        <div>
          <strong>{activeProject?.name || "Select project"}</strong>
          <span>{activeProject?.path || "Choose a folder on this PC"}</span>
        </div>
        <ChevronDown size={16} />
      </button>
      <div className="sectionLabel">Recent Threads</div>
      <div className="threadList">
        {visibleThreads.map((thread) => {
          const project = projects.find((item) => item.id === thread.projectId);
          return (
            <button
              key={thread.id}
              className={classNames("threadItem", activeThreadId === thread.id && "selected")}
              onClick={() => onSelectThread(thread.id)}
            >
              <span className={classNames("threadAccent", thread.state === "Active" ? "green" : "slate")} />
              <span className="threadTitle">{thread.title}</span>
              <span className="threadMeta">{project?.name || "Project"} - {thread.state}</span>
            </button>
          );
        })}
        {visibleThreads.length === 0 && <div className="emptyState">No saved chats yet.</div>}
      </div>
      <div className="stackHealth">
        <div>
          <span>Toolchain</span>
          <strong>
            {installed}/{tools.length || 8}
          </strong>
        </div>
        <div>
          <span>Mode</span>
          <strong>Draft</strong>
        </div>
      </div>
    </aside>
  );
}

function TopBar({ config, onRefresh, saving, activeView, setActiveView }) {
  return (
    <header className="topBar">
      <div className="titleCluster">
        <div className="crumb">
          <PanelLeft size={14} />
          Local workspace
        </div>
        <h2>Replicate Codex + Claude Code</h2>
        <div className="viewTabs">
          {navItems.slice(0, 6).map((item) => (
            <button
              key={item.id}
              className={activeView === item.id ? "selected" : ""}
              onClick={() => setActiveView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="topActions">
        <button className="selectButton providerSelectButton" onClick={() => setActiveView("models")} title="Open model routing">
          <Brain size={16} />
          <ProviderName config={config} />
          <ChevronDown size={15} />
        </button>
        <button className="selectButton">
          <ShieldCheck size={16} />
          Ask before write
          <ChevronDown size={15} />
        </button>
        <button className="iconTextButton" onClick={onRefresh}>
          <RefreshCcw size={16} />
          Refresh
        </button>
        {saving && <span className="saving">Saving...</span>}
      </div>
    </header>
  );
}

function RoleToggle({ role, enabled, onToggle }) {
  return (
    <button className={classNames("roleToggle", enabled && "enabled")} onClick={onToggle}>
      <span className="roleIcon">
        {role.id === "planner" && <Brain size={15} />}
        {role.id === "implementer" && <Code2 size={15} />}
        {role.id === "reviewer" && <FileDiff size={15} />}
        {role.id === "tester" && <SquareTerminal size={15} />}
      </span>
      <span>
        <strong>{role.name}</strong>
        <small>{role.defaultTool} · {role.model}</small>
      </span>
    </button>
  );
}

function ChatComposer({ config, draft, setDraft, createPlan, sendMessage, chooseFolder, busy, sending, activeGoal }) {
  const roles = config?.roles ?? [];
  const cleanPrompt = draft.prompt.trim().replace(/^\/(goal|loop)\b\s*/i, "");
  return (
    <div className="composerShell">
      <div className="projectRow">
        <label className="inlineField grow">
          <FolderOpen size={15} />
          <input
            value={draft.projectPath}
            placeholder="Project folder"
            onChange={(event) => setDraft({ ...draft, projectPath: event.target.value })}
          />
        </label>
        <button className="iconTextButton" onClick={chooseFolder}>
          <FolderOpen size={16} />
          Browse
        </button>
        <div className="modeToggle" aria-label="Run mode">
          {["swarm", "solo"].map((mode) => (
            <button
              key={mode}
              className={draft.mode === mode ? "selected" : ""}
              onClick={() => setDraft({ ...draft, mode })}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>
      <div className="workspaceModeToggle" aria-label="Workspace mode">
        {[
          ["draft", "Draft", "Inspect and write artifacts only"],
          ["worktree", "Worktree", "Isolated objective workspace"],
          ["local", "Local", "Direct project run"]
        ].map(([mode, label, title]) => (
          <button
            key={mode}
            title={title}
            className={draft.workspaceMode === mode ? "selected" : ""}
            onClick={() => setDraft({ ...draft, workspaceMode: mode })}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        className="promptBox"
        value={draft.prompt}
        placeholder="Ask agents to inspect a repo, implement a feature, test it, review it, and prepare the diff."
        onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
      />
      <div className="roleStrip">
        {roles.map((role) => (
          <RoleToggle
            key={role.id}
            role={role}
            enabled={draft.roles.includes(role.id)}
            onToggle={() => {
              const next = draft.roles.includes(role.id)
                ? draft.roles.filter((id) => id !== role.id)
                : [...draft.roles, role.id];
              setDraft({ ...draft, roles: next });
            }}
          />
        ))}
      </div>
      <div className="composerActions">
        <button className="iconTextButton">
          <Mic size={16} />
          Voice
        </button>
        <button className="iconTextButton">
          <Monitor size={16} />
          Browser
        </button>
        <button className="iconTextButton" onClick={() => sendMessage?.()} disabled={sending || !draft.prompt.trim() || !sendMessage}>
          <MessageSquare size={16} />
          {sending ? "Sending" : "Send"}
        </button>
        <button
          className="iconTextButton"
          onClick={() => sendMessage?.(`/goal ${cleanPrompt}`)}
          disabled={sending || !cleanPrompt || !sendMessage}
        >
          <Target size={16} />
          Goal
        </button>
        <button
          className="iconTextButton"
          onClick={() => sendMessage?.(cleanPrompt ? `/loop ${cleanPrompt}` : "/loop")}
          disabled={sending || (!cleanPrompt && !activeGoal) || !sendMessage}
        >
          <Repeat2 size={16} />
          Loop
        </button>
        <button className="primaryAction" onClick={createPlan} disabled={busy}>
          <Play size={17} />
          {busy ? "Starting" : draft.workspaceMode === "worktree" ? "Start Worktree Run" : "Start Agent Run"}
        </button>
      </div>
    </div>
  );
}

function ChatView({ config }) {
  const [draft, setDraft] = useState(defaultDraft);
  const [runbook, setRunbook] = useState(null);
  const [busy, setBusy] = useState(false);

  const selectedRoles = useMemo(
    () => (config?.roles ?? []).filter((role) => draft.roles.includes(role.id)),
    [config, draft.roles]
  );

  async function createPlan() {
    setBusy(true);
    try {
      setRunbook(await api("/api/runs/plan", { method: "POST", body: JSON.stringify(draft) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workbench">
      <section className="conversation">
        <div className="message userMessage">
          <div className="avatar user">T</div>
          <div className="bubble">
            <div className="messageHeader">You</div>
            <p>
              Build me a free-model desktop agent client that feels like Codex and Claude Code, supports long projects, direct folder access,
              multiple models, and agents checking one another's work.
            </p>
          </div>
        </div>
        <div className="message assistantMessage">
          <div className="avatar agent">
            <Bot size={17} />
          </div>
          <div className="bubble">
            <div className="messageHeader">Command Center</div>
            <p>
              I would run this as a local shell around OpenCode, Aider, Goose, Cline/Kilo, and LiteLLM. The app owns model routing,
              approval boundaries, worktrees, review gates, and the unified timeline.
            </p>
            <div className="capabilityGrid">
              <div><GitBranch size={16} /> Worktree swarms</div>
              <div><Brain size={16} /> Model aliases</div>
              <div><FileDiff size={16} /> Diff review</div>
              <div><SquareTerminal size={16} /> Terminal streaming</div>
              <div><Monitor size={16} /> Browser control</div>
              <div><ShieldCheck size={16} /> Approval gates</div>
            </div>
          </div>
        </div>
        {runbook && (
          <div className="message assistantMessage">
            <div className="avatar agent">
              <Workflow size={17} />
            </div>
            <div className="bubble runBubble">
              <div className="messageHeader">Generated Runbook</div>
              <div className="runMeta">
                <span>{runbook.mode}</span>
                <span>{runbook.provider?.name}</span>
                <span>{runbook.roles.length} agents</span>
              </div>
              {runbook.phases.map((phase) => (
                <details key={phase.name} open={phase.name === "Agent Runs"}>
                  <summary>{phase.name}</summary>
                  {phase.commands.map((command, index) => (
                    <CommandLine key={`${phase.name}-${index}`} value={command} />
                  ))}
                </details>
              ))}
            </div>
          </div>
        )}
        <ChatComposer config={config} draft={draft} setDraft={setDraft} createPlan={createPlan} busy={busy} />
      </section>
      <Inspector config={config} selectedRoles={selectedRoles} runbook={runbook} />
    </div>
  );
}

function WorkspaceChatView({ config, project, thread, messages = [], context, activeGoal, activeLoop, activeObjective, onSendMessage, onChooseFolder, onEnsureThread }) {
  const [draft, setDraft] = useState(defaultDraft);
  const [activeRun, setActiveRun] = useState(null);
  const [loopState, setLoopState] = useState(activeLoop || null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  // Live Grok Build session for this thread. Falls back to the legacy saved-chat
  // path when the agent bridge is unavailable (browser build, or no daemon).
  const agent = useAgentSession(thread?.id);

  useEffect(() => {
    setDraft((current) => ({
      ...current,
      title: thread?.title || current.title,
      projectPath: project?.path || current.projectPath
    }));
  }, [project?.path, thread?.title]);

  const selectedRoles = useMemo(
    () => (config?.roles ?? []).filter((role) => draft.roles.includes(role.id)),
    [config, draft.roles]
  );

  useEffect(() => {
    setLoopState(activeLoop || null);
  }, [activeLoop?.id, activeLoop?.status, activeLoop?.currentIteration]);

  async function createPlan() {
    setBusy(true);
    try {
      const result = await api("/api/runs/start", {
        method: "POST",
        body: JSON.stringify({
          ...draft,
          threadId: thread?.id
        })
      });
      setActiveRun(result.run);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!activeRun?.id || ["complete", "failed", "needs_attention"].includes(activeRun.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api(`/api/runs/${activeRun.id}`);
        setActiveRun(result.run);
      } catch {
        window.clearInterval(timer);
      }
    }, 2200);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, activeRun?.status]);

  useEffect(() => {
    if (!loopState?.id || !["queued", "running"].includes(loopState.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await api(`/api/loops/${loopState.id}`);
        setLoopState(result.loop);
      } catch {
        window.clearInterval(timer);
      }
    }, 2600);
    return () => window.clearInterval(timer);
  }, [loopState?.id, loopState?.status]);

  async function sendCurrentMessage(contentOverride) {
    const content = String(contentOverride ?? draft.prompt).trim();
    if (!content) return;
    setSending(true);
    try {
      // Slash commands stay on the legacy path; they are handled server-side
      // and have nothing to do with an agent turn.
      const isCommand = content.startsWith("/");
      // The agent needs a real thread id: it binds the ACP session to it and
      // the route rejects a missing one. On a fresh workspace no thread exists
      // until the first send, so resolve it here rather than sending undefined.
      const threadId = thread?.id || (onEnsureThread ? await onEnsureThread() : null);
      if (agent.available && !isCommand && threadId) {
        await agent.send(content, { threadId, projectPath: project?.path || null });
      } else {
        await onSendMessage(content);
      }
      setDraft((current) => ({ ...current, prompt: "" }));
    } catch {
      // The agent surfaces its own error state; keep the draft so the user can retry.
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="workbench">
      {/* The agent blocks until a permission is answered, so this renders above
          everything and is intentionally not dismissible by clicking away. */}
      <PermissionDialog request={agent.permission} onAnswer={agent.answerPermission} />
      <section className="conversation">
        <AgentStatusBar
          connection={agent.connection}
          error={agent.error}
          busy={agent.busy}
          onCancel={agent.cancel}
        />
        {messages.length === 0 && agent.turns.length === 0 && (
          <div className="emptyConversation">
            <Bot size={22} />
            <strong>Start a real saved chat</strong>
            <span>Pick a project folder, then send a message or plan a swarm run.</span>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={classNames("message", message.role === "user" ? "userMessage" : "assistantMessage")}>
            <div className={classNames("avatar", message.role === "user" ? "user" : "agent")}>
              {message.role === "user" ? "T" : <Bot size={17} />}
            </div>
            <div className="bubble">
              <div className="messageHeader">{message.role === "user" ? "You" : "Command Center"}</div>
              <p className="messageText">{message.content}</p>
              {message.role !== "user" && message.meta && (
                <div className="routeMeta">
                  {message.meta.providerId && <span>{message.meta.providerId}</span>}
                  {message.meta.model && <span>{message.meta.model}</span>}
                  {message.meta.routeReason && <span>{message.meta.routeReason}</span>}
                  {message.meta.fallbackErrors?.length > 0 && <span>{message.meta.fallbackErrors.length} fallback miss</span>}
                  {message.meta.error && <span>{message.meta.error}</span>}
                </div>
              )}
            </div>
          </div>
        ))}
        {loopState && (
          <div className="message assistantMessage">
            <div className="avatar agent">
              <Repeat2 size={17} />
            </div>
            <div className="bubble runBubble">
              <div className="messageHeader">Goal Loop</div>
              <div className="runMeta">
                <span>{loopState.status}</span>
                <span>{loopState.currentIteration || 0}/{loopState.maxIterations}</span>
                <span>{loopState.workspaceMode}</span>
              </div>
              <p className="messageText">{loopState.objective}</p>
              <div className="runSteps">
                {loopState.iterations?.map((iteration) => (
                  <div className={classNames("runStep", iteration.status)} key={iteration.index}>
                    <StatusDot ok={iteration.status === "complete"} tone={iteration.status === "needs_attention" ? "missing" : "ok"} />
                    <div>
                      <strong>Iteration {iteration.index}</strong>
                      <span>{iteration.status}{iteration.runStatus ? ` - ${iteration.runStatus}` : ""}</span>
                      {iteration.summary && <small>{iteration.summary}</small>}
                      {iteration.runId && <code>{iteration.runId}</code>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {activeRun && (
          <div className="message assistantMessage">
            <div className="avatar agent">
              <Workflow size={17} />
            </div>
            <div className="bubble runBubble">
              <div className="messageHeader">Agent Run</div>
              <div className="runMeta">
                <span>{activeRun.status}</span>
                <span>{activeRun.workspaceMode || "draft"}</span>
                <span>{activeRun.providerId}</span>
                <span>{activeRun.model}</span>
              </div>
              <p className="mutedNote">{activeRun.cleanupPolicy}</p>
              {activeRun.worktreePath && (
                <div className="worktreePath">
                  <GitBranch size={14} />
                  <code>{activeRun.worktreeExecutionPath || activeRun.worktreePath}</code>
                </div>
              )}
              <div className="runSteps">
                {activeRun.steps?.map((step) => (
                  <div className={classNames("runStep", step.status)} key={step.id}>
                    <StatusDot ok={step.status === "complete"} tone={step.status === "failed" ? "missing" : "ok"} />
                    <div>
                      <strong>{step.name}</strong>
                      <span>{step.status}{step.error ? ` - ${step.error}` : ""}</span>
                      {step.output && <small>{step.output}</small>}
                      {step.artifactPath && <code>{step.artifactPath}</code>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {agent.turns.map((turn, index) => (
          <div
            key={`agent-${index}`}
            className={classNames("message", turn.role === "user" ? "userMessage" : "assistantMessage")}
          >
            <div className={classNames("avatar", turn.role === "user" ? "user" : "agent")}>
              {turn.role === "user" ? "T" : <Bot size={17} />}
            </div>
            <div className="bubble">
              <div className="messageHeader">{turn.role === "user" ? "You" : "Grok"}</div>
              <p className="messageText">{turn.text}</p>
            </div>
          </div>
        ))}

        {(agent.thought || agent.toolCalls.length > 0) && (
          <div className="message assistantMessage">
            <div className="avatar agent"><Bot size={17} /></div>
            <div className="bubble">
              <ThoughtPanel thought={agent.thought} />
              <ToolCallStream toolCalls={agent.toolCalls} />
            </div>
          </div>
        )}

        <ChatComposer
          config={config}
          draft={draft}
          setDraft={setDraft}
          createPlan={createPlan}
          sendMessage={sendCurrentMessage}
          chooseFolder={onChooseFolder}
          busy={busy}
          sending={sending}
          activeGoal={activeGoal}
        />
      </section>
      <Inspector
        config={config}
        selectedRoles={selectedRoles}
        runbook={activeRun}
        context={context}
        project={project}
        thread={thread}
        activeGoal={activeGoal}
        activeLoop={loopState}
        activeObjective={activeObjective}
      />
    </div>
  );
}

function Inspector({ config, selectedRoles, runbook, context, project, thread, activeGoal, activeLoop, activeObjective }) {
  return (
    <aside className="inspector">
      <section className="inspectorSection">
        <div className="sectionTop">
          <h3>Agent Council</h3>
          <span>{selectedRoles.length} live</span>
        </div>
        <div className="agentList">
          {selectedRoles.map((role) => (
            <div className="agentRow" key={role.id}>
              <StatusDot ok />
              <div>
                <strong>{role.name}</strong>
                <span>{role.defaultTool} · {role.model}</span>
              </div>
              <button className="smallIconButton" title="Inspect agent">
                <Activity size={14} />
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="inspectorSection">
        <div className="sectionTop">
          <h3>Goal</h3>
          <span>{activeGoal?.status || "none"}</span>
        </div>
        {activeObjective && (
          <div className="goalBox">
            <Layers3 size={16} />
            <div>
              <strong>{activeObjective.title}</strong>
              <p>{activeObjective.status} - {(activeObjective.taskGraph || []).length} tasks - {(activeObjective.evalPlan || []).length} evals</p>
            </div>
          </div>
        )}
        {activeGoal ? (
          <div className="goalBox">
            <Target size={16} />
            <div>
              <strong>{activeGoal.title}</strong>
              <p>{activeGoal.objective}</p>
            </div>
          </div>
        ) : (
          <p className="mutedNote">No active objective for this thread.</p>
        )}
        {activeLoop && (
          <div className="loopBox">
            <Repeat2 size={16} />
            <div>
              <strong>{activeLoop.status}</strong>
              <span>iteration {activeLoop.currentIteration || 0}/{activeLoop.maxIterations}</span>
            </div>
          </div>
        )}
      </section>
      <section className="inspectorSection">
        <div className="sectionTop">
          <h3>Workspace</h3>
          <span>Local</span>
        </div>
        <div className="metricGrid">
          <div>
            <strong>{project ? "1" : "0"}</strong>
            <span>project</span>
          </div>
          <div>
            <strong>0</strong>
            <span>unsafe ops</span>
          </div>
          <div>
            <strong>{thread ? "1" : "0"}</strong>
            <span>thread</span>
          </div>
          <div>
            <strong>{runbook?.worktreePath ? "1" : "0"}</strong>
            <span>worktree</span>
          </div>
        </div>
      </section>
      {runbook?.worktreePath && (
        <section className="inspectorSection">
          <div className="sectionTop">
            <h3>Lease</h3>
            <span>{runbook.worktreeCreated ? "new" : "reused"}</span>
          </div>
          <div className="leaseBox">
            <GitBranch size={15} />
            <code>{runbook.worktreeExecutionPath || runbook.worktreePath}</code>
          </div>
          <p className="mutedNote">This objective is isolated from the source folder until a diff is reviewed and merged.</p>
        </section>
      )}
      <section className="inspectorSection">
        <div className="sectionTop">
          <h3>Context</h3>
          <span>pack</span>
        </div>
        <div className="metricGrid">
          <div>
            <strong>{context?.approximateTokens ?? 0}</strong>
            <span>est tokens</span>
          </div>
          <div>
            <strong>{context?.messageCount ?? 0}</strong>
            <span>messages</span>
          </div>
          <div>
            <strong>{context?.includedMessages ?? 0}</strong>
            <span>included</span>
          </div>
          <div>
            <strong>{context?.maxRecentMessages ?? 16}</strong>
            <span>recent cap</span>
          </div>
        </div>
        <p className="mutedNote">{context?.strategy || "No context pack loaded yet."}</p>
      </section>
      <section className="inspectorSection">
        <div className="sectionTop">
          <h3>Drivetrain</h3>
          <span>7 systems</span>
        </div>
        <div className="drivetrainGrid">
          <span>real chat</span>
          <span>tool runtime</span>
          <span>context pack</span>
          <span>model router</span>
          <span>objective loop</span>
          <span>repo hygiene</span>
          <span>revenue path</span>
        </div>
        <p className="mutedNote">Use Send for real model chat, Goal to create the durable objective, and Start Agent Run for the first scoped work cycle.</p>
      </section>
      <section className="inspectorSection">
        <div className="sectionTop">
          <h3>Activity</h3>
          <span>stream</span>
        </div>
        <div className="activityList">
          {(runbook?.steps?.length ? runbook.steps.map((step) => [step.name.toLowerCase(), step.output || step.status, step.status]) : activityItems).map(([agent, text, time]) => (
            <div className="activityItem" key={`${agent}-${text}-${time}`}>
              <span>{time}</span>
              <p><strong>{agent}</strong> {text}</p>
            </div>
          ))}
        </div>
      </section>
      <section className="inspectorSection terminalPreview">
        <div className="sectionTop">
          <h3>Terminal</h3>
          <span>preview</span>
        </div>
        <pre>{`> provider: ${config?.activeProviderId ?? "lite-gateway"}\n> policy: approval gated\n> queue: ${runbook ? "runbook ready" : "idle"}`}</pre>
      </section>
    </aside>
  );
}

function ObjectivesView({ project, thread, activeObjective, onChooseFolder, onObjectiveStarted, onReviewRun }) {
  const [idea, setIdea] = useState("");
  const [objectives, setObjectives] = useState([]);
  const [selectedObjective, setSelectedObjective] = useState(activeObjective || null);
  const [maxIterations, setMaxIterations] = useState(4);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [taskBusy, setTaskBusy] = useState(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [error, setError] = useState(null);

  function storeObjective(nextObjective) {
    if (!nextObjective) return;
    setSelectedObjective(nextObjective);
    setObjectives((current) => [nextObjective, ...current.filter((item) => item.id !== nextObjective.id)]);
  }

  async function loadObjectives() {
    if (!thread?.id && !project?.id) return;
    const params = new URLSearchParams();
    if (thread?.id) params.set("threadId", thread.id);
    if (!thread?.id && project?.id) params.set("projectId", project.id);
    const result = await api(`/api/objectives?${params.toString()}`);
    const list = result.objectives || [];
    setObjectives(list);
    setSelectedObjective((current) => activeObjective || current || list[0] || null);
  }

  useEffect(() => {
    if (activeObjective) {
      storeObjective(activeObjective);
    }
  }, [activeObjective?.id, activeObjective?.status]);

  useEffect(() => {
    loadObjectives().catch((err) => setError(err.message));
  }, [thread?.id, project?.id]);

  async function planObjective() {
    setBusy(true);
    setError(null);
    try {
      const result = await api("/api/objectives/plan", {
        method: "POST",
        body: JSON.stringify({
          idea,
          threadId: thread?.id,
          projectId: project?.id,
          projectPath: project?.path
        })
      });
      storeObjective(result.objective);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function startLoop() {
    if (!selectedObjective?.id) return;
    setStarting(true);
    setError(null);
    try {
      const result = await api(`/api/objectives/${selectedObjective.id}/start`, {
        method: "POST",
        body: JSON.stringify({
          maxIterations,
          workspaceMode: "worktree"
        })
      });
      storeObjective(result.objective);
      await onObjectiveStarted?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  async function refreshObjective(objectiveId = selectedObjective?.id) {
    if (!objectiveId) return;
    const result = await api(`/api/objectives/${objectiveId}`);
    storeObjective(result.objective);
  }

  async function runNextTask() {
    if (!selectedObjective?.id) return;
    setTaskBusy("next");
    setError(null);
    try {
      const result = await api(`/api/objectives/${selectedObjective.id}/tasks/next`, {
        method: "POST",
        body: JSON.stringify({})
      });
      storeObjective(result.objective);
    } catch (err) {
      setError(err.message);
    } finally {
      setTaskBusy(null);
    }
  }

  async function runTask(taskId) {
    if (!selectedObjective?.id || !taskId) return;
    setTaskBusy(taskId);
    setError(null);
    try {
      const result = await api(`/api/objectives/${selectedObjective.id}/tasks/${taskId}/start`, {
        method: "POST",
        body: JSON.stringify({})
      });
      storeObjective(result.objective);
    } catch (err) {
      setError(err.message);
    } finally {
      setTaskBusy(null);
    }
  }

  async function applyTaskPatch(task, patch) {
    if (!selectedObjective?.id || !task?.id || !patch) return;
    const busyKey = `${task.id}:patch:${patch.stepId}:${patch.index}`;
    setTaskBusy(busyKey);
    setError(null);
    try {
      const result = await api(`/api/objectives/${selectedObjective.id}/tasks/${task.id}/patches/apply`, {
        method: "POST",
        body: JSON.stringify({
          stepId: patch.stepId,
          patchIndex: patch.index
        })
      });
      storeObjective(result.objective);
    } catch (err) {
      setError(err.message);
    } finally {
      setTaskBusy(null);
    }
  }

  async function reconcileReview() {
    if (!selectedObjective?.id) return;
    setReviewBusy(true);
    setError(null);
    try {
      const result = await api(`/api/objectives/${selectedObjective.id}/review/reconcile`, {
        method: "POST",
        body: JSON.stringify({})
      });
      storeObjective(result.objective);
    } catch (err) {
      setError(err.message);
    } finally {
      setReviewBusy(false);
    }
  }

  const objective = selectedObjective;
  const clarityBlocked = objective?.status === "needs_clarity";
  const taskPollKey = JSON.stringify((objective?.taskGraph || []).map((task) => [task.id, task.status, task.runStatus]));
  const commanderGoal = objective?.goalLedger?.selfGoal;
  const agentGoals = objective?.goalLedger?.agentGoals || [];
  const discrepancies = objective?.reviewBoard?.discrepancies || [];
  const openDiscrepancies = discrepancies.filter((item) => item.status === "open");
  const reworkTasks = (objective?.taskGraph || []).filter((task) => task.phase === "rework");

  useEffect(() => {
    const hasRunningTask = (selectedObjective?.taskGraph || []).some((task) => ["starting", "running"].includes(task.status));
    if (!selectedObjective?.id || !hasRunningTask) return;
    const timer = window.setInterval(() => {
      refreshObjective(selectedObjective.id).catch((err) => setError(err.message));
    }, 2600);
    return () => window.clearInterval(timer);
  }, [selectedObjective?.id, taskPollKey]);

  function taskBlockers(task) {
    const tasks = objective?.taskGraph || [];
    return (task.dependsOn || []).filter((dependencyId) => {
      const dependency = tasks.find((item) => item.id === dependencyId);
      return !["complete", "changes_applied", "merged"].includes(dependency?.status);
    });
  }

  function canRunTask(task) {
    if (!objective || taskBusy) return false;
    if (["starting", "running", "complete", "changes_applied", "merged", "needs_input"].includes(task.status)) return false;
    return taskBlockers(task).length === 0;
  }

  return (
    <div className="pageGrid objectivesPage">
      <section className="panel surface full">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Objective Orchestrator</p>
            <h3>Idea to Long-Run Build System</h3>
          </div>
          <Target size={22} />
        </div>
        <div className="objectiveComposer">
          <label className="inlineField grow">
            <FolderOpen size={15} />
            <input value={project?.path || ""} placeholder="Select a project folder" readOnly />
          </label>
          <button className="iconTextButton" onClick={onChooseFolder}>
            <FolderOpen size={16} />
            Browse
          </button>
          <textarea
            className="objectiveIdeaBox"
            value={idea}
            placeholder="Describe the project or money-making system you want built. Include target user, revenue path, data sources, constraints, and what success looks like."
            onChange={(event) => setIdea(event.target.value)}
          />
          <div className="objectiveActions">
            <button className="primaryAction" onClick={planObjective} disabled={busy || !idea.trim() || !project?.path}>
              <Brain size={17} />
              {busy ? "Planning" : "Plan Objective"}
            </button>
            <label className="stepperField">
              <span>Loop</span>
              <input
                type="number"
                min="1"
                max="12"
                value={maxIterations}
                onChange={(event) => setMaxIterations(Number(event.target.value))}
              />
            </label>
            <button
              className="iconTextButton"
              onClick={startLoop}
              disabled={starting || !objective || clarityBlocked}
              title={clarityBlocked ? "Answer clarity questions and re-plan before starting." : "Start the managed worktree goal loop."}
            >
              <Repeat2 size={16} />
              {starting ? "Starting" : "Start Goal Loop"}
            </button>
            <button
              className="primaryAction"
              onClick={runNextTask}
              disabled={!objective || clarityBlocked || Boolean(taskBusy)}
              title="Start the first unblocked task in this objective."
            >
              <Play size={17} />
              {taskBusy === "next" ? "Starting" : "Run Next Task"}
            </button>
          </div>
        </div>
        {error && <div className="providerOutput error"><p>{error}</p></div>}
      </section>

      {objectives.length > 0 && (
        <section className="panel surface">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">Saved</p>
              <h3>Objective Plans</h3>
            </div>
            <span className="countPill">{objectives.length}</span>
          </div>
          <div className="objectiveList">
            {objectives.map((item) => (
              <button
                key={item.id}
                className={classNames("objectiveListItem", objective?.id === item.id && "selected")}
                onClick={() => setSelectedObjective(item)}
              >
                <strong>{item.title}</strong>
                <span>{item.status} - {(item.taskGraph || []).length} tasks - {(item.evalPlan || []).length} evals</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {objective && (
        <>
          <section className="panel surface">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">{objective.status}</p>
                <h3>{objective.title}</h3>
              </div>
              <Layers3 size={22} />
            </div>
            <div className="runMeta">
              <span>{objective.agents?.length || 0} agents</span>
              <span>{objective.taskGraph?.length || 0} tasks</span>
              <span>{objective.evalPlan?.length || 0} evals</span>
            </div>
            <p className="objectiveText">{objective.spec?.objective}</p>
            <div className="gateList">
              {(objective.spec?.successCriteria || []).map((item) => (
                <div key={item}><Check size={16} /> {item}</div>
              ))}
            </div>
          </section>

          <section className="panel surface">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Clarity Gate</p>
                <h3>{objective.clarity?.required ? "Needs answers" : "Ready to run"}</h3>
              </div>
              <ShieldCheck size={22} />
            </div>
            {objective.clarity?.required ? (
              <div className="questionList">
                {objective.clarity.questions.map((question) => (
                  <div key={question} className="questionItem">
                    <strong>{question}</strong>
                    <span>Add the answer to the idea box and click Plan Objective again.</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="gateList">
                <div><Check size={16} /> The current brief is specific enough to begin a managed loop.</div>
                <div><Check size={16} /> Work starts in a managed worktree by default.</div>
              </div>
            )}
          </section>

          <section className="panel surface full">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Router</p>
                <h3>Agent and Model Assignments</h3>
              </div>
              <Cpu size={22} />
            </div>
            <div className="objectiveGrid">
              {(objective.agents || []).map((agent) => (
                <article className="objectiveCard" key={agent.id}>
                  <div className="agentRow compact">
                    <StatusDot ok={agent.configured} tone="missing" />
                    <div>
                      <strong>{agent.name}</strong>
                      <span>{agent.providerName} - {agent.model}</span>
                    </div>
                  </div>
                  <p>{agent.responsibility}</p>
                  <small>{agent.costTier} - {agent.reason}</small>
                </article>
              ))}
            </div>
          </section>

          <section className="panel surface full">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Goal Ledger</p>
                <h3>Commander and Agent /goals</h3>
              </div>
              <Target size={22} />
            </div>
            <div className="goalLedgerGrid">
              {commanderGoal && (
                <article className="goalCard commander">
                  <div className="goalCardTop">
                    <strong>{commanderGoal.ownerName}</strong>
                    <span>{commanderGoal.status}</span>
                  </div>
                  <code>{commanderGoal.command}</code>
                  <p>{commanderGoal.objective}</p>
                </article>
              )}
              {agentGoals.map((goal) => (
                <article className="goalCard" key={goal.id}>
                  <div className="goalCardTop">
                    <strong>{goal.ownerName}</strong>
                    <span>{goal.status}</span>
                  </div>
                  <code>{goal.command}</code>
                  <p>{goal.taskSummary}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="panel surface full">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Review Board</p>
                <h3>Discrepancies and Rework</h3>
              </div>
              <button className="iconTextButton" onClick={reconcileReview} disabled={reviewBusy}>
                <FileDiff size={16} />
                {reviewBusy ? "Reconciling" : "Reconcile Review"}
              </button>
            </div>
            <div className="reviewBoardSummary">
              <div>
                <strong>{openDiscrepancies.length}</strong>
                <span>open discrepancies</span>
              </div>
              <div>
                <strong>{reworkTasks.length}</strong>
                <span>rework tasks</span>
              </div>
              <div>
                <strong>{agentGoals.filter((goal) => goal.status === "needs_rework").length}</strong>
                <span>agent goals flagged</span>
              </div>
            </div>
            <div className="discrepancyList">
              {openDiscrepancies.map((item) => (
                <article className="discrepancyItem" key={item.id}>
                  <div>
                    <span className="severityBadge">{item.severity}</span>
                    <strong>{item.title}</strong>
                  </div>
                  <p>{item.evidence}</p>
                  <small>{item.ownerAgentId} - from {item.sourceTaskId}</small>
                </article>
              ))}
              {openDiscrepancies.length === 0 && (
                <div className="emptyConversation compact">
                  <Check size={20} />
                  <strong>No open discrepancies</strong>
                  <span>Reviewer/tester findings will appear here and become rework tasks.</span>
                </div>
              )}
            </div>
          </section>

          <section className="panel surface full">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Execution</p>
                <h3>Task Graph</h3>
              </div>
              <Workflow size={22} />
            </div>
            <div className="taskGraph">
              {(objective.taskGraph || []).map((task) => {
                const blockers = taskBlockers(task);
                const patches = task.patchCandidates || [];
                return (
                  <article className={classNames("taskNode", ["running", "starting"].includes(task.status) && "running")} key={task.id}>
                    <div>
                      <span>{task.phase}</span>
                      <strong>{task.title}</strong>
                    </div>
                    <div className="taskMeta">
                      <span>{task.agentId}</span>
                      <span>{task.status}</span>
                      <span>{task.workspaceMode}</span>
                    </div>
                    <p>{(task.acceptanceCriteria || []).join(" / ")}</p>
                    {blockers.length > 0 && <small className="taskNote">Blocked by {blockers.join(", ")}</small>}
                    {task.runId && (
                      <div className="taskRunBox">
                        <code>{task.runId}</code>
                        {task.runSummary && <span>{task.runSummary}</span>}
                        {task.worktreePath && <small>{task.worktreePath}</small>}
                      </div>
                    )}
                    {task.diffStat && <pre className="miniPre">{task.diffStat}</pre>}
                    {patches.length > 0 && (
                      <div className="patchList">
                        {patches.map((patch) => {
                          const patchBusyKey = `${task.id}:patch:${patch.stepId}:${patch.index}`;
                          return (
                            <div className="patchCandidate" key={`${patch.stepId}-${patch.index}`}>
                              <div>
                                <strong>{patch.stepName || patch.stepId} patch {Number(patch.index) + 1}</strong>
                                <span>{patch.applied ? "applied" : patch.canApply ? "validated" : "needs review"}</span>
                              </div>
                              <button
                                className="iconTextButton"
                                onClick={() => applyTaskPatch(task, patch)}
                                disabled={!patch.canApply || patch.applied || taskBusy === patchBusyKey}
                              >
                                <FileDiff size={16} />
                                {taskBusy === patchBusyKey ? "Applying" : patch.applied ? "Applied" : "Apply"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="taskActions">
                      <button className="iconTextButton" onClick={() => runTask(task.id)} disabled={!canRunTask(task)}>
                        <Play size={16} />
                        {taskBusy === task.id ? "Starting" : "Run Task"}
                      </button>
                      {task.runId && task.workspaceMode === "worktree" && (
                        <button className="iconTextButton" onClick={() => onReviewRun?.(task.runId)}>
                          <FileDiff size={16} />
                          Review Diff
                        </button>
                      )}
                      {task.artifacts?.length > 0 && <span>{task.artifacts.length} artifacts</span>}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="panel surface">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Verification</p>
                <h3>Evals and Backtests</h3>
              </div>
              <SquareTerminal size={22} />
            </div>
            <div className="evalList">
              {(objective.evalPlan || []).map((item) => (
                <div className="evalItem" key={item.id}>
                  <strong>{item.name}</strong>
                  <span>{item.type} - {item.reason}</span>
                  <code>{item.command}</code>
                </div>
              ))}
            </div>
          </section>

          <section className="panel surface">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Delivery</p>
                <h3>Definition of Done</h3>
              </div>
              <Clipboard size={22} />
            </div>
            <div className="gateList">
              {(objective.delivery?.checklist || []).map((item) => (
                <div key={item}><Check size={16} /> {item}</div>
              ))}
            </div>
            <p className="mutedNote">{objective.contextPolicy?.strategy}</p>
          </section>
        </>
      )}
    </div>
  );
}

function AgentsView({ config, tools, setConfig, saveConfig, saving }) {
  const roles = config?.roles ?? [];
  const toolOptions = tools?.length ? tools : [];

  function updateRole(roleId, patch) {
    setConfig({
      ...config,
      roles: roles.map((role) => role.id === roleId ? { ...role, ...patch } : role)
    });
  }

  return (
    <div className="pageGrid">
      <section className="panel surface">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Swarm</p>
            <h3>Agent Roles</h3>
          </div>
          <Workflow size={22} />
        </div>
        <div className="roleCards">
          {roles.map((role) => (
            <article className="roleCard" key={role.id}>
              <div className="roleCardHeader">
                <span className="roleIcon large">
                  {role.id === "planner" && <Brain size={18} />}
                  {role.id === "implementer" && <Code2 size={18} />}
                  {role.id === "reviewer" && <FileDiff size={18} />}
                  {role.id === "tester" && <SquareTerminal size={18} />}
                </span>
                <div>
                  <h4>{role.name}</h4>
                  <p>{role.defaultTool} · {role.model}</p>
                </div>
              </div>
              <p>{role.instruction}</p>
              <div className="roleControls">
                <label className="field">
                  <span>Tool</span>
                  <select value={role.defaultTool} onChange={(event) => updateRole(role.id, { defaultTool: event.target.value })}>
                    {toolOptions.map((tool) => (
                      <option key={tool.id} value={tool.id}>
                        {tool.label}{tool.installed ? "" : " (not installed)"}
                      </option>
                    ))}
                  </select>
                </label>
                <button className="iconTextButton" onClick={() => saveConfig()} disabled={saving}>
                  <Save size={16} />
                  {saving ? "Saving" : "Save"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="panel surface">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Review Gates</p>
            <h3>Collaboration Pattern</h3>
          </div>
          <ShieldCheck size={22} />
        </div>
        <div className="gateList">
          <div><Check size={16} /> Planner creates a scoped implementation map.</div>
          <div><Check size={16} /> Implementer edits in an isolated worktree.</div>
          <div><Check size={16} /> Reviewer critiques the diff before merge.</div>
          <div><Check size={16} /> Tester runs checks and reports failures.</div>
          <div><Check size={16} /> Stronger model arbitrates disagreements.</div>
        </div>
      </section>
    </div>
  );
}

function DiffReviewView({ project, initialRunId }) {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(initialRunId || null);
  const [gateBundle, setGateBundle] = useState(null);
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState(null);

  const projectPath = project?.path?.toLowerCase?.() || "";
  const reviewRuns = useMemo(() => {
    return runs
      .filter((run) => {
        if (!run.worktreePath || !run.sourceProjectPath) return false;
        if (!projectPath) return true;
        if (run.id === initialRunId) return true;
        return run.sourceProjectPath.toLowerCase() === projectPath;
      })
      .slice(0, 60);
  }, [runs, projectPath, initialRunId]);

  async function loadRuns() {
    setBusy(true);
    setError(null);
    try {
      const result = await api("/api/runs");
      const nextRuns = result.runs || [];
      setRuns(nextRuns);
      if (initialRunId) {
        setSelectedRunId(initialRunId);
      } else if (!selectedRunId) {
        const first = nextRuns.find((run) => run.worktreePath && run.sourceProjectPath);
        if (first) setSelectedRunId(first.id);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadGate(runId = selectedRunId) {
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api(`/api/runs/${encodeURIComponent(runId)}/merge-gate`);
      setGateBundle(result);
    } catch (err) {
      setGateBundle(null);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function mergeRun(archiveLease = false) {
    if (!selectedRunId) return;
    setMerging(true);
    setError(null);
    try {
      const result = await api(`/api/runs/${encodeURIComponent(selectedRunId)}/merge`, {
        method: "POST",
        body: JSON.stringify({ archiveLease })
      });
      setGateBundle(result);
      setRuns((current) => current.map((run) => (run.id === result.run?.id ? result.run : run)));
    } catch (err) {
      setError(err.message);
    } finally {
      setMerging(false);
    }
  }

  useEffect(() => {
    loadRuns();
  }, [project?.path]);

  useEffect(() => {
    if (initialRunId) setSelectedRunId(initialRunId);
  }, [initialRunId]);

  useEffect(() => {
    if (!selectedRunId && reviewRuns[0]) {
      setSelectedRunId(reviewRuns[0].id);
    }
  }, [reviewRuns, selectedRunId]);

  useEffect(() => {
    if (selectedRunId) {
      loadGate(selectedRunId);
    }
  }, [selectedRunId]);

  const selectedRun = gateBundle?.run || reviewRuns.find((run) => run.id === selectedRunId);
  const gate = gateBundle?.gate;
  const changedFiles = gate?.changedFiles || [];

  return (
    <div className="pageGrid reviewPage">
      <section className="panel surface">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Review Queue</p>
            <h3>Managed Worktree Runs</h3>
          </div>
          <button className="iconTextButton" onClick={loadRuns} disabled={busy}>
            <RefreshCcw size={16} />
            {busy ? "Refreshing" : "Refresh"}
          </button>
        </div>
        {error && <div className="providerOutput error"><p>{error}</p></div>}
        <div className="reviewRunList">
          {reviewRuns.map((run) => (
            <button
              key={run.id}
              className={classNames("reviewRunItem", run.id === selectedRunId && "selected")}
              onClick={() => setSelectedRunId(run.id)}
            >
              <strong>{run.title || run.prompt || run.id}</strong>
              <span>{run.status} - {run.providerId || "provider"} - {run.model || "model"}</span>
              <code>{run.id}</code>
            </button>
          ))}
          {reviewRuns.length === 0 && (
            <div className="emptyConversation">
              <FileDiff size={22} />
              <strong>No worktree runs to review</strong>
              <span>Start an objective task or agent run in Worktree mode, then return here.</span>
            </div>
          )}
        </div>
      </section>

      <section className="panel surface">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Merge Gate</p>
            <h3>{selectedRun?.title || "Select a run"}</h3>
          </div>
          <FileDiff size={22} />
        </div>
        {selectedRun && (
          <div className="runMeta">
            <span>{selectedRun.status}</span>
            <span>{selectedRun.workspaceMode}</span>
            <span>{selectedRun.mode}</span>
          </div>
        )}
        {gate && (
          <>
            <div className="reviewMetricGrid">
              <div>
                <strong>{changedFiles.length}</strong>
                <span>files</span>
              </div>
              <div>
                <strong>{gate.canApply ? "yes" : "no"}</strong>
                <span>applies</span>
              </div>
              <div>
                <strong>{gate.sourceDirty ? "dirty" : "clean"}</strong>
                <span>source</span>
              </div>
              <div>
                <strong>{gate.merged ? "done" : gate.canMerge ? "ready" : "blocked"}</strong>
                <span>merge</span>
              </div>
            </div>
            <div className={classNames("providerOutput", !gate.canMerge && !gate.merged && "error")}>
              <strong>{gate.merged ? "Merged" : gate.canMerge ? "Ready to merge" : "Needs attention"}</strong>
              <p>{gate.warning || gate.checkOutput || "Review the diff before merging."}</p>
              {gate.patchPath && <small>{gate.patchPath}</small>}
            </div>
            <div className="mergeActions">
              <button className="primaryAction" onClick={() => mergeRun(false)} disabled={merging || !gate.canMerge}>
                <FileDiff size={16} />
                {merging ? "Merging" : "Merge to Source"}
              </button>
              <button className="iconTextButton" onClick={() => mergeRun(true)} disabled={merging || !gate.canMerge}>
                <History size={16} />
                Merge + Archive
              </button>
              <button className="iconTextButton" onClick={() => loadGate()} disabled={busy}>
                <RefreshCcw size={16} />
                Recheck
              </button>
            </div>
          </>
        )}
      </section>

      {gate && (
        <>
          <section className="panel surface full">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Changed Files</p>
                <h3>Diff Summary</h3>
              </div>
              <span className="countPill">{changedFiles.length}</span>
            </div>
            <div className="reviewPaths">
              <label className="pathLine">
                <FolderOpen size={14} />
                <code>{gate.sourceProjectPath}</code>
              </label>
              <label className="pathLine">
                <GitBranch size={14} />
                <code>{gate.worktreePath}</code>
              </label>
            </div>
            <div className="changedFileList">
              {changedFiles.map((file) => (
                <div className="changedFile" key={`${file.status}-${file.file}`}>
                  <strong>{file.status}</strong>
                  <code>{file.file}</code>
                </div>
              ))}
            </div>
            {gate.diffStat && <pre className="miniPre">{gate.diffStat}</pre>}
            {gate.sourceStatus && (
              <details className="statusDetails">
                <summary>Source status</summary>
                <pre className="miniPre">{gate.sourceStatus}</pre>
              </details>
            )}
            {gate.worktreeStatus && (
              <details className="statusDetails">
                <summary>Worktree status</summary>
                <pre className="miniPre">{gate.worktreeStatus}</pre>
              </details>
            )}
          </section>

          <section className="panel surface full">
            <div className="panelHeader">
              <div>
                <p className="eyebrow">Patch Preview</p>
                <h3>Review Before Merge</h3>
              </div>
              {gate.diffText && <CopyButton value={gate.diffText} />}
            </div>
            <pre className="diffPreview">{gate.diffPreview || "No diff available."}</pre>
          </section>
        </>
      )}
    </div>
  );
}

function WorktreesView({ project }) {
  const [leases, setLeases] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function refreshLeases() {
    setBusy(true);
    setError(null);
    try {
      const suffix = project?.path ? `?projectPath=${encodeURIComponent(project.path)}` : "";
      const result = await api(`/api/worktrees${suffix}`);
      setLeases(result.leases || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function archiveLease(leaseId) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/worktrees/${leaseId}/archive`, { method: "POST", body: JSON.stringify({}) });
      await refreshLeases();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshLeases();
  }, [project?.path]);

  return (
    <div className="pageGrid">
      <section className="panel surface full">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Isolation</p>
            <h3>Worktree Leases</h3>
          </div>
          <button className="iconTextButton" onClick={refreshLeases} disabled={busy}>
            <RefreshCcw size={16} />
            {busy ? "Refreshing" : "Refresh"}
          </button>
        </div>
        {error && <div className="providerOutput error"><p>{error}</p></div>}
        <div className="leaseSummary">
          <div>
            <strong>{leases.filter((lease) => lease.status === "active").length}</strong>
            <span>active</span>
          </div>
          <div>
            <strong>{leases.filter((lease) => lease.dirty).length}</strong>
            <span>dirty</span>
          </div>
          <div>
            <strong>{project?.name || "All projects"}</strong>
            <span>scope</span>
          </div>
        </div>
        <div className="leaseList">
          {leases.map((lease) => (
            <article className={classNames("leaseCard", lease.status === "archived" && "archived")} key={lease.id}>
              <div className="panelHeader compact">
                <div>
                  <p className="eyebrow">{lease.status}</p>
                  <h4>{lease.title || lease.objectiveKey}</h4>
                </div>
                {lease.status !== "archived" && (
                  <button className="iconTextButton" onClick={() => archiveLease(lease.id)} disabled={busy}>
                    <History size={16} />
                    Archive
                  </button>
                )}
              </div>
              <div className="leaseMeta">
                <span>{lease.baseBranch || "detached"}</span>
                <span>{lease.baseCommit ? lease.baseCommit.slice(0, 8) : "no commit"}</span>
                <span>{lease.dirty ? "dirty" : "clean"}</span>
                <span>{lease.exists ? "exists" : "missing"}</span>
              </div>
              <label className="pathLine">
                <GitBranch size={14} />
                <code>{lease.executionPath || lease.path}</code>
              </label>
              {lease.gitStatus && (
                <pre className="miniPre">{lease.gitStatus}</pre>
              )}
              {lease.diffStat && (
                <pre className="miniPre">{lease.diffStat}</pre>
              )}
            </article>
          ))}
          {leases.length === 0 && (
            <div className="emptyConversation">
              <GitBranch size={22} />
              <strong>No managed worktrees yet</strong>
              <span>Choose Worktree mode in the composer, then start an agent run.</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ModelsView({ config, setConfig, saveConfig, providerStatus = [] }) {
  const [providerModels, setProviderModels] = useState({});
  const [selectedModels, setSelectedModels] = useState({});
  const [testResults, setTestResults] = useState({});
  const [busyProvider, setBusyProvider] = useState(null);
  const [scout, setScout] = useState(null);
  const [scoutBusy, setScoutBusy] = useState(false);

  if (!config) return null;

  function updateProvider(id, patch) {
    setConfig({
      ...config,
      providers: config.providers.map((provider) => (provider.id === id ? { ...provider, ...patch } : provider))
    });
  }

  function statusFor(provider) {
    return providerStatus.find((item) => item.id === provider.id);
  }

  function canTestProvider(provider) {
    const status = statusFor(provider);
    return Boolean(status?.configured || provider.kind === "local-openai-compatible");
  }

  function priceText(value) {
    if (value === null || value === undefined) return "-";
    if (value === 0) return "$0";
    return `$${value.toFixed(value < 1 ? 3 : 2)}`;
  }

  function selectProvider(provider, model) {
    const selectedModel = model || selectedModels[provider.id] || provider.models?.[0] || config.activeModel;
    setConfig({
      ...config,
      activeProviderId: provider.id,
      activeModel: selectedModel
    });
  }

  async function loadModels(provider) {
    setBusyProvider(`${provider.id}:models`);
    setTestResults({ ...testResults, [provider.id]: null });
    try {
      const result = await api(`/api/providers/${provider.id}/models`);
      setProviderModels({ ...providerModels, [provider.id]: result.models ?? [] });
      if (result.models?.[0]?.id) {
        setSelectedModels({ ...selectedModels, [provider.id]: result.models[0].id });
        if (config.activeProviderId === provider.id) {
          setConfig({ ...config, activeModel: result.models[0].id });
        }
      }
    } catch (err) {
      setTestResults({ ...testResults, [provider.id]: { error: err.message } });
    } finally {
      setBusyProvider(null);
    }
  }

  async function testProvider(provider) {
    const model = selectedModels[provider.id] || provider.models?.[0] || "";
    setBusyProvider(`${provider.id}:test`);
    try {
      const result = await api("/api/providers/test", {
        method: "POST",
        body: JSON.stringify({
          providerId: provider.id,
          model,
          prompt: "Reply in one sentence: API wiring is working for Agent Command Center."
        })
      });
      setTestResults({ ...testResults, [provider.id]: result });
    } catch (err) {
      setTestResults({ ...testResults, [provider.id]: { error: err.message } });
    } finally {
      setBusyProvider(null);
    }
  }

  async function scoutLatestModels() {
    setScoutBusy(true);
    try {
      setScout(await api("/api/models/scout"));
    } catch (err) {
      setScout({ error: err.message, models: [] });
    } finally {
      setScoutBusy(false);
    }
  }

  function useScoutedModel(model) {
    const provider = config.providers.find((item) => item.id === model.providerId);
    if (!provider) return;
    const nextProviders = config.providers.map((item) => {
      if (item.id !== provider.id || item.models.includes(model.id)) return item;
      return { ...item, models: [model.id, ...item.models] };
    });
    setSelectedModels({ ...selectedModels, [provider.id]: model.id });
    setConfig({
      ...config,
      providers: nextProviders,
      activeProviderId: provider.id,
      activeModel: model.id
    });
  }

  return (
    <div className="pageGrid">
      <section className="panel surface full">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Routing</p>
            <h3>Model Providers</h3>
          </div>
          <button className="iconTextButton" onClick={saveConfig}>
            <Save size={16} />
            Save
          </button>
        </div>
        <div className="modelStatusGrid">
          {providerStatus.map((provider) => (
            <div className="statusPill" key={provider.id}>
              <StatusDot ok={provider.configured} tone="missing" />
              <span>{provider.name}</span>
              <strong>{provider.configured ? "Configured" : "Missing"}</strong>
            </div>
          ))}
        </div>
        <div className="modelScout">
          <div className="modelScoutTop">
            <div>
              <p className="eyebrow">Model scout</p>
              <h4>Cheap and cutting-edge watchlist</h4>
            </div>
            <button className="iconTextButton" onClick={scoutLatestModels} disabled={scoutBusy}>
              <Sparkles size={16} />
              {scoutBusy ? "Scanning" : "Scan Latest"}
            </button>
          </div>
          {scout?.error && <div className="providerOutput error"><p>{scout.error}</p></div>}
          {(scout?.models?.length ?? 0) > 0 && (
            <div className="scoutGrid">
              {scout.models.map((model) => (
                <button className="scoutRow" key={model.id} onClick={() => useScoutedModel(model)}>
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.id}</small>
                  </span>
                  <span>{model.reason}</span>
                  <span>{model.contextLength ? `${Math.round(model.contextLength / 1000)}K ctx` : "ctx -"}</span>
                  <span>{priceText(model.promptPerMillion)} / {priceText(model.completionPerMillion)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="providerGrid">
          {config.providers.map((provider) => (
            <article key={provider.id} className={classNames("providerCard", config.activeProviderId === provider.id && "selected")}>
              <div className="providerTitle">
                <button
                  className="smallIconButton"
                  title="Use provider"
                  onClick={() => selectProvider(provider)}
                >
                  {config.activeProviderId === provider.id ? <Check size={15} /> : <Zap size={15} />}
                </button>
                <div>
                  <h4>{provider.name}</h4>
                  {config.activeProviderId === provider.id && (
                    <small className="activeModelLine">Active model: {config.activeModel || provider.models?.[0] || "not selected"}</small>
                  )}
                  <p>
                    {provider.kind} · {statusFor(provider)?.configured ? `${provider.apiKeyEnv} found` : `${provider.apiKeyEnv} missing`}
                  </p>
                </div>
              </div>
              <label className="field">
                <span>Base URL</span>
                <input value={provider.baseUrl} onChange={(event) => updateProvider(provider.id, { baseUrl: event.target.value })} />
              </label>
              <label className="field">
                <span>API key env</span>
                <input value={provider.apiKeyEnv} onChange={(event) => updateProvider(provider.id, { apiKeyEnv: event.target.value })} />
              </label>
              <label className="field">
                <span>Models</span>
                <input
                  value={provider.models.join(", ")}
                  onChange={(event) =>
                    updateProvider(provider.id, {
                      models: event.target.value.split(",").map((item) => item.trim()).filter(Boolean)
                    })
                  }
                />
              </label>
              {liveModelProviderIds.has(provider.id) && (
                <>
                  <div className="providerActions">
                    <button className="iconTextButton" onClick={() => loadModels(provider)} disabled={busyProvider === `${provider.id}:models`}>
                      <RefreshCcw size={16} />
                      {busyProvider === `${provider.id}:models` ? "Loading" : "Load Models"}
                    </button>
                    <button
                      className="primaryAction"
                      onClick={() => testProvider(provider)}
                      disabled={!canTestProvider(provider) || busyProvider === `${provider.id}:test`}
                    >
                      <Play size={16} />
                      {busyProvider === `${provider.id}:test` ? "Testing" : "Test API"}
                    </button>
                  </div>
                  {(providerModels[provider.id]?.length ?? 0) > 0 && (
                    <label className="field">
                      <span>Available model</span>
                      <select
                        value={selectedModels[provider.id] || providerModels[provider.id][0]?.id || ""}
                        onChange={(event) => {
                          const model = event.target.value;
                          setSelectedModels({ ...selectedModels, [provider.id]: model });
                          selectProvider(provider, model);
                        }}
                      >
                        {providerModels[provider.id].map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.displayName || model.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {testResults[provider.id] && (
                    <div className={classNames("providerOutput", testResults[provider.id].error && "error")}>
                      {testResults[provider.id].error ? (
                        <p>{testResults[provider.id].error}</p>
                      ) : (
                        <>
                          <strong>{testResults[provider.id].model}</strong>
                          <p>{testResults[provider.id].text || "No text returned."}</p>
                          {testResults[provider.id].usage && <small>{JSON.stringify(testResults[provider.id].usage)}</small>}
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ToolsView({ tools }) {
  return (
    <div className="pageGrid">
      <section className="panel surface full">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Stack</p>
            <h3>Toolchain</h3>
          </div>
          <Hammer size={22} />
        </div>
        <div className="toolTable">
          {tools.map((tool) => (
            <article className="toolRow" key={tool.id}>
              <div className="toolName">
                <StatusDot ok={tool.installed} tone="missing" />
                <div>
                  <h4>{tool.label}</h4>
                  <p>{tool.role}</p>
                </div>
              </div>
              <div className="toolPath">{tool.installed ? tool.path : "Not found"}</div>
              <div className="installCommands">
                {tool.install.map((command) => (
                  <CommandLine key={command} value={command} />
                ))}
              </div>
              <a className="sourceLink" href={tool.source} target="_blank" rel="noreferrer">
                Docs
              </a>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function RevenueView() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  async function refreshStripe() {
    setError(null);
    try {
      setStatus(await api("/api/stripe/status"));
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    refreshStripe();
  }, []);

  return (
    <div className="pageGrid">
      <section className="panel surface full">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Sandbox</p>
            <h3>Stripe Revenue Lab</h3>
          </div>
          <button className="iconTextButton" onClick={refreshStripe}>
            <RefreshCcw size={16} />
            Refresh
          </button>
        </div>
        {error && <div className="providerOutput error"><p>{error}</p></div>}
        <div className="modelStatusGrid">
          <div className="statusPill">
            <StatusDot ok={status?.publishableConfigured} tone="missing" />
            <span>Publishable key</span>
            <strong>{status?.publishableConfigured ? "Ready" : "Missing"}</strong>
          </div>
          <div className="statusPill">
            <StatusDot ok={status?.secretConfigured} tone="missing" />
            <span>Secret key</span>
            <strong>{status?.secretConfigured ? "Ready" : "Missing"}</strong>
          </div>
          <div className="statusPill">
            <StatusDot ok={status?.webhookSecretConfigured} tone="missing" />
            <span>Webhook secret</span>
            <strong>{status?.webhookSecretConfigured ? "Ready" : "Needed"}</strong>
          </div>
          <div className="statusPill">
            <StatusDot ok={status?.listener?.running} tone="missing" />
            <span>Background listener</span>
            <strong>{status?.listener?.running ? "Running" : "Stopped"}</strong>
          </div>
        </div>
        <div className="revenueGrid">
          <article className="revenueCard">
            <div className="panelHeader compact">
              <div>
                <p className="eyebrow">Forward target</p>
                <h4>Local webhook endpoint</h4>
              </div>
              {status?.webhookUrl && <CopyButton value={status.webhookUrl} />}
            </div>
            <CommandLine value={status?.webhookUrl || "http://127.0.0.1:8787/stripe/webhook"} />
          </article>
          <article className="revenueCard">
            <div className="panelHeader compact">
              <div>
                <p className="eyebrow">Stripe CLI</p>
                <h4>Background listener</h4>
              </div>
              <CopyButton value={`stripe listen --forward-to ${status?.webhookUrl || "http://127.0.0.1:8787/stripe/webhook"}`} />
            </div>
            <CommandLine value={status?.listener?.command || `stripe listen --forward-to ${status?.webhookUrl || "http://127.0.0.1:8787/stripe/webhook"}`} />
            {status?.listener?.lastOutput && <p className="mutedNote">{status.listener.lastOutput}</p>}
            {status?.listener?.error && <div className="providerOutput error"><p>{status.listener.error}</p></div>}
          </article>
          <article className="revenueCard">
            <div className="panelHeader compact">
              <div>
                <p className="eyebrow">Events</p>
                <h4>Recommended sandbox events</h4>
              </div>
            </div>
            <div className="eventChips">
              <span>checkout.session.completed</span>
              <span>payment_intent.succeeded</span>
              <span>payment_intent.payment_failed</span>
              <span>customer.subscription.created</span>
              <span>customer.subscription.updated</span>
              <span>customer.subscription.deleted</span>
            </div>
          </article>
        </div>
      </section>
    </div>
  );
}

function SettingsView() {
  return (
    <div className="pageGrid">
      <section className="panel surface">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Permissions</p>
            <h3>Local Policy</h3>
          </div>
          <ShieldCheck size={22} />
        </div>
        <div className="gateList">
          <div><Check size={16} /> Read and write only selected projects.</div>
          <div><Check size={16} /> Ask before network calls.</div>
          <div><Check size={16} /> Ask before destructive commands.</div>
          <div><Check size={16} /> Keep keys in environment variables.</div>
        </div>
      </section>
      <section className="panel surface">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">Launch</p>
            <h3>Desktop Path</h3>
          </div>
          <History size={22} />
        </div>
        <div className="gateList">
          <div><Check size={16} /> Current MVP runs as a local web app.</div>
          <div><Check size={16} /> Next package target is Tauri for a Windows desktop shell.</div>
          <div><Check size={16} /> Same UI can wrap local CLIs and MCP servers.</div>
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [activeView, setActiveView] = useState("chat");
  const [tools, setTools] = useState([]);
  const [config, setConfig] = useState(null);
  const [providerStatus, setProviderStatus] = useState([]);
  const [workspace, setWorkspace] = useState(null);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [threadBundle, setThreadBundle] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [reviewRunId, setReviewRunId] = useState(null);

  async function refresh() {
    setError(null);
    try {
      const [toolData, configData, providerData, workspaceData] = await Promise.all([
        api("/api/tools"),
        api("/api/config"),
        api("/api/providers/status"),
        api("/api/workspace")
      ]);
      setTools(toolData.tools);
      setConfig(configData);
      setProviderStatus(providerData.providers || []);
      setWorkspace(workspaceData);
      setActiveProjectId((current) => current || workspaceData.activeProjectId);
      setActiveThreadId((current) => current || workspaceData.activeThreadId);
    } catch (err) {
      setError(err.message);
    }
  }

  async function saveConfig(nextConfig = config) {
    setSaving(true);
    try {
      setConfig(await api("/api/config", { method: "POST", body: JSON.stringify(nextConfig) }));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function refreshThreadBundle(threadId = activeThreadId) {
    if (!threadId) return null;
    const bundle = await api(`/api/threads/${threadId}`);
    setThreadBundle(bundle);
    return bundle;
  }

  useEffect(() => {
    if (!activeThreadId) return;
    refreshThreadBundle(activeThreadId)
      .catch((err) => setError(err.message));
  }, [activeThreadId]);

  async function chooseProjectFolder() {
    setError(null);
    try {
      const result = await api("/api/projects/select-folder", { method: "POST", body: JSON.stringify({}) });
      if (result.canceled) return;
      const workspaceData = await api("/api/workspace");
      setWorkspace(workspaceData);
      setActiveProjectId(result.project.id);
      const created = await api("/api/threads", {
        method: "POST",
        body: JSON.stringify({
          projectId: result.project.id,
          title: `Work in ${result.project.name}`
        })
      });
      const nextWorkspace = await api("/api/workspace");
      setWorkspace(nextWorkspace);
      setActiveThreadId(created.thread.id);
      setActiveView("chat");
    } catch (err) {
      setError(err.message);
    }
  }

  async function createNewThread() {
    setError(null);
    try {
      const created = await api("/api/threads", {
        method: "POST",
        body: JSON.stringify({
          projectId: activeProjectId || workspace?.activeProjectId,
          title: "New agent chat"
        })
      });
      setWorkspace(await api("/api/workspace"));
      setActiveThreadId(created.thread.id);
      setActiveView("chat");
      return created.thread.id;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }

  /** Resolve a thread id, creating one on first use. */
  async function ensureThreadId() {
    return activeThreadId || await createNewThread();
  }

  async function sendThreadMessage(content) {
    const threadId = await ensureThreadId();
    if (!threadId) {
      return;
    }
    const bundle = await api(`/api/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content, respond: true })
    });
    setThreadBundle(bundle);
    setActiveThreadId(threadId);
    setWorkspace(await api("/api/workspace"));
  }

  return (
    <div className="desktopShell">
      <AppRail activeView={activeView} setActiveView={setActiveView} />
      <WorkspaceThreadList
        tools={tools}
        workspace={workspace}
        activeProjectId={activeProjectId}
        activeThreadId={activeThreadId}
        onChooseFolder={chooseProjectFolder}
        onNewThread={createNewThread}
        onSelectThread={(threadId) => {
          setActiveThreadId(threadId);
          setActiveView("chat");
        }}
      />
      <main className="mainPane">
        <TopBar
          config={config}
          onRefresh={refresh}
          saving={saving}
          activeView={activeView}
          setActiveView={setActiveView}
        />
        {error && (
          <div className="errorBanner">
            <X size={16} />
            {error}
          </div>
        )}
        {activeView === "chat" && config && (
          <WorkspaceChatView
            config={config}
            project={threadBundle?.project}
            thread={threadBundle?.thread}
            messages={threadBundle?.messages || []}
            context={threadBundle?.context}
            activeGoal={threadBundle?.activeGoal}
            activeLoop={threadBundle?.activeLoop}
            activeObjective={threadBundle?.activeObjective}
            onSendMessage={sendThreadMessage}
            onEnsureThread={ensureThreadId}
            onChooseFolder={chooseProjectFolder}
          />
        )}
        {activeView === "objectives" && (
          <ObjectivesView
            project={threadBundle?.project || workspace?.projects?.find((project) => project.id === activeProjectId)}
            thread={threadBundle?.thread}
            activeObjective={threadBundle?.activeObjective}
            onChooseFolder={chooseProjectFolder}
            onObjectiveStarted={() => refreshThreadBundle()}
            onReviewRun={(runId) => {
              setReviewRunId(runId);
              setActiveView("review");
            }}
          />
        )}
        {activeView === "agents" && (
          <AgentsView
            config={config}
            tools={tools}
            setConfig={setConfig}
            saveConfig={saveConfig}
            saving={saving}
          />
        )}
        {activeView === "worktrees" && (
          <WorktreesView project={threadBundle?.project || workspace?.projects?.find((project) => project.id === activeProjectId)} />
        )}
        {activeView === "review" && (
          <DiffReviewView
            project={threadBundle?.project || workspace?.projects?.find((project) => project.id === activeProjectId)}
            initialRunId={reviewRunId}
          />
        )}
        {activeView === "models" && (
          <ModelsView
            config={config}
            setConfig={setConfig}
            saveConfig={saveConfig}
            providerStatus={providerStatus}
          />
        )}
        {activeView === "tools" && <ToolsView tools={tools} />}
        {activeView === "revenue" && <RevenueView />}
        {activeView === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
