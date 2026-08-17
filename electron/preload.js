/**
 * Renderer bridge.
 *
 * The window runs with contextIsolation and sandbox enabled, so the React app
 * cannot reach Node or ipcRenderer directly. This exposes a deliberately narrow
 * surface: agent event subscriptions and a permission reply channel. Nothing
 * else crosses.
 *
 * Permission replies are correlated by an id assigned in the main process,
 * because the `respond` callback that answers ACP lives there and cannot be
 * serialized across the bridge.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** Wrap a listener so callers get an unsubscribe function, not a raw channel. */
function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== "function") return () => {};
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld("agentBridge", {
  /** True when running in the desktop shell; false in the dev browser. */
  available: true,

  /** Streamed session updates: { threadId, sessionId, update, isReplay, meta } */
  onUpdate: subscribe("agent:update"),

  /** Tool approval requests: { id, sessionId, toolCall, options } */
  onPermission: subscribe("agent:permission"),

  /** A permission was answered elsewhere (cancel, expiry, another window). */
  onPermissionResolved: subscribe("agent:permission-resolved"),

  onConnected: subscribe("agent:connected"),
  onDisconnected: subscribe("agent:disconnected"),

  /** Turn lifecycle. `turn-error` carries `quota: true` when the tier is spent. */
  onTurnComplete: subscribe("agent:turn-complete"),
  onTurnError: subscribe("agent:turn-error"),

  /** The daemon died or failed to start. */
  onDaemonExit: subscribe("agent:daemon-exit"),
  onDaemonError: subscribe("agent:daemon-error"),

  /** Agent notifications on rails we do not model yet. */
  onNotify: subscribe("agent:notify"),

  /** Workflow run progress: { threadId, run, removed }. */
  onWorkflow: subscribe("agent:workflow"),

  /** Slash commands and saved workflows the agent advertises. */
  onCommands: subscribe("agent:commands"),

  /** The daemon was released after idling; the next prompt reconnects. */
  onIdleRelease: subscribe("agent:idle-release"),

  /** Daemon stdout/stderr, for a diagnostics pane. */
  onDaemonOutput: subscribe("agent:daemon-output"),

  /**
   * Answer a permission request.
   * @param {string} id        the request id from onPermission
   * @param {string|null} optionId  an option id, or null to cancel
   */
  respondPermission: (id, optionId) =>
    ipcRenderer.invoke("agent:permission-response", { id, optionId }),

  /**
   * Outstanding permission requests. A run outlives the window, so a request
   * raised while no window was open must be re-shown on open — otherwise it
   * stalls for its full timeout and auto-denies with nothing displayed.
   */
  pendingPermissions: () => ipcRenderer.invoke("agent:pending-permissions"),

  /** Update lifecycle: checking -> available -> downloading -> ready. */
  onUpdate: subscribe("update:state"),

  /**
   * The current update state. A "ready" event fired before this window opened
   * would otherwise be lost, leaving a downloaded update with nothing to
   * prompt the restart.
   */
  updateState: () => ipcRenderer.invoke("update:state"),

  checkForUpdate: () => ipcRenderer.invoke("update:check"),

  /** Quit and apply a downloaded update, then relaunch. */
  installUpdate: () => ipcRenderer.invoke("update:install")
});
