import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const unpacked = path.join(root, "release", "win-unpacked");
const exe = path.join(unpacked, `${pkg.build?.productName ?? pkg.name}.exe`);
const asar = path.join(unpacked, "resources", "app.asar");
const requireInstaller = process.argv.includes("--installer");
const requireSigned = process.argv.includes("--require-signed")
  || process.env.PHOENIX_REQUIRE_SIGNED === "1";

const fail = (message) => {
  console.error(`Package verification failed: ${message}`);
  process.exit(1);
};

for (const target of [exe, asar]) {
  if (!existsSync(target) || statSync(target).size === 0) fail(`missing ${path.relative(root, target)}`);
}

const entries = new Set(listPackage(asar).map((entry) => entry.replaceAll("\\", "/")));
for (const required of [
  "/dist/index.html",
  "/electron/main.js",
  "/electron/preload.js",
  "/electron/credentials.js",
  "/PRIVACY.md",
  "/SECURITY.md",
  "/server/api.js",
  "/server/routes.js",
  "/server/spendGuard.js",
  "/server/acp/sessionManager.js",
  "/server/acp/reviewMcpServer.js"
]) {
  if (!entries.has(required)) fail(`app.asar is missing ${required}`);
}

const forbidden = [...entries].filter((entry) =>
  /(^|\/)\.env(?:\.|$)/i.test(entry)
  || /(^|\/)data(?:\/|$)/i.test(entry)
  || /(^|\/)prompts(?:\/|$)/i.test(entry)
  || /(^|\/)test(?:\/|$)/i.test(entry)
);
if (forbidden.length) fail(`private or development paths were packaged: ${forbidden.join(", ")}`);

function signatureStatus(file) {
  if (process.platform !== "win32") return "UnsupportedPlatform";
  const escaped = file.replaceAll("'", "''");
  try {
    return execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (requireSigned) fail(`could not inspect ${path.relative(root, file)} signature: ${error.message}`);
    return "Unavailable";
  }
}

const checked = [{ label: path.relative(root, exe), path: exe }];
if (requireInstaller) {
  const releaseDir = path.join(root, "release");
  const expected = `PhoenixAI Setup ${pkg.version}.exe`;
  const installer = readdirSync(releaseDir)
    .map((name) => path.join(releaseDir, name))
    .find((candidate) => path.basename(candidate).toLowerCase() === expected.toLowerCase());
  if (!installer || statSync(installer).size < 1024 * 1024) fail(`missing installer ${expected}`);
  if (!existsSync(path.join(releaseDir, "latest.yml"))) fail("missing latest.yml update manifest");
  checked.push({ label: path.relative(root, installer), path: installer });
}

for (const item of checked) {
  const signature = signatureStatus(item.path);
  if (requireSigned && signature !== "Valid") fail(`${item.label} signature is ${signature}`);
  console.log(`${item.label}: signature=${signature}`);
}

console.log(`Verified PhoenixAI ${pkg.version}: ${entries.size} packaged paths, no private data paths.`);
