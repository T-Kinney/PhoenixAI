# Releasing PhoenixAI

Shipping an update is one command. The app checks for updates 8 seconds after
launch and every 6 hours after that, downloads in the background, and applies
the update when you quit.

## One-time setup

1. Create a **public** repo on GitHub named `PhoenixAI` (empty — no README, no
   `.gitignore`, GitHub's defaults would collide with what is already here).

2. Fill in the owner in `package.json`:

   ```json
   "publish": [{ "provider": "github", "owner": "YOUR_GITHUB_USERNAME", "repo": "PhoenixAI" }]
   ```

3. Point the local repo at it and push:

   ```bash
   git remote add origin https://github.com/YOUR_GITHUB_USERNAME/PhoenixAI.git && git push -u origin master
   ```

4. Create a **fine-grained personal access token** with `Contents: read and write`
   on this repo only, from https://github.com/settings/tokens. This token uploads
   the installer. It is never committed and never ends up in the app — it is read
   from the environment at build time.

## Shipping an update

Bump the version — this is what tells an installed copy an update exists. A
build with the same version as the installed one is invisible to it.

```bash
npm version patch
```

Then build and publish:

```bash
GH_TOKEN=your_token npm run release
```

In PowerShell:

```bash
$env:GH_TOKEN="your_token"; npm run release
```

That builds the installer, uploads it plus `latest.yml` to a GitHub Release, and
every installed copy picks it up within 6 hours — or on next launch.

To build without publishing:

```bash
npm run release:dry
```

## Why the token is safe

`electron-updater` reads a **public** repo's releases without any credential, so
no token ships inside the app. The token exists only on your machine, only to
upload. This is the reason the repo is public rather than private: a private feed
would require embedding a token in the installer, where anyone could extract it.

## What must never be published

`.gitignore` covers `.env`, `data/`, `*.db`, `release/`, and `prompts/`. A
pre-commit hook backs that up by rejecting credential-shaped filenames and
key-shaped strings. Install it after a fresh clone:

```bash
sh scripts/install-hooks.sh
```

The hook is not versioned by git, so a clone starts unprotected until you run
that once.

`prompts/` is ignored because the ATLAS brief names the internal execution
modules and strategy structure of a private trading system. Keep project-specific
prompts there and they stay local.

## Verifying no secret ever leaked

The packaged app was scanned against every value in `.env` and contained none of
them; the same scan across all 68 blobs in git history was also clean. `.env`
sits at the repo root but is not in `build.files`, so `electron-builder` never
copies it into the installer. If you add a new secret-bearing path, re-check with
the same approach rather than assuming.

## If a release uploads only the blockmap

Symptom: `422 Unprocessable Entity — "Published releases must have a valid tag"`,
and the GitHub release ends up with `PhoenixAI-Setup-X.Y.Z.exe.blockmap` but no
installer and no `latest.yml`.

Cause: electron-builder uploads assets concurrently, and when the release does
not exist yet each upload tries to create it. One wins, the other 422s and its
asset is lost. Without `latest.yml` the updater has no manifest, so auto-update
silently does nothing.

`npm run release` now pushes the git tag first (`scripts/tag-release.mjs`), which
removes the race. If you hit this on an older version, just run `npm run release`
again — the release exists by then, so the uploads attach instead of racing.
