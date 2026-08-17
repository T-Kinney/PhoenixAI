/**
 * Strategy playbook: the human-readable projection of project knowledge.
 *
 * The memory store is queryable and bi-temporal; a playbook file is readable,
 * diffable, git-friendly, and editable by hand. Neither replaces the other, so
 * this module keeps them in sync in both directions:
 *
 *   parsePlaybook()  file -> entries   (import what already exists; never lose it)
 *   renderPlaybook() entries -> file   (regenerate after distillation)
 *
 * The format is not invented here. It is Ted's, taken from
 * `C:\dev\ATLAS Equities\STRATEGY_PLAYBOOK.md`, because it already encodes the
 * things that matter and most knowledge bases omit:
 *
 *   - a STATUS on every claim (PROVEN / MEASURED / THEORY / DEAD ...), so a
 *     hunch is never mistaken for a result;
 *   - RECEIPTS, so every claim carries its evidence trail;
 *   - a DEAD LIST — "never resurrect, never relearn" — which is the only
 *     mechanism that actually prevents rework;
 *   - explicit anti-merge directives, because collapsing two distinct findings
 *     into one average destroys both.
 *
 * Negative knowledge is first-class. "We tried X, it failed because Y" is more
 * expensive to rediscover than a success is to repeat.
 */

/** Status vocabulary, strongest evidence first. DEAD is terminal. */
export const STATUSES = [
  "PROVEN",        // holds up live, in production
  "LIVE",          // deployed, accumulating evidence
  "LIVE-TESTING",  // deployed behind a gate, under evaluation
  "MEASURED",      // quantified offline, not yet live
  "STUDY RUNNING", // investigation in flight
  "MIXED",         // partially supported, partially contradicted
  "THEORY",        // plausible, unmeasured
  "DEAD"           // disproven or abandoned — never resurrect
];

const SECTION_KEYS = ["FINGERPRINT", "ENTRY", "EXIT", "RULE", "EVIDENCE", "WHY", "RECEIPTS", "NEVER MERGE"];

/** Split a heading like "1. CRUSH_LOW (dip-reversal) — PROVEN, LIVE". */
function parseHeading(line) {
  const raw = line.replace(/^#+\s*/, "").trim();
  // The status sits after an em/en dash near the end.
  // lastIndexOf(" - ") points at the SPACE, so slicing at dash+1 kept the
  // hyphen in the status and re-appended a dash to the title each round-trip.
  const hyphen = raw.lastIndexOf(" - ");
  const dash = Math.max(raw.lastIndexOf("—"), raw.lastIndexOf("–"), hyphen === -1 ? -1 : hyphen + 1);
  let title = raw;
  let status = null;
  if (dash > 0) {
    const tail = raw.slice(dash + 1).trim();
    const upper = tail.toUpperCase();
    if (STATUSES.some((s) => upper.includes(s))) {
      status = tail;
      title = raw.slice(0, dash).trim();
    }
  }
  // Handles "1.", "3a.", and sub-numbers like "4.1".
  const numbered = title.match(/^([0-9]+(?:\.[0-9]+)*[a-z]?)\.?\s+(.*)$/i);
  return {
    ordinal: numbered ? numbered[1] : null,
    title: numbered ? numbered[2].trim() : title,
    status
  };
}

/** Pull "KEY: value" blocks out of an entry body, keeping the rest as prose. */
function parseBody(body) {
  const fields = {};
  const prose = [];
  let currentKey = null;
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z ._/-]{2,20}):\s*(.*)$/);
    if (match && SECTION_KEYS.includes(match[1].trim())) {
      currentKey = match[1].trim();
      fields[currentKey] = match[2].trim();
      continue;
    }
    if (currentKey && line.trim() && !line.startsWith("#")) {
      fields[currentKey] += ` ${line.trim()}`;
      continue;
    }
    if (line.trim()) prose.push(line.trim());
    if (!line.trim()) currentKey = null;
  }
  return { fields, prose: prose.join("\n") };
}

/**
 * Parse an existing playbook into structured entries.
 *
 * Written to be forgiving: a hand-maintained file drifts, and refusing to read
 * it because a heading is malformed would defeat the point.
 */
export function parsePlaybook(markdown) {
  const text = String(markdown ?? "");
  const lines = text.split(/\r?\n/);
  const entries = [];
  const deadList = [];

  let current = null;
  let buffer = [];

  const flush = () => {
    if (!current) return;
    const { fields, prose } = parseBody(buffer.join("\n"));
    entries.push({ ...current, ...{ fields, body: prose } });
    current = null;
    buffer = [];
  };

  for (const line of lines) {
    if (/^#{2,3}\s/.test(line)) {
      flush();
      const heading = parseHeading(line);
      // The DEAD LIST is a single section of comma/semicolon-separated items
      // rather than one entry per idea.
      if (/dead list/i.test(heading.title)) {
        current = { ...heading, isDeadList: true };
      } else if (/^index$/i.test(heading.title.trim())) {
        // Our own renderer emits an "## Index" section; re-parsing it would
        // create a phantom entry containing the entire index.
        current = null;
        buffer = [];
        continue;
      } else {
        current = { ...heading, isDeadList: false };
      }
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();

  // Explode the DEAD LIST into individual "never relearn" items.
  for (const entry of entries.filter((e) => e.isDeadList)) {
    for (const item of entry.body.split(/[;\n]+/)) {
      const clean = item.replace(/^[-*\s]+/, "").trim().replace(/\.$/, "");
      if (clean.length > 2) deadList.push(clean);
    }
  }

  // Doctrine and meta sections are not strategy claims. Labelling them THEORY
  // would imply they are unproven hypotheses awaiting evidence, which misreads
  // the document.
  const DOCTRINE = /^(axiom|outstanding|.*'s (trading )?mechanism|.*doctrine)/i;
  for (const entry of entries) {
    if (!entry.status && DOCTRINE.test(entry.title)) entry.kindHint = "doctrine";
  }

  return {
    entries: entries.filter((e) => !e.isDeadList),
    deadList
  };
}

/** Order entries by evidence strength, then by their original numbering. */
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    const rank = (e) => {
      const upper = String(e.status ?? "THEORY").toUpperCase();
      const index = STATUSES.findIndex((s) => upper.includes(s));
      return index === -1 ? STATUSES.length : index;
    };
    const diff = rank(a) - rank(b);
    if (diff !== 0) return diff;
    return String(a.ordinal ?? "").localeCompare(String(b.ordinal ?? ""), undefined, { numeric: true });
  });
}

/**
 * Render entries back to markdown in the same shape.
 *
 * Regenerated wholesale rather than patched, so the file cannot drift from the
 * store. Anything a human writes by hand is imported on the next parse, which
 * is why parse and render are symmetric.
 */
export function renderPlaybook({ project, entries = [], deadList = [], outstanding = [], generatedAt = null }) {
  const stamp = generatedAt ?? new Date().toISOString().slice(0, 10);
  const out = [];

  out.push(`# STRATEGY STATE — ${project}`);
  out.push("");
  out.push(`_Generated ${stamp}. Structured source: the project memory store._`);
  out.push("");
  out.push("Every claim carries a STATUS and RECEIPTS. A claim without receipts is a");
  out.push("THEORY no matter how confident it sounds. Nothing is deleted — disproven");
  out.push("work moves to the DEAD LIST so it is never relearned.");
  out.push("");

  const byStatus = new Map();
  for (const entry of sortEntries(entries)) {
    const key = String(entry.status ?? "THEORY").toUpperCase().split(",")[0].trim();
    if (!byStatus.has(key)) byStatus.set(key, []);
    byStatus.get(key).push(entry);
  }

  out.push("## Index");
  out.push("");
  for (const [status, group] of byStatus) {
    out.push(`- **${status}** (${group.length}): ${group.map((e) => e.title).join(" · ")}`);
  }
  out.push("");

  let n = 0;
  for (const entry of sortEntries(entries)) {
    n += 1;
    out.push(`## ${n}. ${entry.title}${entry.status ? ` — ${entry.status}` : ""}`);
    out.push("");
    for (const key of SECTION_KEYS) {
      const value = entry.fields?.[key];
      if (value) out.push(`${key}: ${value}`);
    }
    if (entry.body?.trim()) {
      out.push("");
      out.push(entry.body.trim());
    }
    // Receipts arrive as fields.RECEIPTS from the parser and as an array from
    // distillation; emit whichever is present, without duplicating.
    if (!entry.fields?.RECEIPTS && entry.receipts?.length) {
      out.push(`RECEIPTS: ${entry.receipts.join("; ")}`);
    }
    out.push("");
  }

  out.push("## DEAD LIST (never resurrect, never relearn)");
  out.push("");
  if (deadList.length) {
    // Kept as prose rather than bullets to match the original density.
    out.push(deadList.join("; ") + ".");
  } else {
    out.push("_Nothing retired yet._");
  }
  out.push("");

  if (outstanding.length) {
    out.push("## OUTSTANDING — what must be solved");
    out.push("");
    outstanding.forEach((item, i) => out.push(`${i + 1}. ${item}`));
    out.push("");
  }

  return out.join("\n");
}

/**
 * Convert parsed entries into memory-store rows.
 *
 * `subject` is the strategy name so later findings about the same thing can
 * supersede earlier ones instead of piling up as duplicates.
 */
export function entriesToMemories(parsed, { project }) {
  const memories = [];

  for (const entry of parsed.entries) {
    const status = String(entry.status ?? (entry.kindHint === "doctrine" ? "DOCTRINE" : "THEORY")).toUpperCase();
    const kind = entry.kindHint === "doctrine" ? "doctrine"
      : status.includes("DEAD") ? "failure"
      : status.includes("THEORY") ? "theory"
      : status.includes("PROVEN") || status.includes("LIVE") ? "strategy"
      : "finding";

    const detail = [
      entry.fields?.FINGERPRINT && `FINGERPRINT: ${entry.fields.FINGERPRINT}`,
      entry.fields?.ENTRY && `ENTRY: ${entry.fields.ENTRY}`,
      entry.fields?.EXIT && `EXIT: ${entry.fields.EXIT}`,
      entry.fields?.RULE && `RULE: ${entry.fields.RULE}`,
      entry.body
    ].filter(Boolean).join("\n");

    memories.push({
      scope: "project",
      project,
      kind,
      subject: entry.title,
      text: `[${status}] ${entry.title}\n${detail}`.trim(),
      // Status IS the confidence signal — a claim's strength should never be
      // inferred from how assertively it was written.
      // Confidence is "how sure are we this is TRUE", not "rank me first".
      // DEAD previously sat at 0.99 — above PROVEN — which meant an imported
      // playbook filled the top of every confidence-ordered window with retired
      // entries and evicted the live strategies.
      confidence: status.includes("DEAD") ? 0.9
        : status.includes("PROVEN") ? 0.95
        : status.includes("MEASURED") ? 0.8
        : status.includes("LIVE") ? 0.75
        : status.includes("MIXED") ? 0.5
        : 0.4,
      // B16: imported entries carried no epistemic/observations, so
      // actionableMemories() returned nothing at all from a playbook. A
      // PROVEN/MEASURED entry in a hand-maintained playbook IS corroborated
      // evidence; a THEORY is explicitly not.
      epistemic: status.includes("PROVEN") || status.includes("MEASURED") || status.includes("DEAD")
        ? "verified"
        : status.includes("THEORY") ? "hedged" : "asserted",
      observations: status.includes("PROVEN") || status.includes("MEASURED") || status.includes("DEAD") ? 2 : 1,
      receipts: entry.fields?.RECEIPTS ? [entry.fields.RECEIPTS] : []
    });
  }

  // Each dead-list item is its own memory so retrieval can surface exactly the
  // one that matches a proposal about to be re-attempted.
  for (const item of parsed.deadList) {
    memories.push({
      scope: "project",
      project,
      kind: "failure",
      subject: item.slice(0, 60),
      text: `[DEAD — never resurrect] ${item}`,
      confidence: 0.99,
      receipts: []
    });
  }

  return memories;
}
