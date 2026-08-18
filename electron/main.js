import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { startAutoUpdate } from "./updater.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const distDir = path.join(appRoot, "dist");
const resourcesDir = path.join(appRoot, "resources");
const iconPath = path.join(resourcesDir, "icon.png");
let api;
let quitting = false;


protocol.registerSchemesAsPrivileged([
  {
    scheme: "phoenix",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

async function readRequestJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

let routes = null;
let sessions = null;
let buildRoutes = null;
let matchRoute = null;
let updater = null;
// The last update state, replayed to windows that open after it was emitted so
// a late-opening window still shows "restart to update".
let lastUpdateState = null;

/** Push an agent event to every open window. */
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/**
 * Permission correlation lives in SessionManager, not here — keeping it in the
 * host is what previously left the dev server unable to approve anything. This
 * host only relays.
 */
function onAgentPermission(request) {
  broadcast("agent:permission", request);
}

/** Native folder picker — desktop-only, injected into the shared route table. */
async function selectFolder() {
  const result = await dialog.showOpenDialog({
    title: "Select Project Folder",
    properties: ["openDirectory"]
  });
  if (result.canceled || !result.filePaths[0]) {
    return { canceled: true };
  }
  return api.addProject({ path: result.filePaths[0] });
}

/**
 * Routes are defined once in server/routes.js and shared with the dev server.
 * This host only adapts the protocol request into the table's calling
 * convention; it never declares endpoints of its own.
 */
async function handleApi(request, pathname) {
  try {
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    const match = matchRoute(routes, request.method, pathname);
    if (!match) {
      return jsonResponse({ error: `Route not found: ${request.method} ${pathname}` }, 404);
    }
    const body = request.method === "POST" ? await readRequestJson(request) : {};
    const value = await match.route.handler({ params: match.params, body, query });
    return jsonResponse(value ?? {});
  } catch (error) {
    return jsonResponse({ error: error.message }, error.status || 502);
  }
}

async function handleAppProtocol(request) {
  const url = new URL(request.url);
  const pathname = url.pathname || "/";

  if (pathname.startsWith("/api/")) {
    return handleApi(request, pathname);
  }

  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(distDir, safePath);
  if (!resolved.startsWith(distDir)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  try {
    const bytes = await fs.readFile(resolved);
    return new Response(bytes, {
      headers: { "content-type": contentTypeFor(resolved) }
    });
  } catch {
    const index = await fs.readFile(path.join(distDir, "index.html"));
    return new Response(index, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    title: "PhoenixAI",
    icon: iconPath,
    backgroundColor: "#f3f1ec",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  window.loadURL("phoenix://app/");
  return window;
}

app.setName("PhoenixAI");
app.setAppUserModelId("com.rykerphoenix.phoenixai");

app.whenReady().then(() => {
  process.env.AGENTCC_DATA_DIR = path.join(app.getPath("userData"), "data");
  process.env.AGENTCC_ENV_PATH = path.join(app.getPath("userData"), ".env");
  return Promise.all([
    import("../server/api.js"),
    import("../server/routes.js"),
    import("../server/acp/sessionManager.js")
  ]);
}).then(async ([apiModule, routesModule, sessionModule]) => {
  api = apiModule;
  buildRoutes = routesModule.buildRoutes;
  matchRoute = routesModule.matchRoute;

  // The ACP session manager binds threads to Grok Build sessions. The daemon
  // itself is started lazily on first use, so launching the app does not spawn
  // an agent until something actually needs one.
  sessions = new sessionModule.SessionManager({
    statePath: path.join(app.getPath("userData"), "data", "acp-sessions.json"),
    // NOT rootDir: in a packaged build that resolves inside app.asar, which is
    // a FILE. Spawning the agent daemon with a cwd that is not a real directory
    // fails with ENOENT, so the agent never starts.
    defaultCwd: app.getPath("userData"),
    approvalMode: (await apiModule.readConfig().catch(() => ({})))?.approvalMode ?? "ask",
    // Attaching this makes the memory MCP server available to every agent
    // session, which is what lets Grok (and any other harness) consult the
    // project's accumulated knowledge instead of starting cold.
    memoryDbPath: path.join(app.getPath("userData"), "data", "memory.db")
  });
  await sessions.load();
  sessions.on("permission", onAgentPermission);
  sessions.on("permission-resolved", (info) => broadcast("agent:permission-resolved", info));
  // Auto-approved actions still reach the UI: granting silently with no record
  // is how a user loses track of what the agent did on their machine.
  sessions.on("permission-auto", (info) => broadcast("agent:permission-auto", info));
  sessions.on("update", (payload) => broadcast("agent:update", payload));
  sessions.on("connected", (status) => broadcast("agent:connected", status));
  sessions.on("disconnected", (info) => broadcast("agent:disconnected", info));
  sessions.on("daemon-output", (text) => broadcast("agent:daemon-output", text));
  sessions.on("daemon-exit", (info) => broadcast("agent:daemon-exit", info));
  sessions.on("daemon-error", (e) => broadcast("agent:daemon-error", { message: e?.message }));
  sessions.on("turn-complete", (info) => broadcast("agent:turn-complete", info));
  sessions.on("turn-error", (info) => broadcast("agent:turn-error", info));
  sessions.on("notify", (payload) => broadcast("agent:notify", payload));
  sessions.on("workflow", (payload) => broadcast("agent:workflow", payload));
  sessions.on("commands", (payload) => broadcast("agent:commands", payload));
  sessions.on("idle-release", (info) => broadcast("agent:idle-release", info));
  sessions.on("auth-complete", (info) => broadcast("agent:auth-complete", info));
  sessions.on("auth-error", (info) => broadcast("agent:auth-error", info));

  // The manager validates the id and the option, so a compromised renderer
  // cannot name an option the agent never offered.
  ipcMain.handle("agent:permission-response", (_event, { id, optionId }) =>
    sessions.respondToPermission(id, optionId));

  // A run can outlive the window. Without replaying the backlog, a permission
  // raised while no window was open would stall for its full TTL and then
  // auto-deny, with the user never seeing a dialog.
  ipcMain.handle("agent:pending-permissions", () => sessions.pendingPermissions());

  // Updates. Packaged builds only — in dev there is no published feed, and
  // checking would just log errors on every launch.
  updater = startAutoUpdate({
    enabled: app.isPackaged,
    broadcast: (channel, payload) => {
      lastUpdateState = payload;
      broadcast(channel, payload);
    }
  });
  ipcMain.handle("update:state", () => lastUpdateState);
  ipcMain.handle("update:check", () => { updater.check(); });
  ipcMain.handle("update:install", () => { updater.quitAndInstall(); });

  routes = buildRoutes({ selectFolder, sessions });

  protocol.handle("phoenix", handleAppProtocol);
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

let shuttingDown = false;
app.on("before-quit", (event) => {
  if (shuttingDown) return;
  // Windows does not kill a child with its parent, and shutdown() has a
  // 5-second escalation loop. Fire-and-forget here orphaned a `grok agent
  // serve` (plus its bash/MCP grandchildren) on every single quit.
  event.preventDefault();
  shuttingDown = true;
  quitting = true;
  Promise.resolve(sessions?.shutdown())
    .catch(() => {})
    .finally(() => app.quit());
});
