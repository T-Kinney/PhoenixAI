/**
 * React binding for the Grok Build agent session.
 *
 * Consumes `window.agentBridge` (exposed by electron/preload.js) and turns the
 * raw ACP event stream into render-ready state.
 *
 * Three things here are easy to get wrong and are handled once, centrally:
 *
 *  1. REPLAY. Reattaching to a session replays its whole history from disk.
 *     Every replayed update carries `isReplay`, and a UI that ignores it will
 *     duplicate the entire conversation on every reload. Replay rebuilds state
 *     rather than appending to it.
 *
 *  2. TOOL CALLS. `tool_call_update` is a PATCH keyed by id, not a snapshot.
 *     Rendering updates as independent events produces a list of duplicated,
 *     half-filled rows instead of one row that fills in.
 *
 *  3. PERMISSIONS. The agent blocks until answered. An unanswered prompt is
 *     not a cosmetic bug — it is a hung turn.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const UPDATE = {
  MESSAGE: "agent_message_chunk",
  THOUGHT: "agent_thought_chunk",
  TOOL_CALL: "tool_call",
  TOOL_UPDATE: "tool_call_update",
  PLAN: "plan",
  USER_MESSAGE: "user_message_chunk",
  COMMANDS: "available_commands_update"
};

const emptyState = () => ({
  turns: [],          // [{ role, text }]
  thought: "",        // reasoning for the in-flight turn
  toolCalls: [],      // ordered, merged by id
  plan: null,
  commands: []
});

function textOf(update) {
  const content = update?.content;
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("");
  return content.text ?? "";
}

/** Fold one update into state. Pure, so replay and live share one code path. */
function reduceUpdate(state, update) {
  const kind = update?.sessionUpdate;
  const next = { ...state };

  switch (kind) {
    case UPDATE.USER_MESSAGE: {
      const text = textOf(update);
      if (!text) return state;
      next.turns = [...state.turns, { role: "user", text }];
      return next;
    }
    case UPDATE.MESSAGE: {
      const text = textOf(update);
      if (!text) return state;
      const last = state.turns[state.turns.length - 1];
      // Chunks belong to one assistant turn; append rather than create a turn
      // per chunk, or a reply arrives as dozens of separate bubbles.
      if (last?.role === "assistant") {
        next.turns = [...state.turns.slice(0, -1), { ...last, text: last.text + text }];
      } else {
        next.turns = [...state.turns, { role: "assistant", text }];
      }
      next.thought = "";
      return next;
    }
    case UPDATE.THOUGHT: {
      next.thought = state.thought + textOf(update);
      return next;
    }
    case UPDATE.TOOL_CALL:
    case UPDATE.TOOL_UPDATE: {
      const id = update.toolCallId ?? update.id;
      if (!id) return state;
      const index = state.toolCalls.findIndex((t) => t.id === id);
      const patch = {
        id,
        title: update.title,
        kind: update.kind,
        status: update.status,
        content: update.content,
        locations: update.locations
      };
      // Drop undefined so a patch never erases a field the first event set.
      for (const key of Object.keys(patch)) {
        if (patch[key] === undefined) delete patch[key];
      }
      if (index === -1) {
        next.toolCalls = [...state.toolCalls, { status: "pending", ...patch }];
      } else {
        next.toolCalls = state.toolCalls.map((t, i) => (i === index ? { ...t, ...patch } : t));
      }
      return next;
    }
    case UPDATE.PLAN: {
      next.plan = update.entries ?? update.plan ?? null;
      return next;
    }
    case UPDATE.COMMANDS: {
      next.commands = update.availableCommands ?? update.commands ?? [];
      return next;
    }
    case "usage_update": {
      next.usage = update.usage ?? update;
      return next;
    }
    default:
      return state;
  }
}

export function useAgentSession(threadId) {
  const bridge = typeof window !== "undefined" ? window.agentBridge : null;
  // True only once a transport is actually carrying events. Deriving this from
  // a status value nothing ever set made it true from the first render, so the
  // legacy saved-chat path could never be reached.
  const [transportReady, setTransportReady] = useState(false);
  const [state, setState] = useState(emptyState);
  const [permission, setPermission] = useState(null);
  const [connection, setConnection] = useState({ status: "idle", detail: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Typing should never be blocked by a running turn. Queued messages send
  // automatically when the turn ends, and stay editable until then.
  const [queue, setQueue] = useState([]);
  // Slash commands the agent itself advertises, merged into the palette.
  const [commands, setCommands] = useState([]);
  // Context usage, so the window limit is visible before it is hit.
  const [usage, setUsage] = useState(null);
  // Memories the agent pulled in via the MCP tool, so the user can see WHY it
  // answered the way it did rather than the recall being invisible.
  const [memoryHits, setMemoryHits] = useState([]);

  // Replay arrives as a burst that rebuilds history; buffer it so the UI does
  // not thrash through hundreds of intermediate renders.
  const replayBuffer = useRef([]);
  const replayTimer = useRef(null);
  const threadRef = useRef(threadId);
  threadRef.current = threadId;

  // True from the first replay update until the first live one. Replay is a
  // rebuild, but it can arrive across SEVERAL debounce windows — restarting
  // from empty on every flush threw away all but the final chunk.
  const replaying = useRef(false);

  const flushReplay = useCallback(() => {
    const buffered = replayBuffer.current;
    replayBuffer.current = [];
    replayTimer.current = null;
    if (!buffered.length) return;
    setState((prev) => buffered.reduce(reduceUpdate, prev));
  }, []);

  /** Begin a replay run: clear once, then accumulate across flushes. */
  const beginReplay = useCallback(() => {
    if (replaying.current) return;
    replaying.current = true;
    setState(emptyState());
  }, []);

  useEffect(() => {
    // Dev browser: no context bridge, so consume the SSE stream instead. Both
    // paths carry identical payloads, so everything downstream is shared.
    if (!bridge?.available) {
      const source = new EventSource("/api/agent/events");
      const onUpdate = (e) => {
        const payload = JSON.parse(e.data);
        if (payload?.threadId && payload.threadId !== threadRef.current) return;
        if (payload?.isReplay) {
          beginReplay();
          replayBuffer.current.push(payload.update);
          if (replayTimer.current) clearTimeout(replayTimer.current);
          replayTimer.current = setTimeout(flushReplay, 120);
          return;
        }
        if (replayBuffer.current.length) flushReplay();
        replaying.current = false;
        setState((prev) => reduceUpdate(prev, payload.update));
      };
      const onPermission = (e) => setPermission(JSON.parse(e.data));
      const onResolved = () => setPermission(null);
      const onConnected = (e) => setConnection({ status: "connected", detail: JSON.parse(e.data) });
      const onTurnError = (e) => {
        const info = JSON.parse(e.data);
        setBusy(false);
        setError({ message: info.message, quota: Boolean(info.quota) });
      };
      const onTurnComplete = () => setBusy(false);

      source.addEventListener("update", onUpdate);
      source.addEventListener("permission", onPermission);
      source.addEventListener("permission-resolved", onResolved);
      source.addEventListener("connected", onConnected);
      source.onopen = () => setTransportReady(true);
      source.addEventListener("turn-error", onTurnError);
      source.addEventListener("turn-complete", onTurnComplete);
      source.onerror = () => setConnection({ status: "disconnected", detail: null });

      return () => {
        source.close();
        setTransportReady(false);
        if (replayTimer.current) clearTimeout(replayTimer.current);
      };
    }

    const offUpdate = bridge.onUpdate((payload) => {
      // Ignore traffic for other threads sharing the daemon.
      if (payload?.threadId && payload.threadId !== threadRef.current) return;

      if (payload?.isReplay) {
        beginReplay();
        replayBuffer.current.push(payload.update);
        if (replayTimer.current) clearTimeout(replayTimer.current);
        replayTimer.current = setTimeout(flushReplay, 120);
        return;
      }
      // A live update after buffered replay means replay is over.
      if (replayBuffer.current.length) flushReplay();
      replaying.current = false;
      setState((prev) => reduceUpdate(prev, payload.update));
    });

    setTransportReady(true);
    const offPermission = bridge.onPermission((request) => setPermission(request));

    // H5: the IPC path subscribed fewer channels than SSE, so in the desktop
    // build quota exhaustion and turn errors were invisible, and a permission
    // resolved elsewhere left the modal up forever.
    const offResolved = bridge.onPermissionResolved?.(() => setPermission(null));
    const offTurnComplete = bridge.onTurnComplete?.(() => setBusy(false));
    const offTurnError = bridge.onTurnError?.((info) => {
      setBusy(false);
      setError({ message: info?.message ?? "Turn failed", quota: Boolean(info?.quota) });
    });
    const offDaemonError = bridge.onDaemonError?.((info) =>
      setError({ message: info?.message ?? "Agent process error", quota: false }));

    // A run outlives the window, so re-show anything raised while it was closed.
    bridge.pendingPermissions?.().then((list) => {
      if (Array.isArray(list) && list.length) setPermission(list[0]);
    }).catch(() => {});
    const offConnected = bridge.onConnected((status) =>
      setConnection({ status: "connected", detail: status }));
    const offDisconnected = bridge.onDisconnected((info) =>
      setConnection({ status: "disconnected", detail: info }));

    return () => {
      setTransportReady(false);
      offUpdate?.();
      offPermission?.();
      offResolved?.();
      offTurnComplete?.();
      offTurnError?.();
      offDaemonError?.();
      offConnected?.();
      offDisconnected?.();
      if (replayTimer.current) clearTimeout(replayTimer.current);
    };
  }, [bridge, flushReplay, beginReplay]);

  const answerPermissionById = useCallback(async (id, optionId) => {
    if (!id) return;
    if (bridge?.available) {
      await bridge.respondPermission(id, optionId ?? null).catch(() => {});
      return;
    }
    await fetch("/api/agent/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, optionId: optionId ?? null })
    }).catch(() => {});
  }, [bridge]);

  const answerPermission = useCallback(async (optionId) => {
    if (!permission) return;
    const id = permission.id;
    setPermission(null);
    if (bridge?.available) {
      await bridge.respondPermission(id, optionId ?? null);
      return;
    }
    await fetch("/api/agent/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, optionId: optionId ?? null })
    }).catch(() => {});
  }, [bridge, permission]);

  const send = useCallback(async (text, { projectPath = null, threadId = null } = {}) => {
    if (!text?.trim()) return;
    // thread?.id lags behind a bundle refetch, so callers may pass the id they
    // just resolved. Without one there is nothing to bind a session to.
    const target = threadId || threadRef.current;
    if (!target) throw new Error("No thread selected.");
    setBusy(true);
    setError(null);
    // Echo immediately; the agent's own user_message_chunk may lag.
    setState((prev) => ({ ...prev, turns: [...prev.turns, { role: "user", text }] }));
    try {
      const response = await fetch("/api/agent/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: target, text, projectPath })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `${response.status}`);
      return data;
    } catch (e) {
      // Quota exhaustion is a decision point, not a generic failure.
      const quota = /usage limit|balance exhausted|plan limit|rate limit/i.test(e.message);
      setError({ message: e.message, quota });
      throw e;
    }
    // NOTE: busy is deliberately NOT cleared here. The POST returns as soon as
    // the turn is accepted; the turn itself ends on turn-complete/turn-error.
  }, []);

  /** Queue a message for when the current turn finishes. */
  const enqueue = useCallback((text) => {
    if (!text?.trim()) return;
    setQueue((q) => [...q, { id: `q_${Date.now()}_${q.length}`, text }]);
  }, []);

  const dequeue = useCallback((id) => {
    setQueue((q) => q.filter((item) => item.id !== id));
  }, []);

  const editQueued = useCallback((id, text) => {
    setQueue((q) => q.map((item) => (item.id === id ? { ...item, text } : item)));
  }, []);

  const cancel = useCallback(async () => {
    await fetch("/api/agent/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: threadRef.current })
    }).catch(() => {});
  }, []);

  // Flush the queue when a turn ends. One at a time — sending the whole queue
  // at once would interleave unrelated requests into a single turn.
  useEffect(() => {
    if (busy || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    send(next.text).catch(() => {});
  }, [busy, queue, send]);

  // Reset when the user switches threads.
  useEffect(() => {
    if (replayTimer.current) {
      clearTimeout(replayTimer.current);
      replayTimer.current = null;
    }
    replayBuffer.current = [];
    replaying.current = false;

    // Answer rather than abandon: dropping the dialog leaves the agent blocked
    // for the full permission TTL with nothing on screen to release it.
    setPermission((current) => {
      if (current) answerPermissionById(current.id, null);
      return null;
    });

    setState(emptyState());
    setError(null);
    setBusy(false);
    setQueue([]);
    setMemoryHits([]);
  }, [threadId]);

  return useMemo(() => ({
    ...state,
    permission,
    answerPermission,
    connection,
    busy,
    error,
    send,
    cancel,
    queue,
    memoryHits,
    usage,
    commands,
    enqueue,
    dequeue,
    editQueued,
    // Usable in the desktop app via IPC, and in the dev browser via SSE.
    available: transportReady
  }), [state, permission, answerPermission, connection, busy, error, send, cancel,
       transportReady, queue, enqueue, dequeue, editQueued, memoryHits, usage, commands]);
}
