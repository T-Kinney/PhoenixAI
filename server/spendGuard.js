import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const LOCAL_PROVIDER_IDS = new Set(["ollama", "lm-studio", "lite-gateway"]);

export const DEFAULT_SPENDING_SAFETY = Object.freeze({
  paidCloudCallsEnabled: false,
  // OpenRouter is deliberately non-overridable in this release. Its credential
  // may remain encrypted at rest, but no inference path is allowed to use it.
  openRouterEnabled: false,
  dailyBudgetUsd: 0,
  perRequestBudgetUsd: 0,
  maxInputBytes: 100_000,
  maxOutputTokens: 1_200,
  maxRequestsPerHour: 2,
  maxConcurrentRequests: 1,
  // These are intentionally pessimistic reservation rates. Direct providers do
  // not consistently return a dollar cost, so unknown cost is never treated as
  // zero. Provider-side key limits remain the authoritative dollar barrier.
  inputPriceCeilingUsdPerMillion: 20,
  outputPriceCeilingUsdPerMillion: 60
});

function clampNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

export function sanitizeSpendingSafety(value = {}) {
  const dailyBudgetUsd = clampNumber(value.dailyBudgetUsd, 0, 0, 100);
  return {
    paidCloudCallsEnabled: value.paidCloudCallsEnabled === true,
    // This is a hard product decision, not a renderer-controlled preference.
    openRouterEnabled: false,
    dailyBudgetUsd,
    perRequestBudgetUsd: Math.min(
      dailyBudgetUsd,
      clampNumber(value.perRequestBudgetUsd, 0, 0, 25)
    ),
    maxInputBytes: Math.round(clampNumber(value.maxInputBytes, 100_000, 1_000, 250_000)),
    maxOutputTokens: Math.round(clampNumber(value.maxOutputTokens, 1_200, 64, 2_000)),
    maxRequestsPerHour: Math.round(clampNumber(value.maxRequestsPerHour, 2, 1, 10)),
    // Parallel paid requests are intentionally never configurable.
    maxConcurrentRequests: 1,
    inputPriceCeilingUsdPerMillion: clampNumber(value.inputPriceCeilingUsdPerMillion, 20, 1, 200),
    outputPriceCeilingUsdPerMillion: clampNumber(value.outputPriceCeilingUsdPerMillion, 60, 1, 400)
  };
}

function todayUtc(now) {
  return now.toISOString().slice(0, 10);
}

function hourAgo(now) {
  return now.getTime() - 60 * 60 * 1_000;
}

function money(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function reservationSummary(ledger, now) {
  const settlements = new Map(
    ledger.events
      .filter((event) => event.type === "settlement")
      .map((event) => [event.reservationId, event])
  );
  const today = todayUtc(now);
  const allReservations = ledger.events.filter((event) => event.type === "reservation");
  const todayReservations = allReservations.filter((event) => String(event.createdAt).startsWith(today));
  const chargedUsd = todayReservations.reduce((sum, reservation) => {
    const settlement = settlements.get(reservation.id);
    return sum + Number(settlement?.chargedUsd ?? reservation.estimatedUsd ?? 0);
  }, 0);
  const requestsLastHour = allReservations.filter((event) =>
    new Date(event.createdAt).getTime() >= hourAgo(now)).length;
  const active = allReservations.filter((event) => {
    if (settlements.has(event.id)) return false;
    // A crashed process must not hold the concurrency lock forever. Its full
    // reservation still counts against the daily budget until UTC rollover.
    return now.getTime() - new Date(event.createdAt).getTime() < 30 * 60 * 1_000;
  });
  return { chargedUsd: money(chargedUsd), requestsLastHour, active: active.length };
}

export class SpendBlockedError extends Error {
  constructor(message, code = "SPENDING_BLOCKED") {
    super(message);
    this.name = "SpendBlockedError";
    this.code = code;
    this.status = 403;
  }
}

export class SpendGuard {
  constructor({ ledgerPath, now = () => new Date() } = {}) {
    if (!ledgerPath) throw new Error("SpendGuard requires a ledgerPath.");
    this.ledgerPath = ledgerPath;
    this.lockPath = `${ledgerPath}.lock`;
    this.now = now;
  }

  estimate({ prompt, maxOutputTokens, policy }) {
    // UTF-8 bytes are a deliberately conservative upper bound for text tokens.
    const inputUnits = Buffer.byteLength(String(prompt ?? ""), "utf8");
    return money(
      (inputUnits * policy.inputPriceCeilingUsdPerMillion
        + maxOutputTokens * policy.outputPriceCeilingUsdPerMillion) / 1_000_000
    );
  }

  async reserve({ providerId, prompt, maxOutputTokens, policy: rawPolicy }) {
    const policy = sanitizeSpendingSafety(rawPolicy);
    const requestedTokens = Number(maxOutputTokens);
    const boundedOutputTokens = Math.min(
      policy.maxOutputTokens,
      Math.max(1, Number.isFinite(requestedTokens) ? Math.round(requestedTokens) : policy.maxOutputTokens)
    );

    if (LOCAL_PROVIDER_IDS.has(providerId)) {
      return { paid: false, providerId, maxOutputTokens: boundedOutputTokens };
    }
    if (providerId === "openrouter") {
      return this.#blocked(providerId, "OpenRouter inference is hard-blocked in this release.", "OPENROUTER_BLOCKED");
    }
    if (!policy.paidCloudCallsEnabled) {
      return this.#blocked(providerId, "Paid cloud calls are locked. Enable them explicitly in Spending safety.", "PAID_CALLS_LOCKED");
    }
    if (policy.dailyBudgetUsd <= 0 || policy.perRequestBudgetUsd <= 0) {
      return this.#blocked(providerId, "Paid calls require non-zero daily and per-request budgets.", "NO_BUDGET");
    }

    const inputBytes = Buffer.byteLength(String(prompt ?? ""), "utf8");
    if (inputBytes > policy.maxInputBytes) {
      return this.#blocked(
        providerId,
        `Prompt is ${inputBytes.toLocaleString()} bytes; paid-call limit is ${policy.maxInputBytes.toLocaleString()} bytes.`,
        "INPUT_LIMIT"
      );
    }

    const estimatedUsd = this.estimate({ prompt, maxOutputTokens: boundedOutputTokens, policy });
    if (estimatedUsd > policy.perRequestBudgetUsd) {
      return this.#blocked(
        providerId,
        `Conservative request reservation $${estimatedUsd.toFixed(4)} exceeds the $${policy.perRequestBudgetUsd.toFixed(2)} per-request limit.`,
        "REQUEST_BUDGET"
      );
    }

    const result = await this.#withLedger((ledger) => {
      const now = this.now();
      const summary = reservationSummary(ledger, now);
      if (summary.active >= 1) {
        return { blocked: "Another paid request is already running.", code: "PAID_CONCURRENCY" };
      }
      if (summary.requestsLastHour >= policy.maxRequestsPerHour) {
        return { blocked: `Paid request limit of ${policy.maxRequestsPerHour} per hour reached.`, code: "PAID_RATE_LIMIT" };
      }
      if (money(summary.chargedUsd + estimatedUsd) > policy.dailyBudgetUsd) {
        return {
          blocked: `Daily local budget would be exceeded ($${summary.chargedUsd.toFixed(4)} used/reserved of $${policy.dailyBudgetUsd.toFixed(2)}).`,
          code: "DAILY_BUDGET"
        };
      }

      const reservation = {
        type: "reservation",
        id: crypto.randomUUID(),
        providerId,
        estimatedUsd,
        maxOutputTokens: boundedOutputTokens,
        inputBytes,
        createdAt: now.toISOString()
      };
      ledger.events.push(reservation);
      return { reservation };
    });

    if (result.blocked) return this.#blocked(providerId, result.blocked, result.code);
    return { paid: true, ...result.reservation };
  }

  async settle(reservation, { actualCostUsd = null, outcome = "completed", usage = null } = {}) {
    if (!reservation?.paid || !reservation.id) return reservation;
    const actual = Number(actualCostUsd);
    const hasActualCost = actualCostUsd !== null && actualCostUsd !== undefined
      && Number.isFinite(actual) && actual >= 0;
    const chargedUsd = hasActualCost
      ? money(actual)
      : money(reservation.estimatedUsd);
    await this.#withLedger((ledger) => {
      if (!ledger.events.some((event) => event.type === "settlement" && event.reservationId === reservation.id)) {
        ledger.events.push({
          type: "settlement",
          reservationId: reservation.id,
          providerId: reservation.providerId,
          chargedUsd,
          costSource: hasActualCost ? "provider" : "conservative-reservation",
          outcome,
          usage: usage && typeof usage === "object" ? {
            promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
            completionTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
            totalTokens: usage.total_tokens ?? null
          } : null,
          createdAt: this.now().toISOString()
        });
      }
      return null;
    });
    return { ...reservation, chargedUsd };
  }

  async status(rawPolicy) {
    const policy = sanitizeSpendingSafety(rawPolicy);
    const ledgerStatus = await this.#withLedger((ledger) => {
      const summary = reservationSummary(ledger, this.now());
      const blocked = ledger.events.filter((event) => event.type === "blocked").slice(-10).reverse();
      return { ...summary, blockedAttempts: blocked };
    }, { write: false });
    return {
      policy,
      openRouterStatus: "hard-blocked",
      today: {
        chargedOrReservedUsd: ledgerStatus.chargedUsd,
        remainingLocalBudgetUsd: money(Math.max(0, policy.dailyBudgetUsd - ledgerStatus.chargedUsd)),
        requestsLastHour: ledgerStatus.requestsLastHour,
        activePaidRequests: ledgerStatus.active
      },
      blockedAttempts: ledgerStatus.blockedAttempts
    };
  }

  async #blocked(providerId, message, code) {
    await this.#withLedger((ledger) => {
      ledger.events.push({ type: "blocked", providerId, code, message, createdAt: this.now().toISOString() });
      return null;
    }).catch(() => {});
    throw new SpendBlockedError(message, code);
  }

  async #withLedger(operation, { write = true } = {}) {
    const lock = await this.#acquireLock();
    try {
      const ledger = await this.#readLedger();
      const result = await operation(ledger);
      if (write) {
        const cutoff = this.now().getTime() - 31 * 24 * 60 * 60 * 1_000;
        ledger.events = ledger.events
          .filter((event) => new Date(event.createdAt).getTime() >= cutoff)
          .slice(-5_000);
        await this.#writeLedger(ledger);
      }
      return result;
    } finally {
      await lock.close().catch(() => {});
      await fs.unlink(this.lockPath).catch(() => {});
    }
  }

  async #readLedger() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.ledgerPath, "utf8"));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.events)) {
        throw new Error("Unsupported spend ledger format.");
      }
      return parsed;
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, events: [] };
      throw new SpendBlockedError(`Spend ledger is unavailable; paid calls fail closed: ${error.message}`, "LEDGER_UNAVAILABLE");
    }
  }

  async #writeLedger(ledger) {
    await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    const temporary = `${this.ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.ledgerPath);
  }

  async #acquireLock() {
    await fs.mkdir(path.dirname(this.ledgerPath), { recursive: true });
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        return await fs.open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const stat = await fs.stat(this.lockPath).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > 30_000) {
          await fs.unlink(this.lockPath).catch(() => {});
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new SpendBlockedError("Spend ledger is busy; paid calls fail closed.", "LEDGER_BUSY");
  }
}
