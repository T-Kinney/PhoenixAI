import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const endpoint = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const model = process.argv[2] || process.env.BENCH_MODEL || "gemma4-coder:q8";
const outputDir = path.resolve("data", "model-benchmarks");

const tasks = [
  {
    id: "two_sum",
    seconds: 8,
    prompt: [
      "Write Python code only. No markdown.",
      "Define function two_sum(nums, target) that returns indices of two different numbers whose values add to target.",
      "Return any valid pair. If no pair exists, return None.",
      "Do not read input or print."
    ].join("\n"),
    tests: [
      "assert tuple(two_sum([2, 7, 11, 15], 9)) in ((0, 1), (1, 0))",
      "assert tuple(two_sum([3, 2, 4], 6)) in ((1, 2), (2, 1))",
      "assert two_sum([1, 2, 3], 99) is None"
    ]
  },
  {
    id: "balanced_brackets",
    seconds: 8,
    prompt: [
      "Write Python code only. No markdown.",
      "Define function is_balanced(s) that returns True when (), [], and {} brackets are correctly balanced.",
      "Ignore all non-bracket characters.",
      "Do not read input or print."
    ].join("\n"),
    tests: [
      "assert is_balanced('{[()]}') is True",
      "assert is_balanced('a+(b*c)-[d/e]') is True",
      "assert is_balanced('([)]') is False",
      "assert is_balanced('(((') is False"
    ]
  },
  {
    id: "merge_intervals",
    seconds: 8,
    prompt: [
      "Write Python code only. No markdown.",
      "Define function merge_intervals(intervals) that merges overlapping closed intervals.",
      "Each interval is a two-item list [start, end]. Return a list of lists sorted by start.",
      "Do not mutate the caller's input. Do not read input or print."
    ].join("\n"),
    tests: [
      "data = [[1,3],[2,6],[8,10],[15,18]]",
      "assert merge_intervals(data) == [[1,6],[8,10],[15,18]]",
      "assert data == [[1,3],[2,6],[8,10],[15,18]]",
      "assert merge_intervals([[1,4],[4,5]]) == [[1,5]]",
      "assert merge_intervals([]) == []"
    ]
  },
  {
    id: "top_k_frequent",
    seconds: 8,
    prompt: [
      "Write Python code only. No markdown.",
      "Define function top_k_frequent(items, k) that returns the k most frequent items.",
      "Break ties by the natural ascending order of the item.",
      "Do not read input or print."
    ].join("\n"),
    tests: [
      "assert top_k_frequent(['b','a','b','c','a','b'], 2) == ['b','a']",
      "assert top_k_frequent([3,1,2,2,3,1], 2) == [1,2]",
      "assert top_k_frequent(['x'], 3) == ['x']"
    ]
  },
  {
    id: "slugify",
    seconds: 8,
    prompt: [
      "Write Python code only. No markdown.",
      "Define function slugify(text) that lowercases text, converts runs of non-alphanumeric characters to one hyphen, and strips leading/trailing hyphens.",
      "Do not read input or print."
    ].join("\n"),
    tests: [
      "assert slugify('Hello, World!') == 'hello-world'",
      "assert slugify('  Agent---Command Center  ') == 'agent-command-center'",
      "assert slugify('AI_Models 2026') == 'ai-models-2026'",
      "assert slugify('!!!') == ''"
    ]
  }
];

function extractCode(text) {
  const raw = String(text || "").trim();
  const fence = raw.match(/```(?:python)?\s*([\s\S]*?)```/i);
  return (fence ? fence[1] : raw)
    .replace(/^\s*python\s*\n/i, "")
    .trim();
}

async function callOllama(prompt) {
  const started = Date.now();
  const response = await fetch(`${endpoint}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0,
        num_predict: 700,
        top_p: 0.9
      }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Ollama HTTP ${response.status}`);
  }
  return {
    text: data.response || "",
    elapsedMs: Date.now() - started,
    evalCount: data.eval_count || null,
    evalDurationNs: data.eval_duration || null,
    promptEvalCount: data.prompt_eval_count || null
  };
}

function runPython(filePath, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("python", [filePath], {
      windowsHide: true,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: code === null });
    });
  });
}

async function benchmarkTask(task, runDir) {
  const generation = await callOllama(task.prompt);
  const code = extractCode(generation.text);
  const filePath = path.join(runDir, `${task.id}.py`);
  const testCode = [
    code,
    "",
    "# benchmark tests",
    ...task.tests,
    "print('PASS')"
  ].join("\n");
  await fs.writeFile(filePath, testCode, "utf8");
  const execution = await runPython(filePath, task.seconds * 1000);
  const passed = execution.code === 0 && execution.stdout.includes("PASS");
  return {
    id: task.id,
    passed,
    elapsedMs: generation.elapsedMs,
    evalCount: generation.evalCount,
    evalTokensPerSecond: generation.evalCount && generation.evalDurationNs
      ? Number((generation.evalCount / (generation.evalDurationNs / 1e9)).toFixed(2))
      : null,
    promptEvalCount: generation.promptEvalCount,
    code,
    stdout: execution.stdout.trim(),
    stderr: execution.stderr.trim(),
    exitCode: execution.code
  };
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(outputDir, `${model.replace(/[^a-z0-9_.-]+/gi, "_")}-${runId}`);
  await fs.mkdir(runDir, { recursive: true });

  const results = [];
  for (const task of tasks) {
    console.log(`benchmark ${model}: ${task.id}`);
    try {
      results.push(await benchmarkTask(task, runDir));
    } catch (error) {
      results.push({ id: task.id, passed: false, error: error.message });
    }
  }
  const passed = results.filter((item) => item.passed).length;
  const summary = {
    model,
    endpoint,
    checkedAt: new Date().toISOString(),
    tasks: results.length,
    passed,
    passRate: Number((passed / results.length).toFixed(3)),
    averageElapsedMs: Math.round(results.reduce((sum, item) => sum + (item.elapsedMs || 0), 0) / results.length),
    averageEvalTokensPerSecond: Number((results.reduce((sum, item) => sum + (item.evalTokensPerSecond || 0), 0) / results.filter((item) => item.evalTokensPerSecond).length).toFixed(2)),
    results
  };
  const outputPath = path.join(runDir, "summary.json");
  await fs.writeFile(outputPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({
    model,
    passed,
    tasks: results.length,
    passRate: summary.passRate,
    averageElapsedMs: summary.averageElapsedMs,
    averageEvalTokensPerSecond: summary.averageEvalTokensPerSecond,
    outputPath
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
