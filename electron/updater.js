// Auto-update for PhoenixAI.
//
// The app is installed per-user (NSIS, oneClick=false, perMachine=false), so an
// update can be downloaded and applied without a UAC prompt. The flow is:
//
//   launch -> check -> download in background -> tell the user -> install on quit
//
// Nothing is installed behind the user's back mid-session: the downloaded
// package is staged and swapped in when the app exits, which is the same
// behaviour people are used to from other desktop software.

import electronUpdater from "electron-updater";
import log from "electron-log";

const { autoUpdater } = electronUpdater;

// How long after launch to check. Checking immediately competes with window
// paint and the agent daemon probe, and a few seconds costs nothing.
const FIRST_CHECK_DELAY_MS = 8_000;
// Long-running sessions should still pick up releases without a restart.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let timer = null;
let started = false;

/**
 * @param {object} options
 * @param {(channel: string, payload: unknown) => void} options.broadcast
 *   Sends state to every open window.
 * @param {boolean} [options.enabled] False in dev, where there is no published
 *   feed and electron-updater would only log errors.
 */
export function startAutoUpdate({ broadcast, enabled = true }) {
  if (started) return { check: () => {}, quitAndInstall: () => {} };
  started = true;

  autoUpdater.logger = log;
  log.transports.file.level = "info";

  // We drive the download ourselves so the user is told a download is starting
  // rather than discovering it from bandwidth use.
  autoUpdater.autoDownload = false;
  // Applying on quit is the least disruptive moment.
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (state, payload = {}) => broadcast("update:state", { state, ...payload });

  autoUpdater.on("checking-for-update", () => send("checking"));

  autoUpdater.on("update-available", (info) => {
    send("available", { version: info?.version, notes: normalizeNotes(info?.releaseNotes) });
    autoUpdater.downloadUpdate().catch((error) => {
      send("error", { message: error?.message ?? String(error) });
    });
  });

  autoUpdater.on("update-not-available", () => send("current"));

  autoUpdater.on("download-progress", (p) => {
    send("downloading", {
      percent: Math.round(p?.percent ?? 0),
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    send("ready", { version: info?.version, notes: normalizeNotes(info?.releaseNotes) });
  });

  // A missing or unreachable feed must never break the app. It is surfaced
  // quietly and the user keeps working on the version they have.
  autoUpdater.on("error", (error) => {
    send("error", { message: error?.message ?? String(error) });
  });

  const check = () => {
    if (!enabled) { send("disabled"); return; }
    autoUpdater.checkForUpdates().catch((error) => {
      send("error", { message: error?.message ?? String(error) });
    });
  };

  if (enabled) {
    setTimeout(check, FIRST_CHECK_DELAY_MS).unref?.();
    timer = setInterval(check, RECHECK_INTERVAL_MS);
    timer.unref?.();
  } else {
    send("disabled");
  }

  return {
    check,
    quitAndInstall() {
      // isSilent=false shows the installer's own progress; isForceRunAfter=true
      // reopens PhoenixAI once the swap completes.
      autoUpdater.quitAndInstall(false, true);
    },
    stop() { if (timer) clearInterval(timer); }
  };
}

// GitHub returns release notes as HTML, other providers as an array of
// {version, note}. The renderer shows plain text, so flatten both.
function normalizeNotes(notes) {
  if (!notes) return "";
  const raw = Array.isArray(notes)
    ? notes.map((n) => (typeof n === "string" ? n : n?.note ?? "")).join("\n\n")
    : String(notes);
  return raw.replace(/<[^>]+>/g, "").trim().slice(0, 600);
}
