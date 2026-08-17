/**
 * ACP harness registry.
 *
 * The Agent Client Protocol publishes a machine-readable registry of agents
 * with exact, SHA-pinned launch commands. Because this app already speaks ACP,
 * every one of them is drivable through the SAME client we built for Grok —
 * no per-vendor adapter, no second protocol.
 *
 * That reframes the product. This is not a Grok GUI that might add others; it
 * is a desktop front-end for the whole ACP ecosystem, of which Grok is one
 * entry. As of the registry fetched 2026-08-15 that is 38 agents, including
 * Claude, Codex, Gemini CLI, Cline, goose, opencode, Qwen Code, Kimi CLI,
 * Cursor, GitHub Copilot, Junie and Devin.
 *
 * Registry: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
 *
 * Two distribution forms appear:
 *   npx    -> { package, args? }                  (spawn via npx)
 *   binary -> { <platform>: { archive, cmd, args, sha256 } }
 *
 * We deliberately do NOT auto-download binaries. Fetching and executing a
 * remote archive is a materially different trust decision from running a
 * package the user already installed, and it should be an explicit, visible
 * action rather than a side effect of picking an agent from a dropdown.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Map Node's platform/arch onto the registry's platform keys. */
/** Locate npx's JS entrypoint so it can run under Node without a shell. */
function resolveNpxCli() {
  const dir = path.dirname(process.execPath);
  const candidates = [
    path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js")
  ];
  for (const candidate of candidates) {
    try { if (fsSync.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

export function platformKey() {
  const os_ = process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : "linux";
  const arch = process.arch === "arm64" ? "aarch64"
    : process.arch === "x64" ? "x86_64"
    : process.arch;
  return `${os_}-${arch}`;
}

/**
 * Structural validation for registry entries.
 *
 * These values end up as spawn arguments, so they are treated as untrusted
 * input regardless of source. This does NOT make launching safe by itself —
 * `npx -y <package>` executes remote code by design, which is why
 * `resolveLaunch` marks every entry as requiring explicit user consent.
 */
function sanitizeAgents(raw) {
  if (!Array.isArray(raw)) return [];
  const safeToken = /^[A-Za-z0-9@._/+-]+$/;
  return raw.filter((a) => {
    if (!a || typeof a !== "object") return false;
    if (typeof a.id !== "string" || typeof a.name !== "string") return false;
    const npx = a.distribution?.npx;
    if (npx) {
      if (typeof npx.package !== "string" || !safeToken.test(npx.package)) return false;
      if (npx.args && (!Array.isArray(npx.args) || !npx.args.every((x) => typeof x === "string"))) {
        return false;
      }
    }
    return true;
  });
}

export class HarnessRegistry {
  #agents = [];
  #fetchedAt = 0;

  constructor({ cachePath = null } = {}) {
    this.cachePath = cachePath
      ?? path.join(os.homedir(), ".agent-command-center", "acp-registry.json");
  }

  get agents() {
    return this.#agents;
  }

  /**
   * Load the registry, preferring a fresh network copy and falling back to
   * cache. The app must remain usable offline, so a failed fetch degrades to
   * the last known registry rather than leaving the harness list empty.
   */
  async load({ force = false } = {}) {
    if (!force && this.#agents.length && Date.now() - this.#fetchedAt < CACHE_TTL_MS) {
      return this.#agents;
    }

    try {
      const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      this.#agents = sanitizeAgents(data.agents);
      this.#fetchedAt = Date.now();
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true }).catch(() => {});
      await fs.writeFile(this.cachePath, JSON.stringify(data), "utf8").catch(() => {});
      return this.#agents;
    } catch {
      try {
        const cached = JSON.parse(await fs.readFile(this.cachePath, "utf8"));
        // The cache is an unsigned local file. Validate it exactly as strictly
        // as the network payload — otherwise anything able to write it gets
        // arbitrary package execution on the next offline launch.
        this.#agents = sanitizeAgents(cached.agents);
        this.#fetchedAt = Date.now();
      } catch {
        this.#agents = [];
      }
      return this.#agents;
    }
  }

  find(idOrName) {
    const needle = String(idOrName ?? "").toLowerCase();
    return this.#agents.find(
      (a) => a.id?.toLowerCase() === needle || a.name?.toLowerCase() === needle
    ) ?? null;
  }

  /**
   * Resolve an agent to a spawnable command for this platform.
   *
   * Returns { kind, command, args, requiresDownload, ... } or null when the
   * agent publishes nothing runnable here.
   */
  resolveLaunch(idOrName, { npxPath = null } = {}) {
    const agent = this.find(idOrName);
    if (!agent?.distribution) return null;

    const { npx, binary } = agent.distribution;

    if (npx?.package) {
      // Node's spawn() REFUSES .cmd/.bat without shell:true (the CVE-2024-27980
      // mitigation), so `npx.cmd` throws EINVAL on Windows — which would have
      // made all 21 npx harnesses unlaunchable. Using shell:true instead would
      // turn registry-supplied strings into a shell-injection vector, so
      // resolve npx's own JS entrypoint and run it under this Node binary,
      // keeping shell:false and passing args as an array.
      const cli = npxPath ?? resolveNpxCli();
      const usingCli = cli.endsWith(".js");
      return {
        kind: "npx",
        agentId: agent.id,
        name: agent.name,
        version: agent.version,
        license: agent.license,
        command: usingCli ? process.execPath : cli,
        // -y so a first run does not stall on an install prompt with no TTY.
        args: [...(usingCli ? [cli] : []), "-y", npx.package, ...(npx.args ?? [])],
        // Running a package from the network is a trust decision the user makes
        // explicitly, not a side effect of picking an entry from a list.
        requiresConsent: true,
        requiresDownload: false
      };
    }

    if (binary) {
      const key = platformKey();
      const entry = binary[key];
      if (!entry) {
        return {
          kind: "unsupported",
          agentId: agent.id,
          name: agent.name,
          reason: `No published binary for ${key}. Available: ${Object.keys(binary).join(", ")}`
        };
      }
      return {
        kind: "binary",
        agentId: agent.id,
        name: agent.name,
        version: agent.version,
        license: agent.license,
        archive: entry.archive,
        sha256: entry.sha256,
        command: entry.cmd,
        args: entry.args ?? [],
        // Surfaced so the UI can require an explicit install step. Downloading
        // and running a remote archive is a trust decision the user makes, not
        // something a dropdown selection should trigger.
        requiresDownload: true
      };
    }

    return null;
  }

  /** Agents runnable here without downloading anything. */
  readyToRun() {
    return this.#agents
      .map((a) => this.resolveLaunch(a.id))
      .filter((l) => l && l.kind === "npx");
  }

  /** Grouped for a picker: open-source first, since licence matters to the user. */
  catalogue() {
    const open = [];
    const proprietary = [];
    for (const agent of this.#agents) {
      const launch = this.resolveLaunch(agent.id);
      const row = {
        id: agent.id,
        name: agent.name,
        version: agent.version,
        license: agent.license,
        description: agent.description,
        repository: agent.repository,
        runnable: launch?.kind === "npx",
        requiresDownload: launch?.requiresDownload ?? false,
        unsupported: launch?.kind === "unsupported"
      };
      (/proprietary/i.test(agent.license ?? "") ? proprietary : open).push(row);
    }
    // The registry is remote and unvalidated; one malformed entry must not take
    // out the entire harness picker.
    const byName = (a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""));
    return { open: open.sort(byName), proprietary: proprietary.sort(byName) };
  }
}

/**
 * Local harnesses that are installed rather than fetched from the registry.
 * Grok Build is here because the user installed it directly; the registry
 * entry would launch a different (npx-fetched) copy.
 */
export const LOCAL_HARNESSES = [
  {
    id: "grok-build-local",
    name: "Grok Build (installed)",
    command: path.join(os.homedir(), ".grok", "bin",
      process.platform === "win32" ? "grok.exe" : "grok"),
    args: ["agent", "stdio"],
    license: "proprietary",
    note: "Uses the locally installed grok, so it shares your logged-in session and quota."
  }
];
