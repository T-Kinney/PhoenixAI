/**
 * PhoenixAI — desktop shell.
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
  Bot, ChevronDown, Download, FileText, FolderOpen, Image, Loader2, Paperclip,
  Plus, Send, Settings, Square, Terminal, Workflow, X, Zap
} from "lucide-react";
import { useAgentSession } from "./useAgentSession.js";
import { PermissionDialog, ToolCallStream, ThoughtPanel, AgentStatusBar } from "./AgentPanels.jsx";

/** Anything larger than this is refused with a reason rather than silently truncated. */
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|svg)$/i;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read a File into the {name, data} shape the prompt endpoint expects. */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      // readAsDataURL gives "data:<mime>;base64,<payload>" — the server wants
      // only the payload.
      const comma = String(reader.result).indexOf(",");
      resolve({
        name: file.name || "pasted-file",
        size: file.size,
        data: String(reader.result).slice(comma + 1)
      });
    };
    reader.readAsDataURL(file);
  });
}

/** One attached file, with a way to remove it before sending. */
function AttachmentChip({ file, onRemove }) {
  const isImage = IMAGE_RE.test(file.name);
  return (
    <div className="attachChip" title={`${file.name} — ${formatBytes(file.size)}`}>
      {isImage ? <Image size={12} /> : <FileText size={12} />}
      <span className="attachName">{file.name}</span>
      <span className="attachSize">{formatBytes(file.size)}</span>
      <button className="attachRemove" onClick={() => onRemove(file.id)} title="Remove">
        <X size={11} />
      </button>
    </div>
  );
}

/**
 * Update notice.
 *
 * Deliberately silent for "checking", "current" and "error": a failed update
 * check is not the user's problem and an unreachable feed must not put a red
 * bar above their work. Only a download in progress or an update ready to
 * apply is worth a line.
 */
function UpdateBanner() {
  const [state, setState] = useState(null);

  useEffect(() => {
    const bridge = window.agentBridge;
    if (!bridge?.onUpdate) return undefined;
    // Replay first: a "ready" emitted before this window mounted would
    // otherwise leave a downloaded update with nothing to prompt the restart.
    bridge.updateState?.().then((s) => { if (s) setState(s); }).catch(() => {});
    return bridge.onUpdate(setState);
  }, []);

  if (state?.state === "downloading") {
    return (
      <div className="banner bannerUpdate">
        <Loader2 size={13} className="spin" />
        Downloading update {state.version ? `${state.version} ` : ""}— {state.percent ?? 0}%
      </div>
    );
  }

  if (state?.state === "ready") {
    return (
      <div className="banner bannerUpdate">
        <Download size={13} />
        <span>Update {state.version ?? ""} is ready.</span>
        <button
          className="bannerAction"
          onClick={() => window.agentBridge?.installUpdate?.()}
        >
          Restart and install
        </button>
      </div>
    );
  }

  return null;
}

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

function Sidebar({ workspace, activeThreadId, activeProjectId, onSelectProject,
                  onSelectThread, onNewThread, onChooseFolder }) {
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
          <div className="sidebarTitle">PhoenixAI</div>
          <div className="sidebarSub">Local agent workspace</div>
        </div>
        <button className="iconBtn" onClick={onNewThread} title="New chat">
          <Plus size={16} />
        </button>
      </div>

      <div className="sidebarScroll">
        {projects.map((project) => (
          <div key={project.id} className="projectBlock">
            <button
              className={cx("projectRow", project.id === activeProjectId && "projectRowActive")}
              onClick={() => onSelectProject(project.id)}
              title={`Work in ${project.path}`}
            >
              <FolderOpen size={14} />
              <div className="projectMeta">
                <div className="projectName">{project.name}</div>
                <div className="projectPath">{project.path}</div>
              </div>
            </button>
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

  const [activeProjectId, setActiveProjectId] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  // Drag events fire for every child element, so a plain boolean flickers.
  // Counting enter/leave pairs is what keeps the overlay stable.
  const dragDepth = useRef(0);
  const session = useAgentSession(activeThreadId);

  const addFiles = useCallback(async (fileList) => {
    const incoming = Array.from(fileList ?? []);
    if (!incoming.length) return;
    const accepted = [];
    for (const file of incoming) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
        continue;
      }
      try {
        const read = await readFile(file);
        accepted.push({ ...read, id: `${file.name}-${file.size}-${accepted.length}-${performance.now()}` });
      } catch (e) {
        setError(e.message);
      }
    }
    if (accepted.length) setAttachments((prev) => [...prev, ...accepted]);
  }, []);

  const removeAttachment = useCallback((id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // The agent's working directory. Explicit selection wins; otherwise follow
  // the open thread; otherwise the first project.
  const project = workspace?.projects?.find((p) => p.id === activeProjectId)
    ?? workspace?.projects?.find((p) => p.id === bundle?.thread?.projectId)
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
    // A file with no prose is a valid message.
    if (!text && attachments.length === 0) return;
    // Queue rather than block while a turn is running; it flushes on completion.
    if (session.busy) { session.enqueue(text); setDraft(""); return; }
    const threadId = activeThreadId ?? await newThread();
    if (!threadId) return;
    const payload = attachments.map(({ name, data, size }) => ({ name, data, size }));
    setDraft("");
    setAttachments([]);
    session.send(text, { threadId, projectPath: project?.path, attachments: payload })
      .catch(() => {});
  }, [draft, attachments, session, activeThreadId, newThread, project]);

  const messages = bundle?.messages ?? [];

  return (
    <div className="shell">
      <PermissionDialog request={session.permission} onAnswer={session.answerPermission} />

      <Sidebar
        workspace={workspace}
        activeThreadId={activeThreadId}
        activeProjectId={project?.id ?? null}
        onSelectProject={(id) => {
          setActiveProjectId(id);
          // A thread belongs to one folder. Switching projects while a foreign
          // thread is open would leave the chat filed under the old project
          // while the agent worked in the new one, so close it instead.
          if (bundle?.thread && bundle.thread.projectId !== id) setActiveThreadId(null);
        }}
        onSelectThread={setActiveThreadId}
        onNewThread={newThread}
        onChooseFolder={async () => {
          await api("/api/projects/select-folder", { method: "POST" }).catch((e) => setError(e.message));
          setWorkspace(await api("/api/workspace"));
        }}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbarTitle">{bundle?.thread?.title ?? "PhoenixAI"}</div>
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

        <UpdateBanner />

        {error && <div className="banner bannerError" onClick={() => setError(null)}>{error}</div>}

        <div className="conversation" ref={scrollRef}>
          {messages.length === 0 && session.turns.length === 0 && (
            <div className="empty">
              <Bot size={26} />
              <h2>Start building</h2>
              <p>
                {project
                  ? <>Working in <code>{project.path}</code>. Describe what you want —
                     the agent reads and edits files there, and asks before it writes.</>
                  : <>Add a project folder on the left, then describe what you want.</>}
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

        <div
          className={cx("composer", dragging && "composerDragging")}
          onDragEnter={(e) => {
            if (!e.dataTransfer?.types?.includes("Files")) return;
            e.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(e) => {
            if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(e) => {
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          {dragging && (
            <div className="dropHint">
              <Paperclip size={14} /> Drop files to attach
            </div>
          )}

          {attachments.length > 0 && (
            <div className="attachRow">
              {attachments.map((file) => (
                <AttachmentChip key={file.id} file={file} onRemove={removeAttachment} />
              ))}
            </div>
          )}

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
            onPaste={(e) => {
              // Screenshots arrive on the clipboard as files with no name.
              const files = Array.from(e.clipboardData?.files ?? []);
              if (!files.length) return;
              e.preventDefault();
              addFiles(files);
            }}
            placeholder={session.busy ? "Agent is working — your message will queue…" : "Describe what you want built…"}
            rows={3}
          />
          <div className="composerBar">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
            />
            <button
              className="iconBtn"
              onClick={() => fileInputRef.current?.click()}
              title="Attach files"
            >
              <Paperclip size={15} />
            </button>
            <AgentPicker value={agent} onChange={setAgent} harnesses={harnesses} busy={session.busy} />
            {project ? (
              <span className="workingIn" title={project.path}>
                <FolderOpen size={12} /> {project.name}
              </span>
            ) : (
              <span className="workingIn workingInNone">No project selected</span>
            )}
            <div className="composerSpacer" />
            {session.busy ? (
              <button className="sendBtn sendBtnStop" onClick={session.cancel}>
                <Square size={13} /> Stop
              </button>
            ) : (
              <button
                className="sendBtn"
                onClick={send}
                disabled={!draft.trim() && attachments.length === 0}
              >
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
