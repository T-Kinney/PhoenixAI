import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function nowIso() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`; }
function text(value, limit = 2000) { return String(value ?? "").trim().slice(0, limit); }
function array(value) { return Array.isArray(value) ? value : []; }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
  return value;
}

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function requireFields(input, fields, label) {
  const missing = fields.filter((field) => !text(input?.[field]));
  if (missing.length) throw new Error(`${label} requires: ${missing.join(", ")}.`);
}

function dateMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function chronologicalSplits(splits = {}) {
  const ordered = ["train", "validation", "test"].map((name) => ({ name, ...(splits[name] || {}) }));
  const issues = [];
  for (const period of ordered) {
    const start = dateMs(period.start);
    const end = dateMs(period.end);
    if (start == null || end == null) issues.push(`${period.name} needs valid start and end dates`);
    else if (start >= end) issues.push(`${period.name} start must be before end`);
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const priorEnd = dateMs(ordered[index - 1].end);
    const currentStart = dateMs(ordered[index].start);
    if (priorEnd != null && currentStart != null && priorEnd >= currentStart) {
      issues.push(`${ordered[index - 1].name} and ${ordered[index].name} overlap or touch`);
    }
  }
  return issues;
}

function sanitizeSpec(input, project, previous = null) {
  requireFields(input, ["name", "thesis", "universe", "timeframe", "signalDefinition", "entryRules", "exitRules"], "Strategy specification");
  const evaluation = input.evaluation || {};
  const splits = evaluation.splits || {};
  const splitIssues = chronologicalSplits(splits);
  if (splitIssues.length) throw new Error(`Invalid research split: ${splitIssues.join("; ")}.`);
  const payload = {
    projectId: project.id,
    projectPath: project.path,
    rootId: previous?.rootId || null,
    revision: previous ? Number(previous.revision || 1) + 1 : 1,
    previousSpecId: previous?.id || null,
    name: text(input.name, 120),
    thesis: text(input.thesis, 4000),
    universe: text(input.universe, 1000),
    timeframe: text(input.timeframe, 200),
    signalDefinition: text(input.signalDefinition, 5000),
    entryRules: text(input.entryRules, 5000),
    exitRules: text(input.exitRules, 5000),
    positionSizing: text(input.positionSizing || "Fixed fractional risk; exact fraction must be set before paper trading.", 2000),
    constraints: array(input.constraints).map((item) => text(item, 500)).filter(Boolean).slice(0, 30),
    datasetIds: array(input.datasetIds).map((item) => text(item, 120)).filter(Boolean).slice(0, 20),
    costs: {
      commissionPerTradeUsd: Math.max(0, Number(input.costs?.commissionPerTradeUsd || 0)),
      slippageBps: Math.max(0, Number(input.costs?.slippageBps || 0)),
      spreadBps: Math.max(0, Number(input.costs?.spreadBps || 0)),
      borrowBpsAnnual: Math.max(0, Number(input.costs?.borrowBpsAnnual || 0))
    },
    evaluation: {
      splits: {
        train: { start: text(splits.train?.start, 40), end: text(splits.train?.end, 40) },
        validation: { start: text(splits.validation?.start, 40), end: text(splits.validation?.end, 40) },
        test: { start: text(splits.test?.start, 40), end: text(splits.test?.end, 40) }
      },
      embargoBars: Math.max(0, Math.floor(Number(evaluation.embargoBars || 0))),
      minTrades: Math.max(1, Math.floor(Number(evaluation.minTrades || 30))),
      primaryMetric: text(evaluation.primaryMetric || "sharpe", 80),
      benchmark: text(evaluation.benchmark || "buy-and-hold", 200),
      walkForwardRequired: evaluation.walkForwardRequired !== false
    },
    safety: {
      mode: "research-only",
      liveTrading: "disabled",
      orderPlacement: "disabled",
      mutation: "new-version-only"
    },
    changeNote: text(input.changeNote || (previous ? "New immutable revision." : "Initial immutable specification."), 500)
  };
  const createdAt = nowIso();
  const specId = id("strategy_spec");
  return {
    ...payload,
    id: specId,
    rootId: payload.rootId || specId,
    hash: digest(payload),
    createdAt
  };
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function verifyRegisteredDataset(dataset, projectRoot) {
  try {
    const filePath = await fs.realpath(path.resolve(projectRoot, dataset.relativePath));
    const relativeFromRoot = path.relative(projectRoot, filePath);
    if (relativeFromRoot === "" || relativeFromRoot === ".." || relativeFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFromRoot)) {
      return `${dataset.fileName}: path is no longer inside the project`;
    }
    const before = await fs.stat(filePath);
    if (!before.isFile()) return `${dataset.fileName}: path is no longer a file`;
    const sha256 = await hashFile(filePath);
    const after = await fs.stat(filePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) return `${dataset.fileName}: changed during verification`;
    if (sha256 !== dataset.sha256) return `${dataset.fileName}: checksum changed after registration`;
    return null;
  } catch {
    return `${dataset.fileName}: registered file is unavailable`;
  }
}

async function textFileProfile(filePath, extension) {
  if (![".csv", ".jsonl", ".ndjson", ".txt"].includes(extension)) {
    return { rowCount: null, columns: [], firstRecord: null, lastRecord: null };
  }
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const headSize = Math.min(stat.size, 256 * 1024);
    const head = Buffer.alloc(headSize);
    await handle.read(head, 0, headSize, 0);
    const tailSize = Math.min(stat.size, 128 * 1024);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, Math.max(0, stat.size - tailSize));
    const headLines = head.toString("utf8").split(/\r?\n/).filter(Boolean);
    const tailLines = tail.toString("utf8").split(/\r?\n/).filter(Boolean);
    let rowCount = 0;
    await new Promise((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => { for (const byte of chunk) if (byte === 10) rowCount += 1; });
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    if (stat.size > 0) {
      const lastByte = Buffer.alloc(1);
      await handle.read(lastByte, 0, 1, stat.size - 1);
      if (lastByte[0] !== 10) rowCount += 1;
    }
    const columns = extension === ".csv" ? (headLines[0] || "").split(",").map((item) => item.trim()).slice(0, 200) : [];
    return {
      rowCount: Math.max(0, rowCount - (extension === ".csv" ? 1 : 0)),
      columns,
      firstRecord: headLines[extension === ".csv" ? 1 : 0]?.slice(0, 1000) || null,
      lastRecord: tailLines.at(-1)?.slice(0, 1000) || null
    };
  } finally {
    await handle.close();
  }
}

function check(idValue, name, status, detail) {
  return { id: idValue, name, status, detail };
}

function metricNumber(metrics, name) {
  const raw = metrics?.[name];
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function reviewExperiment({ spec, datasets, input, priorExperiments, integrityIssues = [] }) {
  const checks = [];
  checks.push(check("immutable-spec", "Immutable specification", spec?.hash ? "pass" : "fail", spec?.hash ? `Pinned to ${spec.hash.slice(0, 12)}.` : "No immutable spec hash."));
  const requestedDatasetIds = array(input.datasetIds).length ? input.datasetIds : spec.datasetIds;
  const missingDatasets = requestedDatasetIds.filter((datasetId) => !datasets.some((item) => item.id === datasetId && item.projectId === spec.projectId));
  const provenanceFailures = [
    ...(missingDatasets.length ? [`Missing dataset records: ${missingDatasets.join(", ")}.`] : []),
    ...integrityIssues
  ];
  checks.push(check("data-provenance", "Dataset provenance", requestedDatasetIds.length && !provenanceFailures.length ? "pass" : "fail",
    !requestedDatasetIds.length ? "No registered dataset is attached." : provenanceFailures.join(" ") || "Every dataset checksum was re-verified for this experiment."));

  const splitIssues = chronologicalSplits(spec.evaluation?.splits);
  checks.push(check("chronological-splits", "Chronological train/validation/test split", splitIssues.length ? "fail" : "pass", splitIssues.join("; ") || "Splits are ordered and non-overlapping."));
  checks.push(check("embargo", "Leakage embargo", Number(spec.evaluation?.embargoBars || 0) > 0 ? "pass" : "warn", Number(spec.evaluation?.embargoBars || 0) > 0 ? `${spec.evaluation.embargoBars} bars.` : "No embargo bars are configured."));

  const costs = spec.costs || {};
  const hasCosts = Number(costs.slippageBps || 0) > 0 || Number(costs.spreadBps || 0) > 0 || Number(costs.commissionPerTradeUsd || 0) > 0;
  checks.push(check("cost-model", "Execution cost model", hasCosts ? "pass" : "warn", hasCosts ? "Commission, spread, or slippage is non-zero." : "All trading costs are zero; performance is likely optimistic."));

  const suspiciousFeatures = array(input.features).filter((feature) => {
    const name = text(feature?.name, 200).toLowerCase();
    return Number(feature?.lagBars || 0) < 0 || /(^|_)(target|label|future|forward)(_|$)/.test(name) || feature?.availableAt === "after-decision";
  });
  checks.push(check("feature-leakage", "Feature availability", suspiciousFeatures.length ? "fail" : "pass",
    suspiciousFeatures.length ? `Potential look-ahead features: ${suspiciousFeatures.map((item) => item.name).join(", ")}.` : "No declared feature uses a future lag, target label, or after-decision value."));

  const windows = array(input.walkForward?.windows);
  const windowIssues = [];
  let priorTestEnd = null;
  for (const [index, window] of windows.entries()) {
    const trainEnd = dateMs(window.trainEnd);
    const testStart = dateMs(window.testStart);
    const testEnd = dateMs(window.testEnd);
    if (trainEnd == null || testStart == null || testEnd == null || trainEnd >= testStart || testStart >= testEnd) {
      windowIssues.push(`window ${index + 1} has invalid chronology`);
    }
    if (priorTestEnd != null && testStart != null && testStart <= priorTestEnd) windowIssues.push(`window ${index + 1} overlaps the previous test window`);
    priorTestEnd = testEnd;
  }
  const walkForwardRequired = spec.evaluation?.walkForwardRequired !== false;
  const walkForwardStatus = windowIssues.length ? "fail" : (!walkForwardRequired || windows.length >= 3 ? "pass" : "warn");
  checks.push(check("walk-forward", "Walk-forward validation", walkForwardStatus,
    windowIssues.join("; ") || `${windows.length} chronological out-of-sample windows recorded${walkForwardRequired && windows.length < 3 ? "; at least 3 recommended" : ""}.`));

  const trades = metricNumber(input.metrics?.test, "trades");
  const minTrades = Number(spec.evaluation?.minTrades || 30);
  checks.push(check("sample-size", "Holdout sample size", trades != null && trades >= minTrades ? "pass" : "warn",
    trades == null ? "Test trade count was not reported." : `${trades} trades reported; minimum is ${minTrades}.`));

  const holdoutLabel = text(input.holdoutLabel || "primary-test", 120);
  const priorUses = priorExperiments.filter((experiment) => experiment.specRootId === spec.rootId && experiment.holdoutUsed && experiment.holdoutLabel === holdoutLabel).length;
  checks.push(check("holdout-reuse", "Holdout reuse", input.holdoutUsed && priorUses > 0 ? "warn" : "pass",
    input.holdoutUsed ? (priorUses ? `This holdout was already evaluated ${priorUses} time(s); treat it as validation, not untouched test data.` : "First recorded use of this holdout.") : "Holdout was not opened for this experiment."));

  const trainPrimary = metricNumber(input.metrics?.train, spec.evaluation?.primaryMetric);
  const testPrimary = metricNumber(input.metrics?.test, spec.evaluation?.primaryMetric);
  const degradation = trainPrimary != null && testPrimary != null && Math.abs(trainPrimary) > 0
    ? (trainPrimary - testPrimary) / Math.abs(trainPrimary)
    : null;
  checks.push(check("generalization", "Train-to-test generalization", degradation != null && degradation > 0.5 ? "warn" : "pass",
    degradation == null ? "Primary metric is not available on both train and test." : `${Math.round(degradation * 100)}% change from train to test.`));

  return {
    status: checks.some((item) => item.status === "fail") ? "failed" : checks.some((item) => item.status === "warn") ? "needs_review" : "passed",
    checks,
    holdoutLabel,
    priorHoldoutUses: priorUses
  };
}

export class StrategyLab {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.specsPath = path.join(dataDir, "strategy-specs.jsonl");
    this.datasetsPath = path.join(dataDir, "strategy-datasets.jsonl");
    this.experimentsPath = path.join(dataDir, "strategy-experiments.jsonl");
    this.writeQueue = Promise.resolve();
  }

  withWriteLock(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async listSpecs(projectId) {
    const rows = await readJsonl(this.specsPath);
    return rows.filter((item) => !projectId || item.projectId === projectId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async createSpec(input, project) {
    return this.withWriteLock(async () => {
      const spec = sanitizeSpec(input, project);
      await appendJsonl(this.specsPath, spec);
      return spec;
    });
  }

  async createSpecVersion(specId, input, project) {
    return this.withWriteLock(async () => {
      const specs = await this.listSpecs(project.id);
      const prior = specs.find((item) => item.id === specId);
      if (!prior) throw new Error(`Strategy specification not found: ${specId}`);
      const latest = specs.filter((item) => item.rootId === prior.rootId).sort((a, b) => Number(b.revision) - Number(a.revision))[0];
      if (latest?.id !== prior.id) throw new Error(`Revision ${prior.revision} is no longer current; create the new version from revision ${latest.revision}.`);
      const spec = sanitizeSpec({ ...prior, ...input }, project, prior);
      await appendJsonl(this.specsPath, spec);
      return spec;
    });
  }

  async listDatasets(projectId) {
    const rows = await readJsonl(this.datasetsPath);
    return rows.filter((item) => !projectId || item.projectId === projectId).sort((a, b) => String(b.inspectedAt).localeCompare(String(a.inspectedAt)));
  }

  async inspectDataset(input, project) {
    return this.withWriteLock(async () => {
      requireFields(input, ["relativePath", "source"], "Dataset registration");
      const requestedPath = text(input.relativePath, 1000).replaceAll("\\", "/");
      if (path.isAbsolute(requestedPath)) throw new Error("Dataset path must be relative to the selected project.");
      const projectRoot = await fs.realpath(project.path);
      const filePath = await fs.realpath(path.resolve(projectRoot, requestedPath)).catch(() => null);
      const relativeFromRoot = filePath ? path.relative(projectRoot, filePath) : null;
      if (!filePath || relativeFromRoot === "" || relativeFromRoot === ".." || relativeFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeFromRoot)) {
        throw new Error("Dataset is outside the selected project or does not identify a project file.");
      }
      const relativePath = relativeFromRoot.replaceAll("\\", "/");
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("Dataset path must identify a file.");
      const extension = path.extname(filePath).toLowerCase();
      const [sha256, profile] = await Promise.all([hashFile(filePath), textFileProfile(filePath, extension)]);
      const observedAfter = await fs.stat(filePath);
      if (observedAfter.size !== stat.size || observedAfter.mtimeMs !== stat.mtimeMs) {
        throw new Error("Dataset changed while it was being inspected; retry after the file is stable.");
      }
      const existing = (await this.listDatasets(project.id)).find((item) => item.sha256 === sha256 && item.relativePath === relativePath);
      if (existing) return { ...existing, duplicate: true };
      const dataset = {
      id: id("dataset"),
      projectId: project.id,
      projectPath: project.path,
      relativePath,
      fileName: path.basename(filePath),
      extension,
      bytes: stat.size,
      modifiedAtObserved: stat.mtime.toISOString(),
      sha256,
      source: text(input.source, 500),
      vendor: text(input.vendor, 200) || null,
      license: text(input.license, 500) || null,
      asOf: text(input.asOf, 80) || null,
      timeColumn: text(input.timeColumn, 120) || null,
      symbolColumn: text(input.symbolColumn, 120) || null,
      rowCount: profile.rowCount,
      columns: profile.columns,
      inspectedAt: nowIso(),
      immutable: true
      };
      await appendJsonl(this.datasetsPath, dataset);
      return dataset;
    });
  }

  async listExperiments(projectId) {
    const rows = await readJsonl(this.experimentsPath);
    return rows.filter((item) => !projectId || item.projectId === projectId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async recordExperiment(input, project) {
    return this.withWriteLock(async () => {
      requireFields(input, ["specId", "label"], "Experiment");
      const specs = await this.listSpecs(project.id);
      const spec = specs.find((item) => item.id === input.specId);
      if (!spec) throw new Error(`Strategy specification not found: ${input.specId}`);
      const datasets = await this.listDatasets(project.id);
      const priorExperiments = await this.listExperiments(project.id);
      const requestedDatasetIds = array(input.datasetIds).length ? input.datasetIds.slice(0, 20) : spec.datasetIds;
      const attachedDatasets = requestedDatasetIds.flatMap((datasetId) => {
        const dataset = datasets.find((item) => item.id === datasetId);
        return dataset ? [dataset] : [];
      });
      const projectRoot = await fs.realpath(project.path);
      const integrityIssues = (await Promise.all(attachedDatasets.map((dataset) => verifyRegisteredDataset(dataset, projectRoot)))).filter(Boolean);
      const review = reviewExperiment({ spec, datasets, input, priorExperiments, integrityIssues });
      const experiment = {
      id: id("experiment"),
      projectId: project.id,
      projectPath: project.path,
      specId: spec.id,
      specRootId: spec.rootId,
      specRevision: spec.revision,
      specHash: spec.hash,
      label: text(input.label, 160),
      datasetIds: requestedDatasetIds,
      datasetSnapshots: attachedDatasets.map((dataset) => ({
        id: dataset.id,
        relativePath: dataset.relativePath,
        sha256: dataset.sha256,
        modifiedAtObserved: dataset.modifiedAtObserved
      })),
      codeCommit: text(input.codeCommit, 120) || null,
      randomSeed: Number.isFinite(Number(input.randomSeed)) ? Number(input.randomSeed) : 42,
      features: array(input.features).slice(0, 300),
      metrics: input.metrics && typeof input.metrics === "object" ? input.metrics : {},
      walkForward: input.walkForward && typeof input.walkForward === "object" ? input.walkForward : { windows: [] },
      holdoutUsed: input.holdoutUsed === true,
      holdoutLabel: review.holdoutLabel,
      notes: text(input.notes, 4000) || null,
      review,
      immutable: true,
      createdAt: nowIso()
      };
      experiment.hash = digest(experiment);
      await appendJsonl(this.experimentsPath, experiment);
      return experiment;
    });
  }

  async compareExperiments(projectId, ids = []) {
    const experiments = await this.listExperiments(projectId);
    const selected = ids.length ? experiments.filter((item) => ids.includes(item.id)) : experiments.slice(0, 8);
    const specs = await this.listSpecs(projectId);
    return selected.map((experiment) => {
      const spec = specs.find((item) => item.id === experiment.specId);
      const primaryMetric = spec?.evaluation?.primaryMetric || "sharpe";
      return {
        id: experiment.id,
        label: experiment.label,
        specId: experiment.specId,
        specRevision: experiment.specRevision,
        status: experiment.review.status,
        primaryMetric,
        train: metricNumber(experiment.metrics?.train, primaryMetric),
        validation: metricNumber(experiment.metrics?.validation, primaryMetric),
        test: metricNumber(experiment.metrics?.test, primaryMetric),
        trades: metricNumber(experiment.metrics?.test, "trades"),
        warnings: experiment.review.checks.filter((item) => item.status !== "pass").map((item) => item.detail),
        createdAt: experiment.createdAt
      };
    });
  }
}

export const __test = { canonical, digest, chronologicalSplits, reviewExperiment };
