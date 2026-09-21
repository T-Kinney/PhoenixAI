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

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, BarChart3, Bot, ChevronDown, ChevronRight, ClipboardList, Database, Download, FileText, FlaskConical, FolderOpen, GitBranch, History, Image, Loader2,
  MessageSquare, PanelRightClose, PanelRightOpen, Paperclip, Sparkles,
  Check, Code2, Copy, Files, GitCompare, LockKeyhole, Play, Plus, RefreshCw, Search, Send, Settings, ShieldCheck, Square, Terminal, Trash2, Workflow, X, Zap
} from "lucide-react";
import { useAgentSession } from "./useAgentSession.js";
import { PermissionDialog, ToolCallStream, ThoughtPanel, AgentStatusBar } from "./AgentPanels.jsx";

/** Anything larger than this is refused with a reason rather than silently truncated. */
const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
/**
 * Ceiling across all attachments on one message. Base64 inflates by ~33%, so
 * this must stay comfortably under the server's JSON body limit (96mb) or the
 * post fails at the transport with an error that looks like the agent broke.
 */
const MAX_ATTACHMENT_TOTAL = 64 * 1024 * 1024;

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|svg)$/i;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MIME_EXTENSION = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
  "image/bmp": "bmp", "image/avif": "avif", "image/svg+xml": "svg",
  "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md",
  "text/csv": "csv", "application/json": "json"
};

/**
 * A pasted screenshot has no filename. The server classifies by extension, so
 * an unnamed PNG would be treated as an unknown binary — give it a real name
 * derived from its MIME type instead.
 */
function nameFor(file) {
  if (file.name && /\.[A-Za-z0-9]{1,8}$/.test(file.name)) return file.name;
  const ext = MIME_EXTENSION[file.type] ?? "bin";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return file.name ? `${file.name}.${ext}` : `pasted-${stamp}.${ext}`;
}

/** Read a File into the {name, data} shape the prompt endpoint expects. */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name || "pasted file"}`));
    reader.onload = () => {
      // readAsDataURL gives "data:<mime>;base64,<payload>" — the server wants
      // only the payload.
      const comma = String(reader.result).indexOf(",");
      resolve({
        name: nameFor(file),
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
    if (!bridge?.onUpdaterState) return undefined;
    // Replay first: a "ready" emitted before this window mounted would
    // otherwise leave a downloaded update with nothing to prompt the restart.
    bridge.updateState?.().then((s) => { if (s) setState(s); }).catch(() => {});
    return bridge.onUpdaterState(setState);
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

function relativeTime(value) {
  const ms = Date.now() - new Date(value || 0).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
                  onClick={() => {
                    if (group.needsConsent) {
                      const accepted = window.confirm(
                        `${item.name} will be downloaded and executed through the official ACP registry on first use. ` +
                        `Continue only if you trust ${item.name} and its published package.`
                      );
                      if (!accepted) return;
                      localStorage.setItem(`phoenix-harness-consent:${item.agentId ?? item.id}`, "yes");
                    }
                    onChange(item);
                    setOpen(false);
                  }}
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
                  onSelectThread, onNewThread, onChooseFolder, onRenameThread, onDeleteThread }) {
  const projects = workspace?.projects ?? [];
  const threads = workspace?.threads ?? [];
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());

  const byProject = useMemo(() => {
    const map = new Map();
    for (const project of projects) map.set(project.id, []);
    for (const thread of threads.filter((item) => !query.trim()
      || `${item.title} ${item.summary ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()))) {
      if (!map.has(thread.projectId)) map.set(thread.projectId, []);
      map.get(thread.projectId).push(thread);
    }
    return map;
  }, [projects, threads, query]);

  return (
    <aside className="sidebar">
      <div className="sidebarHead">
        <div className="brandLockup">
          <span className="brandMark"><Sparkles size={14} /></span>
          <div>
          <div className="sidebarTitle">PhoenixAI</div>
          <div className="sidebarSub">Local agent workspace</div>
          </div>
        </div>
      </div>

      <label className="threadSearch">
        <Search size={12} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search chats" />
      </label>

      <div className="sidebarScroll">
        {projects.map((project) => {
          const projectThreads = byProject.get(project.id) ?? [];
          const isCollapsed = collapsed.has(project.id) && !query.trim();
          return <div key={project.id} className="projectBlock">
            <div className={cx("projectHeader", project.id === activeProjectId && "projectHeaderActive")}>
              <button className="projectCollapse" aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${project.name}`}
                onClick={() => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(project.id)) next.delete(project.id); else next.add(project.id);
                  return next;
                })}>
                {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              </button>
              <button className="projectRow" onClick={() => onSelectProject(project.id)} title={`Work in ${project.path}`}>
                <FolderOpen size={14} />
                <div className="projectMeta">
                  <div className="projectName">{project.name}</div>
                  <div className="projectPath">{project.path}</div>
                </div>
                <span className="projectCount">{projectThreads.length}</span>
              </button>
            </div>
            {!isCollapsed && <div className="threadList">
              <button className="projectNewChat" onClick={() => onNewThread(project.id)}>
                <Plus size={12} /> New chat
              </button>
              {projectThreads.map((thread) => (
                <div key={thread.id} className={cx("threadItem", thread.id === activeThreadId && "threadItemActive")}>
                  <MessageSquare size={12} className="threadIcon" />
                  <button className="threadOpen" onClick={() => onSelectThread(thread.id)} onDoubleClick={() => onRenameThread(thread)}>
                    <span className="threadTitle">{thread.title || "Untitled"}</span>
                    <span className="threadWhen">{relativeTime(thread.updatedAt || thread.createdAt)}</span>
                  </button>
                  {thread.id === activeThreadId && (
                    <button className="threadDelete" aria-label={`Delete ${thread.title || "chat"}`} title="Delete chat" onClick={() => onDeleteThread(thread)}><Trash2 size={11} /></button>
                  )}
                </div>
              ))}
              {projectThreads.length === 0 && <div className="threadEmpty">No conversations yet</div>}
            </div>}
          </div>;
        })}

        {projects.length === 0 && <div className="sidebarWelcome">Add a folder to give PhoenixAI a safe project workspace.</div>}

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

function ReviewerPanel({ toolCalls }) {
  const reviewers = (toolCalls ?? []).filter((call) =>
    /review|critic|qwen|kimi|deepseek/i.test(`${call.title || ""} ${call.kind || ""}`));
  if (!reviewers.length) return null;
  return (
    <section className="panel reviewerPanel">
      <div className="panelHead"><ShieldCheck size={13} /> Independent reviews</div>
      {reviewers.map((call) => (
        <div className="reviewerRow" key={call.id}>
          <span className={cx("reviewerDot", `reviewer-${call.status || "pending"}`)} />
          <span>{call.title || call.kind || "Reviewer"}</span>
          <small>{call.status === "completed" ? "done" : call.status === "in_progress" ? "running" : call.status || "queued"}</small>
        </div>
      ))}
    </section>
  );
}

function ControlRoom({ threadId, project, spending, onOpenChat, onError }) {
  const [objectives, setObjectives] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [events, setEvents] = useState([]);
  const [idea, setIdea] = useState("");
  const [clarity, setClarity] = useState("");
  const [busy, setBusy] = useState(null);

  const selected = objectives.find((item) => item.id === selectedId) || objectives[0] || null;
  const paidLocked = spending?.policy?.paidCloudCallsEnabled !== true;

  const refresh = useCallback(async (preferredId = null) => {
    if (!project?.id) { setObjectives([]); setSelectedId(null); return; }
    const result = await api(`/api/objectives?projectId=${encodeURIComponent(project.id)}`);
    setObjectives(result.objectives || []);
    setSelectedId((current) => {
      const candidate = preferredId || current;
      return result.objectives?.some((item) => item.id === candidate) ? candidate : (result.objectives?.[0]?.id || null);
    });
  }, [project?.id]);

  useEffect(() => { refresh().catch((error) => onError(error.message)); }, [refresh, onError]);

  useEffect(() => {
    if (!selected?.id) { setEvents([]); return; }
    api(`/api/objectives/${selected.id}/events`).then((result) => setEvents(result.events || [])).catch(() => {});
  }, [selected?.id, selected?.updatedAt]);

  useEffect(() => {
    if (!selected || !["running", "in_progress"].includes(selected.status)) return undefined;
    const timer = setInterval(() => refresh(selected.id).catch(() => {}), 4000);
    return () => clearInterval(timer);
  }, [selected?.id, selected?.status, refresh]);

  const mutate = useCallback(async (key, path, body = {}) => {
    setBusy(key);
    try {
      const result = await api(path, { method: "POST", body: JSON.stringify(body) });
      const objective = result.objective;
      await refresh(objective?.id || selected?.id);
      if (objective?.id) {
        const audit = await api(`/api/objectives/${objective.id}/events`).catch(() => ({ events: [] }));
        setEvents(audit.events || []);
      }
      return result;
    } catch (error) {
      onError(error.message);
      return null;
    } finally {
      setBusy(null);
    }
  }, [onError, refresh, selected?.id]);

  const plan = async (event) => {
    event.preventDefault();
    if (!idea.trim() || !project) return;
    setBusy("plan");
    try {
      const result = await api("/api/objectives/plan", {
        method: "POST",
        body: JSON.stringify({ idea, projectId: project.id, projectPath: project.path, threadId })
      });
      setIdea("");
      await refresh(result.objective.id);
    } catch (error) {
      onError(error.message);
    } finally {
      setBusy(null);
    }
  };

  if (!project) {
    return <div className="controlEmpty"><ClipboardList size={28} /><h2>Select a project first</h2><p>The Control Room is always scoped to one project folder.</p></div>;
  }

  return (
    <div className="controlRoom">
      <aside className="objectiveRail">
        <div className="controlSectionHead"><span>Objectives</span><button className="iconBtn" onClick={() => refresh()} title="Refresh"><RefreshCw size={13} /></button></div>
        <form className="objectiveCreate" onSubmit={plan}>
          <textarea value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="Define a durable objective…" rows={4} />
          <button className="controlPrimary" disabled={!idea.trim() || busy === "plan"}>{busy === "plan" ? <Loader2 size={13} className="spin" /> : <Plus size={13} />} Plan objective</button>
        </form>
        <div className="objectiveList">
          {objectives.map((objective) => <button key={objective.id} className={cx("objectiveItem", selected?.id === objective.id && "objectiveItemActive")} onClick={() => setSelectedId(objective.id)}>
            <strong>{objective.title}</strong>
            <span><i className={cx("statusDot", `status-${objective.status}`)} />{String(objective.status).replaceAll("_", " ")}</span>
          </button>)}
          {!objectives.length && <div className="objectiveNone">No objectives yet. Planning is local and does not call a model.</div>}
        </div>
      </aside>

      <section className="controlCanvas">
        {!selected ? <div className="controlEmpty"><ClipboardList size={28} /><h2>Create the first objective</h2><p>PhoenixAI will record the plan, exact agent routes, gates, evidence, and decisions.</p></div> : <>
          <div className="controlHero">
            <div>
              <div className="controlEyebrow">{selected.control?.operatingMode || "build"} objective · {String(selected.status).replaceAll("_", " ")}</div>
              <h2>{selected.title}</h2>
              <p>{selected.spec?.objective || selected.idea}</p>
            </div>
            <button className="controlChat" onClick={() => onOpenChat(`Continue the objective “${selected.title}”. Review its current task graph, preserve the recorded control policy, and choose the next safe action.`)}><MessageSquare size={14} /> Continue with Grok</button>
          </div>

          <div className="controlGuardrail">
            <LockKeyhole size={15} />
            <div><strong>Execution boundary</strong><span>Live trading and order placement are disabled. Patches, merges, destructive actions, and external writes require you.</span></div>
            <span className={cx("controlLock", paidLocked ? "controlLocked" : "controlBudgeted")}>{paidLocked ? "Paid agents locked" : `$${Number(spending?.policy?.dailyBudgetUsd || 0).toFixed(2)} daily cap`}</span>
          </div>

          {selected.clarity?.required && <form className="clarityGate" onSubmit={(event) => { event.preventDefault(); if (clarity.trim()) mutate("clarity", `/api/objectives/${selected.id}/clarity`, { answers: clarity }).then(() => setClarity("")); }}>
            <strong>Clarity gate</strong>
            {(selected.clarity.questions || []).map((question) => <span key={question}>• {question}</span>)}
            <textarea value={clarity} onChange={(event) => setClarity(event.target.value)} rows={3} placeholder="Answer the questions before any agent work starts…" />
            <button className="controlPrimary" disabled={!clarity.trim() || busy === "clarity"}>Record answers</button>
          </form>}

          <div className="controlGrid">
            <section className="controlCard controlAgents">
              <div className="controlCardHead"><ShieldCheck size={14} /><span>Command and agent lanes</span></div>
              <div className="commanderRow"><span className="agentGlyph">G</span><div><strong>{selected.control?.commander?.name || "Grok Build"}</strong><small>Commander · {selected.control?.commander?.model || "grok-4.7"} · scope, delegate, arbitrate, deliver</small></div><b>{selected.control?.commander?.execution === "api-key" ? "xAI API · grok-4.7" : selected.control?.commander?.execution === "subscription-session" ? "subscription session" : (selected.control?.commander?.execution || "Grok")}</b></div>
              {(selected.agents || []).map((agent) => <div className="agentLane" key={agent.id}>
                <div><strong>{agent.name}</strong><small>{agent.responsibility}</small></div>
                <div className="agentRoute"><span>{agent.providerName}</span><code>{agent.model}</code><em>{agent.configured ? "configured" : "setup needed"}</em></div>
              </div>)}
            </section>

            <section className="controlCard controlTasks">
              <div className="controlCardHead"><Workflow size={14} /><span>Task graph</span><b>{(selected.taskGraph || []).filter((task) => ["complete", "changes_applied", "merged"].includes(task.status)).length}/{selected.taskGraph?.length || 0}</b></div>
              <div className="taskList">{(selected.taskGraph || []).map((task) => {
                const blocked = (task.dependsOn || []).some((id) => !(selected.taskGraph || []).some((candidate) => candidate.id === id && ["complete", "changes_applied", "merged"].includes(candidate.status)));
                const canRun = !paidLocked && !blocked && !["needs_input", "starting", "running", "complete", "changes_applied", "merged", "awaiting_patch_approval"].includes(task.status);
                const patch = (task.patchCandidates || []).find((candidate) => candidate.canApply && !candidate.applied);
                const canMerge = Boolean(task.runId && ["reviewer", "tester"].includes(task.agentId) && task.status === "complete");
                return <div className="taskRow" key={task.id}>
                  <i className={cx("taskState", `task-${task.status}`)}>{["complete", "changes_applied", "merged"].includes(task.status) ? <Check size={10} /> : null}</i>
                  <div className="taskCopy"><strong>{task.title}</strong><small>{task.phase} · {task.agentId}{blocked ? " · waiting on dependency" : ""}</small>{task.runSummary && <span>{task.runSummary}</span>}</div>
                  <div className="taskRowActions">
                    {patch && <button title="Apply this validated candidate to the isolated worktree" disabled={Boolean(busy)} onClick={() => mutate(`patch-${task.id}`, `/api/objectives/${selected.id}/tasks/${task.id}/patches/apply`, { stepId: patch.stepId, patchIndex: patch.index })}><Check size={12} /> Apply candidate</button>}
                    {canRun && <button title={`Run the locked ${task.agentId} route`} disabled={busy === task.id} onClick={() => mutate(task.id, `/api/objectives/${selected.id}/tasks/${task.id}/start`)}>{busy === task.id ? <Loader2 size={12} className="spin" /> : <Play size={12} />} Run</button>}
                    {canMerge && <button title="Human-approved merge to the source project" disabled={Boolean(busy)} onClick={() => { if (window.confirm("Apply the reviewed isolated change set to the source project? The source must be clean.")) mutate(`merge-${task.id}`, `/api/objectives/${selected.id}/tasks/${task.id}/merge`, { archiveLease: false }); }}><GitCompare size={12} /> Merge</button>}
                  </div>
                </div>;
              })}</div>
              <div className="taskActions">
                <button disabled={paidLocked || Boolean(busy) || selected.clarity?.required} onClick={() => mutate("next", `/api/objectives/${selected.id}/tasks/next`)}><Play size={12} /> Run next eligible</button>
                <button disabled={Boolean(busy)} onClick={() => mutate("reconcile", `/api/objectives/${selected.id}/review/reconcile`)}><ShieldCheck size={12} /> Reconcile reviews</button>
              </div>
            </section>

            <section className="controlCard">
              <div className="controlCardHead"><Check size={14} /><span>Accuracy gates</span></div>
              {(selected.evalPlan || []).map((gate) => <div className="evalRow" key={gate.id}><i /><div><strong>{gate.name}</strong><small>{gate.reason}</small></div><span>{gate.status}</span></div>)}
            </section>

            <section className="controlCard">
              <div className="controlCardHead"><Activity size={14} /><span>Evidence and decisions</span><b>{events.length}</b></div>
              <div className="auditList">{events.slice(0, 20).map((event) => <div className="auditRow" key={event.id}><i /><div><strong>{event.type.replaceAll(".", " ")}</strong><small>{event.note || [event.providerId, event.model].filter(Boolean).join(" / ")}</small></div><time>{relativeTime(event.at)}</time></div>)}</div>
              {!events.length && <div className="objectiveNone">No control-plane events recorded yet.</div>}
            </section>
          </div>
        </>}
      </section>
    </div>
  );
}

const EMPTY_STRATEGY = {
  name: "", thesis: "", universe: "", timeframe: "", signalDefinition: "", entryRules: "", exitRules: "",
  positionSizing: "Risk 0.25% of research equity per simulated position.",
  trainStart: "2022-01-01", trainEnd: "2022-12-31", validationStart: "2023-01-02", validationEnd: "2023-12-29", testStart: "2024-01-02", testEnd: "2024-12-31",
  embargoBars: 5, minTrades: 30, primaryMetric: "sharpe", benchmark: "buy-and-hold",
  commissionPerTradeUsd: 0.65, slippageBps: 2, spreadBps: 1, changeNote: "Initial immutable specification."
};

const EMPTY_WINDOWS = [1, 2, 3].map(() => ({ trainEnd: "", testStart: "", testEnd: "" }));

function strategyPayload(draft, datasetIds = []) {
  return {
    name: draft.name,
    thesis: draft.thesis,
    universe: draft.universe,
    timeframe: draft.timeframe,
    signalDefinition: draft.signalDefinition,
    entryRules: draft.entryRules,
    exitRules: draft.exitRules,
    positionSizing: draft.positionSizing,
    datasetIds,
    costs: {
      commissionPerTradeUsd: Number(draft.commissionPerTradeUsd),
      slippageBps: Number(draft.slippageBps),
      spreadBps: Number(draft.spreadBps)
    },
    evaluation: {
      splits: {
        train: { start: draft.trainStart, end: draft.trainEnd },
        validation: { start: draft.validationStart, end: draft.validationEnd },
        test: { start: draft.testStart, end: draft.testEnd }
      },
      embargoBars: Number(draft.embargoBars),
      minTrades: Number(draft.minTrades),
      primaryMetric: draft.primaryMetric,
      benchmark: draft.benchmark,
      walkForwardRequired: true
    },
    changeNote: draft.changeNote
  };
}

function StrategyLabView({ project, onError, onOpenSettings }) {
  const [state, setState] = useState(null);
  const [mode, setMode] = useState("specs");
  const [busy, setBusy] = useState(null);
  const [draft, setDraft] = useState(EMPTY_STRATEGY);
  const [revisionOf, setRevisionOf] = useState(null);
  const [datasetDraft, setDatasetDraft] = useState({ relativePath: "", source: "", vendor: "", license: "", asOf: "", timeColumn: "timestamp", symbolColumn: "symbol" });
  const [experiment, setExperiment] = useState({ specId: "", datasetId: "", label: "", features: "", trainMetric: "", validationMetric: "", testMetric: "", trades: "", holdoutUsed: false, holdoutLabel: "primary-test", randomSeed: 42, notes: "" });
  const [windows, setWindows] = useState(EMPTY_WINDOWS);
  const [marketStatus, setMarketStatus] = useState(null);
  const [marketSymbol, setMarketSymbol] = useState("SPY");
  const [marketType, setMarketType] = useState("EQUITY");
  const [marketQuote, setMarketQuote] = useState(null);
  const [expirations, setExpirations] = useState([]);
  const [expirationDate, setExpirationDate] = useState("");
  const [optionChain, setOptionChain] = useState(null);
  const [marketBusy, setMarketBusy] = useState(null);
  const [marketError, setMarketError] = useState(null);
  const [operations, setOperations] = useState(null);
  const [alertDraft, setAlertDraft] = useState({ symbol: "SPY", type: "EQUITY", condition: "last_above", threshold: "", note: "" });
  const [paperDraft, setPaperDraft] = useState({ name: "Research paper account", initialCashUsd: 100000, maxOrderNotionalPct: 2, maxPositionPct: 10, maxOpenPositions: 10, maxDailyRealizedLossPct: 1, slippageBps: 2, commissionPerFillUsd: 0.65 });
  const [paperOrder, setPaperOrder] = useState({ symbol: "SPY", type: "EQUITY", side: "BUY", quantity: 1 });
  const [operationsBusy, setOperationsBusy] = useState(null);

  const refresh = useCallback(async () => {
    if (!project?.id) { setState(null); return; }
    const result = await api(`/api/strategy-lab?projectId=${encodeURIComponent(project.id)}&projectPath=${encodeURIComponent(project.path)}`);
    setState(result);
    setExperiment((current) => ({
      ...current,
      specId: current.specId || result.specs?.[0]?.id || "",
      datasetId: current.datasetId || result.datasets?.[0]?.id || ""
    }));
  }, [project?.id, project?.path]);

  useEffect(() => { refresh().catch((error) => onError(error.message)); }, [refresh, onError]);
  const refreshMarketStatus = useCallback(() => api("/api/market-data/status").then(setMarketStatus).catch((error) => setMarketError(error.message)), []);
  useEffect(() => { refreshMarketStatus(); }, [refreshMarketStatus]);
  const refreshOperations = useCallback(async () => {
    if (!project?.id) return setOperations(null);
    setOperations(await api(`/api/research-operations?projectId=${encodeURIComponent(project.id)}&projectPath=${encodeURIComponent(project.path)}`));
  }, [project?.id, project?.path]);
  useEffect(() => { refreshOperations().catch((error) => onError(error.message)); }, [refreshOperations, onError]);

  const marketInstrumentType = marketType === "INDEX" ? "UNDERLYING_SECURITY_FOR_INDEX_OPTION" : "EQUITY";
  const fetchQuote = async () => {
    setMarketBusy("quote"); setMarketError(null);
    try {
      setMarketQuote(await api("/api/market-data/quotes", { method: "POST", body: JSON.stringify({ symbol: marketSymbol, type: marketType }) }));
    } catch (error) { setMarketError(error.message); } finally { setMarketBusy(null); }
  };
  const fetchExpirations = async () => {
    setMarketBusy("expirations"); setMarketError(null); setOptionChain(null);
    try {
      const result = await api("/api/market-data/options/expirations", { method: "POST", body: JSON.stringify({ symbol: marketSymbol, type: marketInstrumentType }) });
      const values = result.data?.expirations || [];
      setExpirations(values); setExpirationDate(values[0] || "");
    } catch (error) { setMarketError(error.message); } finally { setMarketBusy(null); }
  };
  const fetchOptionChain = async () => {
    setMarketBusy("chain"); setMarketError(null);
    try {
      setOptionChain(await api("/api/market-data/options/chain", { method: "POST", body: JSON.stringify({ symbol: marketSymbol, type: marketInstrumentType, expirationDate }) }));
    } catch (error) { setMarketError(error.message); } finally { setMarketBusy(null); }
  };
  const createAlert = async (event) => {
    event.preventDefault(); setOperationsBusy("alert");
    try { await api("/api/research-operations/alerts", { method: "POST", body: JSON.stringify({ ...alertDraft, projectId: project.id, projectPath: project.path }) }); setAlertDraft((current) => ({ ...current, threshold: "", note: "" })); await refreshOperations(); }
    catch (error) { onError(error.message); } finally { setOperationsBusy(null); }
  };
  const scanAlerts = async () => {
    setOperationsBusy("scan");
    try { await api("/api/research-operations/alerts/scan", { method: "POST", body: JSON.stringify({ projectId: project.id, projectPath: project.path }) }); await refreshOperations(); }
    catch (error) { onError(error.message); } finally { setOperationsBusy(null); }
  };
  const createPaperAccount = async (event) => {
    event.preventDefault(); setOperationsBusy("paper-account");
    try { await api("/api/research-operations/paper-account", { method: "POST", body: JSON.stringify({ projectId: project.id, projectPath: project.path, name: paperDraft.name, initialCashUsd: Number(paperDraft.initialCashUsd), risk: paperDraft }) }); await refreshOperations(); }
    catch (error) { onError(error.message); } finally { setOperationsBusy(null); }
  };
  const simulateFill = async (event) => {
    event.preventDefault(); setOperationsBusy("paper-fill");
    try { await api("/api/research-operations/paper-fills/simulate", { method: "POST", body: JSON.stringify({ ...paperOrder, quantity: Number(paperOrder.quantity), idempotencyKey: crypto.randomUUID(), projectId: project.id, projectPath: project.path }) }); await refreshOperations(); }
    catch (error) { onError(error.message); } finally { setOperationsBusy(null); }
  };

  const field = (name, label, options = {}) => <label className={cx("labField", options.wide && "labFieldWide")}>
    <span>{label}</span>
    {options.multiline
      ? <textarea rows={options.rows || 3} value={draft[name]} onChange={(event) => setDraft((current) => ({ ...current, [name]: event.target.value }))} />
      : <input type={options.type || "text"} step={options.step} value={draft[name]} onChange={(event) => setDraft((current) => ({ ...current, [name]: event.target.value }))} />}
  </label>;

  const saveSpec = async (event) => {
    event.preventDefault();
    setBusy("spec");
    try {
      const path = revisionOf ? `/api/strategy-lab/specs/${revisionOf}/versions` : "/api/strategy-lab/specs";
      await api(path, { method: "POST", body: JSON.stringify({ ...strategyPayload(draft), projectId: project.id, projectPath: project.path }) });
      setDraft(EMPTY_STRATEGY); setRevisionOf(null); await refresh();
    } catch (error) { onError(error.message); } finally { setBusy(null); }
  };

  const beginRevision = (spec) => {
    const splits = spec.evaluation?.splits || {};
    setDraft({
      ...EMPTY_STRATEGY, ...spec,
      trainStart: splits.train?.start || "", trainEnd: splits.train?.end || "",
      validationStart: splits.validation?.start || "", validationEnd: splits.validation?.end || "",
      testStart: splits.test?.start || "", testEnd: splits.test?.end || "",
      embargoBars: spec.evaluation?.embargoBars ?? 0, minTrades: spec.evaluation?.minTrades ?? 30,
      primaryMetric: spec.evaluation?.primaryMetric || "sharpe", benchmark: spec.evaluation?.benchmark || "buy-and-hold",
      commissionPerTradeUsd: spec.costs?.commissionPerTradeUsd ?? 0, slippageBps: spec.costs?.slippageBps ?? 0, spreadBps: spec.costs?.spreadBps ?? 0,
      changeNote: "Describe what changed in this immutable revision."
    });
    setRevisionOf(spec.id); setMode("specs");
  };

  const inspectDataset = async (event) => {
    event.preventDefault(); setBusy("dataset");
    try {
      await api("/api/strategy-lab/datasets/inspect", { method: "POST", body: JSON.stringify({ ...datasetDraft, projectId: project.id, projectPath: project.path }) });
      setDatasetDraft((current) => ({ ...current, relativePath: "", source: "" })); await refresh();
    } catch (error) { onError(error.message); } finally { setBusy(null); }
  };

  const recordExperiment = async (event) => {
    event.preventDefault(); setBusy("experiment");
    try {
      const spec = state.specs.find((item) => item.id === experiment.specId);
      const primary = spec?.evaluation?.primaryMetric || "sharpe";
      const numberOrNull = (value) => value === "" || value == null ? null : Number(value);
      const features = experiment.features.split(",").map((entry) => {
        const [name, lag] = entry.trim().split(":");
        return { name, lagBars: Number(lag || 1), availableAt: Number(lag || 1) < 0 ? "after-decision" : "before-decision" };
      }).filter((item) => item.name);
      await api("/api/strategy-lab/experiments", { method: "POST", body: JSON.stringify({
        projectId: project.id, projectPath: project.path, specId: experiment.specId, label: experiment.label,
        datasetIds: experiment.datasetId ? [experiment.datasetId] : [], features, randomSeed: Number(experiment.randomSeed),
        metrics: {
          train: { [primary]: numberOrNull(experiment.trainMetric) }, validation: { [primary]: numberOrNull(experiment.validationMetric) },
          test: { [primary]: numberOrNull(experiment.testMetric), trades: numberOrNull(experiment.trades) }
        },
        walkForward: { windows }, holdoutUsed: experiment.holdoutUsed, holdoutLabel: experiment.holdoutLabel, notes: experiment.notes
      }) });
      setExperiment((current) => ({ ...current, label: "", features: "", trainMetric: "", validationMetric: "", testMetric: "", trades: "", holdoutUsed: false, notes: "" }));
      setWindows(EMPTY_WINDOWS); await refresh(); setMode("compare");
    } catch (error) { onError(error.message); } finally { setBusy(null); }
  };

  if (!project) return <div className="controlEmpty"><FlaskConical size={28} /><h2>Select a project first</h2><p>Research artifacts never cross project boundaries.</p></div>;

  return <div className="strategyLab">
    <div className="labHeader">
      <div><div className="controlEyebrow">Research only · immutable evidence</div><h2>Strategy Lab</h2><p>Freeze the hypothesis before testing, fingerprint every dataset, and distrust results until the methodology gates pass.</p></div>
      <div className="labSafety"><LockKeyhole size={14} /><strong>No orders</strong><span>Live execution disabled</span></div>
    </div>
    <div className="labTabs">
      <button className={mode === "specs" ? "active" : ""} onClick={() => setMode("specs")}><ClipboardList size={13} /> Specifications <b>{state?.specs?.length || 0}</b></button>
      <button className={mode === "data" ? "active" : ""} onClick={() => setMode("data")}><Database size={13} /> Data provenance <b>{state?.datasets?.length || 0}</b></button>
      <button className={mode === "experiments" ? "active" : ""} onClick={() => setMode("experiments")}><FlaskConical size={13} /> Experiments <b>{state?.experiments?.length || 0}</b></button>
      <button className={mode === "compare" ? "active" : ""} onClick={() => setMode("compare")}><BarChart3 size={13} /> Compare</button>
      <button className={mode === "market" ? "active" : ""} onClick={() => setMode("market")}><Activity size={13} /> Market data</button>
      <button className={mode === "alerts" ? "active" : ""} onClick={() => setMode("alerts")}><Zap size={13} /> Alerts <b>{operations?.alerts?.length || 0}</b></button>
      <button className={mode === "paper" ? "active" : ""} onClick={() => setMode("paper")}><BarChart3 size={13} /> Paper</button>
    </div>

    {mode === "specs" && <div className="labSplit">
      <form className="labForm" onSubmit={saveSpec}>
        <div className="labFormHead"><strong>{revisionOf ? "Create immutable revision" : "New strategy specification"}</strong><span>{revisionOf ? "The prior version will remain unchanged." : "Required before experiments can be recorded."}</span></div>
        <div className="labFields">
          {field("name", "Strategy name", { wide: true })}{field("thesis", "Falsifiable thesis", { wide: true, multiline: true })}
          {field("universe", "Universe")}{field("timeframe", "Timeframe")}
          {field("signalDefinition", "Signal definition", { wide: true, multiline: true })}
          {field("entryRules", "Entry rules", { wide: true, multiline: true })}{field("exitRules", "Exit rules", { wide: true, multiline: true })}
          {field("positionSizing", "Position sizing", { wide: true, multiline: true, rows: 2 })}
          {field("trainStart", "Train start", { type: "date" })}{field("trainEnd", "Train end", { type: "date" })}
          {field("validationStart", "Validation start", { type: "date" })}{field("validationEnd", "Validation end", { type: "date" })}
          {field("testStart", "Untouched test start", { type: "date" })}{field("testEnd", "Untouched test end", { type: "date" })}
          {field("embargoBars", "Embargo bars", { type: "number" })}{field("minTrades", "Minimum test trades", { type: "number" })}
          {field("commissionPerTradeUsd", "Commission / trade ($)", { type: "number", step: ".01" })}{field("slippageBps", "Slippage (bps)", { type: "number", step: ".1" })}
          {field("spreadBps", "Spread (bps)", { type: "number", step: ".1" })}{field("benchmark", "Benchmark")}
          {field("changeNote", "Version note", { wide: true })}
        </div>
        <div className="labFormActions">{revisionOf && <button type="button" onClick={() => { setRevisionOf(null); setDraft(EMPTY_STRATEGY); }}>Cancel revision</button>}<button className="controlPrimary" disabled={busy === "spec"}>{busy === "spec" ? <Loader2 size={12} className="spin" /> : <LockKeyhole size={12} />} Freeze specification</button></div>
      </form>
      <div className="labRecords">{(state?.specs || []).map((spec) => <article className="specRecord" key={spec.id}>
        <header><div><strong>{spec.name}</strong><span>Revision {spec.revision} · {relativeTime(spec.createdAt)}</span></div>{(state?.specs || []).some((other) => other.rootId === spec.rootId && other.revision > spec.revision) ? <span>Superseded</span> : <button onClick={() => beginRevision(spec)}>New revision</button>}</header>
        <p>{spec.thesis}</p><div className="specMeta"><span>{spec.universe}</span><span>{spec.timeframe}</span><span>{spec.evaluation?.primaryMetric}</span></div>
        <code title={spec.hash}>{spec.hash.slice(0, 16)}…</code><small>{spec.changeNote}</small>
      </article>)}{!state?.specs?.length && <div className="labEmpty">No frozen strategy specifications yet.</div>}</div>
    </div>}

    {mode === "data" && <div className="labSplit labDataSplit">
      <form className="labForm" onSubmit={inspectDataset}>
        <div className="labFormHead"><strong>Register a local dataset</strong><span>The file stays in the project. PhoenixAI records its checksum and provenance.</span></div>
        {Object.entries({ relativePath: "Project-relative file", source: "Source / acquisition method", vendor: "Vendor", license: "License / usage terms", asOf: "Data as-of", timeColumn: "Timestamp column", symbolColumn: "Symbol column" }).map(([name, label]) => <label className="labField" key={name}><span>{label}</span><input value={datasetDraft[name]} onChange={(event) => setDatasetDraft((current) => ({ ...current, [name]: event.target.value }))} /></label>)}
        <button className="controlPrimary" disabled={!datasetDraft.relativePath || !datasetDraft.source || busy === "dataset"}>{busy === "dataset" ? <Loader2 size={12} className="spin" /> : <Database size={12} />} Fingerprint dataset</button>
      </form>
      <div className="labRecords">{(state?.datasets || []).map((dataset) => <article className="datasetRecord" key={dataset.id}><header><strong>{dataset.fileName}</strong><span>{dataset.rowCount == null ? formatBytes(dataset.bytes) : `${dataset.rowCount.toLocaleString()} rows`}</span></header><p>{dataset.source}</p><code title={dataset.sha256}>{dataset.sha256.slice(0, 20)}…</code><small>{dataset.relativePath} · inspected {relativeTime(dataset.inspectedAt)}</small></article>)}{!state?.datasets?.length && <div className="labEmpty">No verified datasets yet.</div>}</div>
    </div>}

    {mode === "experiments" && <form className="labForm labExperiment" onSubmit={recordExperiment}>
      <div className="labFormHead"><strong>Record reproducible experiment evidence</strong><span>PhoenixAI reviews methodology; it never converts these results into orders.</span></div>
      <div className="labFields">
        <label className="labField"><span>Frozen specification</span><select value={experiment.specId} onChange={(event) => setExperiment((current) => ({ ...current, specId: event.target.value }))}><option value="">Select…</option>{(state?.specs || []).map((spec) => <option value={spec.id} key={spec.id}>{spec.name} · r{spec.revision}</option>)}</select></label>
        <label className="labField"><span>Verified dataset</span><select value={experiment.datasetId} onChange={(event) => setExperiment((current) => ({ ...current, datasetId: event.target.value }))}><option value="">Select…</option>{(state?.datasets || []).map((dataset) => <option value={dataset.id} key={dataset.id}>{dataset.fileName}</option>)}</select></label>
        {Object.entries({ label: "Experiment label", features: "Features (name:lag, comma separated)", trainMetric: "Train primary metric", validationMetric: "Validation primary metric", testMetric: "Test primary metric", trades: "Test trades", randomSeed: "Random seed", holdoutLabel: "Holdout label" }).map(([name, label]) => <label className="labField" key={name}><span>{label}</span><input type={["trainMetric", "validationMetric", "testMetric", "trades", "randomSeed"].includes(name) ? "number" : "text"} step="any" value={experiment[name]} onChange={(event) => setExperiment((current) => ({ ...current, [name]: event.target.value }))} /></label>)}
        <label className="labCheck labFieldWide"><input type="checkbox" checked={experiment.holdoutUsed} onChange={(event) => setExperiment((current) => ({ ...current, holdoutUsed: event.target.checked }))} /><span>I opened the untouched holdout for this experiment</span></label>
      </div>
      <div className="walkForward"><strong>Walk-forward windows</strong><span>Record the actual expanding train and out-of-sample windows. At least three are recommended.</span>{windows.map((window, index) => <div className="windowRow" key={index}><b>{index + 1}</b>{["trainEnd", "testStart", "testEnd"].map((name) => <label key={name}><span>{name.replace(/([A-Z])/g, " $1")}</span><input type="date" value={window[name]} onChange={(event) => setWindows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [name]: event.target.value } : item))} /></label>)}</div>)}</div>
      <label className="labField labFieldWide"><span>Notes and reproducibility details</span><textarea rows={3} value={experiment.notes} onChange={(event) => setExperiment((current) => ({ ...current, notes: event.target.value }))} /></label>
      <button className="controlPrimary" disabled={!experiment.specId || !experiment.datasetId || !experiment.label || busy === "experiment"}><FlaskConical size={12} /> Record and review</button>
    </form>}

    {mode === "compare" && <div className="comparisonPanel"><div className="comparisonHead"><div><strong>Experiment comparison</strong><span>Failed and warned methodology stays visible beside performance.</span></div><button onClick={() => refresh()}><RefreshCw size={12} /> Refresh</button></div>
      <div className="comparisonTable"><div className="comparisonRow comparisonLabels"><span>Experiment</span><span>Status</span><span>Metric</span><span>Train</span><span>Validation</span><span>Test</span><span>Trades</span></div>{(state?.comparison || []).map((row) => <div className="comparisonRow" key={row.id}><span><strong>{row.label}</strong><small>r{row.specRevision} · {relativeTime(row.createdAt)}</small></span><span className={cx("reviewStatus", `review-${row.status}`)}>{row.status.replaceAll("_", " ")}</span><code>{row.primaryMetric}</code><b>{row.train ?? "—"}</b><b>{row.validation ?? "—"}</b><b>{row.test ?? "—"}</b><b>{row.trades ?? "—"}</b>{row.warnings?.length > 0 && <em>{row.warnings.join(" ")}</em>}</div>)}</div>{!state?.comparison?.length && <div className="labEmpty">No experiments to compare yet.</div>}
    </div>}

    {mode === "market" && <div className="marketWorkspace">
      <div className="marketBoundary"><ShieldCheck size={16} /><div><strong>Read-only data boundary</strong><span>Quotes, option chains, Greeks, and bars only. PhoenixAI exposes no portfolio, preflight, cancel, or order tool.</span></div><em>{marketStatus?.ready ? "Connected" : "Setup required"}</em></div>
      {!marketStatus?.ready ? <div className="marketSetup"><Database size={24} /><strong>Connect Public.com market data</strong><p>Save the personal secret and account ID in Settings. Both are encrypted for this Windows account; short-lived access tokens stay in memory.</p><div className="marketSetupActions"><button className="controlPrimary" onClick={onOpenSettings}>Open Settings</button><button onClick={refreshMarketStatus}><RefreshCw size={12} /> Recheck</button></div></div> : <>
        <div className="marketControls">
          <label className="labField"><span>Symbol</span><input value={marketSymbol} onChange={(event) => setMarketSymbol(event.target.value.toUpperCase())} /></label>
          <label className="labField"><span>Instrument</span><select value={marketType} onChange={(event) => setMarketType(event.target.value)}><option value="EQUITY">Equity / ETF</option><option value="INDEX">Index</option><option value="CRYPTO">Crypto quote</option></select></label>
          <button className="controlPrimary" disabled={!marketSymbol || marketBusy} onClick={fetchQuote}>{marketBusy === "quote" ? <Loader2 size={12} className="spin" /> : <Activity size={12} />} Get quote</button>
          <button disabled={!marketSymbol || marketBusy || marketType === "CRYPTO"} onClick={fetchExpirations}>{marketBusy === "expirations" ? <Loader2 size={12} className="spin" /> : <BarChart3 size={12} />} Find expirations</button>
        </div>
        {marketError && <div className="marketError">{marketError}</div>}
        {marketQuote && <div className="marketResult"><div className="marketResultHead"><div><strong>Quote evidence</strong><span>{marketQuote.source} · retrieved {new Date(marketQuote.retrievedAt).toLocaleString()}</span></div><FreshnessBadge value={marketQuote.freshness} /></div>
          <div className="quoteGrid">{(marketQuote.data?.quotes || []).map((quote) => <article key={`${quote.instrument?.type}-${quote.instrument?.symbol}`}><header><strong>{quote.instrument?.symbol}</strong><span>{quote.instrument?.type}</span></header><div><b>{quote.last ?? "—"}</b><small>last</small></div><div><b>{quote.bid ?? "—"}</b><small>bid</small></div><div><b>{quote.ask ?? "—"}</b><small>ask</small></div><footer>{quote.outcome || "Provider response"}</footer></article>)}</div>
        </div>}
        {expirations.length > 0 && <div className="chainControls"><label className="labField"><span>Expiration</span><select value={expirationDate} onChange={(event) => setExpirationDate(event.target.value)}>{expirations.map((value) => <option value={value} key={value}>{value}</option>)}</select></label><button className="controlPrimary" disabled={!expirationDate || marketBusy} onClick={fetchOptionChain}>{marketBusy === "chain" ? <Loader2 size={12} className="spin" /> : <BarChart3 size={12} />} Load option chain</button><span>{expirations.length} expirations returned by provider</span></div>}
        {optionChain && <OptionChainResult result={optionChain} />}
        <p className="marketTerms">Personal, non-commercial Public Individual API use only. Provider timestamps and freshness labels remain attached to every result.</p>
      </>}
    </div>}

    {mode === "alerts" && <div className="labSplit">
      <form className="labForm" onSubmit={createAlert}><div className="labFormHead"><strong>New immutable price alert</strong><span>Triggers only on a fresh false-to-true transition. Scans never trade.</span></div><div className="labFields">
        <label className="labField"><span>Symbol</span><input value={alertDraft.symbol} onChange={(event) => setAlertDraft((current) => ({ ...current, symbol: event.target.value.toUpperCase() }))} /></label>
        <label className="labField"><span>Instrument</span><select value={alertDraft.type} onChange={(event) => setAlertDraft((current) => ({ ...current, type: event.target.value }))}><option>EQUITY</option><option>INDEX</option><option>CRYPTO</option></select></label>
        <label className="labField"><span>Condition</span><select value={alertDraft.condition} onChange={(event) => setAlertDraft((current) => ({ ...current, condition: event.target.value }))}><option value="last_above">Last above</option><option value="last_below">Last below</option></select></label>
        <label className="labField"><span>Threshold</span><input type="number" step="any" value={alertDraft.threshold} onChange={(event) => setAlertDraft((current) => ({ ...current, threshold: event.target.value }))} /></label>
        <label className="labField labFieldWide"><span>Research note</span><textarea rows={3} value={alertDraft.note} onChange={(event) => setAlertDraft((current) => ({ ...current, note: event.target.value }))} /></label>
      </div><div className="labFormActions"><button type="button" disabled={!operations?.marketData?.ready || !operations?.alerts?.length || operationsBusy} onClick={scanAlerts}><RefreshCw size={12} /> Scan now</button><button className="controlPrimary" disabled={!alertDraft.threshold || operationsBusy}>{operationsBusy === "alert" ? <Loader2 size={12} className="spin" /> : <LockKeyhole size={12} />} Freeze alert</button></div>{!operations?.marketData?.ready && <div className="marketError">Public.com credentials are required before scanning.</div>}</form>
      <div className="labRecords">{(operations?.alerts || []).map((alert) => <article className="specRecord" key={alert.id}><header><strong>{alert.symbol}</strong><span>Active</span></header><p>{alert.condition.replaceAll("_", " ")} {alert.threshold}</p><small>{alert.note || "No note"} · {relativeTime(alert.createdAt)}</small></article>)}{!operations?.alerts?.length && <div className="labEmpty">No research alerts yet.</div>}{(operations?.signalEvents || []).slice(0, 10).map((event) => <article className="signalRecord" key={event.id}><header><strong>{event.symbol} · {event.last ?? "no quote"}</strong><span>{event.transitioned ? "Triggered" : event.matched ? "Still matched" : "Observed"}</span></header><small>{event.source} · {event.freshness?.stale ? "stale" : "fresh"} · {relativeTime(event.at)}</small></article>)}</div>
    </div>}

    {mode === "paper" && <div className="paperWorkspace"><div className="marketBoundary"><ShieldCheck size={16} /><div><strong>Simulation boundary</strong><span>Local paper fills only. No broker order is created, transmitted, replaced, or cancelled.</span></div><em>Paper only</em></div>
      {!operations?.paper?.account ? <form className="labForm paperAccountForm" onSubmit={createPaperAccount}><div className="labFormHead"><strong>Create append-only paper ledger</strong><span>Risk limits are frozen with the account and enforced before every simulated fill.</span></div><div className="labFields">{Object.entries({ name: "Account name", initialCashUsd: "Initial cash ($)", maxOrderNotionalPct: "Max order (%)", maxPositionPct: "Max position (%)", maxOpenPositions: "Max positions", maxDailyRealizedLossPct: "Daily realized loss (%)", slippageBps: "Slippage (bps)", commissionPerFillUsd: "Fee per fill ($)" }).map(([name, label]) => <label className="labField" key={name}><span>{label}</span><input type={name === "name" ? "text" : "number"} step="any" value={paperDraft[name]} onChange={(event) => setPaperDraft((current) => ({ ...current, [name]: event.target.value }))} /></label>)}</div><button className="controlPrimary" disabled={operationsBusy === "paper-account"}><LockKeyhole size={12} /> Freeze paper account</button></form> : <>
        <div className="paperSummary"><div><span>Paper cash</span><strong>${Number(operations.paper.cashUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div><span>Realized P/L</span><strong>${Number(operations.paper.realizedPnlUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div><span>Daily realized</span><strong>${Number(operations.paper.dailyRealizedPnlUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div><span>Open positions</span><strong>{operations.paper.positions.length}</strong></div></div>
        <form className="paperTicket" onSubmit={simulateFill}><div><strong>Simulated market fill</strong><span>Uses current ask for buys and bid for sells, then applies frozen slippage and fees.</span></div>{Object.entries({ symbol: "Symbol", quantity: "Whole shares" }).map(([name, label]) => <label className="labField" key={name}><span>{label}</span><input type={name === "quantity" ? "number" : "text"} min="1" value={paperOrder[name]} onChange={(event) => setPaperOrder((current) => ({ ...current, [name]: name === "symbol" ? event.target.value.toUpperCase() : event.target.value }))} /></label>)}<label className="labField"><span>Instrument</span><select value={paperOrder.type} onChange={(event) => setPaperOrder((current) => ({ ...current, type: event.target.value }))}><option>EQUITY</option><option>INDEX</option><option>CRYPTO</option></select></label><label className="labField"><span>Side</span><select value={paperOrder.side} onChange={(event) => setPaperOrder((current) => ({ ...current, side: event.target.value }))}><option>BUY</option><option>SELL</option></select></label><button className="controlPrimary" disabled={!operations?.marketData?.ready || operationsBusy === "paper-fill"}><Play size={12} /> Simulate fill</button></form>
        {!operations?.marketData?.ready && <div className="marketError">Public.com credentials are required for fresh bid/ask evidence.</div>}
        <div className="paperColumns"><div className="comparisonPanel"><div className="comparisonHead"><div><strong>Positions</strong><span>Derived from the append-only ledger</span></div></div>{operations.paper.positions.map((position) => <div className="paperRow" key={position.symbol}><strong>{position.symbol}</strong><span>{position.quantity} units</span><span>${position.averageCost.toFixed(3)} avg</span></div>)}{!operations.paper.positions.length && <div className="labEmpty">No positions.</div>}</div><div className="comparisonPanel"><div className="comparisonHead"><div><strong>Recent decisions</strong><span>Filled and rejected attempts remain visible</span></div></div>{[...operations.paper.fills, ...operations.paper.rejections].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12).map((fill) => <div className={cx("paperRow", fill.status === "rejected" && "paperRejected")} key={fill.id}><strong>{fill.side} {fill.quantity} {fill.symbol}</strong><span>{fill.status}</span><span>{fill.fillPrice ? `$${fill.fillPrice.toFixed(3)}` : fill.rejectionReasons?.join("; ")}</span></div>)}</div></div>
      </>}
    </div>}
  </div>;
}

function FreshnessBadge({ value }) {
  const label = value?.stale === true ? "Stale / verify" : value?.stale === false ? "Fresh timestamp" : "Timestamp unavailable";
  return <span className={cx("freshnessBadge", value?.stale === true ? "freshnessStale" : value?.stale === false ? "freshnessCurrent" : "") } title={value?.reason}>{label}{Number.isFinite(value?.ageSeconds) ? ` · ${value.ageSeconds}s` : ""}</span>;
}

function OptionChainResult({ result }) {
  const rows = [
    ...(result.data?.calls || []).map((quote) => ({ ...quote, side: "Call" })),
    ...(result.data?.puts || []).map((quote) => ({ ...quote, side: "Put" }))
  ].slice(0, 160);
  return <div className="marketResult"><div className="marketResultHead"><div><strong>{result.data?.baseSymbol || "Option"} chain</strong><span>{result.source} · {rows.length} contracts shown</span></div><FreshnessBadge value={result.freshness} /></div><div className="chainTable"><div className="chainRow chainLabels"><span>Side</span><span>Strike</span><span>Bid</span><span>Ask</span><span>Last</span><span>Volume</span><span>OI</span><span>Delta</span><span>IV</span></div>{rows.map((quote, index) => <div className="chainRow" key={`${quote.instrument?.symbol}-${index}`}><b>{quote.side}</b><code>{quote.optionDetails?.strikePrice ?? "—"}</code><span>{quote.bid ?? "—"}</span><span>{quote.ask ?? "—"}</span><span>{quote.last ?? "—"}</span><span>{quote.volume ?? "—"}</span><span>{quote.openInterest ?? "—"}</span><span>{quote.optionDetails?.greeks?.delta ?? "—"}</span><span>{quote.optionDetails?.greeks?.impliedVolatility ?? "—"}</span></div>)}</div></div>;
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
  const [billing, setBilling] = useState(null);
  const [spending, setSpending] = useState(null);
  const [backgroundStatus, setBackgroundStatus] = useState(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [surface, setSurface] = useState("chat");
  const scrollRef = useRef(null);

  const [activeProjectId, setActiveProjectId] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [approvalMode, setApprovalMode] = useState("ask");
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef(null);
  // Drag events fire for every child element, so a plain boolean flickers.
  // Counting enter/leave pairs is what keeps the overlay stable.
  const dragDepth = useRef(0);
  const session = useAgentSession(activeThreadId);
  const commandSuggestions = useMemo(() => {
    if (!draft.startsWith("/")) return [];
    const needle = draft.slice(1).toLowerCase();
    return (session.commands ?? []).filter((command) => {
      const name = command.name ?? command.command ?? command.id ?? "";
      return String(name).replace(/^\//, "").toLowerCase().includes(needle);
    }).slice(0, 8);
  }, [draft, session.commands]);

  const addFiles = useCallback(async (fileList) => {
    const incoming = Array.from(fileList ?? []).filter(Boolean);
    if (!incoming.length) return;
    const accepted = [];
    for (const file of incoming) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)} per file.`);
        continue;
      }
      try {
        const read = await readFile(file);
        accepted.push({ ...read, id: `${file.name}-${file.size}-${accepted.length}-${performance.now()}` });
      } catch (e) {
        setError(e.message);
      }
    }
    if (!accepted.length) return;
    setAttachments((prev) => {
      // Enforce the total here rather than in the loop: the running total has to
      // include what is already attached, not just this batch.
      const merged = [...prev];
      let total = prev.reduce((sum, a) => sum + (a.size ?? 0), 0);
      for (const file of accepted) {
        if (total + file.size > MAX_ATTACHMENT_TOTAL) {
          setError(`Attachments would exceed ${formatBytes(MAX_ATTACHMENT_TOTAL)} in one message. ${file.name} was not attached.`);
          continue;
        }
        total += file.size;
        merged.push(file);
      }
      return merged;
    });
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
    api("/api/spending-safety").then(setSpending).catch(() => {});
    api("/api/agent/approval-mode").then((d) => setApprovalMode(d.mode)).catch(() => {});
    api("/api/harnesses/ready")
      .then((d) => setHarnesses({
        // The locally installed Grok is listed first and separately: it uses
        // the logged-in session, so it neither downloads nor bills per token.
        installed: [{ id: "grok-build-local", name: "Grok Build (installed)", license: "proprietary" }],
        ready: d.agents ?? []
      }))
      .catch(() => setHarnesses({ installed: [], ready: [] }));
  }, []);

  useEffect(() => {
    if (!showSettings) api("/api/spending-safety").then(setSpending).catch(() => {});
  }, [showSettings]);

  useEffect(() => {
    let mounted = true;
    const refresh = () => api("/api/agent/status").then((value) => { if (mounted) setBackgroundStatus(value); }).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => api("/api/agent/billing")
      .then((value) => { if (active) setBilling(value); })
      .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 60_000);
    const off = window.agentBridge?.onBilling?.((value) => setBilling(value));
    return () => { active = false; clearInterval(timer); off?.(); };
  }, []);

  useEffect(() => {
    if (!agent && harnesses?.installed?.length) setAgent(harnesses.installed[0]);
  }, [harnesses, agent]);

  useEffect(() => {
    if (!activeThreadId) { setBundle(null); return; }
    api(`/api/threads/${activeThreadId}`).then(setBundle).catch((e) => setError(e.message));
  }, [activeThreadId]);

  useEffect(() => {
    if (!activeThreadId || !harnesses) return;
    api(`/api/agent/binding/${activeThreadId}`).then(({ binding }) => {
      if (!binding?.harnessId) return;
      const all = [...(harnesses.installed ?? []), ...(harnesses.ready ?? [])];
      const match = all.find((item) => (item.id ?? item.agentId) === binding.harnessId);
      setAgent(match ?? { id: binding.harnessId, name: binding.harnessId, license: "bound" });
    }).catch(() => {});
  }, [activeThreadId, harnesses]);

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

  useEffect(() => {
    if (session.busy || session.permission || session.toolCalls.length || workflowRuns.length || session.memoryHits.length || session.plan?.length) {
      setInspectorOpen(true);
    }
  }, [session.busy, session.permission, session.toolCalls.length, workflowRuns.length, session.memoryHits.length, session.plan]);

  const newThread = useCallback(async (projectId = project?.id) => {
    const created = await api("/api/threads", {
      method: "POST",
      body: JSON.stringify({ projectId })
    }).catch((e) => { setError(e.message); return null; });
    if (created?.thread?.id) {
      setActiveProjectId(created.thread.projectId);
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
    const agentId = agent?.id ?? agent?.agentId ?? "grok-build-local";
    const sendOptions = {
      threadId: activeThreadId,
      projectPath: project?.path,
      attachments: attachments.map(({ name, data, size }) => ({ name, data, size })),
      harnessId: agentId,
      harnessConsent: agentId === "grok-build-local"
        || localStorage.getItem(`phoenix-harness-consent:${agentId}`) === "yes"
    };
    if (session.busy) {
      session.enqueue(text, sendOptions);
      setDraft("");
      setAttachments([]);
      return;
    }
    const threadId = activeThreadId ?? await newThread();
    if (!threadId) return;
    setDraft("");
    setAttachments([]);
    session.send(text, { ...sendOptions, threadId })
      .then(async () => {
        setWorkspace(await api("/api/workspace"));
        setBundle(await api(`/api/threads/${threadId}`));
      })
      .catch(() => {});
  }, [draft, attachments, session, activeThreadId, newThread, project]);

  const messages = bundle?.messages ?? [];

  return (
    <div className={cx("shell", !inspectorOpen && "shellInspectorClosed")}>
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
        onRenameThread={async (thread) => {
          const title = window.prompt("Rename chat", thread.title || "");
          if (!title?.trim()) return;
          await api(`/api/threads/${thread.id}/rename`, { method: "POST", body: JSON.stringify({ title }) });
          setWorkspace(await api("/api/workspace"));
          if (thread.id === activeThreadId) setBundle(await api(`/api/threads/${thread.id}`));
        }}
        onDeleteThread={async (thread) => {
          if (!window.confirm(`Delete “${thread.title || "Untitled"}”? This removes its local chat record.`)) return;
          await api(`/api/threads/${thread.id}/delete`, { method: "POST", body: "{}" });
          if (thread.id === activeThreadId) setActiveThreadId(null);
          setWorkspace(await api("/api/workspace"));
        }}
        onChooseFolder={async () => {
          await api("/api/projects/select-folder", { method: "POST" }).catch((e) => setError(e.message));
          setWorkspace(await api("/api/workspace"));
        }}
      />

      <main className="main">
        <header className="topbar">
          <div className="topbarContext">
            <div className="topbarTitle">
              <span>{project?.name ?? "PhoenixAI"}</span>
              {bundle?.thread?.title && <><ChevronRight size={13} /><strong>{bundle.thread.title}</strong></>}
            </div>
            {project && <div className="topbarMeta">
              {bundle?.context?.project?.gitRepo
                ? <><GitBranch size={11} /> {bundle.context.project.branch || "detached"}<span className={cx("gitState", bundle.context.project.dirty && "gitDirty")}>{bundle.context.project.dirty ? "changes" : "clean"}</span></>
                : <><FolderOpen size={11} /> Local folder</>}
              <span className="topbarPath">{project.path}</span>
            </div>}
          </div>
          <div className="topbarRight">
            <div className="surfaceSwitch" aria-label="Workspace view">
              <button className={surface === "chat" ? "active" : ""} onClick={() => setSurface("chat")}><MessageSquare size={12} /> Chat</button>
              <button className={surface === "control" ? "active" : ""} onClick={() => setSurface("control")}><ClipboardList size={12} /> Control Room</button>
              <button className={surface === "lab" ? "active" : ""} onClick={() => setSurface("lab")}><FlaskConical size={12} /> Strategy Lab</button>
            </div>
            {(backgroundStatus?.activeTurns > 0 || backgroundStatus?.pendingPermissions?.length > 0) && (
              <div className="backgroundBadge" title="Agent activity continues even if you switch chats">
                {backgroundStatus.activeTurns ?? 0} running
                {backgroundStatus.pendingPermissions?.length ? ` · ${backgroundStatus.pendingPermissions.length} waiting` : ""}
              </div>
            )}
            {billing?.available && (
              <div className="usageMeter" title={`Grok Build shared usage · updated ${billing.updatedAt ?? "recently"}`}>
                <span>{billing.remainingPercent != null
                  ? `${Math.round(billing.remainingPercent)}% Grok left`
                  : `${billing.subscriptionTier ?? "Grok"} · usage not reported`}</span>
                {billing.remainingPercent != null && (
                  <span className="usageTrack"><span style={{ width: `${billing.remainingPercent}%` }} /></span>
                )}
              </div>
            )}
            {spending && (
              <button className={cx("spendChip", spending.policy?.paidCloudCallsEnabled && "spendChipOn")}
                onClick={() => setShowSettings(true)} title="Open spending safety settings">
                {spending.policy?.paidCloudCallsEnabled
                  ? `$${Number(spending.today?.chargedOrReservedUsd ?? 0).toFixed(2)} / $${Number(spending.policy.dailyBudgetUsd ?? 0).toFixed(2)} today`
                  : "Paid reviews locked"}
              </button>
            )}
            <AgentStatusBar
              connection={session.connection}
              error={session.error}
              busy={session.busy}
              onCancel={session.cancel}
            />
            <button className="iconBtn" onClick={() => setShowSettings(true)} title="Settings">
              <Settings size={15} />
            </button>
            <button className="iconBtn" onClick={() => setInspectorOpen((value) => !value)}
              title={inspectorOpen ? "Hide activity" : "Show activity"} aria-pressed={inspectorOpen}>
              {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          </div>
        </header>

        <UpdateBanner />

        {error && <div className="banner bannerError" onClick={() => setError(null)}>{error}</div>}

        {surface === "chat" ? <>
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
              {project && <div className="promptSuggestions" aria-label="Suggested prompts">
                {["Review this project", "Find failing tests", "Explain the architecture", "Continue the current objective"].map((suggestion) => (
                  <button key={suggestion} onClick={() => setDraft(suggestion)}>{suggestion}</button>
                ))}
              </div>}
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
          {commandSuggestions.length > 0 && (
            <div className="commandPalette">
              {commandSuggestions.map((command, index) => {
                const name = command.name ?? command.command ?? command.id ?? String(command);
                return <button key={`${name}-${index}`} onClick={() => setDraft(`/${String(name).replace(/^\//, "")} `)}>
                  <strong>/{String(name).replace(/^\//, "")}</strong>
                  <span>{command.description ?? command.help ?? "Agent command"}</span>
                </button>;
              })}
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
              const data = e.clipboardData;
              if (!data) return;
              // Two paths, because they are not equivalent: copying a file in
              // Explorer populates `files`, while a screenshot tool often only
              // exposes `items` with kind "file". Reading one alone silently
              // drops the other.
              let files = Array.from(data.files ?? []);
              if (!files.length) {
                files = Array.from(data.items ?? [])
                  .filter((item) => item.kind === "file")
                  .map((item) => item.getAsFile())
                  .filter(Boolean);
              }
              if (!files.length) return;   // plain text paste — leave it alone
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
            <button
              className={cx("approvalChip", approvalMode === "auto" && "approvalChipAuto")}
              title={approvalMode === "auto"
                ? "The agent runs without asking. Click to require approval."
                : "You approve each action. Click to let the agent run unattended."}
              onClick={async () => {
                const next = approvalMode === "auto" ? "ask" : "auto";
                setApprovalMode(next);
                await api("/api/agent/approval-mode", {
                  method: "POST", body: JSON.stringify({ mode: next })
                }).catch((e) => { setError(e.message); setApprovalMode(approvalMode); });
              }}
            >
              {approvalMode === "auto"
                ? <><Zap size={12} /> Auto-approve</>
                : <><ShieldCheck size={12} /> Ask each time</>}
            </button>
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
        </> : surface === "control" ? <ControlRoom
          threadId={activeThreadId}
          project={project}
          spending={spending}
          onError={setError}
          onOpenChat={(prompt) => { setDraft(prompt); setSurface("chat"); }}
        /> : <StrategyLabView project={project} onError={setError} onOpenSettings={() => setShowSettings(true)} />}
      </main>

      <aside className={cx("inspector", !inspectorOpen && "inspectorHidden")} aria-hidden={!inspectorOpen}>
        <div className="inspectorHead">
          <span>Live activity</span>
          <button className="iconBtn" onClick={() => setInspectorOpen(false)} title="Hide activity"><X size={13} /></button>
        </div>
        <PlanPanel plan={session.plan} />
        <ProjectPanel threadId={activeThreadId} files={bundle?.context?.files ?? []} />
        <WorkflowPanel runs={workflowRuns} />
        <ReviewerPanel toolCalls={session.toolCalls} />
        <MemoryPanel hits={session.memoryHits} />
        {session.toolCalls.length > 0 && (
          <section className="panel">
            <div className="panelHead"><Terminal size={13} /> Activity</div>
            <ToolCallStream toolCalls={session.toolCalls} />
          </section>
        )}
        {!session.busy && workflowRuns.length === 0 && session.toolCalls.length === 0 && (
          <div className="inspectorEmpty">Plans, file activity, spawned reviewers, and workflow progress appear here.</div>
        )}
      </aside>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} harnesses={harnesses} billing={billing} threadId={activeThreadId} />}
    </div>
  );
}

function InlineMarkdown({ text }) {
  const parts = String(text ?? "").split(/(`[^`\n]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g);
  return parts.map((part, index) => {
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function PlanPanel({ plan }) {
  if (!Array.isArray(plan) || !plan.length) return null;
  return (
    <section className="panel">
      <div className="panelHead"><Check size={13} /> Plan</div>
      {plan.map((item, index) => (
        <div key={item.id ?? index} className="planItem">
          <span className={cx("planState", `plan-${item.status ?? item.state ?? "pending"}`)} />
          <span>{item.content ?? item.text ?? item.step ?? String(item)}</span>
        </div>
      ))}
    </section>
  );
}

function ProjectPanel({ threadId, files = [] }) {
  const [mode, setMode] = useState("files");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(null);
  const [diff, setDiff] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [searchResult, setSearchResult] = useState(null);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalResult, setTerminalResult] = useState(null);
  const [skills, setSkills] = useState(null);
  const [checkpoints, setCheckpoints] = useState(null);
  const shown = files.filter((file) => !query || file.toLowerCase().includes(query.toLowerCase())).slice(0, 100);
  useEffect(() => {
    setPreview(null); setDiff(null); setSearchResult(null); setTerminalResult(null); setSkills(null); setCheckpoints(null);
  }, [threadId]);
  if (!threadId) return null;
  return (
    <section className="panel projectPanel">
      <div className="panelTabs">
        <button className={mode === "files" ? "active" : ""} onClick={() => setMode("files")}><Files size={12} /> Files</button>
        <button className={mode === "diff" ? "active" : ""} onClick={async () => {
          setMode("diff"); setDiff({ loading: true });
          try { setDiff(await api(`/api/threads/${threadId}/diff`)); } catch (error) { setDiff({ error: error.message }); }
        }}><GitCompare size={12} /> Diff</button>
        <button className={mode === "search" ? "active" : ""} onClick={() => setMode("search")} title="Search file contents"><Search size={12} /></button>
        <button className={mode === "terminal" ? "active" : ""} onClick={() => setMode("terminal")} title="Project terminal"><Terminal size={12} /></button>
        <button className={mode === "skills" ? "active" : ""} onClick={async () => {
          setMode("skills");
          if (!skills) {
            try { setSkills(await api(`/api/threads/${threadId}/skills`)); }
            catch (error) { setSkills({ error: error.message }); }
          }
        }} title="Project skills"><Workflow size={12} /></button>
        <button className={mode === "checkpoints" ? "active" : ""} onClick={async () => {
          setMode("checkpoints");
          try { setCheckpoints(await api(`/api/threads/${threadId}/checkpoints`)); }
          catch (error) { setCheckpoints({ error: error.message }); }
        }} title="Checkpoints"><History size={12} /></button>
      </div>
      {mode === "files" && <>
        <input className="projectFilter" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter project files" />
        <div className="projectFiles">
          {shown.map((file) => <button key={file} onClick={async () => {
            try { setPreview(await api(`/api/threads/${threadId}/file?path=${encodeURIComponent(file)}`)); }
            catch (error) { setPreview({ path: file, error: error.message }); }
          }}><Code2 size={10} /> {file}</button>)}
        </div>
        {preview && <div className="filePreview"><div>{preview.path}</div><pre>{preview.error ?? preview.content}</pre></div>}
      </>}
      {mode === "diff" && <div className="filePreview">
        {diff?.loading ? "Loading diff…" : diff?.error ? diff.error : <pre>{diff?.diff || diff?.status || "Working tree is clean."}</pre>}
        {diff?.truncated && <div>Diff preview truncated at 250 KB.</div>}
      </div>}
      {mode === "search" && <>
        <form className="projectToolForm" onSubmit={async (event) => {
          event.preventDefault();
          if (!searchText.trim()) return;
          setSearchResult({ loading: true });
          try {
            setSearchResult(await api(`/api/threads/${threadId}/search`, {
              method: "POST", body: JSON.stringify({ query: searchText })
            }));
          } catch (error) { setSearchResult({ error: error.message }); }
        }}>
          <input value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search text in project" />
          <button>Search</button>
        </form>
        <div className="searchResults">
          {searchResult?.loading ? "Searching…" : searchResult?.error ?? searchResult?.matches?.map((match, index) => (
            <button key={`${match.path}:${match.line}:${index}`} onClick={async () => {
              try { setPreview(await api(`/api/threads/${threadId}/file?path=${encodeURIComponent(match.path)}`)); }
              catch (error) { setPreview({ path: match.path, error: error.message }); }
            }}><strong>{match.path}:{match.line}</strong><span>{match.text}</span></button>
          ))}
        </div>
        {preview && <div className="filePreview"><div>{preview.path}</div><pre>{preview.error ?? preview.content}</pre></div>}
      </>}
      {mode === "terminal" && <>
        <form className="projectToolForm terminalForm" onSubmit={async (event) => {
          event.preventDefault();
          if (!terminalCommand.trim()) return;
          setTerminalResult({ loading: true });
          try {
            setTerminalResult(await api(`/api/threads/${threadId}/terminal`, {
              method: "POST", body: JSON.stringify({ command: terminalCommand })
            }));
          } catch (error) { setTerminalResult({ error: error.message }); }
        }}>
          <span>&gt;</span><input value={terminalCommand} onChange={(e) => setTerminalCommand(e.target.value)} placeholder="Run in project folder" />
          <button>Run</button>
        </form>
        <div className="terminalHint">Commands run without provider API keys and stop after 30 seconds.</div>
        {terminalResult && <div className="terminalOutput">
          {terminalResult.loading ? "Running…" : terminalResult.error ?? <>
            <div>exit {terminalResult.exitCode} · {terminalResult.ms} ms</div>
            <pre>{[terminalResult.stdout, terminalResult.stderr].filter(Boolean).join("\n") || "(no output)"}</pre>
          </>}
        </div>}
      </>}
      {mode === "skills" && <div className="skillList">
        {skills?.error ?? (skills?.skills?.length
          ? skills.skills.map((skill) => <button key={skill.file} onClick={async () => {
            try { setPreview(await api(`/api/threads/${threadId}/file?path=${encodeURIComponent(skill.file)}`)); }
            catch (error) { setPreview({ path: skill.file, error: error.message }); }
          }}>{skill.file}</button>)
          : "No project SKILL.md files found.")}
        {preview && <div className="filePreview"><div>{preview.path}</div><pre>{preview.error ?? preview.content}</pre></div>}
      </div>}
      {mode === "checkpoints" && <div className="checkpointList">
        <button className="checkpointCreate" onClick={async () => {
          const name = window.prompt("Checkpoint name", `Before change ${new Date().toLocaleTimeString()}`);
          if (name == null) return;
          try {
            await api(`/api/threads/${threadId}/checkpoints`, { method: "POST", body: JSON.stringify({ name }) });
            setCheckpoints(await api(`/api/threads/${threadId}/checkpoints`));
          } catch (error) { setCheckpoints({ error: error.message }); }
        }}>Create checkpoint</button>
        {checkpoints?.error && <div className="modelError">{checkpoints.error}</div>}
        {(checkpoints?.checkpoints ?? []).map((checkpoint) => <div className="checkpointItem" key={checkpoint.id}>
          <div><strong>{checkpoint.name}</strong><span>{new Date(checkpoint.createdAt).toLocaleString()}</span></div>
          <button onClick={async () => {
            if (!window.confirm(`Restore “${checkpoint.name}”? Restore is allowed only when the current Git working tree is clean.`)) return;
            try {
              await api(`/api/threads/${threadId}/checkpoints/${checkpoint.id}/restore`, { method: "POST", body: "{}" });
              setDiff(null);
            } catch (error) { setCheckpoints({ ...checkpoints, error: error.message }); }
          }}>Restore</button>
        </div>)}
        {!checkpoints?.error && checkpoints?.checkpoints?.length === 0 && <div>No checkpoints yet.</div>}
      </div>}
    </section>
  );
}

function CodeBlock({ code, language }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeBlock">
      <div className="codeHead">
        <span>{language || "code"}</span>
        <button onClick={async () => {
          await navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}>{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

/** Safe markdown subset: no HTML injection, with readable prose and code. */
function MarkdownMessage({ text }) {
  const chunks = String(text ?? "").split(/```([\w.+-]*)\r?\n([\s\S]*?)```/g);
  return chunks.map((chunk, index) => {
    if (index % 3 === 1) return null; // language belongs to the following code chunk
    if (index % 3 === 2) return <CodeBlock key={index} language={chunks[index - 1]} code={chunk.replace(/\s+$/, "")} />;
    return chunk.split(/\r?\n{2,}/).filter(Boolean).map((paragraph, paragraphIndex) => {
      const heading = /^(#{1,4})\s+(.+)$/.exec(paragraph);
      if (heading) {
        const Tag = `h${heading[1].length}`;
        return <Tag key={`${index}-${paragraphIndex}`}><InlineMarkdown text={heading[2]} /></Tag>;
      }
      const lines = paragraph.split(/\r?\n/);
      if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
        return <ul key={`${index}-${paragraphIndex}`}>{lines.map((line, i) => <li key={i}><InlineMarkdown text={line.replace(/^\s*[-*]\s+/, "")} /></li>)}</ul>;
      }
      return <p key={`${index}-${paragraphIndex}`}><InlineMarkdown text={paragraph} /></p>;
    });
  });
}

function Message({ role, text, agentName }) {
  const isUser = role === "user";
  return (
    <div className={cx("messageRow", isUser ? "user" : "assistant")}>
      <div className="avatar">{isUser ? "T" : <Bot size={15} />}</div>
      <div className="bubble">
        <div className="bubbleWho">{isUser ? "You" : (agentName ?? "Agent")}</div>
        <div className="bubbleText"><MarkdownMessage text={text} /></div>
      </div>
    </div>
  );
}

function SettingsPanel({ onClose, harnesses, billing, threadId }) {
  const [providers, setProviders] = useState(null);
  const [auth, setAuth] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [deviceCode, setDeviceCode] = useState("");
  const [providerModels, setProviderModels] = useState({});
  const [providerBalances, setProviderBalances] = useState({});
  const [credentials, setCredentials] = useState(null);
  const [credentialInputs, setCredentialInputs] = useState({});
  const [credentialBusy, setCredentialBusy] = useState(null);
  const [credentialMessage, setCredentialMessage] = useState(null);
  const [reasoning, setReasoning] = useState(null);
  const [capabilities, setCapabilities] = useState(null);
  const [spending, setSpending] = useState(null);
  const [spendDraft, setSpendDraft] = useState(null);
  const [spendConfirmation, setSpendConfirmation] = useState("");
  const [providerLimitConfirmed, setProviderLimitConfirmed] = useState(false);
  const [spendBusy, setSpendBusy] = useState(false);
  const [spendMessage, setSpendMessage] = useState(null);
  const [diagnosticError, setDiagnosticError] = useState(null);
  const modalRef = useRef(null);

  useEffect(() => {
    api("/api/providers/status").then(setProviders).catch(() => {});
    api("/api/credentials").then(setCredentials).catch(() => {});
    api("/api/agent/auth").then(setAuth).catch(() => {});
    api("/api/agent/reasoning").then((value) => setReasoning(value.effort ?? "")).catch(() => {});
    api("/api/spending-safety").then((value) => {
      setSpending(value);
      setSpendDraft(value.policy);
    }).catch(() => {});
    for (const providerId of ["kimi", "deepseek"]) {
      api(`/api/providers/${providerId}/balance`)
        .then((value) => setProviderBalances((current) => ({ ...current, [providerId]: value })))
        .catch(() => {});
    }
    if (threadId) api(`/api/agent/capabilities/${threadId}`).then((value) => setCapabilities(value.capabilities)).catch(() => {});
  }, [threadId]);

  useEffect(() => {
    modalRef.current?.focus();
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const refreshAuth = useCallback(() => api("/api/agent/auth").then(setAuth), []);
  const refreshProviders = useCallback(() => Promise.all([
    api("/api/providers/status").then(setProviders),
    api("/api/credentials").then(setCredentials)
  ]), []);
  const refreshProviderBalance = useCallback((providerId) =>
    api(`/api/providers/${providerId}/balance`)
      .then((value) => setProviderBalances((current) => ({ ...current, [providerId]: value }))), []);

  const saveCredential = useCallback(async (providerId) => {
    const value = credentialInputs[providerId] ?? "";
    if (!value.trim()) return;
    setCredentialBusy(providerId);
    setCredentialMessage(null);
    try {
      const status = await api(`/api/credentials/${providerId}`, {
        method: "POST", body: JSON.stringify({ value })
      });
      setCredentials(status);
      setCredentialInputs((current) => ({ ...current, [providerId]: "" }));
      await refreshProviders();
      if (["kimi", "deepseek"].includes(providerId)) await refreshProviderBalance(providerId);
      setCredentialMessage({ ok: true, text: "Credential encrypted and activated." });
    } catch (error) {
      setCredentialMessage({ ok: false, text: error.message });
    } finally {
      setCredentialBusy(null);
    }
  }, [credentialInputs, refreshProviders, refreshProviderBalance]);

  const clearCredential = useCallback(async (providerId) => {
    setCredentialBusy(providerId);
    setCredentialMessage(null);
    try {
      const status = await api(`/api/credentials/${providerId}/clear`, { method: "POST", body: "{}" });
      setCredentials(status);
      await refreshProviders();
      setProviderBalances((current) => ({ ...current, [providerId]: null }));
      setCredentialMessage({ ok: true, text: "Stored credential removed." });
    } catch (error) {
      setCredentialMessage({ ok: false, text: error.message });
    } finally {
      setCredentialBusy(null);
    }
  }, [refreshProviders]);

  const discoverProvider = useCallback(async (providerId) => {
    setProviderModels((current) => ({ ...current, [providerId]: { loading: true } }));
    try {
      const result = await api(`/api/providers/${providerId}/models?strict=1`);
      setProviderModels((current) => ({ ...current, [providerId]: result }));
    } catch (error) {
      setProviderModels((current) => ({ ...current, [providerId]: { error: error.message } }));
    }
  }, []);

  const updateSpending = useCallback(async (paidCloudCallsEnabled, includeLimits = true) => {
    setSpendBusy(true);
    setSpendMessage(null);
    try {
      const result = await api("/api/spending-safety", {
        method: "POST",
        body: JSON.stringify({
          ...(includeLimits ? spendDraft : {}),
          paidCloudCallsEnabled,
          confirmation: paidCloudCallsEnabled ? spendConfirmation : undefined,
          providerLimitConfirmed: paidCloudCallsEnabled ? providerLimitConfirmed : undefined
        })
      });
      setSpending(result);
      setSpendDraft(result.policy);
      setSpendConfirmation("");
      setProviderLimitConfirmed(false);
      setSpendMessage({ ok: true, text: paidCloudCallsEnabled
        ? "Paid cloud calls unlocked within these host-enforced limits."
        : "Paid cloud calls locked. Agent review credentials were withdrawn." });
    } catch (error) {
      setSpendMessage({ ok: false, text: error.message });
    } finally {
      setSpendBusy(false);
    }
  }, [spendDraft, spendConfirmation, providerLimitConfirmed]);

  const login = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const result = await api("/api/agent/auth/login", {
        method: "POST",
        body: JSON.stringify({ methodId: auth?.availableMethods?.find((m) => m.id !== "cached_token")?.id })
      });
      if (result.authUrl) window.open(result.authUrl, "_blank", "noopener,noreferrer");
      if (!result.authUrl && result.mode !== "device") {
        setAuthError("Grok did not return a login URL. Try again or check the diagnostics output.");
      }
      setTimeout(() => refreshAuth().catch(() => {}), 1500);
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }, [auth, refreshAuth]);

  const logout = useCallback(async () => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await api("/api/agent/auth/logout", { method: "POST", body: "{}" });
      await refreshAuth();
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setAuthBusy(false);
    }
  }, [refreshAuth]);

  return (
    <div className="modalBackdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="PhoenixAI settings"
        tabIndex={-1} ref={modalRef} onClick={(e) => e.stopPropagation()}>
        <div className="modalHead">
          <h3>Settings</h3>
          <button className="iconBtn" aria-label="Close settings" onClick={onClose}><X size={16} /></button>
        </div>

        <section className="settingSection">
          <h4>Agent</h4>
          {auth ? (
            <div className="settingRow">
              <span>Account</span>
              <span className="settingValue">
                {auth.authenticated
                  ? (auth.usingApiKey ? `XAI_API_KEY · ${auth.model || "grok-4.7"}` : (auth.email ?? auth.methodId ?? "yes"))
                  : "not signed in"}
                {auth.authMode && !auth.usingApiKey && ` · ${auth.authMode}`}
              </span>
            </div>
          ) : <div className="settingHint">Agent not connected yet.</div>}
          <div className="settingActions">
            {auth?.usingApiKey ? (
              <div className="settingHint">Grok 4.7 is billed through your xAI API key. Browser sign-in is not required.</div>
            ) : auth?.authenticated ? (
              <button className="agentBtn agentBtnQuiet" disabled={authBusy} onClick={logout}>Sign out</button>
            ) : (
              <button className="agentBtn agentBtnPrimary" disabled={authBusy} onClick={login}>
                {authBusy ? "Starting login…" : "Sign in to Grok"}
              </button>
            )}
            <button className="agentBtn agentBtnQuiet" disabled={authBusy} onClick={() => refreshAuth().catch(() => {})}>
              Refresh
            </button>
          </div>
          {auth?.authMode === "device" && !auth?.authenticated && (
            <div className="deviceCodeRow">
              <input value={deviceCode} onChange={(e) => setDeviceCode(e.target.value)} placeholder="Device code" />
              <button className="agentBtn agentBtnPrimary" onClick={async () => {
                await api("/api/agent/auth/code", { method: "POST", body: JSON.stringify({ code: deviceCode }) });
                await refreshAuth();
              }}>Submit</button>
            </div>
          )}
          {authError && <div className="settingWarn">{authError}</div>}
          <div className="settingRow reasoningRow">
            <label htmlFor="reasoning-effort">Reasoning effort</label>
            <select id="reasoning-effort" value={reasoning ?? ""} onChange={async (event) => {
              const value = event.target.value;
              setReasoning(value);
              await api("/api/agent/reasoning", {
                method: "POST", body: JSON.stringify({ effort: value || null })
              }).catch((error) => setAuthError(error.message));
            }}>
              <option value="">Agent default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </select>
          </div>
          <div className="settingHint">Applies when a new chat creates its agent session.</div>
          {auth?.dataRetentionOptOut === false && (
            // Surfaced because this project handles proprietary code and the
            // setting is otherwise only visible via a terminal command.
            <div className="settingWarn">
              Coding data may be retained for training. Change this in the agent's privacy settings.
            </div>
          )}
        </section>

        <section className="settingSection spendingSafety">
          <h4>Spending safety</h4>
          <div className="spendStatusGrid">
            <div>
              <span>Paid cloud calls</span>
              <strong className={spending?.policy?.paidCloudCallsEnabled ? "spendOn" : "spendLocked"}>
                {spending?.policy?.paidCloudCallsEnabled ? "LIMITED" : "LOCKED"}
              </strong>
            </div>
            <div>
              <span>OpenRouter inference</span>
              <strong className="spendLocked">HARD BLOCKED</strong>
            </div>
          </div>
          <div className="settingHint">
            The host—not the model—enforces these controls. OpenRouter cannot be enabled in this release and its key is never given to agents.
            Direct paid providers default off, allow one request at a time, and fail closed if the shared ledger is unavailable.
          </div>
          <div className="settingWarn">
            Before unlocking QwenCloud: enable <strong>Free quota only</strong>, or set a small monthly Spending Limit and email alert under Pay-As-You-Go. Provider billing can lag, so PhoenixAI keeps its own smaller daily limit too.
          </div>
          <div className="settingWarn">
            Before unlocking Kimi: set a project daily spending budget in Kimi project settings. Moonshot notes that enforcement can lag by about 10 minutes, so keep PhoenixAI's daily limit below the deposited balance.
          </div>
          <div className="settingWarn">
            Before unlocking direct DeepSeek: keep only the prepaid amount you intend to risk. PhoenixAI reads the official balance, but still uses its smaller local daily and per-request limits for every call.
          </div>
          {spending && spendDraft && <>
            <div className="settingRow spendToday">
              <span>Today charged or conservatively reserved</span>
              <span className="settingValue">${Number(spending.today?.chargedOrReservedUsd ?? 0).toFixed(4)} / ${Number(spendDraft.dailyBudgetUsd ?? 0).toFixed(2)}</span>
            </div>
            <div className="spendFields">
              <label>Daily local budget (USD)
                <input type="number" min="0" max="100" step="0.25" value={spendDraft.dailyBudgetUsd}
                  onChange={(event) => setSpendDraft((value) => ({ ...value, dailyBudgetUsd: Number(event.target.value) }))} />
              </label>
              <label>Per-request limit (USD)
                <input type="number" min="0" max="25" step="0.05" value={spendDraft.perRequestBudgetUsd}
                  onChange={(event) => setSpendDraft((value) => ({ ...value, perRequestBudgetUsd: Number(event.target.value) }))} />
              </label>
              <label>Maximum output tokens
                <input type="number" min="64" max="2000" step="64" value={spendDraft.maxOutputTokens}
                  onChange={(event) => setSpendDraft((value) => ({ ...value, maxOutputTokens: Number(event.target.value) }))} />
              </label>
              <label>Paid requests per hour
                <input type="number" min="1" max="10" step="1" value={spendDraft.maxRequestsPerHour}
                  onChange={(event) => setSpendDraft((value) => ({ ...value, maxRequestsPerHour: Number(event.target.value) }))} />
              </label>
            </div>
            {spending.policy.paidCloudCallsEnabled ? (
              <div className="settingActions">
                <button className="agentBtn agentBtnPrimary" disabled={spendBusy} onClick={() => updateSpending(true)}>Save limits</button>
                <button className="agentBtn agentBtnStrong" disabled={spendBusy} onClick={() => updateSpending(false, false)}>Lock paid calls now</button>
              </div>
            ) : <>
              <label className="spendConfirm">
                Type <code>ENABLE PAID CLOUD CALLS</code> to unlock direct providers
                <input value={spendConfirmation} onChange={(event) => setSpendConfirmation(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
              <label className="spendAttestation">
                <input type="checkbox" checked={providerLimitConfirmed} onChange={(event) => setProviderLimitConfirmed(event.target.checked)} />
                I enabled a provider-side limit, Free quota only block, or deliberately limited prepaid balance.
              </label>
              <button className="agentBtn agentBtnStrong" disabled={spendBusy || !providerLimitConfirmed || spendConfirmation !== "ENABLE PAID CLOUD CALLS"}
                onClick={() => updateSpending(true)}>Unlock within limits</button>
            </>}
            {spendMessage && <div className={spendMessage.ok ? "settingSuccess" : "settingWarn"}>{spendMessage.text}</div>}
            {(spending.blockedAttempts ?? []).slice(0, 3).map((attempt, index) => (
              <div className="spendBlocked" key={`${attempt.createdAt}-${index}`}>{attempt.providerId}: {attempt.message}</div>
            ))}
          </>}
        </section>

        <section className="settingSection">
          <h4>Grok usage</h4>
          {auth?.usingApiKey ? (
            <div className="settingHint">
              Token usage for <code>{auth.model || "grok-4.7"}</code> is billed on
              your xAI API account at console.x.ai. PhoenixAI does not invent a
              remaining-quota percentage for API keys.
            </div>
          ) : billing?.available ? (
            <>
              <div className="settingRow">
                <span>Shared pool remaining</span>
                <span className="settingValue ok">{billing.remainingPercent != null ? `${billing.remainingPercent.toFixed(1)}%` : "Not reported"}</span>
              </div>
              <div className="settingRow">
                <span>Plan</span>
                <span className="settingValue">{billing.subscriptionTier ?? "Grok Build"}</span>
              </div>
              {billing.currentPeriod?.end && (
                <div className="settingRow"><span>Resets</span><span className="settingValue">{new Date(billing.currentPeriod.end).toLocaleString()}</span></div>
              )}
              <div className="settingHint">{billing.remainingPercent != null
                ? "This is the service's shared usage percentage, not a token balance."
                : "Grok Build returned the plan and billing period but no remaining percentage. PhoenixAI will not guess."}</div>
            </>
          ) : <div className="settingHint">Usage is unavailable until Grok Build is connected and signed in.</div>}
        </section>

        <section className="settingSection">
          <h4>Available agents</h4>
          <div className="settingHint">
            {harnesses?.ready?.length ?? 0} agents from the ACP registry can run here.
            Each downloads on first use.
          </div>
        </section>

        <section className="settingSection">
          <h4>MCP and commands</h4>
          {threadId ? <>
            <div className="settingRow"><span>MCP servers</span><span className="settingValue">{capabilities?.mcpServers?.length ?? 0}</span></div>
            <div className="capabilityTags">
              {(capabilities?.mcpServers ?? []).map((server) => <span key={server.name}>{server.name}</span>)}
            </div>
            <div className="settingRow"><span>Advertised commands</span><span className="settingValue">{capabilities?.commands?.length ?? 0}</span></div>
            <div className="settingHint">Type / in the composer to open the command palette.</div>
          </> : <div className="settingHint">Open a chat to inspect its MCP servers and commands.</div>}
        </section>

        <section className="settingSection">
          <h4>Provider credentials</h4>
          <div className="settingHint">
            Desktop entries are encrypted with Windows account protection. Values are activated in the host process and never returned to this page.
            Environment and .env credentials remain supported.
          </div>
          {credentials?.available ? (credentials.providers ?? []).map((credential) => (
            <div key={credential.id} className="credentialSetting">
              <div className="settingRow">
                <span>{credential.name}</span>
                <span className={cx("settingValue", credential.configured ? "ok" : "muted")}>
                  {credential.id === "openrouter" && credential.configured
                    ? `stored · inference blocked`
                    : (credential.configured ? `configured · ${credential.source}` : "not set")}
                </span>
              </div>
              <div className="credentialActions">
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={`${credential.name} credential`}
                  placeholder={credential.configured ? "Paste to replace" : credential.id === "public-account" ? "Paste account ID" : "Paste API key"}
                  value={credentialInputs[credential.id] ?? ""}
                  onChange={(event) => setCredentialInputs((current) => ({ ...current, [credential.id]: event.target.value }))}
                />
                <button className="agentBtn agentBtnPrimary" disabled={credentialBusy === credential.id || !(credentialInputs[credential.id] ?? "").trim()}
                  onClick={() => saveCredential(credential.id)}>Save</button>
                {credential.source === "secure-storage" && (
                  <button className="agentBtn agentBtnQuiet" disabled={credentialBusy === credential.id}
                    onClick={() => clearCredential(credential.id)}>Clear</button>
                )}
                {credential.configured && !["openrouter", "public", "public-account"].includes(credential.id) && (
                  <button className="agentBtn agentBtnQuiet" disabled={providerModels[credential.id]?.loading}
                    onClick={() => discoverProvider(credential.id)}>
                    {providerModels[credential.id]?.loading ? "Checking…" : "Check"}
                  </button>
                )}
              </div>
              {providerModels[credential.id]?.models && (
                <div className="modelList">Verified {providerModels[credential.id].models.length} models · {providerModels[credential.id].models.slice(0, 5).map((model) => model.id).join(" · ")}</div>
              )}
              {credential.id === "kimi" && Number.isFinite(providerBalances.kimi?.availableBalanceUsd) && (
                <div className="settingSuccess">Available Kimi balance: ${providerBalances.kimi.availableBalanceUsd.toFixed(2)}</div>
              )}
              {credential.id === "deepseek" && Number.isFinite(providerBalances.deepseek?.availableBalanceUsd) && (
                <div className="settingSuccess">
                  Direct DeepSeek balance: ${providerBalances.deepseek.availableBalanceUsd.toFixed(2)}
                  {providerBalances.deepseek.available === false ? " · unavailable" : " · available"}
                </div>
              )}
              {credential.id === "deepseek" && (
                <div className="settingHint">Auto DeepSeek reviews use QwenCloud; choose the direct route to charge this account.</div>
              )}
              {providerModels[credential.id]?.error && <div className="modelError">{providerModels[credential.id].error}</div>}
            </div>
          )) : <div className="settingHint">Encrypted entry is available in the packaged desktop app. Development mode uses `.env`.</div>}
          {credentialMessage && <div className={credentialMessage.ok ? "settingSuccess" : "settingWarn"}>{credentialMessage.text}</div>}
          {(credentials?.errors ?? []).map((error) => <div key={error} className="settingWarn">{error}</div>)}

          <h4 className="providerCatalogTitle">Provider catalog</h4>
          {(providers?.providers ?? []).map((p) => (
            <div key={p.id} className="providerSetting">
              <div className="settingRow">
                <span>{p.name}</span>
                <span className={cx("settingValue", p.configured ? "ok" : "muted")}>
                  {p.configured ? "configured" : "not set"}
                </span>
              </div>
              {p.id === "openrouter"
                ? <div className="modelError">Inference disabled by the application spending firewall.</div>
                : <button className="modelDiscover" onClick={() => discoverProvider(p.id)}>
                  {providerModels[p.id]?.loading ? "Verifying…" : "Verify credential and list models"}
                </button>}
              {providerModels[p.id]?.models && (
                <div className="modelList">
                  {providerModels[p.id].models.slice(0, 8).map((model) => model.id).join(" · ")}
                </div>
              )}
              {providerModels[p.id]?.error && <div className="modelError">{providerModels[p.id].error}</div>}
            </div>
          ))}
        </section>

        <section className="settingSection">
          <h4>Privacy and diagnostics</h4>
          <div className="settingRow"><span>PhoenixAI telemetry</span><span className="settingValue ok">off</span></div>
          <div className="settingHint">
            Chats, checkpoints, and memory stay in the local application data folder until you delete them.
            Prompts sent to a selected cloud model are governed by that provider's account and retention policy.
          </div>
          <button className="agentBtn agentBtnQuiet diagnosticButton" onClick={async () => {
            setDiagnosticError(null);
            try {
              const diagnostics = await api("/api/diagnostics");
              const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `phoenix-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
              anchor.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) { setDiagnosticError(error.message); }
          }}>Download diagnostics</button>
          <div className="settingHint">Exports runtime and configuration status, never prompts or secret values.</div>
          {diagnosticError && <div className="settingWarn">{diagnosticError}</div>}
        </section>
      </div>
    </div>
  );
}
