import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { SessionManager } from "../server/acp/sessionManager.js";

test("market-data MCP advertises only bounded read-only tools", async () => {
  const child = spawn(process.execPath, ["server/acp/marketDataMcpServer.js"], {
    cwd: path.resolve("."),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH }
  });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.trim().split(/\r?\n/).filter(Boolean)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
  child.stdin.end();
  await new Promise((resolve, reject) => {
    child.on("exit", resolve);
    child.on("error", reject);
  });
  const response = JSON.parse(lines[0]);
  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["market_quotes", "market_option_expirations", "market_option_chain", "market_option_greeks", "market_price_history"]);
  assert.equal(names.some((name) => /order|cancel|portfolio|account|preflight/i.test(name)), false);
  assert.equal(response.result.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false), true);
  assert.equal(response.result.tools.find((tool) => tool.name === "market_option_chain").inputSchema.properties.maxContractsPerSide.maximum, 150);
});

test("Grok sessions receive the isolated market-data MCP only when both Public credentials exist", () => {
  const priorSecret = process.env.PUBLIC_COM_SECRET;
  const priorAccount = process.env.PUBLIC_COM_ACCOUNT_ID;
  try {
    delete process.env.PUBLIC_COM_SECRET;
    delete process.env.PUBLIC_COM_ACCOUNT_ID;
    const manager = new SessionManager({ statePath: path.join(path.resolve("."), "data", "test-sessions.json") });
    assert.equal(manager.mcpServersFor(path.resolve(".")).some((server) => server.name === "market-data-readonly"), false);
    process.env.PUBLIC_COM_SECRET = "test-public-secret";
    process.env.PUBLIC_COM_ACCOUNT_ID = "account_123";
    const server = manager.mcpServersFor(path.resolve(".")).find((item) => item.name === "market-data-readonly");
    assert.ok(server);
    assert.deepEqual(server.env.map((item) => item.name), ["PUBLIC_COM_SECRET", "PUBLIC_COM_ACCOUNT_ID"]);
    assert.equal(server.args.some((value) => /marketDataMcpServer\.js$/i.test(value)), true);
    assert.equal(server.args.includes("--audit"), true);
  } finally {
    if (priorSecret == null) delete process.env.PUBLIC_COM_SECRET; else process.env.PUBLIC_COM_SECRET = priorSecret;
    if (priorAccount == null) delete process.env.PUBLIC_COM_ACCOUNT_ID; else process.env.PUBLIC_COM_ACCOUNT_ID = priorAccount;
  }
});
