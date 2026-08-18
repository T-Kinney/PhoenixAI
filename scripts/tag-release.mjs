/**
 * Create and push the git tag for the current version before electron-builder
 * publishes.
 *
 * Without this, publishing a NEW version races: electron-builder uploads the
 * installer and the blockmap concurrently, and each upload tries to create the
 * GitHub release because it does not exist yet. One wins; the other gets
 *
 *   422 Unprocessable Entity — "Published releases must have a valid tag"
 *
 * and its asset never uploads. That is how a release ends up holding only a
 * blockmap, with no installer and — fatally for auto-update — no latest.yml.
 *
 * Pushing the tag first means the release GitHub creates is anchored to a ref
 * that already exists, so both uploads attach to the same release.
 *
 * Idempotent: an existing local or remote tag is left alone, so re-running a
 * failed release is safe.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = `v${version}`;

// A tag pointing at the wrong commit is worse than no tag: the release would
// ship notes and assets for code nobody can check out.
let localSha = "";
try { localSha = git("rev-list", "-n", "1", tag); } catch { /* no local tag */ }

const head = git("rev-parse", "HEAD");

if (localSha && localSha !== head) {
  console.error(`refusing to publish: ${tag} points at ${localSha.slice(0, 8)} but HEAD is ${head.slice(0, 8)}.`);
  console.error(`Bump the version in package.json, or delete the tag with: git tag -d ${tag}`);
  process.exit(1);
}

if (!localSha) {
  git("tag", tag);
  console.log(`created tag ${tag} at ${head.slice(0, 8)}`);
} else {
  console.log(`tag ${tag} already present`);
}

// Pushing an already-pushed tag is a no-op; a tag that exists remotely at a
// different commit fails loudly here rather than producing a mismatched release.
try {
  git("push", "origin", tag);
  console.log(`pushed ${tag} to origin`);
} catch (error) {
  const message = String(error.stderr || error.message);
  if (/already exists|up to date|up-to-date/i.test(message)) {
    console.log(`tag ${tag} already on origin`);
  } else {
    console.error(`could not push ${tag}:\n${message}`);
    process.exit(1);
  }
}
