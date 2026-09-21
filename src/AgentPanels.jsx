/**
 * Agent-session UI: approval dialog, tool-call stream, reasoning, status.
 *
 * The approval dialog is the reason this app exists rather than the terminal:
 * the same permission request the TUI renders as a text prompt becomes a real
 * dialog showing exactly what the agent wants to touch.
 */

import React from "react";

/** Order options so the safe choice is never the default. */
const OPTION_ORDER = { reject_once: 0, reject_always: 1, allow_once: 2, allow_always: 3 };

function optionTone(kind) {
  if (kind === "allow_always") return "agentBtn agentBtnStrong";
  if (kind === "allow_once") return "agentBtn agentBtnPrimary";
  return "agentBtn agentBtnQuiet";
}

/**
 * Blocking approval dialog. The agent is stopped until this is answered, so it
 * deliberately has no dismiss-by-clicking-away.
 */
export function PermissionDialog({ request, onAnswer }) {
  const dialogRef = React.useRef(null);
  React.useEffect(() => {
    if (!request) return;
    dialogRef.current?.querySelector("button")?.focus();
  }, [request]);
  if (!request) return null;

  const title = request.toolCall?.title || request.title || "Agent action";
  const kind = request.toolCall?.kind || "";
  const locations = request.toolCall?.locations || [];
  const options = [...(request.options || [])].sort(
    (a, b) => (OPTION_ORDER[a.kind] ?? 9) - (OPTION_ORDER[b.kind] ?? 9)
  );

  return (
    <div className="agentModalBackdrop" role="dialog" aria-modal="true" aria-label="Agent permission request"
      onKeyDown={(event) => { if (event.key === "Escape") onAnswer(null); }}>
      <div className="agentModal" ref={dialogRef}>
        <div className="agentModalHead">
          <span className="agentModalKind">{kind || "permission"}</span>
          <h3>{title}</h3>
        </div>

        {locations.length > 0 && (
          <ul className="agentModalPaths">
            {locations.slice(0, 8).map((loc, i) => (
              <li key={i}><code>{loc.path || String(loc)}</code></li>
            ))}
          </ul>
        )}

        <p className="agentModalHint">
          The agent is paused until you answer.
        </p>

        <div className="agentModalActions">
          {options.map((option) => (
            <button
              key={option.optionId}
              className={optionTone(option.kind)}
              onClick={() => onAnswer(option.optionId)}
            >
              {option.name || option.optionId}
            </button>
          ))}
          <button className="agentBtn agentBtnQuiet" onClick={() => onAnswer(null)}>
            Cancel turn
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL = {
  pending: "queued",
  in_progress: "running",
  completed: "done",
  failed: "failed"
};

/** Live tool activity. One row per tool call, updated in place. */
export function ToolCallStream({ toolCalls = [] }) {
  if (!toolCalls.length) return null;
  return (
    <ol className="agentToolList">
      {toolCalls.map((call) => (
        <li key={call.id} className={`agentToolItem agentTool-${call.status || "pending"}`}>
          <span className="agentToolStatus">{STATUS_LABEL[call.status] || call.status || "…"}</span>
          <span className="agentToolTitle">{call.title || call.kind || call.id}</span>
          {Array.isArray(call.locations) && call.locations.length > 0 && (
            <span className="agentToolPath">{call.locations[0]?.path}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Reasoning stream, collapsed by default — it is long and rarely the point. */
export function ThoughtPanel({ thought }) {
  const [open, setOpen] = React.useState(false);
  if (!thought) return null;
  return (
    <div className="agentThought">
      <button className="agentThoughtToggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide reasoning" : "Show reasoning"}
      </button>
      {open && <pre className="agentThoughtBody">{thought}</pre>}
    </div>
  );
}

/**
 * Connection + quota state. Quota exhaustion is surfaced as a decision, not as
 * a red error — the free tier running out is expected, not a malfunction.
 */
export function AgentStatusBar({ connection, error, busy, onCancel }) {
  if (error?.quota) {
    return (
      <div className="agentStatus agentStatusQuota">
        <strong>Grok usage limit reached.</strong>{" "}
        The free tier is exhausted. A SuperGrok subscription raises the limit, or it resets later.
      </div>
    );
  }
  if (error) {
    return <div className="agentStatus agentStatusError">{error.message}</div>;
  }
  if (connection?.status === "unavailable") {
    return (
      <div className="agentStatus agentStatusIdle">
        Agent sessions need the desktop app — the browser build cannot spawn one.
      </div>
    );
  }
  if (connection?.status === "disconnected") {
    return <div className="agentStatus agentStatusError">Agent disconnected. The next message reconnects.</div>;
  }

  return (
    <div className="agentStatus">
      <span className={`agentDot ${busy ? "agentDotBusy" : "agentDotIdle"}`} />
      {busy ? "Agent working" : "Ready"}
      {busy && (
        <button className="agentBtn agentBtnQuiet agentCancel" onClick={onCancel}>Stop</button>
      )}
    </div>
  );
}
