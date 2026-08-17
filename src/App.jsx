/**
 * Agent Command Center — desktop shell.
 *
 * Deliberately one surface, not six tabs. The previous UI exposed Objectives,
 * Agent Roles, a Stack Toolchain and an Agent Council, none of which were
 * connected to anything at runtime — so the app advertised capability it did
 * not have and made its real capability harder to find.
 *
 * The rule here: every control maps to something that actually executes.
 *
 *   left    projects, and the threads inside them
 *   centre  the conversation, with tool calls and diffs inline
 *   bottom  which agent is answering, and the approval posture
 *   right   only live state — tool calls, workflow runs, memory hits
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot, ChevronDown, FolderOpen, Loader2, Plus, Send, Settings,
  Square, Terminal, Workflow, X, Zap
} from "lucide-react";
import { useAgentSession } from "./useAgentSession.js";
import { PermissionDialog, ToolCallStream, ThoughtPanel, AgentStatusBar } from "./AgentPanels.jsx";

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try { data = JSON.parse(text); } catch { throw new Error(`${path}: invalid JSON`); }
  }
  if (!response.ok) throw new Error(data?.error || `${response.status} ${response.statusText}`);
  return data;
}

const cx = (...parts) => parts.filter(Boolean).join(" ");

/* ------------------------------------------------------------------ */
/* Agent picker — populated from what is actually runnable, never a
   hardcoded list. The old dropdown offered models that no longer exist. */

function AgentPicker({ value, onChange, harnesses, busy }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const groups = useMemo(() => {
    const installed = harnesses?.installed ?? [];
    const ready = harnesses?.ready ?? [];
    return [
      { label: "Installed", items: installed },
      { label: `Available (${ready.length})`, items: ready, needsConsent: true }
    ].filter((g) => g.items.length);
  }, [harnesses]);

  return (
    <div className="picker" ref={ref}>
      <button className="pickerButton" onClick={() => setOpen((v) => !v)} disabled={busy}>
        <Zap size={14} />
        <span className="pickerLabel">{value?.name ?? "Select agent"}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="pickerMenu">
          {groups.length === 0 && <div className="pickerEmpty">Loading agents…</div>}
          {groups.map((group) => (
            <div key={group.label}>
              <div className="pickerGroup">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={item.id ?? item.agentId}
                  className={cx("pickerItem", value?.id === (item.id ?? item.agentId) && "pickerItemActive")}
                  onClick={() => { onChange(item); setOpen(false); }}
                >
                  <span className="pickerItemName">{item.name}</span>
                  <span className="pickerItemMeta">
                    {item.license}
                    {/* Running a package off the network is a trust decision,
                        so it is labelled before it is chosen, not after. */}
                    {group.needsConsent && " · downloads on first use"}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Sidebar({ workspace, activeThreadId, onSelectThread, onNewThread, onChooseFolder }) {
  const projects = workspace?.projects ?? [];
  const threads = workspace?.threads ?? [];

  const byProject = useMemo(() => {
    const map = new Map();
    for (const project of projects) map.set(project.id, []);
    for (const thread of threads) {
      if (!map.has(thread.projectId)) map.set(thread.projectId, []);
      map.get(thread.projectId).push(thread);
    }
    return map;
  }, [projects, threads]);

  return (
    <aside className="sidebar">
      <div className="sidebarHead">
        <div>
          <div className="sidebarTitle">Command Center</div>
          <div className="sidebarSub">Local agent workspace</div>
        </div>
        <button className="iconBtn" onClick={onNewThread} title="New chat">
          <Plus size={16} />
        </button>
      </div>

      <div className="sidebarScroll">
        {projects.map((project) => (
          <div key={project.id} className="projectBlock">
            <div className="projectRow">
              <FolderOpen size={14} />
              <div className="projectMeta">
                <div className="projectName">{project.name}</div>
                <div className="projectPath">{project.path}</div>
              </div>
            </div>
            <div className="threadList">
              {(byProject.get(project.id) ?? []).map((thread) => (
                <button
                  key={thread.id}
                  className={cx("threadItem", thread.id === activeThreadId && "threadItemActive")}
                  onClick={() => onSelectThread(thread.id)}
                >
                  {thread.title || "Untitled"}
                </button>
              ))}
              {(byProject.get(project.id) ?? []).length === 0 && (
                <div className="threadEmpty">No chats yet</div>
              )}
            </div>
          </div>
        ))}

        <button className="addProject" onClick={onChooseFolder}>
          <Plus size={13} /> Add project folder
        </button>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */

function WorkflowPanel({ runs }) {
  if (!runs?.length) return null;
  return (
    <section className="panel">
      <div className="panelHead"><Workflow size={13} /> Workflow runs</div>
      {runs.map((run) => (
        <div key={run.runId} className="wfRun">
          <div className="wfTop">
            <span className="wfName">{run.name}</span>
            <span className={cx("wfStatus", `wf-${run.status}`)}>{run.status}</span>
          </div>
          {run.currentPhase && <div className="wfPhase">{run.currentPhase}</div>}
          <div className="wfPhases">
            {run.phases.map((p) => (
              <span key={p.title} className={cx("wfPhaseDot", `wfPhase-${p.state}`)} title={p.title} />
            ))}
          </div>
          {/* A run can spawn up to 1,024 agents, so the budget is shown
              during the run rather than discovered in a bill afterwards. */}
          <div className="wfBudget">
            <div className="wfBar"><div className="wfBarFill" style={{ width: `${run.budget.pctUsed}%` }} /></div>
            <span>
              {run.budget.used}/{run.budget.total} agents
              {run.budget.incomplete && " (approx)"}
            </span>
          </div>
          {run.activeAgents > 0 && <div className="wfActive">{run.activeAgents} running</div>}
          {run.resultSummary && <div className="wfSummary">{run.resultSummary}</div>}
        </div>
      ))}
    </section>
  );
}

function MemoryPanel({ hits }) {
  if (!hits?.length) return null;
  return (
    <section className="panel">
      <div className="panelHead">Recalled from project memory</div>
      {hits.map((m, i) => (
        <div key={i} className={cx("memHit", m.kind === "failure" && "memHitFailure")}>
          <span className="memKind">{m.kind}</span>
          <span className="memText">{m.text.split("\n")[0]}</span>
        </div>
      ))}
    </section>
  );
}

/* ------------------------------------------------------------------ */

export default function App() {
  const [workspace, setWorkspace] = useState(null);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [bundle, setBundle] = useState(null);
  const [harnesses, setHarnesses] = useState(null);
  const [agent, setAgent] = useState(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [workflowRuns, setWorkflowRuns] = useState([]);
  const scrollRef = useRef(null);

  const session = useAgentSession(activeThreadId);
  const project = workspace?.projects?.find((p) => p.id === bundle?.thread?.projectId)
    ?? workspace?.projects?.[0];

  useEffect(() => {
    api("/api/workspace").then(setWorkspace).catch((e) => setError(e.message));
    api("/api/harnesses/ready")
      .then((d) => setHarnesses({
        // The locally installed Grok is listed first and separately: it uses
        // the logged-in session, so it neither downloads nor bills per token.
        installed: [{ id: "grok-local", name: "Grok Build (installed)", license: "proprietary" }],
        ready: d.agents ?? []
      }))
      .catch(() => setHarnesses({ installed: [], ready: [] }));
  }, []);

  useEffect(() => {
    if (!agent && harnesses?.installed?.length) setAgent(harnesses.installed[0]);
  }, [harnesses, agent]);

  useEffect(() => {
    if (!activeThreadId) { setBundle(null); return; }
    api(`/api/threads/${activeThreadId}`).then(setBundle).catch((e) => setError(e.message));
  }, [activeThreadId]);

  // Workflow runs arrive on the event stream; there is no polling endpoint
  // because the agent pushes them.
  useEffect(() => {
    const bridge = window.agentBridge;
    if (bridge?.onWorkflow) {
      return bridge.onWorkflow(({ run, removed }) => {
        setWorkflowRuns((runs) => removed
          ? runs.filter((r) => r.runId !== run?.runId)
          : [run, ...runs.filter((r) => r.runId !== run.runId)]);
      });
    }
    const source = new EventSource("/api/agent/events");
    const handler = (e) => {
      const { run, removed } = JSON.parse(e.data);
      setWorkflowRuns((runs) => removed
        ? runs.filter((r) => r.runId !== run?.runId)
        : [run, ...runs.filter((r) => r.runId !== run.runId)]);
    };
    source.addEventListener("workflow", handler);
    return () => source.close();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [session.turns, bundle?.messages]);

  const newThread = useCallback(async () => {
    const created = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({ projectId: project?.id, title: "New chat" })
    }).catch((e) => { setError(e.message); return null; });
    if (created?.thread?.id) {
      setActiveThreadId(created.thread.id);
      setWorkspace(await api("/api/workspace"));
    }
    return created?.thread?.id ?? null;
  }, [project]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    // Queue rather than block while a turn is running; it flushes on completion.
    if (session.busy) { session.enqueue(text); setDraft(""); return; }
    const threadId = activeThreadId ?? await newThread();
    if (!threadId) return;
    setDraft("");
    session.send(text, { threadId, projectPath: project?.path }).catch(() => {});
  }, [draft, session, activeThreadId, newThread, project]);

  const messages = bundle?.messages ?? [];

  return (
    <div className="shell">
      <PermissionDialog request={session.permission} onAnswer={session.answerPermission} />

      <Sidebar
        workspace={workspace}
        activeThreadId={activeThreadId}
        onSelectThread={setActiveThreadId}
        onNewThread={newThread}
        onChooseFolder={async () => {
          await api("/api/projects/select-folder", { method: "POST" }).catch((e) => setError(e.message));
          setWorkspace(await api("/api/workspace"));
        }}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbarTitle">{bundle?.thread?.title ?? "Agent Command Center"}</div>
          <div className="topbarRight">
            <AgentStatusBar
              connection={session.connection}
              error={session.error}
              busy={session.busy}
              onCancel={session.cancel}
            />
            <button className="iconBtn" onClick={() => setShowSettings(true)} title="Settings">
              <Settings size={15} />
            </button>
          </div>
        </header>

        {error && <div className="banner bannerError" onClick={() => setError(null)}>{error}</div>}

        <div className="conversation" ref={scrollRef}>
          {messages.length === 0 && session.turns.length === 0 && (
            <div className="empty">
              <Bot size={26} />
              <h2>Start building</h2>
              <p>
                Point at a project folder and describe what you want. The agent reads and
                edits files directly, and asks before it writes.
              </p>
            </div>
          )}

          {messages.map((m) => (
            <Message key={m.id} role={m.role} text={m.content} />
          ))}

          {session.turns.map((turn, i) => (
            <Message key={`t${i}`} role={turn.role} text={turn.text} agentName={agent?.name} />
          ))}

          {(session.thought || session.toolCalls.length > 0) && (
            <div className="messageRow assistant">
              <div className="avatar"><Bot size={15} /></div>
              <div className="bubble">
                <ThoughtPanel thought={session.thought} />
                <ToolCallStream toolCalls={session.toolCalls} />
              </div>
            </div>
          )}
        </div>

        <div className="composer">
          {session.queue.length > 0 && (
            <div className="queue">
              {session.queue.map((q) => (
                <div key={q.id} className="queueItem">
                  <span>{q.text}</span>
                  <button onClick={() => session.dequeue(q.id)}><X size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <textarea
            className="composerInput"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder={session.busy ? "Agent is working — your message will queue…" : "Describe what you want built…"}
            rows={3}
          />
          <div className="composerBar">
            <AgentPicker value={agent} onChange={setAgent} harnesses={harnesses} busy={session.busy} />
            <div className="composerSpacer" />
            {session.busy ? (
              <button className="sendBtn sendBtnStop" onClick={session.cancel}>
                <Square size={13} /> Stop
              </button>
            ) : (
              <button className="sendBtn" onClick={send} disabled={!draft.trim()}>
                <Send size={13} /> Send
              </button>
            )}
          </div>
        </div>
      </main>

      <aside className={cx("inspector", workflowRuns.length === 0 && session.toolCalls.length === 0 && "inspectorQuiet")}>
        <WorkflowPanel runs={workflowRuns} />
        <MemoryPanel hits={session.memoryHits} />
        {session.toolCalls.length > 0 && (
          <section className="panel">
            <div className="panelHead"><Terminal size={13} /> Activity</div>
            <ToolCallStream toolCalls={session.toolCalls} />
          </section>
        )}
        {workflowRuns.length === 0 && session.toolCalls.length === 0 && (
          <div className="inspectorEmpty">Live activity appears here while the agent works.</div>
        )}
      </aside>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} harnesses={harnesses} />}
    </div>
  );
}

function Message({ role, text, agentName }) {
  const isUser = role === "user";
  return (
    <div className={cx("messageRow", isUser ? "user" : "assistant")}>
      <div className="avatar">{isUser ? "T" : <Bot size={15} />}</div>
      <div className="bubble">
        <div className="bubbleWho">{isUser ? "You" : (agentName ?? "Agent")}</div>
        <div className="bubbleText">{text}</div>
      </div>
    </div>
  );
}

function SettingsPanel({ onClose, harnesses }) {
  const [providers, setProviders] = useState(null);
  const [auth, setAuth] = useState(null);

  useEffect(() => {
    api("/api/providers/status").then(setProviders).catch(() => {});
    api("/api/agent/auth").then(setAuth).catch(() => {});
  }, []);

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <h3>Settings</h3>
          <button className="iconBtn" onClick={onClose}><X size={16} /></button>
        </div>

        <section className="settingSection">
          <h4>Agent</h4>
          {auth ? (
            <div className="settingRow">
              <span>Signed in</span>
              <span className="settingValue">
                {auth.authenticated ? (auth.email ?? auth.methodId ?? "yes") : "not signed in"}
                {auth.authMode && ` · ${auth.authMode}`}
              </span>
            </div>
          ) : <div className="settingHint">Agent not connected yet.</div>}
          {auth?.dataRetentionOptOut === false && (
            // Surfaced because this project handles proprietary code and the
            // setting is otherwise only visible via a terminal command.
            <div className="settingWarn">
              Coding data may be retained for training. Change this in the agent's privacy settings.
            </div>
          )}
        </section>

        <section className="settingSection">
          <h4>Available agents</h4>
          <div className="settingHint">
            {harnesses?.ready?.length ?? 0} agents from the ACP registry can run here.
            Each downloads on first use.
          </div>
        </section>

        <section className="settingSection">
          <h4>API keys</h4>
          <div className="settingHint">Read from .env — never sent to the browser.</div>
          {(providers?.providers ?? []).map((p) => (
            <div key={p.id} className="settingRow">
              <span>{p.name}</span>
              <span className={cx("settingValue", p.configured ? "ok" : "muted")}>
                {p.configured ? "configured" : "not set"}
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
