# Releasing PhoenixAI

PhoenixAI uses electron-builder, NSIS, GitHub Releases, electron-updater, and
Windows Authenticode signing. Public releases must be signed; unsigned output is
for private smoke testing only.

## One-time setup

1. Confirm the GitHub publisher in `package.json` points at the intended public
   repository. A public update feed avoids embedding a read token in the app.
2. Create a fine-grained GitHub token with Contents read/write access to this
   repository.
3. Obtain a Windows code-signing certificate and its password. Prefer a
   hardware-backed or managed signing service for a public product.
4. Install the secret guard with `sh scripts/install-hooks.sh`.

Set release credentials only in the build environment:

```powershell
$env:GH_TOKEN = "github-token"
$env:CSC_LINK = "C:\secure\certificate.pfx"
$env:CSC_KEY_PASSWORD = "certificate-password"
```

`CSC_LINK` may also use a supported encoded or remote certificate reference.
Never place the certificate, password, or token in this repository or its
`.env` file.

## Release sequence

Start from a clean, reviewed commit on the release branch.

```powershell
npm.cmd ci
npm.cmd run verify
npm.cmd audit --omit=dev
npm.cmd version patch
npm.cmd run release
```

`npm run release` blocks when the GitHub token or signing credentials are
missing, creates and pushes `v<version>`, builds the NSIS installer, publishes
the installer, blockmap, and `latest.yml`, then requires valid signatures on the
packaged executable and installer.

The app checks for updates shortly after launch and every six hours. Downloads
are staged in the background and applied when the user quits or chooses the
restart action.

## Private release-candidate build

```powershell
npm.cmd run release:dry
```

This produces an unsigned installer for local testing and verifies its layout
and update manifest. Do not distribute it publicly. For an unpacked smoke build
use `npm.cmd run package:folder`.

## Release checklist

- Confirm `Get-AuthenticodeSignature` reports `Valid` for both
  `release\win-unpacked\PhoenixAI.exe` and the NSIS installer.
- Install on a clean Windows user profile and verify launch, project selection,
  Grok sign-in, permission prompting, a cancelled turn, and clean uninstall.
- Verify Qwen, Kimi, and DeepSeek model discovery with test accounts, then run
  one approved adversarial review against a non-sensitive fixture repository.
- Save and clear a disposable provider key through Settings, restart the app,
  and confirm only encrypted ciphertext appears in `data\credentials.json`.
- Confirm Grok usage remaining appears when the subscription billing extension
  is available and degrades to “unavailable” without guessing.
- Download diagnostics and inspect it for prompts, project content, and secret
  values before attaching it to any issue.
- Publish release notes and verify a previous signed version detects and stages
  the new update.

## Why the tag is pushed first

electron-builder uploads release assets concurrently. If no tag exists, two
uploads can race to create the release and leave an incomplete asset set. The
tag helper creates or validates the version tag before publication so every
asset attaches to the same release.

## Secret and package boundaries

`.gitignore` excludes `.env`, local data, databases, logs, releases, private
prompts, and dependencies. The release file list includes only the compiled UI,
Electron host, server code, model assets, scripts, metadata, and icons. The
post-package verifier independently rejects secret/state path classes.
