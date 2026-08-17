/**
 * ACP verification suite. Replaces the three ad-hoc probe scripts with
 * assertions and a real exit code, so regressions are caught rather than
 * eyeballed.
 *
 *   node scripts/acp-verify.mjs
 *
 * Every check runs against a live `grok.exe` in a disposable temp project.
 * Exit 0 = all passed. Exit 1 = something regressed.
 *
 * Why this file exists: the earlier probes called the client's permission
 * `respond()` with a fully-formed response object while the client expected an
 * option-id string. The result nested one inside the other, the agent rejected
 * it, and the turn cancelled — which LOOKED like a successful deny. The suite
 * now asserts the mechanism, not just the outcome.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GrokAcpClient, UPDATE_KINDS, DANGEROUS_OPTION_IDS } from "../server/acp/client.js";
import { GrokDaemon } from "../server/acp/daemon.js";

const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function scratch(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-verify-"));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body, "utf8");
  }
  return dir;
}

/** Collect streamed updates into a shape the assertions can inspect. */
function collect(client) {
  const seen = { text: "", kinds: new Set(), tools: [], replayCount: 0, liveCount: 0 };
  client.on("update", (_sid, update, meta) => {
    const kind = update?.sessionUpdate;
    if (kind) seen.kinds.add(kind);
    if (kind === UPDATE_KINDS.MESSAGE) seen.text += update.content?.text || "";
    if (kind === UPDATE_KINDS.TOOL_CALL) seen.tools.push(update.title || update.kind);
    if (meta?.isReplay) seen.replayCount += 1;
    else seen.liveCount += 1;
  });
  return seen;
}

// ---------------------------------------------------------------------------

async function testBadBinaryFailsFast() {
  const client = new GrokAcpClient({ bin: "C:\\nope\\definitely-not-grok.exe" });
  const started = Date.now();
  let message = "";
  try {
    await Promise.race([
      client.start(),
      sleep(10_000).then(() => { throw new Error("HUNG"); })
    ]);
    check("bad binary path rejects", false, "start() resolved unexpectedly");
  } catch (e) {
    message = e.message;
    check("bad binary path rejects", message !== "HUNG",
      message === "HUNG" ? "start() hung instead of rejecting" : `${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  check("bad binary error is actionable", /not found|install/i.test(message), message.slice(0, 70));
}

async function testStreamingAndTools() {
  const dir = await scratch({ "inventory.txt": "widgets: 41\ngizmos: 7\nsprockets: 128\n" });
  const client = new GrokAcpClient({ cwd: dir });
  const seen = collect(client);
  await client.start();
  const sessionId = await client.newSession({ cwd: dir });
  await client.prompt(sessionId,
    "Read inventory.txt and reply with only the total of all three numbers.");

  check("streams message chunks", seen.text.length > 0, `${seen.text.trim().slice(0, 40)}`);
  check("emits tool calls", seen.tools.length > 0, seen.tools.join(", "));
  check("computes correct answer", seen.text.includes("176"), seen.text.trim().slice(0, 40));
  check("emits thought stream", seen.kinds.has(UPDATE_KINDS.THOUGHT));
  await client.stop();
  return seen;
}

/** The critical one: does a DENY through the client's own respond() work? */
async function testPermissionDeny() {
  const dir = await scratch({ "notes.txt": "original contents\n" });
  const target = path.join(dir, "notes.txt");
  const client = new GrokAcpClient({ cwd: dir });

  let offered = null;
  let dangerousSeen = false;
  client.on("permission", (req, respond) => {
    offered = (req?.options || []).map((o) => `${o.optionId}:${o.kind}`);
    for (const o of req?.options || []) {
      if (DANGEROUS_OPTION_IDS.has(o.optionId)) dangerousSeen = true;
    }
    const reject = (req?.options || []).find((o) => o.kind === "reject_once");
    // Pass an option-id STRING — the documented contract.
    respond(reject?.optionId ?? null);
  });

  await client.start();
  const sessionId = await client.newSession({ cwd: dir });
  await client.prompt(sessionId,
    `Overwrite notes.txt so it contains exactly the text MODIFIED. Use your file editing tool.`);

  const after = await fs.readFile(target, "utf8");
  check("permission prompt fires", offered !== null, offered ? offered.join(" | ") : "none");
  check("deny prevents the write", !after.includes("MODIFIED"), JSON.stringify(after));
  check("no dangerous option auto-offered", !dangerousSeen,
    dangerousSeen ? "enable-always-approve present — never auto-select index 0" : "");
  await client.stop();
}

/** respond() must accept an object too, since callers reach for both shapes. */
async function testPermissionAllowViaObject() {
  const dir = await scratch({ "seed.txt": "seed\n" });
  const client = new GrokAcpClient({ cwd: dir });

  let fired = false;
  client.on("permission", (req, respond) => {
    fired = true;
    const allow = (req?.options || []).find((o) => o.kind === "allow_once");
    // Fully-formed object — previously this nested and corrupted the response.
    respond({ outcome: { outcome: "selected", optionId: allow?.optionId } });
  });

  await client.start();
  const sessionId = await client.newSession({ cwd: dir });
  await client.prompt(sessionId, `Create a file named created.txt containing the text OK.`);

  const exists = await fs.access(path.join(dir, "created.txt")).then(() => true, () => false);
  check("respond() accepts object form", fired && exists,
    fired ? (exists ? "write completed" : "write did not happen") : "prompt never fired");
  await client.stop();
}

/**
 * The property that actually justifies `serve` over `stdio`. The Grok source
 * states it directly (agent/server.rs:6-10): "session actors (and any in-flight
 * prompts) survive client disconnects — when a client reconnects and loads an
 * existing session, ongoing work continues to stream to the new connection."
 *
 * Test discipline that matters here:
 *  - the RECONNECTED client must also answer permission requests, or the
 *    in-flight turn stalls waiting on approval nobody is listening for;
 *  - do not issue a second prompt until the first turn has actually finished.
 */
async function testMidTurnDisconnectSurvival() {
  const dir = await scratch({ "data.txt": "the answer is 7311\n" });
  const target = path.join(dir, "result.txt");
  const daemon = new GrokDaemon({ cwd: dir });
  await daemon.start();

  const c1 = await daemon.connect();
  c1.on("permission", (_r, respond) => respond("allow-once"));
  const sessionId = await c1.newSession({ cwd: dir });

  // Start a turn, then sever the socket WHILE it is in flight.
  const inFlight = c1.prompt(sessionId,
    "Read data.txt, then create a file called result.txt containing only the number you found.");
  inFlight.catch(() => {});           // expected to reject when we cut the socket

  await sleep(2000);
  await c1.stop();                    // hard drop mid-turn
  check("daemon survives client drop", daemon.running);

  // Reattach. This client MUST be able to approve, or the resumed turn stalls.
  const c2 = await daemon.connect();
  c2.on("permission", (_r, respond) => respond("allow-once"));
  const seen = collect(c2);
  await c2.loadSession(sessionId, { cwd: dir });

  check("replay is flagged via _meta", seen.replayCount > 0,
    `replay=${seen.replayCount} live=${seen.liveCount}`);

  // Give the resumed turn room to finish and stream to the new connection.
  let wroteFile = false;
  for (let i = 0; i < 40 && !wroteFile; i++) {
    await sleep(1500);
    wroteFile = await fs.access(target).then(() => true, () => false);
  }
  check("mid-turn work completes after reconnect", wroteFile,
    wroteFile ? "result.txt was created post-disconnect" : "turn did not finish within 60s");
  if (wroteFile) {
    const body = await fs.readFile(target, "utf8");
    check("resumed turn produced correct output", body.includes("7311"), JSON.stringify(body.trim()));
  }

  // Memory across the reconnect, now that the first turn is done.
  const seen2 = collect(c2);
  await c2.prompt(sessionId, "What number did you read from data.txt? Reply with only the number.");
  check("session retains memory", seen2.text.includes("7311"), seen2.text.trim().slice(0, 40));

  await c2.stop();
  await daemon.stop();
  check("daemon stops cleanly", !daemon.running);
}

async function testDaemonSecretNotInArgv() {
  const dir = await scratch({ "x.txt": "x\n" });
  const daemon = new GrokDaemon({ cwd: dir });
  const info = await daemon.start();
  const { execSync } = await import("node:child_process");
  let cmdline = "";
  try {
    cmdline = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"ProcessId=${info.pid}\\").CommandLine"`,
      { encoding: "utf8", timeout: 20000 }
    );
  } catch { /* best effort */ }
  check("secret absent from process argv", !/--secret/.test(cmdline), cmdline.trim().slice(0, 90));
  check("describe() omits secret", !JSON.stringify(info).includes("secret"));
  await daemon.stop();
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("\n=== ACP VERIFICATION SUITE ===\n");
  const tests = [
    ["bad binary", testBadBinaryFailsFast],
    ["streaming + tools", testStreamingAndTools],
    ["permission deny", testPermissionDeny],
    ["permission allow (object form)", testPermissionAllowViaObject],
    ["daemon secret hygiene", testDaemonSecretNotInArgv],
    ["mid-turn disconnect", testMidTurnDisconnectSurvival]
  ];

  // Optional substring filter so a single test can be re-run in isolation:
  //   node scripts/acp-verify.mjs mid-turn
  const filter = process.argv[2];
  const selected = filter
    ? tests.filter(([label]) => label.toLowerCase().includes(filter.toLowerCase()))
    : tests;
  if (filter && selected.length === 0) {
    console.log(`No test matches "${filter}". Available: ${tests.map(([l]) => l).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  for (const [label, fn] of selected) {
    console.log(`\n--- ${label} ---`);
    try {
      await fn();
    } catch (e) {
      check(`${label} (threw)`, false, e.message.slice(0, 120));
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log(failed.map((f) => `  FAIL ${f.name}`).join("\n"));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`SUITE CRASHED: ${e.stack}`);
  process.exitCode = 1;
});
