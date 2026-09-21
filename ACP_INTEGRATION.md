# ACP Integration — architecture and state

Agent Command Center drives **Grok Build** (xAI's open-source coding agent) as its
execution engine over **ACP** (Agent Client Protocol, JSON-RPC). The Electron app
is the control plane; the agent owns its own tool loop.

## Why this shape

The original design called a model once per "step" — single-shot chat completion,
no tools, no history, no streaming — and regex-scraped a unified diff out of the
model's prose. It had never produced a working patch. Rebuilding that loop by hand
meant re-deriving roughly 80 Rust crates' worth of context compaction, subagents,
codebase graph, sandboxing, MCP, hooks, LSP, and a permission engine — all of which
Grok Build already ships under Apache 2.0.

So: they own the agent loop; we own the window, projects, threads, approval UX,
worktrees, the merge gate, and model policy.

## Layout

```
server/acp/transports.js   stdio + WebSocket, one interface
server/acp/client.js       ACP JSON-RPC client (handshake, updates, permissions, auth)
server/acp/daemon.js       `grok agent serve` lifecycle
server/acp/sessionManager.js  threads <-> sessions, permissions, auth, tool state
server/routes.js           the one route table both hosts consume
server/index.js            dev host (Express + SSE)  -> Vite proxies /api here
electron/main.js           desktop host (agentcc:// protocol + IPC)
electron/preload.js        contextBridge -> window.agentBridge
src/useAgentSession.js     React binding (IPC in the app, SSE in the browser)
src/AgentPanels.jsx        approval dialog, tool stream, reasoning, status
scripts/acp-verify.mjs     live verification suite
```

## Wire facts learned the hard way

These are not all in xAI's docs; several were found by reading the Rust source or
by running traffic.

- **Extension methods carry a leading `_` on the wire.** Docs show `x.ai/...`;
  the decoder rejects anything without the underscore. Base ACP methods
  (`session/update`, `session/request_permission`) are *not* prefixed.
- **Two extension rails carry session updates**: `_x.ai/session/update` and
  `_x.ai/session_notification`. The second carries subagent activity, model
  auto-switch, and session renames.
- **Undocumented update kinds** exist: `available_commands_update`,
  `user_message_chunk`, `session_info_update`, `current_mode_update`,
  `config_option_update`.
- **`_meta.isReplay` sits on the notification params, not inside `update`.**
  `session/load` replays the whole conversation from disk, so dropping `_meta`
  makes every reconnect re-render the entire history as fresh output.
- **`tool_call_update` is a patch keyed by `toolCallId`**, not a snapshot.
- **Permission options differ per access kind.** Edit prompts offer
  `allow-edits-session` / `allow-once` / `reject-once`; bash and generic offer
  `always-allow` / `allow-once` / `reject-once` / `reject-always`. For clients
  identifying as desktop/TUI, Grok **prepends `enable-always-approve` at index 0
  with kind `allow_once`** — so "pick the first allow_once" silently enables
  global YOLO mode. It is filtered in `sessionManager` and re-validated on the
  way back.
- **Session auth and API-key auth hit different backends.** A cached session
  token routes to `cli-chat-proxy.grok.com` (subscription pool); an API key routes
  to `api.x.ai` (per-token billing, Grok 4.7). PhoenixAI injects `XAI_API_KEY`
  into the agent child and omits `GROK_DISABLE_API_KEY_AUTH` whenever a key is
  configured. The kill switch is only set when no key is present, so a signed-in
  SuperGrok install still works without an API key. Launch args include
  `--model grok-4.7` and `--effort high`.
- **`grok agent serve` survives client disconnects.** Verified: a turn severed
  mid-flight completed server-side and the result was correct on reconnect.
- **WebSocket auth** accepts `Authorization: Bearer <secret>` or `?server-key=`
  on `/ws`. Node's native WebSocket cannot set headers, so we use the query
  param on a loopback bind with a per-launch secret passed via
  `GROK_AGENT_SECRET` (never argv — Windows exposes command lines to any
  same-user process).

## Verified

Against a live agent (`grok 1.0.3`):

- handshake, `session/new`, streaming (message / thought / tool / plan)
- tool execution; deny is honored and the write does not happen
- `serve` keeps state across client reconnects
- **a turn severed mid-flight completes server-side** — the property that
  justifies `serve` over `stdio`
- daemon secret absent from process argv
- replay flagged via `_meta.isReplay`

Offline: 51 routes, no duplicates, correct precedence, host parity
(case-insensitivity, trailing slash, encoded slashes, `%` decoding, malformed
encoding -> 400), `threadId` validation, clean Vite build.

## NOT verified

Everything below has only ever been syntax-checked. The free-tier quota is
exhausted, so none of it has run against a live agent:

- the auth / login flow (`beginLogin`, `submitAuthCode`, `logout`)
- the SSE endpoint and the browser transport
- `startPrompt` returning on acceptance rather than completion
- the whole React path (hook, dialog, tool stream)
- permission backlog replay to a newly opened window

## Running the checks

```bash
node scripts/acp-verify.mjs            # full suite (consumes quota)
node scripts/acp-verify.mjs mid-turn   # one test by substring
```

## Retiring server/api.js

`routes.js` binds 40 of its 49 exports, but there are call sites outside the
route table that a grep of `routes.js` alone would miss:

- `electron/main.js` -> `api.addProject`, `api.getStripeStatus`,
  `api.handleStripeWebhook`
- `server/index.js` -> `rootDir`, `handleStripeWebhook`

Keep: worktree leases, the merge gate, the subprocess runner, persistence,
provider-key detection, Stripe.
Retire: the provider registry, the single-shot model callers, the run executor,
patch scraping, and the objectives/goal-ledger/task-graph scaffolding
(deterministic keyword matching, not model reasoning).
