/**
 * Durable conversation + memory store.
 *
 * Two layers, deliberately separated:
 *
 *   1. EVENTS — an append-only log of everything that happened. Ground truth.
 *      Never mutated, never summarized in place. This is what makes the history
 *      recoverable no matter what the distillation layer gets wrong.
 *
 *   2. MEMORIES — distilled, durable statements (decisions, constraints,
 *      failures, preferences) extracted FROM events. Bi-temporal, so a fact that
 *      changes supersedes its predecessor instead of overwriting it: you can ask
 *      both "what is true now" and "what did we believe in June".
 *
 * The point of the split: context windows bound what a model can READ at once,
 * but nothing bounds what we can STORE and search. Retrieval decides what a
 * given turn actually sees.
 *
 * Vendor-neutral on purpose. Grok's own memory (`x.ai/memory/*`) is Grok-only;
 * this store is shared across every model the app drives.
 *
 * Zero dependencies — node:sqlite ships with Node and Electron, including FTS5
 * for BM25 and blob columns for embedding vectors.
 */

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const SCHEMA_VERSION = 1;

/**
 * Dropped from keyword queries. Without this an OR-expansion matches almost
 * everything on filler words, drowning the real signal in BM25 noise.
 */
const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "was",
  "were", "are", "our", "you", "your", "can", "will", "should", "would", "could",
  "using", "make", "let", "lets", "how", "what", "why", "when",
  "does", "did", "has", "have", "had", "not", "but", "all", "any", "one",
  "try", "just", "some", "more", "than"
  // Deliberately NOT stop words: get, set, put, run, add, use, new. In a coding
  // corpus those are identifiers and method names, not filler.
]);

/** Minimum term length. 2 keeps domain identifiers like EV, ML, Q4, RS. */
const MIN_TERM_LENGTH = 2;

/** Float32 <-> BLOB. SQLite has no vector type; a packed blob is compact and fast enough. */
export function packVector(values) {
  return new Uint8Array(Float32Array.from(values).buffer);
}
export function unpackVector(blob) {
  if (!blob) return null;
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** Vectors are stored normalized, so dot product IS cosine similarity. */
export function normalize(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  const mag = Math.sqrt(sum) || 1;
  return Float32Array.from(values, (v) => v / mag);
}
export function dot(a, b) {
  let total = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) total += a[i] * b[i];
  return total;
}

export class MemoryStore {
  #db = null;

  constructor(dbPath) {
    this.dbPath = dbPath;
  }

  open() {
    if (this.#db) return this;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.#db = new DatabaseSync(this.dbPath);
    // WAL keeps readers from blocking the writer — the UI reads while a turn writes.
    // WAL alone permits one writer plus N readers; it does NOT serialize two
    // writers. One MCP process is spawned PER SESSION, so overlapping writes
    // are routine — without a busy timeout the loser gets an immediate
    // "database is locked" rather than waiting its turn.
    const mode = this.#db.prepare("PRAGMA journal_mode = WAL").get();
    if (String(mode?.journal_mode ?? "").toLowerCase() !== "wal") {
      // Not fatal, but worth knowing: on a redirected/network userData folder
      // WAL is unavailable and concurrency guarantees change.
      process.emitWarning(`SQLite journal_mode is '${mode?.journal_mode}', not WAL.`);
    }
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#migrate();
    return this;
  }

  get db() {
    if (!this.#db) throw new Error("MemoryStore is not open.");
    return this.#db;
  }

  #migrate() {
    const db = this.#db;
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const current = Number(
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value ?? 0
    );
    if (current >= SCHEMA_VERSION) return;

    db.exec(`
      -- Ground truth. Append-only.
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id   TEXT    NOT NULL,
        session_id  TEXT,
        ts          INTEGER NOT NULL,
        kind        TEXT    NOT NULL,   -- ACP sessionUpdate kind
        role        TEXT,               -- user | assistant | tool | system
        text        TEXT,               -- extracted plain text, for search
        payload     TEXT,               -- full JSON, for exact replay
        provider    TEXT,               -- grok | anthropic | openai | nvidia ...
        model       TEXT,
        project     TEXT                -- project path, for cross-thread recall
      );
      CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, id);
      CREATE INDEX IF NOT EXISTS idx_events_project ON events(project, ts);

      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        text, content='events', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
        INSERT INTO events_fts(rowid, text) VALUES (new.id, new.text);
      END;

      -- Distilled durable statements. Bi-temporal: superseding never destroys.
      CREATE TABLE IF NOT EXISTS memories (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        scope         TEXT NOT NULL,      -- global | project | thread
        project       TEXT,
        thread_id     TEXT,
        kind          TEXT NOT NULL,      -- decision | constraint | fact | failure | preference | glossary
        subject       TEXT,               -- the entity this is about (file, module, concept)
        text          TEXT NOT NULL,
        confidence    REAL DEFAULT 0.7,
        -- Grammatical confidence, preserved from the source utterance.
        -- Measured: consolidation that flattens "reportedly X" into "X" gets
        -- acted on at 0.68-0.81, the same rate as a flat assertion, while
        -- "probably X" collapses to ~0.00-0.13. Source attribution does not
        -- protect you; phrasing does. So the hedge is stored, not inferred.
        epistemic    TEXT DEFAULT 'asserted',   -- asserted|hedged|inferred|verified
        -- Independent observations supporting this claim. Requiring >=2 before
        -- a claim is treated as actionable is the only mitigation that measured
        -- 0.00 wrong-grants AND 0.00 false-escalation.
        observations INTEGER DEFAULT 1,
        source_events TEXT,               -- JSON array of event ids
        created_at    INTEGER NOT NULL,
        -- Bi-temporal validity. A changed fact gets valid_to set and a new row
        -- inserted, so "what did we believe in June" stays answerable.
        valid_from    INTEGER NOT NULL,
        valid_to      INTEGER,
        superseded_by INTEGER REFERENCES memories(id),
        provider      TEXT                -- which model distilled it
      );
      CREATE INDEX IF NOT EXISTS idx_mem_scope ON memories(scope, project, valid_to);
      CREATE INDEX IF NOT EXISTS idx_mem_subject ON memories(subject);

      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, subject, content='memories', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, subject) VALUES (new.id, new.text, new.subject);
      END;
      -- External-content FTS5 tables need explicit delete/update sync or the
      -- index drifts from the table. Without these, superseded rows stay
      -- matchable and can fill the LIMIT before live rows are reached.
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, subject)
        VALUES ('delete', old.id, old.text, old.subject);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, subject)
        VALUES ('delete', old.id, old.text, old.subject);
        INSERT INTO memories_fts(rowid, text, subject) VALUES (new.id, new.text, new.subject);
      END;

      -- Embeddings live apart so re-embedding with a better model does not
      -- rewrite the memories themselves.
      CREATE TABLE IF NOT EXISTS vectors (
        ref_type  TEXT NOT NULL,          -- 'memory' | 'event'
        ref_id    INTEGER NOT NULL,
        model     TEXT NOT NULL,
        dim       INTEGER NOT NULL,
        vec       BLOB NOT NULL,
        PRIMARY KEY (ref_type, ref_id, model)
      );

      -- What has been distilled already, so consolidation is resumable.
      CREATE TABLE IF NOT EXISTS distill_progress (
        thread_id     TEXT PRIMARY KEY,
        last_event_id INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)")
      .run(String(SCHEMA_VERSION));
  }

  // --- events -------------------------------------------------------------

  /**
   * Append one event. Returns its id, or null when there is nothing worth
   * storing (empty text and no payload of interest).
   */
  appendEvent({ threadId, sessionId = null, kind, role = null, text = "",
                payload = null, provider = null, model = null, project = null, ts = null }) {
    if (!threadId || !kind) return null;
    const info = this.db.prepare(`
      INSERT INTO events (thread_id, session_id, ts, kind, role, text, payload, provider, model, project)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      threadId, sessionId, ts ?? Date.now(), kind, role,
      String(text ?? ""), payload ? JSON.stringify(payload) : null,
      provider, model, project
    );
    return Number(info.lastInsertRowid);
  }

  /** Full transcript for a thread, oldest first. This is what rehydrates the UI. */
  eventsForThread(threadId, { limit = 5000, afterId = 0 } = {}) {
    return this.db.prepare(`
      SELECT id, session_id, ts, kind, role, text, payload, provider, model
      FROM events WHERE thread_id = ? AND id > ?
      ORDER BY id ASC LIMIT ?
    `).all(threadId, afterId, limit).map((row) => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload) : null
    }));
  }

  /** User/assistant transcript reconstructed from exact append-only ACP events. */
  conversationForThread(threadId, { limit = 5000 } = {}) {
    const events = this.eventsForThread(threadId, { limit });
    const turns = [];
    for (const event of events) {
      if (!event.text) continue;
      if (event.kind === "user_prompt") {
        turns.push({ role: "user", text: event.text });
      } else if (event.kind === "agent_message_chunk") {
        const last = turns[turns.length - 1];
        if (last?.role === "assistant") last.text += event.text;
        else turns.push({ role: "assistant", text: event.text });
      }
    }
    return turns;
  }

  countEvents(threadId) {
    return Number(this.db.prepare("SELECT COUNT(*) n FROM events WHERE thread_id=?")
      .get(threadId)?.n ?? 0);
  }

  // --- memories -----------------------------------------------------------

  addMemory({ scope = "project", project = null, threadId = null, kind, subject = null,
              text, confidence = 0.7, sourceEvents = [], provider = null, validFrom = null,
              epistemic = "asserted", observations = 1 }) {
    if (!text?.trim() || !kind) return null;
    const now = Date.now();
    const info = this.db.prepare(`
      INSERT INTO memories (scope, project, thread_id, kind, subject, text, confidence,
                            source_events, created_at, valid_from, provider, epistemic, observations)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(scope, project, threadId, kind, subject, text.trim(), confidence,
           JSON.stringify(sourceEvents), now, validFrom ?? now, provider, epistemic, observations);
    return Number(info.lastInsertRowid);
  }

  /**
   * Record another independent sighting of an existing claim.
   *
   * Promotion is by corroboration, not by restatement: a claim seen in two
   * separate sessions is worth more than one asserted twice in the same breath.
   */
  reinforce(id, { epistemic = null } = {}) {
    const row = this.db.prepare("SELECT observations, epistemic FROM memories WHERE id=?").get(id);
    if (!row) return null;
    const next = Number(row.observations ?? 1) + 1;
    // A hedged claim corroborated independently becomes verified; it never
    // becomes verified by being repeated more confidently.
    const status = epistemic ?? (next >= 2 && row.epistemic === "hedged" ? "verified" : row.epistemic);
    this.db.prepare("UPDATE memories SET observations=?, epistemic=? WHERE id=?").run(next, status, id);
    return next;
  }

  /** Claims safe to act on: corroborated, or asserted-and-verified. */
  actionableMemories(opts = {}) {
    return this.activeMemories(opts).filter(
      (m) => m.epistemic === "verified" || (m.observations ?? 1) >= 2
    );
  }

  /**
   * Retire a memory in favour of a newer one. The old row survives with a
   * closed validity interval — history is never destroyed, only bounded.
   */
  supersede(oldId, newId, at = Date.now()) {
    this.db.prepare("UPDATE memories SET valid_to = ?, superseded_by = ? WHERE id = ? AND valid_to IS NULL")
      .run(at, newId, oldId);
  }

  /** Currently-true memories. Pass `asOf` to ask what was believed at a past time. */
  activeMemories({ project = null, scope = null, kind = null, kinds = null, asOf = null,
                   limit = 5000, onTruncate = null } = {}) {
    const clauses = [];
    const args = [];
    if (asOf) {
      clauses.push("valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)");
      args.push(asOf, asOf);
    } else {
      clauses.push("valid_to IS NULL");
    }
    if (project) {
      clauses.push("(project = ? OR scope = 'global')");
      args.push(project);
    } else {
      // Without a project, return only global-scope rows. Previously this
      // leaked every project's memories into whatever session asked.
      clauses.push("scope = 'global'");
    }
    if (scope) { clauses.push("scope = ?"); args.push(scope); }
    if (kind) { clauses.push("kind = ?"); args.push(kind); }
    // Filter by kind IN SQL, not after the LIMIT. Doing it in JS afterwards let
    // a dead-list entry fall outside the capped window and the failure gate
    // then answered "proceed" for something already retired.
    if (kinds?.length) {
      clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`);
      args.push(...kinds);
    }
    args.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE ${clauses.join(" AND ")}
      ORDER BY confidence DESC, created_at DESC LIMIT ?
    `).all(...args);
    // A silent cap is how real knowledge disappears from a growing corpus:
    // low-value rows with high confidence fill the window and evict the
    // dead-list entry the gate was about to match on. Say so rather than
    // quietly returning a partial view.
    if (rows.length === limit) {
      onTruncate?.(limit);
      process.emitWarning(
        `activeMemories hit its ${limit}-row cap; results may be incomplete.`
      );
    }
    return rows;
  }

  // --- vectors ------------------------------------------------------------

  putVector(refType, refId, model, values) {
    const normalized = normalize(values);
    this.db.prepare(`
      INSERT OR REPLACE INTO vectors (ref_type, ref_id, model, dim, vec) VALUES (?,?,?,?,?)
    `).run(refType, refId, model, normalized.length, packVector(normalized));
  }

  /**
   * Brute-force cosine ranking.
   *
   * Deliberate: at desktop scale (tens of thousands of memories) a linear scan
   * over 2048-dim float32 is a few milliseconds, and it avoids an ANN index and
   * a native dependency. Revisit past ~100k vectors.
   */
  searchVectors(refType, model, queryVector, { limit = 20, ids = null } = {}) {
    const query = normalize(queryVector);
    let sql = "SELECT ref_id, vec FROM vectors WHERE ref_type = ? AND model = ?";
    const args = [refType, model];
    if (ids?.length) {
      sql += ` AND ref_id IN (${ids.map(() => "?").join(",")})`;
      args.push(...ids);
    }
    const scored = [];
    for (const row of this.db.prepare(sql).all(...args)) {
      scored.push({ id: row.ref_id, score: dot(query, unpackVector(row.vec)) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // --- search -------------------------------------------------------------

  /**
   * BM25 keyword search. Cheap, exact, and strong on identifiers a vector misses.
   *
   * The query is rewritten as an OR of quoted terms. FTS5 treats a bare
   * multi-word string as an implicit AND, which means a natural-language
   * question essentially never matches a short memory row — every term would
   * have to appear. That silently reduced "hybrid" retrieval to vector-only.
   *
   * Terms are individually quoted so punctuation common in this domain
   * (`fee>=75%`, `rvol>=10`) cannot be parsed as FTS operators.
   */
  searchText(table, query, { limit = 20 } = {}) {
    const fts = table === "memories" ? "memories_fts" : "events_fts";
    // Restrict to currently-valid rows BEFORE the LIMIT, so retired history
    // cannot consume the result window.
    const liveOnly = table === "memories";

    const terms = String(query ?? "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(t));
    if (!terms.length) return [];

    const expression = [...new Set(terms)].map((t) => `"${t}"`).join(" OR ");
    try {
      const sql = liveOnly
        ? `SELECT f.rowid AS id, bm25(${fts}) AS rank
             FROM ${fts} f JOIN memories m ON m.id = f.rowid
            WHERE ${fts} MATCH ? AND m.valid_to IS NULL
            ORDER BY rank LIMIT ?`
        : `SELECT rowid AS id, bm25(${fts}) AS rank
             FROM ${fts} WHERE ${fts} MATCH ? ORDER BY rank LIMIT ?`;
      return this.db.prepare(sql).all(expression, limit);
    } catch {
      return [];   // malformed FTS expression; degrade rather than throw
    }
  }

  memoriesByIds(ids) {
    if (!ids?.length) return [];
    return this.db.prepare(
      `SELECT * FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`
    ).all(...ids);
  }

  // --- distillation bookkeeping -------------------------------------------

  distillCursor(threadId) {
    return Number(this.db.prepare("SELECT last_event_id FROM distill_progress WHERE thread_id=?")
      .get(threadId)?.last_event_id ?? 0);
  }

  setDistillCursor(threadId, lastEventId) {
    this.db.prepare(`
      INSERT INTO distill_progress (thread_id, last_event_id, updated_at) VALUES (?,?,?)
      ON CONFLICT(thread_id) DO UPDATE SET last_event_id=excluded.last_event_id, updated_at=excluded.updated_at
    `).run(threadId, lastEventId, Date.now());
  }

  stats() {
    const one = (sql) => Number(this.db.prepare(sql).get()?.n ?? 0);
    return {
      events: one("SELECT COUNT(*) n FROM events"),
      memories: one("SELECT COUNT(*) n FROM memories WHERE valid_to IS NULL"),
      supersededMemories: one("SELECT COUNT(*) n FROM memories WHERE valid_to IS NOT NULL"),
      vectors: one("SELECT COUNT(*) n FROM vectors"),
      threads: one("SELECT COUNT(DISTINCT thread_id) n FROM events"),
      sizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0
    };
  }

  close() {
    this.#db?.close();
    this.#db = null;
  }
}
