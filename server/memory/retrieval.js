/**
 * Hybrid retrieval: BM25 (FTS5) + dense vectors, fused with RRF.
 *
 * Every constant here comes from a measurement, not intuition. The numbers and
 * why they were chosen:
 *
 *  - RRF over weighted score fusion. RRF ignores raw scores entirely, so
 *    FTS5's BM25 (negative, unbounded) never has to be reconciled with cosine
 *    similarity, and swapping embedding models cannot silently shift the
 *    balance. Tuned weighted fusion was measured to buy roughly one point of
 *    recall while requiring corpus-specific normalization — not worth it here.
 *
 *  - k = 60. The original RRF value; the optimum is flat across k in [20,100].
 *    At 60, rank 1 contributes 1/61 and rank 100 contributes 1/160 — only a
 *    2.6x spread, so the formula rewards appearing in BOTH lists over topping
 *    one. That is the right bias when lexical and semantic signals disagree,
 *    which on conversational text is often.
 *
 *  - 50 candidates per arm -> fuse -> 20 -> inject 3-5.
 *
 *  - Results are ordered by RELEVANCE, NOT CHRONOLOGY. Across 18 models,
 *    shuffled haystacks outperformed coherent ones, and accuracy is highest
 *    when the target sits near the beginning. Chronology belongs in metadata.
 *
 *  - Hard cap on injected tokens, not just result count. The same content
 *    retrieved down to a focused set beats the full context on the same model;
 *    more retrieved is not more useful, and individual near-miss distractors
 *    cause disproportionate damage.
 *
 *  - Metadata pre-filtering before the query. Scaling a corpus without scoping
 *    dropped accuracy from 75% to under 40%; domain scoping recovered it. This
 *    is the largest single effect in the retrieval literature and it costs
 *    nothing.
 */

const RRF_K = 60;
const PER_ARM = 50;
const FUSED = 20;
const DEFAULT_INJECT = 5;
const DEFAULT_TOKEN_BUDGET = 2000;

/** Rough token estimate. Good enough for a budget guard. */
const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

/**
 * Distinctive terms, for measuring overlap in the degraded (keyword-only) path.
 * Deliberately keeps short identifiers like EV, ML, Q4 — dropping them would
 * blind the gate to exactly the domain terms that matter here.
 */
const OVERLAP_STOP = new Set([
  "the","and","for","with","that","this","from","into","was","are","our","you",
  "can","will","should","would","could","add","use","make","let","how","what",
  "why","when","does","did","has","have","not","but","all","any","one","new",
  "get","set","put","run","try","just","some","more","than","lets","write"
]);
function termsOf(text) {
  return [...new Set(
    String(text ?? "").toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length >= 2 && !OVERLAP_STOP.has(t))
  )];
}

/**
 * Reciprocal Rank Fusion.
 * score(d) = sum over lists of 1 / (k + rank(d))
 */
export function fuseRRF(rankedLists, { k = RRF_K, limit = FUSED } = {}) {
  const scores = new Map();
  for (const list of rankedLists) {
    list.forEach((item, index) => {
      const id = item.id ?? item;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export class Retriever {
  /**
   * @param {object} opts
   * @param {import("./store.js").MemoryStore} opts.store
   * @param {(texts: string[]) => Promise<number[][]>} [opts.embed]  optional embedder
   * @param {string} [opts.embedModel]
   */
  constructor({ store, embed = null, embedModel = "nvidia/nemotron-3-embed-1b" }) {
    this.store = store;
    this.embed = embed;
    this.embedModel = embedModel;
  }

  /**
   * Retrieve memories for a query.
   *
   * Pre-filters by project/scope BEFORE searching, then fuses BM25 and vector
   * arms. Degrades to keyword-only when no embedder is configured, which keeps
   * the whole layer usable with zero network calls.
   */
  async recall(query, {
    project = null,
    kinds = null,
    inject = DEFAULT_INJECT,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
    actionableOnly = false,
    asOf = null
  } = {}) {
    // 1. Scope the candidate pool first — the largest measured effect.
    const pool = actionableOnly
      ? this.store.actionableMemories({ project, asOf, kinds })
      : this.store.activeMemories({ project, asOf, kinds });
    const allowed = pool;
    if (!allowed.length) return { memories: [], usedTokens: 0, arms: {} };

    const allowedIds = new Set(allowed.map((m) => m.id));

    // 2. Keyword arm.
    const keyword = this.store.searchText("memories", query, { limit: PER_ARM })
      .filter((row) => allowedIds.has(row.id));

    // 3. Vector arm, when an embedder is available.
    let vector = [];
    const similarity = new Map();
    if (this.embed) {
      try {
        const [queryVector] = await this.embed([query]);
        if (queryVector?.length) {
          vector = this.store.searchVectors("memory", this.embedModel, queryVector, {
            limit: PER_ARM,
            ids: [...allowedIds]
          });
          // Keep the raw cosine alongside the rank. RRF deliberately discards
          // scores, which is right for ranking and WRONG for any gate that has
          // to decide "is this related at all".
          for (const hit of vector) similarity.set(hit.id, hit.score);
        }
      } catch {
        // A dead embedding endpoint degrades to keyword-only rather than
        // failing the turn. Memory is an enhancement, never a dependency.
        vector = [];
      }
    }

    // 4. Fuse.
    const fused = fuseRRF([keyword, vector].filter((l) => l.length));
    const byId = new Map(allowed.map((m) => [m.id, m]));

    // 5. Inject under a token budget, most relevant FIRST.
    const chosen = [];
    let usedTokens = 0;
    for (const hit of fused) {
      if (chosen.length >= inject) break;
      const memory = byId.get(hit.id);
      if (!memory) continue;
      const cost = estimateTokens(memory.text);
      if (usedTokens + cost > tokenBudget) continue;
      chosen.push({ ...memory, score: hit.score, similarity: similarity.get(hit.id) ?? null });
      usedTokens += cost;
    }

    return {
      memories: chosen,
      usedTokens,
      arms: { keyword: keyword.length, vector: vector.length, fused: fused.length }
    };
  }

  /**
   * Format recalled memories for injection.
   *
   * Every line carries its status and epistemic marker so the model can weigh
   * a corroborated result differently from a hunch — which is the entire point
   * of storing the hedge rather than flattening it.
   */
  format(memories) {
    if (!memories.length) return "";
    const lines = ["## Project memory (most relevant first)", ""];
    for (const m of memories) {
      const marks = [];
      if (m.epistemic && m.epistemic !== "asserted") marks.push(m.epistemic);
      if ((m.observations ?? 1) >= 2) marks.push(`${m.observations}x observed`);
      if (m.kind === "failure") marks.push("DO NOT RETRY");
      const suffix = marks.length ? `  [${marks.join(", ")}]` : "";
      lines.push(`- (${m.kind}) ${m.text}${suffix}`);
    }
    return lines.join("\n");
  }

  /**
   * Check a proposed action against known failures BEFORE it is attempted.
   *
   * This is the anti-rework path and it is deliberately separate from recall():
   * remembering is not the same as complying, and a system that merely *has*
   * the knowledge still violates it most of the time. Surfacing dead-list hits
   * as an explicit gate is what turns memory into prevention.
   */
  async checkAgainstFailures(proposal, {
    project = null,
    limit = 3,
    // Absolute cosine floor. RRF returns the top-N of whatever exists, so
    // without a threshold this gate fires on EVERY proposal — including ones
    // unrelated to anything retired. A warning that always fires gets trained
    // away within a day, which is worse than no warning at all.
    // Tuned empirically against the real ATLAS dead list, not guessed:
    //   true positives  0.712, 0.573, 0.451
    //   true negatives  0.170, 0.159, 0.115
    // A 2.6x gap separates them, so 0.40 sits comfortably inside it. Small
    // sample (n=6) — revisit as the dead list grows, using the nearMisses
    // field below, which exists precisely so this stays measured.
    minSimilarity = 0.40
  } = {}) {
    const { memories } = await this.recall(proposal, {
      project,
      kinds: ["failure"],
      inject: limit * 4,     // over-fetch, then filter on absolute relevance
      tokenBudget: 2000
    });

    // FAIL LOUD, NOT OPEN. Without an embedder there is no similarity score,
    // and filtering on `similarity >= threshold` silently drops every
    // candidate — so the gate reports "proceed" when it simply could not
    // check. On a path whose entire job is to prevent repeating known
    // failures, a false all-clear is the worst possible outcome.
    // Degraded when there is no embedder at all, OR when the specific
    // candidates found have no vectors — an embedding write can fail silently
    // (mcpServer swallows those by design), and such a memory would otherwise
    // be permanently un-blockable even though BM25 finds it every time.
    const degraded = !this.embed || memories.every((m) => m.similarity == null);
    const unscoreable = memories.filter((m) => m.similarity == null);

    if (degraded) {
      // Keyword fallback needs its OWN relevance test. The query is expanded to
      // an OR of terms, so ANY single shared word produces a hit — "write tests
      // for the Kalshi poster" would match a retired Kalshi strategy on the word
      // `kalshi` alone. Blocking on that is the fail-always failure mode, and it
      // gets the warning ignored just as surely as never firing does.
      //
      // Require a meaningful fraction of the proposal's distinctive terms to
      // appear in the memory, not merely one.
      const queryTerms = termsOf(proposal);
      const scored = memories.map((m) => {
        const memoryTerms = new Set(termsOf(m.text));
        const overlap = queryTerms.filter((t) => memoryTerms.has(t)).length;
        return { ...m, overlap, ratio: queryTerms.length ? overlap / queryTerms.length : 0 };
      });

      // Two or more shared distinctive terms, or a high proportion of a short
      // proposal. One word is coincidence; two is a signal.
      const strong = scored
        .filter((m) => m.overlap >= 2 || (m.overlap >= 1 && m.ratio >= 0.5))
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, limit);

      return {
        blocked: strong.length > 0,
        degraded: true,
        matches: strong,
        nearMisses: scored
          .filter((m) => m.overlap === 1 && m.ratio < 0.5)
          .slice(0, 3)
          .map((m) => ({ text: m.text.slice(0, 60), overlap: m.overlap })),
        warning: strong.length
          ? `Possible match against ${strong.length} retired approach(es) ` +
            `(keyword overlap only — semantic check unavailable):\n` +
            strong.map((m) => `  • ${m.text}`).join("\n")
          : null,
        note: "Semantic similarity unavailable; this check used term overlap and may miss paraphrases."
      };
    }

    const scored = memories.filter((m) => m.similarity != null);
    const matches = scored.filter((m) => m.similarity >= minSimilarity).slice(0, limit);

    // Candidates BM25 surfaced but that have no embedding: fall back to term
    // overlap for those rather than dropping them silently.
    const queryTerms = termsOf(proposal);
    const overlapMatches = unscoreable
      .map((m) => {
        const memoryTerms = new Set(termsOf(m.text));
        const overlap = queryTerms.filter((t) => memoryTerms.has(t)).length;
        return { ...m, overlap };
      })
      .filter((m) => m.overlap >= 2)
      .slice(0, limit);

    const all = [...matches, ...overlapMatches].slice(0, limit);

    return {
      blocked: all.length > 0,
      degraded: false,
      unembedded: unscoreable.length,
      matches: all,
      // Exposed so the threshold can be tuned against real near-misses rather
      // than guessed at.
      nearMisses: scored
        .filter((m) => m.similarity < minSimilarity)
        .slice(0, 3)
        .map((m) => ({ text: m.text.slice(0, 60), similarity: Number(m.similarity.toFixed(3)) })),
      warning: matches.length
        ? `This resembles ${matches.length} previously retired approach(es):\n` +
          matches.map((m) => `  • ${m.text}`).join("\n")
        : null
    };
  }
}

/** Embedder backed by NVIDIA NIM. Free on the current key, so distillation and
 *  recall cost nothing and stay off any paid quota. */
export function createNvidiaEmbedder({ apiKey, model = "nvidia/nemotron-3-embed-1b" }) {
  return async function embedTexts(texts, { inputType = "query" } = {}) {
    const response = await fetch("https://integrate.api.nvidia.com/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts, input_type: inputType, encoding_format: "float" })
    });
    if (!response.ok) {
      throw new Error(`Embedding failed: HTTP ${response.status}`);
    }
    const data = await response.json();
    return (data.data ?? []).map((row) => row.embedding);
  };
}
