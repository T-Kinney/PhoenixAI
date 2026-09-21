import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StrategyLab } from "../server/strategyLab.js";

const baseSpec = {
  name: "SPY skew research",
  thesis: "Test whether a pre-declared options-skew condition predicts short-horizon returns.",
  universe: "SPY only",
  timeframe: "one-minute bars",
  signalDefinition: "Enter only when the frozen skew z-score threshold is crossed.",
  entryRules: "Evaluate at bar close and enter on the next bar.",
  exitRules: "Exit after 30 minutes or at the pre-declared stop.",
  positionSizing: "Risk 0.25% of research equity per simulated position.",
  costs: { commissionPerTradeUsd: 0.65, slippageBps: 2, spreadBps: 1 },
  evaluation: {
    splits: {
      train: { start: "2022-01-01", end: "2022-12-31" },
      validation: { start: "2023-01-02", end: "2023-12-29" },
      test: { start: "2024-01-02", end: "2024-12-31" }
    },
    embargoBars: 5,
    minTrades: 30,
    primaryMetric: "sharpe",
    benchmark: "SPY buy-and-hold",
    walkForwardRequired: true
  }
};

const windows = [
  { trainEnd: "2022-12-30", testStart: "2023-01-03", testEnd: "2023-03-31" },
  { trainEnd: "2023-03-31", testStart: "2023-04-03", testEnd: "2023-06-30" },
  { trainEnd: "2023-06-30", testStart: "2023-07-03", testEnd: "2023-09-29" }
];

test("strategy specifications are append-only, hashed, and versioned", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-strategy-spec-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = { id: "project_one", path: folder };
  const lab = new StrategyLab({ dataDir: path.join(folder, "state") });

  const first = await lab.createSpec(baseSpec, project);
  const second = await lab.createSpecVersion(first.id, { changeNote: "Increase minimum sample.", evaluation: { ...baseSpec.evaluation, minTrades: 50 } }, project);
  const rows = await lab.listSpecs(project.id);

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.rootId, first.rootId);
  assert.equal(second.previousSpecId, first.id);
  assert.notEqual(second.hash, first.hash);
  assert.equal(first.safety.liveTrading, "disabled");
  assert.deepEqual(rows.map((row) => row.id).sort(), [first.id, second.id].sort());
  await assert.rejects(
    lab.createSpecVersion(first.id, { ...baseSpec, changeNote: "Stale branch." }, project),
    /no longer current/i
  );
});

test("dataset registration computes provenance and rejects paths outside the project", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-strategy-data-"));
  const projectFolder = path.join(folder, "project");
  await fs.mkdir(projectFolder);
  await fs.writeFile(path.join(projectFolder, "bars.csv"), "timestamp,symbol,close\n2024-01-02T14:30:00Z,SPY,470\n2024-01-02T14:31:00Z,SPY,471");
  await fs.writeFile(path.join(folder, "outside.csv"), "secret\n");
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = { id: "project_one", path: projectFolder };
  const lab = new StrategyLab({ dataDir: path.join(folder, "state") });

  const dataset = await lab.inspectDataset({ relativePath: "bars.csv", source: "Fixture", timeColumn: "timestamp", symbolColumn: "symbol" }, project);
  const duplicate = await lab.inspectDataset({ relativePath: "bars.csv", source: "Fixture" }, project);

  assert.equal(dataset.sha256.length, 64);
  assert.equal(dataset.rowCount, 2);
  assert.deepEqual(dataset.columns, ["timestamp", "symbol", "close"]);
  assert.equal(duplicate.id, dataset.id);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(lab.inspectDataset({ relativePath: "../outside.csv", source: "Invalid" }, project), /outside the selected project/i);
});

test("experiment review detects leakage and repeated holdout use", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "phoenix-strategy-review-"));
  await fs.writeFile(path.join(folder, "bars.csv"), "timestamp,symbol,close\n2024-01-02T14:30:00Z,SPY,470\n");
  t.after(() => fs.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const project = { id: "project_one", path: folder };
  const lab = new StrategyLab({ dataDir: path.join(folder, "state") });
  const dataset = await lab.inspectDataset({ relativePath: "bars.csv", source: "Fixture" }, project);
  const spec = await lab.createSpec({ ...baseSpec, datasetIds: [dataset.id] }, project);
  const experimentInput = {
    specId: spec.id,
    label: "Baseline",
    datasetIds: [dataset.id],
    features: [{ name: "skew_z", lagBars: 1, availableAt: "before-decision" }],
    metrics: { train: { sharpe: 1 }, validation: { sharpe: 0.9 }, test: { sharpe: 0.8, trades: 40 } },
    walkForward: { windows },
    holdoutUsed: true,
    holdoutLabel: "2024-primary"
  };

  const first = await lab.recordExperiment(experimentInput, project);
  const repeated = await lab.recordExperiment({ ...experimentInput, label: "Repeated holdout" }, project);
  const leaked = await lab.recordExperiment({
    ...experimentInput,
    label: "Leaked feature",
    holdoutUsed: false,
    features: [{ name: "future_return", lagBars: -1, availableAt: "after-decision" }]
  }, project);

  assert.equal(first.review.status, "passed");
  assert.equal(repeated.review.status, "needs_review");
  assert.equal(repeated.review.checks.find((item) => item.id === "holdout-reuse").status, "warn");
  assert.equal(leaked.review.status, "failed");
  assert.equal(leaked.review.checks.find((item) => item.id === "feature-leakage").status, "fail");

  const comparison = await lab.compareExperiments(project.id, [first.id, leaked.id]);
  assert.equal(comparison.length, 2);
  assert.equal(comparison.find((item) => item.id === first.id).test, 0.8);

  const unknown = await lab.recordExperiment({
    ...experimentInput,
    label: "Missing metrics",
    holdoutUsed: false,
    metrics: { train: { sharpe: null }, validation: {}, test: { trades: null } }
  }, project);
  const unknownComparison = await lab.compareExperiments(project.id, [unknown.id]);
  assert.equal(unknownComparison[0].train, null);
  assert.equal(unknownComparison[0].validation, null);
  assert.equal(unknownComparison[0].test, null);
  assert.equal(unknownComparison[0].trades, null);

  const concurrent = await Promise.all([
    lab.recordExperiment({ ...experimentInput, label: "Concurrent A", holdoutLabel: "concurrent-test" }, project),
    lab.recordExperiment({ ...experimentInput, label: "Concurrent B", holdoutLabel: "concurrent-test" }, project)
  ]);
  assert.deepEqual(concurrent.map((item) => item.review.checks.find((check) => check.id === "holdout-reuse").status), ["pass", "warn"]);

  await fs.writeFile(path.join(folder, "bars.csv"), "timestamp,symbol,close\n2024-01-02T14:30:00Z,SPY,999\n");
  const changedDataset = await lab.recordExperiment({ ...experimentInput, label: "Changed dataset", holdoutUsed: false }, project);
  assert.equal(changedDataset.review.status, "failed");
  assert.match(changedDataset.review.checks.find((item) => item.id === "data-provenance").detail, /checksum changed/i);
  assert.equal(changedDataset.datasetSnapshots[0].sha256, dataset.sha256);
});
