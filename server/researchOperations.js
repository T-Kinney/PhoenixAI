import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CONDITION_TYPES = new Set(["last_above", "last_below"]);
const INSTRUMENT_TYPES = new Set(["EQUITY", "INDEX", "CRYPTO"]);
function nowIso(now) { return new Date(now()).toISOString(); }
function id(prefix) { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`; }
function text(value, limit = 500) { return String(value ?? "").trim().slice(0, limit); }
function finite(value, label) { const result = Number(value); if (!Number.isFinite(result)) throw new Error(`${label} must be a finite number.`); return result; }

async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}
async function appendJsonl(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
  return value;
}

function safeSymbol(value) {
  const symbol = text(value, 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9. _-]{0,39}$/.test(symbol)) throw new Error("A valid symbol is required.");
  return symbol;
}
function safeType(value) {
  const type = text(value || "EQUITY", 20).toUpperCase();
  if (!INSTRUMENT_TYPES.has(type)) throw new Error(`Unsupported instrument type '${type}'.`);
  return type;
}

function quoteFreshness(quote, now) {
  const timestamps = [quote?.lastTimestamp, quote?.bidTimestamp, quote?.askTimestamp]
    .map((value) => new Date(value).getTime()).filter(Number.isFinite);
  if (!timestamps.length) return { asOf: null, ageSeconds: null, stale: true, reason: "Quote has no provider timestamp." };
  const latest = Math.max(...timestamps); const ageSeconds = Math.round((now() - latest) / 1000);
  if (ageSeconds < -300) return { asOf: new Date(latest).toISOString(), ageSeconds, stale: true, reason: "Provider timestamp is unexpectedly in the future." };
  return { asOf: new Date(latest).toISOString(), ageSeconds: Math.max(0, ageSeconds), stale: ageSeconds > 900, reason: ageSeconds > 900 ? "Quote is more than 15 minutes old." : "Quote timestamp is current." };
}

function defaultRisk(input = {}) {
  return {
    maxOrderNotionalPct: Math.min(25, Math.max(0.1, finite(input.maxOrderNotionalPct ?? 2, "Max order notional"))),
    maxPositionPct: Math.min(50, Math.max(0.5, finite(input.maxPositionPct ?? 10, "Max position"))),
    maxOpenPositions: Math.min(100, Math.max(1, Math.floor(finite(input.maxOpenPositions ?? 10, "Max open positions")))),
    maxDailyRealizedLossPct: Math.min(20, Math.max(0.1, finite(input.maxDailyRealizedLossPct ?? 1, "Max daily realized loss"))),
    slippageBps: Math.min(100, Math.max(0, finite(input.slippageBps ?? 2, "Slippage"))),
    commissionPerFillUsd: Math.min(100, Math.max(0, finite(input.commissionPerFillUsd ?? 0.65, "Commission")))
  };
}

function derivePaperState(account, events, now) {
  const positions = new Map();
  let cash = account.initialCashUsd;
  let realizedPnl = 0;
  let dailyRealizedPnl = 0;
  const today = nowIso(now).slice(0, 10);
  for (const event of events.filter((row) => row.projectId === account.projectId && row.accountId === account.id && row.status === "filled")) {
    const signedQuantity = event.side === "BUY" ? event.quantity : -event.quantity;
    const positionKey = `${event.type}:${event.symbol}`;
    const prior = positions.get(positionKey) || { symbol: event.symbol, type: event.type, quantity: 0, averageCost: 0, realizedPnl: 0 };
    if (signedQuantity > 0) {
      const newQuantity = prior.quantity + signedQuantity;
      prior.averageCost = ((prior.quantity * prior.averageCost) + (signedQuantity * event.fillPrice) + event.feeUsd) / newQuantity;
      prior.quantity = newQuantity;
      cash -= event.quantity * event.fillPrice + event.feeUsd;
    } else {
      const pnl = event.quantity * (event.fillPrice - prior.averageCost) - event.feeUsd;
      prior.quantity -= event.quantity;
      prior.realizedPnl += pnl;
      realizedPnl += pnl;
      if (event.createdAt.slice(0, 10) === today) dailyRealizedPnl += pnl;
      cash += event.quantity * event.fillPrice - event.feeUsd;
      if (prior.quantity === 0) prior.averageCost = 0;
    }
    positions.set(positionKey, prior);
  }
  return { cashUsd: cash, realizedPnlUsd: realizedPnl, dailyRealizedPnlUsd: dailyRealizedPnl, positions: [...positions.values()].filter((item) => item.quantity > 0) };
}

export class ResearchOperations {
  constructor({ dataDir, now = Date.now }) {
    this.alertsPath = path.join(dataDir, "research-alerts.jsonl");
    this.signalEventsPath = path.join(dataDir, "research-signal-events.jsonl");
    this.paperAccountsPath = path.join(dataDir, "paper-accounts.jsonl");
    this.paperEventsPath = path.join(dataDir, "paper-events.jsonl");
    this.now = now;
    this.writeQueue = Promise.resolve();
  }
  withWriteLock(task) { const run = this.writeQueue.then(task, task); this.writeQueue = run.catch(() => {}); return run; }

  async listAlerts(projectId) { return (await readJsonl(this.alertsPath)).filter((row) => row.projectId === projectId); }
  async createAlert(input, project) {
    return this.withWriteLock(async () => {
      const condition = text(input.condition, 30);
      if (!CONDITION_TYPES.has(condition)) throw new Error("Alert condition must be last_above or last_below.");
      const threshold = finite(input.threshold, "Alert threshold");
      if (threshold <= 0) throw new Error("Alert threshold must be greater than zero.");
      const alert = { id: id("alert"), projectId: project.id, symbol: safeSymbol(input.symbol), type: safeType(input.type), condition, threshold, active: true, note: text(input.note, 1000) || null, createdAt: nowIso(this.now), immutable: true };
      await appendJsonl(this.alertsPath, alert);
      return alert;
    });
  }

  async scanAlerts(project, marketData) {
    return this.withWriteLock(async () => {
      const alerts = (await this.listAlerts(project.id)).filter((row) => row.active);
      if (!alerts.length) return { scanned: 0, triggered: [], observations: [], at: nowIso(this.now) };
      const unique = [...new Map(alerts.map((alert) => [`${alert.type}:${alert.symbol}`, { symbol: alert.symbol, type: alert.type }])).values()];
      const evidence = await marketData.quotes({ instruments: unique });
      const priorEvents = (await readJsonl(this.signalEventsPath)).filter((row) => row.projectId === project.id);
      const observations = alerts.map((alert) => {
        const quote = (evidence.data?.quotes || []).find((item) => item.instrument?.symbol === alert.symbol && item.instrument?.type === alert.type);
        const freshness = quoteFreshness(quote, this.now);
        const last = Number(quote?.last);
        const matched = quote?.outcome === "SUCCESS" && Number.isFinite(last) && (alert.condition === "last_above" ? last > alert.threshold : last < alert.threshold);
        const prior = [...priorEvents].reverse().find((row) => row.alertId === alert.id && row.kind === "observation" && row.freshness?.stale === false);
        return { alertId: alert.id, symbol: alert.symbol, condition: alert.condition, threshold: alert.threshold, last: Number.isFinite(last) ? last : null, matched, transitioned: freshness.stale === false && matched && prior?.matched !== true, outcome: quote?.outcome || null, freshness };
      });
      const at = nowIso(this.now);
      for (const observation of observations) await appendJsonl(this.signalEventsPath, { id: id("signal"), kind: "observation", projectId: project.id, at, source: evidence.source, sourceRetrievedAt: evidence.retrievedAt, ...observation });
      const triggered = observations.filter((row) => row.transitioned);
      return { scanned: alerts.length, triggered, observations, at, evidence: { source: evidence.source, retrievedAt: evidence.retrievedAt, freshness: evidence.freshness } };
    });
  }

  async listSignalEvents(projectId, limit = 100) { return (await readJsonl(this.signalEventsPath)).filter((row) => row.projectId === projectId).slice(-Math.max(1, Math.min(500, limit))).reverse(); }
  async listPaperAccounts(projectId) { return (await readJsonl(this.paperAccountsPath)).filter((row) => row.projectId === projectId); }
  async createPaperAccount(input, project) {
    return this.withWriteLock(async () => {
      if ((await this.listPaperAccounts(project.id)).length) throw new Error("This project already has a paper account. Paper ledgers are append-only.");
      const initialCashUsd = finite(input.initialCashUsd ?? 100_000, "Initial cash");
      if (initialCashUsd < 100) throw new Error("Initial paper cash must be at least $100.");
      const account = { id: id("paper"), projectId: project.id, name: text(input.name || "Research paper account", 120), initialCashUsd, risk: defaultRisk(input.risk), liveTrading: false, shortSelling: false, createdAt: nowIso(this.now), immutable: true };
      await appendJsonl(this.paperAccountsPath, account);
      return account;
    });
  }

  async paperState(projectId) {
    const account = (await this.listPaperAccounts(projectId))[0] || null;
    if (!account) return { account: null, cashUsd: null, positions: [], fills: [], rejections: [] };
    const events = (await readJsonl(this.paperEventsPath)).filter((row) => row.projectId === projectId && row.accountId === account.id);
    return { account, ...derivePaperState(account, events, this.now), fills: events.filter((row) => row.status === "filled").reverse(), rejections: events.filter((row) => row.status === "rejected").reverse() };
  }

  async simulatePaperFill(input, project, quoteEvidence) {
    return this.withWriteLock(async () => {
      const account = (await this.listPaperAccounts(project.id))[0];
      if (!account) throw new Error("Create a paper account first.");
      const idempotencyKey = text(input.idempotencyKey, 120);
      if (!idempotencyKey) throw new Error("A unique idempotency key is required.");
      const allEvents = await readJsonl(this.paperEventsPath);
      const duplicate = allEvents.find((row) => row.accountId === account.id && row.idempotencyKey === idempotencyKey);
      if (duplicate) return { event: duplicate, duplicate: true, state: await this.paperState(project.id) };
      const symbol = safeSymbol(input.symbol); const type = safeType(input.type); const side = text(input.side, 8).toUpperCase();
      if (!new Set(["BUY", "SELL"]).has(side)) throw new Error("Paper side must be BUY or SELL.");
      const quantity = finite(input.quantity, "Paper quantity");
      if (quantity <= 0 || !Number.isInteger(quantity)) throw new Error("Paper quantity must be a positive whole number.");
      const quote = (quoteEvidence.data?.quotes || []).find((item) => item.instrument?.symbol === symbol && item.instrument?.type === type);
      const basePrice = Number(side === "BUY" ? quote?.ask : quote?.bid);
      const failures = [];
      if (!Number.isFinite(basePrice) || basePrice <= 0) failures.push(`${side === "BUY" ? "ask" : "bid"} price is unavailable`);
      if (quoteEvidence.freshness?.stale !== false || Number(quoteEvidence.freshness?.ageSeconds) > 60) failures.push("quote is not fresh enough for paper execution");
      const state = await this.paperState(project.id);
      const slip = account.risk.slippageBps / 10_000;
      const fillPrice = Number.isFinite(basePrice) ? basePrice * (side === "BUY" ? 1 + slip : 1 - slip) : 0;
      const notional = quantity * fillPrice;
      const position = state.positions.find((item) => item.symbol === symbol && item.type === type);
      const equity = state.cashUsd + state.positions.reduce((sum, item) => sum + item.quantity * (item.symbol === symbol && Number.isFinite(basePrice) ? basePrice : item.averageCost), 0);
      if (side === "BUY" && notional > equity * account.risk.maxOrderNotionalPct / 100) failures.push("order exceeds max order-notional limit");
      if (side === "BUY" && ((position?.quantity || 0) * fillPrice + notional) > equity * account.risk.maxPositionPct / 100) failures.push("resulting position exceeds max position limit");
      if (side === "BUY" && !position && state.positions.length >= account.risk.maxOpenPositions) failures.push("maximum open positions reached");
      if (side === "BUY" && notional + account.risk.commissionPerFillUsd > state.cashUsd) failures.push("insufficient paper cash");
      if (side === "SELL" && quantity > (position?.quantity || 0)) failures.push("short selling is disabled");
      if (state.dailyRealizedPnlUsd < -(account.initialCashUsd * account.risk.maxDailyRealizedLossPct / 100)) failures.push("daily realized-loss limit reached");
      const event = { id: id("paper_event"), projectId: project.id, accountId: account.id, idempotencyKey, status: failures.length ? "rejected" : "filled", rejectionReasons: failures, symbol, type, side, quantity, bid: Number(quote?.bid) || null, ask: Number(quote?.ask) || null, fillPrice: failures.length ? null : fillPrice, feeUsd: failures.length ? 0 : account.risk.commissionPerFillUsd, source: quoteEvidence.source, sourceRetrievedAt: quoteEvidence.retrievedAt, sourceAsOf: quoteEvidence.freshness?.asOf || null, createdAt: nowIso(this.now), simulated: true, liveOrder: false };
      await appendJsonl(this.paperEventsPath, event);
      return { event, duplicate: false, state: await this.paperState(project.id) };
    });
  }
}

export const __test = { defaultRisk, derivePaperState, quoteFreshness };
