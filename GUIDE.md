# Flying it

What the app does, how to use it, and where the sharp edges are.

## The one-paragraph version

You type a request. The app hands it to **Grok Build** — xAI's own coding agent,
running as a local process — which reads and edits files in your project, runs
commands, and asks permission before it writes. Everything it does is recorded
to a local database, and durable findings become **project memory** that any
model can consult later. Grok is the default; 21 other agents are one click away.

## Running it

```bash
npm run dev        # dev server + Vite, hot reload, http://127.0.0.1:5173
npm run desktop    # build + launch the Electron app
```

The dev server and the desktop app share one route table, so they behave
identically. Dev is faster to iterate in; the desktop app is the real product.

## The three columns

**Left — projects and threads.** A project is a folder on disk. Threads are
conversations inside it. The agent's working directory is the project path, so
"read the config" means *that* project's config.

**Centre — the conversation.** Tool calls appear inline as the agent works: which
file it read, what it changed, what a command returned. Reasoning is collapsed
by default because it is long and rarely the point.

**Right — live state.** Workflow runs with their agent budget, memories the agent
pulled in, and current tool activity. It stays quiet when nothing is happening.

## The agent picker (bottom left of the composer)

Populated from what is **actually runnable**, not a hardcoded list:

- **Grok Build (installed)** — uses your logged-in session. No per-token billing,
  no download.
- **21 registry agents** — Claude, Codex, Gemini CLI, Cline, Qwen Code, Copilot
  and more. Each downloads on first use, which is why they are labelled.

Switching agents does not change the memory. That is the point: the knowledge
belongs to the project, not to a vendor.

## Permissions

The agent pauses and asks before writing. The dialog shows exactly which file,
and offers:

- **Yes** — this one action
- **Yes, allow all edits this session** — stop asking until the session ends
- **No, and tell Grok what to do differently** — reject with feedback

Reject sorts first deliberately: the safe answer is never the default button.
The turn is genuinely blocked until you answer, so an unanswered dialog is a
stalled agent, not a cosmetic annoyance.

## Memory — the part that is unusual

Two layers:

**Events** — an append-only log of everything that happened. Never rewritten.

**Memories** — durable findings distilled from events: decisions, constraints,
measured results, and especially **failures**. Each carries a status and, where
possible, receipts.

The agent reaches these through four tools, over MCP, which is why they work
with any model:

| Tool | What it does |
|---|---|
| `memory_recall` | Search project knowledge before re-deriving something |
| `memory_check_failures` | **Check a proposal against retired approaches** |
| `memory_remember` | Record a finding, preserving how certain it was |
| `memory_playbook` | Read the current strategy state |

`memory_check_failures` is the anti-rework mechanism. Ask for something already
retired and the agent is told to stop, with the original finding attached.

### Two design rules worth knowing

**Hedges are preserved.** "We *think* X works" is stored as hedged, not promoted
to "X works." Memory systems that flatten this get acted on as if hedged claims
were facts at roughly the same rate as flat assertions.

**Nothing is deleted.** When a fact changes, the old row gets a closed validity
interval and the new one supersedes it. You can ask what is true now *and* what
you believed in June — and why it changed.

### Importing an existing playbook

`STRATEGY_PLAYBOOK.md`-style files import losslessly, including the DEAD LIST.
Round-trip is stable, so hand edits survive.

## Workflows

Grok can fan a task across many parallel subagents as one resumable run. Launch
with `/workflow <name>` or `/deep-research <question>` in the composer.

**Watch the budget.** A run can spawn up to 1,024 agents; the default is 128.
The right panel shows used-vs-total during the run, which is why it is there
rather than in a detail view.

Workflows live in `.grok/workflows/*.rhai`. A workflow whose name collides with
an existing command or skill is **silently not advertised** — if one never
appears, that is why.

## Sharp edges

**Nothing here has run against a live agent yet.** The free tier is exhausted.
The first real session will find things.

**Idle release.** The agent process is torn down after 5 minutes idle and
reconnects on your next message. Conversation history survives. If you see a
brief pause on the first message after a break, that is this.

**Quota.** When the tier is spent you get an amber notice, not a red error —
running out is a decision point, not a malfunction.

**Grok Build is at 1.0.5; you have 1.0.3.** Worth updating. Note that an
unreleased commit adds a **consent gate** that blocks sessions until accepted —
that is the change most likely to break a headless client, so if sessions stop
starting after an update, check for a consent prompt.

## Where things live

```
server/acp/          the agent connection (client, daemon, sessions, harnesses, workflows)
server/memory/       store, retrieval, playbook, MCP server
server/routes.js     one route table, shared by both hosts
src/App.jsx          the shell
scripts/acp-verify.mjs   live verification suite (costs quota)
```

## When something breaks

```bash
node scripts/acp-verify.mjs          # full live check
node scripts/acp-verify.mjs mid-turn # one test
```

The daemon logs to stderr and is surfaced in the app. `git log` has a working
baseline to return to.
