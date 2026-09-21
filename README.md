# PhoenixAI

PhoenixAI is a Windows desktop workspace for a Grok Build-led coding workflow.
Grok owns the main conversation and can call bounded Qwen, Kimi, or DeepSeek
reviewers through MCP. Threads are bound to explicit project folders and keep
their own agent session, model choice, memory, checkpoints, and activity.

## Current capabilities

- Grok Build sign-in, persistent ACP sessions, reasoning, tool streaming,
  permission prompts, cancellation, and shared-usage remaining.
- Dynamic model discovery for xAI, Qwen Model Studio, Kimi, DeepSeek, and other
  OpenAI-compatible providers, with catalog fallbacks when offline.
- Independent `review_with_model` MCP tool for bounded, read-only diff review by
  Qwen, Kimi, or DeepSeek, routed through direct keys or Model Studio only after
  the user explicitly unlocks paid calls.
- Fail-closed spending firewall: paid inference defaults off, OpenRouter is hard
  blocked, agent subprocesses do not receive locked credentials, and one shared
  ledger enforces input/output, concurrency, hourly, per-call, and daily limits.
- Durable Control Room with project-scoped objectives, a Grok Build commander,
  locked Kimi coding and DeepSeek adversarial-review lanes, a Qwen verification
  lane, explicit dependencies, accuracy gates, discrepancies, and append-only
  lifecycle evidence. Older objective records are safely upgraded on read.
- One isolated worktree is reused across every task in an objective. Kimi patch
  candidates require explicit application, declared project checks run with all
  provider credentials stripped, DeepSeek receives the actual bounded diff, and
  applying the reviewed change set to the source remains a human-approved gate.
- Offline Strategy Lab with append-only, hashed strategy revisions; project-bound
  dataset fingerprints; checksum re-verification for every experiment; pinned
  dataset snapshots; chronological split, embargo, leakage, cost, sample-size,
  walk-forward, generalization, and holdout-reuse gates; and side-by-side evidence
  comparison. Strategy Lab has no broker connection or order-placement path.
- Allowlisted Public.com market-data integration for quotes, option expirations,
  chains, Greeks, and price history. Both the GUI and Grok receive read-only
  surfaces with source timestamps, staleness labels, bounded responses, short
  caches, and a credential-free audit trail. Account, portfolio, preflight,
  cancellation, and order endpoints are absent by construction.
- Project-scoped research alerts and a local paper ledger. Alerts are immutable,
  source-attributed, evaluated per instrument, and trigger only on a fresh
  false-to-true transition. Paper fills use the adverse bid/ask side plus frozen
  slippage and fees, are idempotent and append-only, enforce cash/order/position/
  daily-loss limits, prohibit shorts, and can never become brokerage orders.
- Project file browser, preview, git diff, content search, scoped terminal,
  discovered skills/commands/MCP inventory, and slash-command palette.
- Local project memory with provenance, recovery checkpoints, thread search,
  markdown/code rendering, plan state, and background-run status.
- Proactive chat reattachment plus an append-only local transcript. If Grok's
  saved session disappears, PhoenixAI creates a replacement and supplies the
  newest complete transcript (bounded to 700,000 characters) with the next
  real user message; the recovery envelope stays hidden from the visible chat.
- Local diagnostics export with no prompts, file contents, or secret values.

## Development

Requirements: Windows, Node.js 24, Git, and Grok Build for live Grok sessions.

```powershell
git clone <repository-url> PhoenixAI
cd PhoenixAI
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run dev
```

Open `http://127.0.0.1:5173`. The local API listens only on loopback. Provider
keys are optional; add only the providers you intend to use.

For the desktop shell:

```powershell
npm.cmd run desktop
```

For an unpacked release candidate:

```powershell
npm.cmd run package:folder
```

The executable is written to `release\win-unpacked\PhoenixAI.exe`. Folder and
installer builds use electron-builder; there is no hand-copied dependency tree.
Build commands remove superseded installers and blockmaps automatically. The
reusable Electron runtime cache lives under `.build-cache`, keeping `release`
limited to the current version and its update metadata.

## Packaged setup

Enter provider keys in Settings to protect them with the signed-in Windows
account, or put provider variables in `%APPDATA%\PhoenixAI\.env`. Grok Build
subscription authentication is handled by the installed Grok client. API key
values stay in the host process and are never returned to the renderer.

On this development machine, `package:folder`, `dist:win`, and `release:dry`
automatically import supported provider keys from the repository `.env` into
PhoenixAI's Windows-encrypted credential vault before packaging. The plaintext
`.env` is never copied into the app or installer, and OpenRouter is deliberately
excluded. The encrypted vault is tied to the current Windows account, so an
installer moved to another computer does not carry or expose these credentials.

For Public.com data, save both `PUBLIC_COM_SECRET` and
`PUBLIC_COM_ACCOUNT_ID`. PhoenixAI automatically mints short-lived access tokens
in memory and exposes only the five market-data operations above. The secret can
authorize broader activity at Public itself, so protect and revoke it like a
brokerage credential even though PhoenixAI intentionally has no trading methods.

Start with Grok Build plus local Ollama/LM Studio models. When you need an
independent cloud reviewer, create a dedicated provider key with a provider-side
hard budget, save it in Settings, and then unlock paid cloud calls with a small
daily and per-request limit. OpenRouter credentials may be stored for a future
release, but OpenRouter inference and automatic fallback are disabled in 0.2.0.

For QwenCloud pay-as-you-go keys, PhoenixAI accepts the documented
`DASHSCOPE_API_KEY` name and `QWEN_API_KEY` as a compatibility alias. Before
unlocking calls, enable QwenCloud's **Free quota only** switch or configure a
small monthly **Spending Limit & Alerts** value in the QwenCloud billing page.

For Kimi, PhoenixAI accepts `MOONSHOT_API_KEY` and the `KIMI_API_KEY` alias,
uses the official `api.moonshot.ai` endpoint, and displays the provider-reported
cash/voucher balance in Settings. Configure a project daily spending budget in
Kimi before unlocking calls; Kimi documents that server-side enforcement can
lag by roughly ten minutes, so the PhoenixAI daily limit should be smaller.
Kimi code-diff reviews default to `kimi-k2.7-code`; `kimi-k3` is available for
explicit architecture, long-horizon planning, and system-wide adversarial review.

For DeepSeek, `DEEPSEEK_API_KEY` is a separate direct billing route. PhoenixAI
lists the direct catalog and displays the provider-reported topped-up/granted
balance without making a generation request. DeepSeek V4 Pro is preferred for
deep coding and adversarial reviews; V4 Flash is the lower-cost option. To avoid
silently choosing between two paid accounts, automatic DeepSeek reviews continue
through QwenCloud when it is configured; Grok must request `route: "direct"` to
charge the direct DeepSeek balance.

Open a project folder, create or select a task, choose Grok Build, and send a
message. Approval mode defaults to **Ask**. A remote reviewer receives project
diff content only after its tool call is approved and the spending firewall has
reserved room for the request.

Grok usage is read from Grok Build's authenticated billing extension and shown
as a shared remaining percentage when that extension is available. PhoenixAI
does not estimate or invent a quota if the service does not return one.

## Verification

```powershell
npm.cmd run verify
npm.cmd audit --omit=dev
npm.cmd run package:folder
npm.cmd run release:dry
```

`verify:package` checks the ASAR for required host/server files and rejects
private `.env`, `data`, `prompts`, and test paths. Public releases additionally
require Authenticode signing; see [RELEASING.md](RELEASING.md).

## Security and privacy

The project terminal and coding agents can change files and execute commands;
they are powerful tools, not a security sandbox. Bind only folders you intend
the app to access and review approval requests carefully.

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md) for the trust model,
credential flow, provider disclosure, local data locations, and deletion steps.
