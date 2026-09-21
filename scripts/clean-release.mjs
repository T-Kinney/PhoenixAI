import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "release");
const cacheRoot = path.join(root, ".build-cache");
const cacheTarget = path.join(cacheRoot, "electron-dist");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const currentVersion = String(pkg.version);

function assertDirectChild(target, parent) {
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(parent)) {
    throw new Error(`Refusing to clean a path outside ${parent}: ${resolved}`);
  }
  return resolved;
}

async function exists(target) {
  return fs.stat(target).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

if (!await exists(releaseRoot)) {
  console.log("Release cleanup skipped: release directory does not exist.");
  process.exit(0);
}

const removed = [];
const entries = await fs.readdir(releaseRoot, { withFileTypes: true });
for (const entry of entries) {
  const installer = entry.name.match(/^PhoenixAI Setup (.+?)\.exe(?:\.blockmap)?$/i);
  const obsoleteInstaller = installer && installer[1] !== currentVersion;
  const obsoleteMetadata = ["builder-debug.yml", "builder-effective-config.yaml"].includes(entry.name);
  const obsoleteLegacyFolder = entry.isDirectory() && entry.name === "Agent Command Center";
  if (!obsoleteInstaller && !obsoleteMetadata && !obsoleteLegacyFolder) continue;
  const target = assertDirectChild(path.join(releaseRoot, entry.name), releaseRoot);
  await fs.rm(target, { recursive: entry.isDirectory(), force: true });
  removed.push(entry.name);
}

// Keep the large Electron runtime cache out of the deliverables directory.
// It is a build optimization, not a release artifact.
const legacyCache = assertDirectChild(path.join(releaseRoot, "electron-dist-cache"), releaseRoot);
if (await exists(legacyCache)) {
  await fs.mkdir(cacheRoot, { recursive: true });
  if (!await exists(cacheTarget)) {
    try {
      await fs.rename(legacyCache, cacheTarget);
    } catch (error) {
      if (!["EPERM", "EACCES", "EXDEV"].includes(error?.code)) throw error;
      // Windows scanners can hold a handle that prevents an atomic directory
      // rename. Copy first, verify the runtime exists, then remove only the
      // already-validated legacy cache path.
      await fs.cp(legacyCache, cacheTarget, { recursive: true, errorOnExist: true, force: false });
      if (!await exists(path.join(cacheTarget, "electron.exe"))) {
        throw new Error("Electron cache copy did not contain electron.exe; legacy cache was preserved.");
      }
      await fs.rm(legacyCache, { recursive: true, force: true });
    }
  } else {
    await fs.rm(legacyCache, { recursive: true, force: true });
  }
  removed.push("electron-dist-cache (moved to .build-cache)");
}

console.log(removed.length
  ? `Cleaned ${removed.length} stale release artifacts:\n- ${removed.join("\n- ")}`
  : `Release directory already contains only PhoenixAI ${currentVersion} artifacts.`);
