import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const distDir = path.join(appRoot, "dist");
const resourcesDir = path.join(appRoot, "resources");
const iconPath = path.join(resourcesDir, "icon.png");
let api;
let stripeServer;
let stripeCliProcess;
let quitting = false;

const stripeListener = {
  enabled: false,
  running: false,
  pid: null,
  command: null,
  startedAt: null,
  stoppedAt: null,
  lastOutput: null,
  error: null,
  webhookSecretCaptured: false
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: "agentcc",
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

function readNodeRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendNodeJson(response, data, status = 200) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "http://127.0.0.1"
  });
  response.end(body);
}

function stripeStatus() {
  return {
    ...api.getStripeStatus(),
    listener: { ...stripeListener }
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveStripeCommand() {
  if (process.env.STRIPE_CLI_PATH && await fileExists(process.env.STRIPE_CLI_PATH)) {
    return process.env.STRIPE_CLI_PATH;
  }

  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const userInstall = path.join(appData, "npm", "stripe.cmd");
  if (await fileExists(userInstall)) {
    return userInstall;
  }

  return process.platform === "win32" ? "stripe.cmd" : "stripe";
}

function noteStripeOutput(text) {
  const clean = String(text || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!clean) return;

  const secret = clean.match(/whsec_[A-Za-z0-9_]+/);
  if (secret?.[0]) {
    process.env.STRIPE_WEBHOOK_SECRET = secret[0];
    stripeListener.webhookSecretCaptured = true;
    stripeListener.error = null;
  }
  const redacted = clean.replace(/whsec_[A-Za-z0-9_]+/g, "whsec_[redacted]");
  stripeListener.lastOutput = redacted.split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
  if (/ready/i.test(clean)) {
    stripeListener.running = true;
    stripeListener.error = null;
  }
  if (/login|auth|error|failed/i.test(clean)) {
    stripeListener.error = stripeListener.lastOutput;
  }
}

async function startStripeCliListener() {
  if (process.env.AGENTCC_STRIPE_LISTENER === "off") {
    stripeListener.enabled = false;
    stripeListener.error = "Auto listener disabled by AGENTCC_STRIPE_LISTENER=off.";
    return;
  }

  const status = api.getStripeStatus();
  if (!status.secretConfigured && !status.publishableConfigured) {
    stripeListener.enabled = false;
    stripeListener.error = "Stripe keys are not configured.";
    return;
  }

  const command = await resolveStripeCommand();
  const args = ["listen", "--forward-to", status.webhookUrl];
  stripeListener.enabled = true;
  stripeListener.running = false;
  stripeListener.command = `${command} ${args.join(" ")}`;
  stripeListener.startedAt = new Date().toISOString();
  stripeListener.stoppedAt = null;
  stripeListener.error = null;

  stripeCliProcess = spawn(command, args, {
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });

  stripeListener.pid = stripeCliProcess.pid || null;
  stripeCliProcess.stdout?.on("data", (chunk) => noteStripeOutput(chunk.toString("utf8")));
  stripeCliProcess.stderr?.on("data", (chunk) => noteStripeOutput(chunk.toString("utf8")));
  stripeCliProcess.on("error", (error) => {
    stripeListener.running = false;
    stripeListener.error = error.message;
  });
  stripeCliProcess.on("exit", (code, signal) => {
    stripeListener.running = false;
    stripeListener.pid = null;
    stripeListener.stoppedAt = new Date().toISOString();
    if (!quitting && code !== 0) {
      stripeListener.error = `Stripe listener exited with ${signal || `code ${code}`}.`;
    }
  });
}

function startStripeWebhookServer() {
  const status = api.getStripeStatus();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

    if (request.method === "GET" && url.pathname === "/stripe/status") {
      sendNodeJson(response, stripeStatus());
      return;
    }

    if (request.method === "POST" && url.pathname === "/stripe/webhook") {
      try {
        const body = await readNodeRequestBody(request);
        const result = await api.handleStripeWebhook(body, request.headers["stripe-signature"]);
        sendNodeJson(response, result);
      } catch (error) {
        sendNodeJson(response, { error: error.message }, 400);
      }
      return;
    }

    sendNodeJson(response, { error: "Not found" }, 404);
  });

  server.on("error", () => {});
  server.listen(status.webhookPort, "127.0.0.1");
  return server;
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
    title: "Agent Command Center",
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
  window.loadURL("agentcc://app/");
  return window;
}

app.setName("Agent Command Center");
app.setAppUserModelId("com.tkinn.agent-command-center");

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
    defaultCwd: apiModule.rootDir,
    // Attaching this makes the memory MCP server available to every agent
    // session, which is what lets Grok (and any other harness) consult the
    // project's accumulated knowledge instead of starting cold.
    memoryDbPath: path.join(app.getPath("userData"), "data", "memory.db")
  });
  await sessions.load();
  sessions.on("permission", onAgentPermission);
  sessions.on("permission-resolved", (info) => broadcast("agent:permission-resolved", info));
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

  routes = buildRoutes({ selectFolder, sessions });

  protocol.handle("agentcc", handleAppProtocol);
  stripeServer = startStripeWebhookServer();
  startStripeCliListener().catch((error) => {
    stripeListener.error = error.message;
  });
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
  stripeCliProcess?.kill();
  stripeServer?.close();
  Promise.resolve(sessions?.shutdown())
    .catch(() => {})
    .finally(() => app.quit());
});
