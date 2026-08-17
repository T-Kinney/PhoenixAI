/**
 * Dev HTTP server.
 *
 * Serves the shared route table from routes.js. Vite proxies /api here during
 * development, which is why this host exists alongside the Electron build: it
 * keeps hot-reload working while the UI is being built.
 *
 * Routes are NOT defined here. Add them to server/routes.js and both hosts
 * pick them up.
 *
 * This host uses the SAME matcher as Electron (`matchRoute`) rather than
 * Express's own routing. Sharing only the handlers let the two diverge on
 * case-sensitivity, trailing slashes, encoded slashes, and repeated query
 * params — "works in the browser, breaks in the app" bugs by construction.
 */

import cors from "cors";
import express from "express";
import path from "node:path";
import { handleStripeWebhook, rootDir } from "./api.js";
import { buildRoutes, matchRoute } from "./routes.js";
import { SessionManager } from "./acp/sessionManager.js";

const app = express();
app.use(cors());

// Must precede express.json(): Stripe signature verification needs the raw body.
app.post("/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    res.json(await handleStripeWebhook(req.body, req.headers["stripe-signature"]));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.use(express.json({ limit: "8mb" }));

// Match Electron, which tolerates a malformed body rather than returning
// Express's default HTML error page.
app.use((error, _req, res, next) => {
  if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON body." });
  return next(error);
});

const sessions = new SessionManager({
  statePath: path.join(rootDir, "data", "acp-sessions.json"),
  defaultCwd: rootDir,
  memoryDbPath: path.join(rootDir, "data", "memory.db")
});
await sessions.load();

const routes = buildRoutes({ sessions });

/**
 * Server-Sent Events stream carrying agent activity.
 *
 * Without this the dev host could start a turn and never show it: updates were
 * emitted into the void and every permission request was auto-denied for want
 * of a listener.
 */
app.get("/api/agent/events", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  res.write(": connected\n\n");

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
  };

  const channels = [
    "update", "permission", "permission-resolved", "connected", "disconnected",
    "daemon-output", "daemon-exit", "daemon-error", "turn-complete", "turn-error", "notify",
    "auth-complete", "auth-error", "workflow", "commands", "idle-release", "released"
  ];
  const bound = channels.map((name) => {
    const fn = (payload) => send(name, payload);
    sessions.on(name, fn);
    return [name, fn];
  });

  // Replay outstanding permissions: a request raised before this client
  // connected would otherwise stall until its TTL expires.
  for (const pending of sessions.pendingPermissions()) send("permission", pending);

  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
  keepAlive.unref?.();

  req.on("close", () => {
    clearInterval(keepAlive);
    for (const [name, fn] of bound) sessions.off(name, fn);
  });
});

// One catch-all so Express and Electron resolve routes identically.
app.all(/^\/api\/.*/, async (req, res) => {
  try {
    // matchRoute throws a 400 on malformed percent-encoding, so it must be
    // inside the try or Express serves its default HTML error page while
    // Electron returns JSON — the exact divergence the shared matcher removed.
    const match = matchRoute(routes, req.method, req.path);
    if (!match) {
      return res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
    }
    const value = await match.route.handler({
      params: match.params,
      body: req.body ?? {},
      query: req.query ?? {}
    });
    return res.json(value ?? {});
  } catch (error) {
    return res.status(error.status || 502).json({ error: error.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

const port = Number(process.env.ACC_PORT || 5455);
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Agent Command Center API listening on http://127.0.0.1:${port}`);
  console.log(`${routes.length} routes mounted from server/routes.js`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await sessions.shutdown().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

export { app, routes, sessions };
