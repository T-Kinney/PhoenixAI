# Agent Command Center

Local-first command center for a Claude Code/Codex-style stack using free or bring-your-own-key models.

## First-run

```powershell
cd C:\Users\tkinn\Documents\Codex\2026-06-14\i-want-to-replcate-the-claude\work\agent-command-center
npm.cmd install
npm.cmd run dev
```

Open the Vite URL, normally `http://127.0.0.1:5173`.

## Easiest launch

Double-click:

```text
Start Agent Command Center.cmd
```

That launcher installs dependencies if needed, starts the local server, and opens `http://127.0.0.1:5173/`.

The URL only works while the local server is running. If a normal browser says the site cannot be reached, run the launcher again.

## Desktop app launch

The real desktop app build is here:

```text
C:\dev\DesktopClient\release\Agent Command Center\Agent Command Center.exe
```

A desktop shortcut is created at:

```text
%USERPROFILE%\OneDrive\Desktop\Agent Command Center.lnk
```

This app does not require `localhost` or a browser. It opens in its own Electron window and serves the UI through the internal `agentcc://` app protocol.

To rebuild the desktop folder and refresh the shortcut:

```powershell
cd C:\dev\DesktopClient
npm.cmd run package:folder
```

## What this MVP does

- Detects installed agent tools on PATH.
- Shows install commands and official docs links for the recommended stack.
- Stores provider profiles in `data/config.json`.
- Creates multi-agent runbooks for isolated git worktrees.
- Keeps API keys out of config by referencing environment variable names.
- Presents the workflow as a Codex/Claude-style shell with thread navigation, chat, composer, model routing, agent council, workspace metrics, activity stream, terminal preview, provider profiles, and toolchain status.

## API wiring

The server loads `.env` from this project folder and never sends API key values to the browser.

Supported live provider routes:

```text
GET  /api/providers/status
GET  /api/providers/anthropic/models
GET  /api/providers/nvidia-nim/models
POST /api/providers/test
```

Configured keys currently expected:

```text
ANTHROPIC_API_KEY
NVIDIA_API_KEY
OPENROUTER_API_KEY
GEMINI_API_KEY
OLLAMA_API_KEY
```

In the app, open **Models**, then use **Load Models** to verify auth without generating text. Use **Test API** when you want to spend a tiny generation call and confirm completions work end-to-end.

## Why this starts as adapters

The fastest useful path is to orchestrate upstream tools instead of immediately forking them. The desktop shell should own project selection, roles, worktrees, approvals, logs, routing, and model policy. Forking OpenCode/Aider/Goose/Kilo/Cline makes sense only when an adapter cannot expose enough state or control.

## Next build step

Add guarded execution:

1. Install OpenCode, Aider, Goose, and LiteLLM.
2. Verify each CLI command template against the installed versions.
3. Add an execution queue that launches commands in isolated worktrees.
4. Stream stdout/stderr into the Run view.
5. Add diff review, merge/discard buttons, and model-vs-model reviewer gates.
