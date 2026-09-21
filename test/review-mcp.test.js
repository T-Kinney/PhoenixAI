import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

test("review MCP advertises only the bounded review tool", async () => {
  const child = spawn(process.execPath, ["server/acp/reviewMcpServer.js", "--project", path.resolve(".")], {
    cwd: path.resolve("."),
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
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
  assert.equal(response.id, 1);
  assert.deepEqual(response.result.tools.map((tool) => tool.name), ["review_with_model"]);
  assert.deepEqual(response.result.tools[0].inputSchema.properties.provider.enum, ["qwen", "kimi", "deepseek"]);
  assert.equal(response.result.tools[0].inputSchema.properties.costPolicy, undefined);
  assert.deepEqual(response.result.tools[0].inputSchema.properties.route.enum, ["auto", "qwencloud", "direct"]);
});
