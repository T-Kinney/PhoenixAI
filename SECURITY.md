# PhoenixAI security

## Trust model

PhoenixAI can read and modify folders that the user explicitly binds to a
project. Agent tool calls remain subject to the selected approval posture. The
built-in project terminal executes exactly the command entered by the user in
the bound project folder; it is not a sandbox.

Child processes receive a reduced operating-system environment. The Grok Build
daemon is the exception for `XAI_API_KEY` / `GROK_API_KEY`: when configured,
those values are injected so Grok 4.7 can bill `api.x.ai`. Paid reviewer keys
(Qwen, Kimi, DeepSeek) are withheld unless the user explicitly unlocks paid
cloud calls with non-zero limits. OpenRouter is hard-blocked in this
release: its credential is never passed to an agent or used for inference.
Credentials entered in the packaged app are encrypted with Electron safe
storage (Windows account protection); the renderer can set or clear a value but
cannot read it back. Changing credentials releases an idle agent connection so
the next session load receives a fresh, narrowly scoped MCP environment.
Local private builds also provision supported keys from the ignored repository
`.env` into that same DPAPI-backed vault. This is a machine-local build step:
the source `.env` and encrypted vault are both excluded from the installer,
OpenRouter is excluded from automatic import, and the vault cannot be decrypted
by a different Windows account.
The desktop renderer runs with Chromium sandboxing, context isolation, no Node
integration, a restrictive Content Security Policy, and a private application
protocol. The development API accepts only the exact loopback development
origin.

Checkpoints are stored outside the repository. Restore refuses to run over a
dirty git worktree so it cannot silently overwrite current edits. Destructive
cleanup remains approval-gated.

Remote review routing is deterministic: Kimi auto-routing prefers its direct
key, while DeepSeek auto-routing prefers Alibaba Model Studio; an explicit
`direct` route is required to spend the separate DeepSeek balance. Every cloud
generation passes through a host-owned spending guard that
defaults off, permits one in-flight request, caps input and output, rate-limits
requests, and reserves a conservative estimated cost in a persistent shared
ledger. A corrupt, locked, or unavailable ledger blocks the request. Provider
model checks use list endpoints and do not generate tokens.

The local ledger is a defense-in-depth circuit breaker, not a bank statement:
providers do not all report exact dollar cost and a request can complete after
a network timeout. Before enabling a direct provider, create a dedicated key
with the smallest provider-side hard budget available. OpenRouter documents
per-key/guardrail budgets at
https://openrouter.ai/docs/guides/features/guardrails/overview; PhoenixAI still
keeps OpenRouter inference disabled regardless of that account setting.
For a prepaid provider without a documented hard per-key budget, keep the
account balance deliberately small and set PhoenixAI's local daily limit lower.

## Release integrity

Production releases must be Authenticode-signed. `npm run release` refuses to
start unless a GitHub token and Windows signing credentials are present, and
the post-package verifier checks required application files while rejecting
private state paths. `PHOENIX_ALLOW_UNSIGNED_RELEASE=1` is only for a deliberate
private test build and must not be used for public distribution.

## Reporting a vulnerability

Do not open a public issue containing credentials, private project content, or
an exploit proof that exposes user data. Contact the repository owner privately
with the affected version, impact, reproduction steps, and any proposed fix.
