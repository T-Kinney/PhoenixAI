# PhoenixAI privacy

PhoenixAI is local-first and does not include product analytics or telemetry.
Project bindings, conversations, checkpoints, run history, configuration, and
the memory database are stored under the application's per-user data folder.
On Windows this is normally `%APPDATA%\PhoenixAI`.

## What leaves the computer

Data leaves the computer only when a configured agent or model needs it:

- Grok Build receives prompts and project context according to its own client
  and account settings.
- Qwen, Kimi, and DeepSeek receive the bounded task and git diff only when paid
  cloud calls are explicitly unlocked and `review_with_model` is invoked.
- Other configured providers receive requests only when explicitly selected.
- Update checks contact the public PhoenixAI GitHub release feed in packaged
  builds.

Provider retention, training, regional processing, and account policies are
controlled by the provider. PhoenixAI cannot override them. Do not open a
project or approve a remote review if its data is not permitted to reach that
provider.

## Credentials

API keys can be read from environment variables or the local `.env` file. In
the packaged desktop app they can also be entered in Settings and encrypted
with Electron safe storage, which uses the signed-in Windows account's OS
protection. Ciphertext is stored in the local app-data folder. Plaintext is
activated only in the Electron host and passed only to the selected provider.
Review credentials are not passed to an agent subprocess while paid calls are
locked, and the OpenRouter key is never passed for inference. A key is never
returned to the renderer, stored in
`config.json`, included in diagnostics, or packaged into releases. Grok
subscription credentials are managed separately by the installed Grok Build
client.

## Local recovery data

A checkpoint may copy untracked project files into the local app-data folder,
up to the documented size cap. That is intentional recovery data and can
contain sensitive content. Protect the Windows account and disk accordingly.

The **Download diagnostics** action exports configuration status, versions, and
feature state. It excludes prompts, file contents, and secret values.

To erase PhoenixAI's local state, close the app and remove its per-user data
folder. This does not remove project files, Grok Build's separate login state,
or data already submitted to an external provider.
