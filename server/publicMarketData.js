import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const PUBLIC_API = "https://api.public.com";
const SOURCE = "Public.com Individual API";
const INSTRUMENT_TYPES = new Set(["EQUITY", "OPTION", "CRYPTO", "INDEX", "UNDERLYING_SECURITY_FOR_INDEX_OPTION"]);
const BAR_PERIODS = new Set(["DAY", "WEEK", "MONTH", "QUARTER", "HALF_YEAR", "YEAR", "FIVE_YEARS", "TEN_YEARS", "ALL", "YTD"]);
const TRADING_SESSIONS = new Set(["REGULAR_HOURS", "REGULAR_AND_EXTENDED_HOURS", "ALL_SESSIONS"]);

function clean(value, limit = 160) { return String(value ?? "").trim().slice(0, limit); }
function nowIso(now) { return new Date(now()).toISOString(); }

function safeAccountId(value) {
  const accountId = clean(value, 128);
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(accountId)) throw new Error("A valid Public.com account ID is required.");
  return accountId;
}

function safeSymbol(value) {
  const symbol = clean(value, 40).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9. _-]{0,39}$/.test(symbol)) throw new Error(`Invalid market symbol '${symbol || "(empty)"}'.`);
  return symbol;
}

function safeType(value, fallback = "EQUITY") {
  const type = clean(value || fallback, 80).toUpperCase();
  if (!INSTRUMENT_TYPES.has(type)) throw new Error(`Unsupported instrument type '${type}'.`);
  return type;
}

function safeIsoDate(value, label) {
  const date = clean(value, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error(`${label} must use a real YYYY-MM-DD calendar date.`);
  return date;
}

function freshnessOf(payload, now) {
  const quotes = [
    ...(Array.isArray(payload?.quotes) ? payload.quotes : []),
    ...(Array.isArray(payload?.calls) ? payload.calls : []),
    ...(Array.isArray(payload?.puts) ? payload.puts : [])
  ];
  const timestamps = quotes.flatMap((quote) => [quote?.lastTimestamp, quote?.bidTimestamp, quote?.askTimestamp])
    .map((value) => new Date(value).getTime()).filter(Number.isFinite);
  if (!timestamps.length) return { asOf: null, ageSeconds: null, stale: null, reason: "Provider returned no quote timestamp." };
  const latest = Math.max(...timestamps);
  const ageSeconds = Math.round((now() - latest) / 1000);
  if (ageSeconds < -300) return { asOf: new Date(latest).toISOString(), ageSeconds, stale: true, reason: "Provider timestamp is unexpectedly in the future." };
  return {
    asOf: new Date(latest).toISOString(),
    ageSeconds: Math.max(0, ageSeconds),
    stale: ageSeconds > 900,
    reason: ageSeconds > 900 ? "Latest quote is more than 15 minutes old; the market may be closed or data may be delayed." : "Timestamp is within the 15-minute freshness window."
  };
}

async function appendAudit(filePath, value) {
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

export class PublicMarketData {
  constructor({ environment = process.env, fetchImpl = fetch, auditPath = null, now = Date.now } = {}) {
    this.environment = environment;
    this.fetchImpl = fetchImpl;
    this.auditPath = auditPath;
    this.now = now;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.cache = new Map();
    this.credentialMarker = null;
  }

  status() {
    return {
      provider: "public",
      source: SOURCE,
      secretConfigured: Boolean(clean(this.environment.PUBLIC_COM_SECRET, 10_000)),
      accountConfigured: Boolean(clean(this.environment.PUBLIC_COM_ACCOUNT_ID, 128)),
      ready: Boolean(clean(this.environment.PUBLIC_COM_SECRET, 10_000) && clean(this.environment.PUBLIC_COM_ACCOUNT_ID, 128)),
      capabilities: ["quotes", "option-expirations", "option-chain", "option-greeks", "price-history"],
      safety: { readOnly: true, accountData: false, portfolioData: false, orders: false, preflight: false },
      retention: "Access tokens are held in memory only; responses use a short local cache."
    };
  }

  accountId(input) {
    return safeAccountId(input || this.environment.PUBLIC_COM_ACCOUNT_ID);
  }

  assertConfigured() {
    const secret = clean(this.environment.PUBLIC_COM_SECRET, 10_000);
    const accountId = safeAccountId(this.environment.PUBLIC_COM_ACCOUNT_ID);
    if (secret.length < 8) throw new Error("PUBLIC_COM_SECRET is not configured.");
    const marker = crypto.createHash("sha256").update(`${secret}\0${accountId}`).digest("hex");
    if (this.credentialMarker && marker !== this.credentialMarker) {
      this.accessToken = null;
      this.accessTokenExpiresAt = 0;
      this.cache.clear();
    }
    this.credentialMarker = marker;
  }

  async token() {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt - 60_000) return this.accessToken;
    const secret = clean(this.environment.PUBLIC_COM_SECRET, 10_000);
    if (secret.length < 8) throw new Error("PUBLIC_COM_SECRET is not configured.");
    const response = await this.fetchImpl(`${PUBLIC_API}/userapiauthservice/personal/access-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ validityInMinutes: 15, secret }),
      signal: AbortSignal.timeout(12_000)
    });
    const data = await this.readResponse(response, 256 * 1024);
    if (!response.ok || !clean(data?.accessToken, 20_000)) throw new Error(`Public.com authentication failed with HTTP ${response.status}.`);
    this.accessToken = clean(data.accessToken, 20_000);
    this.accessTokenExpiresAt = this.now() + 14 * 60_000;
    return this.accessToken;
  }

  async readResponse(response, limit) {
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > limit) throw new Error("Public.com response exceeded the local safety limit.");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > limit) throw new Error("Public.com response exceeded the local safety limit.");
    try { return raw ? JSON.parse(raw) : {}; }
    catch { throw new Error("Public.com returned an invalid JSON response."); }
  }

  async call({ endpoint, method = "POST", body = null, responseLimit = 2 * 1024 * 1024 }) {
    let token = await this.token();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.fetchImpl(`${PUBLIC_API}${endpoint}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000)
      });
      if (response.status === 401 && attempt === 0) {
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        token = await this.token();
        continue;
      }
      const data = await this.readResponse(response, responseLimit);
      if (!response.ok) throw new Error(`Public.com market-data request failed with HTTP ${response.status}.`);
      return data;
    }
    throw new Error("Public.com authorization could not be refreshed.");
  }

  async cached(key, ttlMs, operation, audit) {
    this.assertConfigured();
    const existing = this.cache.get(key);
    if (existing && this.now() - existing.storedAt < ttlMs) {
      return { ...existing.value, cache: { hit: true, ageSeconds: Math.max(0, Math.round((this.now() - existing.storedAt) / 1000)) } };
    }
    const data = await operation();
    const retrievedAt = nowIso(this.now);
    const value = {
      provider: "public",
      source: SOURCE,
      retrievedAt,
      accountScoped: true,
      readOnly: true,
      freshness: freshnessOf(data, this.now),
      data,
      cache: { hit: false, ageSeconds: 0 }
    };
    this.cache.set(key, { storedAt: this.now(), value });
    await appendAudit(this.auditPath, { id: `market_${this.now()}_${Math.random().toString(16).slice(2, 10)}`, at: retrievedAt, provider: "public", readOnly: true, ...audit });
    return value;
  }

  async quotes(input = {}) {
    const accountId = this.accountId(input.accountId);
    const instruments = (Array.isArray(input.instruments) ? input.instruments : [{ symbol: input.symbol, type: input.type }])
      .slice(0, 20).map((instrument) => ({ symbol: safeSymbol(instrument?.symbol), type: safeType(instrument?.type) }));
    if (!instruments.length) throw new Error("At least one instrument is required.");
    const key = `quotes:${accountId}:${JSON.stringify(instruments)}`;
    return this.cached(key, 3_000, () => this.call({ endpoint: `/userapigateway/marketdata/${encodeURIComponent(accountId)}/quotes`, body: { instruments } }), {
      operation: "quotes", instruments
    });
  }

  async optionExpirations(input = {}) {
    const accountId = this.accountId(input.accountId);
    const instrument = { symbol: safeSymbol(input.symbol), type: safeType(input.type, "EQUITY") };
    const key = `expirations:${accountId}:${instrument.type}:${instrument.symbol}`;
    return this.cached(key, 5 * 60_000, () => this.call({ endpoint: `/userapigateway/marketdata/${encodeURIComponent(accountId)}/option-expirations`, body: { instrument } }), {
      operation: "option-expirations", instrument
    });
  }

  async optionChain(input = {}) {
    const accountId = this.accountId(input.accountId);
    const instrument = { symbol: safeSymbol(input.symbol), type: safeType(input.type, "EQUITY") };
    const expirationDate = safeIsoDate(input.expirationDate, "Expiration date");
    const key = `chain:${accountId}:${instrument.type}:${instrument.symbol}:${expirationDate}`;
    return this.cached(key, 15_000, () => this.call({
      endpoint: `/userapigateway/marketdata/${encodeURIComponent(accountId)}/option-chain`, body: { instrument, expirationDate }, responseLimit: 12 * 1024 * 1024
    }), { operation: "option-chain", instrument, expirationDate });
  }

  async optionGreeks(input = {}) {
    const accountId = this.accountId(input.accountId);
    const osiSymbols = (Array.isArray(input.osiSymbols) ? input.osiSymbols : [input.osiSymbol]).slice(0, 50).map(safeSymbol);
    if (!osiSymbols.length) throw new Error("At least one option symbol is required.");
    const query = new URLSearchParams();
    for (const symbol of osiSymbols) query.append("osiSymbols", symbol);
    const key = `greeks:${accountId}:${osiSymbols.join(",")}`;
    return this.cached(key, 5_000, () => this.call({ endpoint: `/userapigateway/option-details/${encodeURIComponent(accountId)}/greeks?${query}`, method: "GET" }), {
      operation: "option-greeks", osiSymbols
    });
  }

  async bars(input = {}) {
    this.accountId(input.accountId); // Confirms the configured account context even though this endpoint is not account-scoped.
    const symbol = safeSymbol(input.symbol);
    const type = safeType(input.type);
    const period = clean(input.period || "DAY", 30).toUpperCase();
    const tradingSessionToggle = clean(input.tradingSessionToggle || "REGULAR_AND_EXTENDED_HOURS", 50).toUpperCase();
    if (!BAR_PERIODS.has(period)) throw new Error(`Unsupported bar period '${period}'.`);
    if (!TRADING_SESSIONS.has(tradingSessionToggle)) throw new Error(`Unsupported trading session '${tradingSessionToggle}'.`);
    const key = `bars:${type}:${symbol}:${period}:${tradingSessionToggle}`;
    const endpoint = `/userapigateway/historicdata/${encodeURIComponent(type)}/${encodeURIComponent(symbol)}/${encodeURIComponent(period)}?${new URLSearchParams({ tradingSessionToggle })}`;
    return this.cached(key, period === "DAY" ? 15_000 : 60_000, () => this.call({ endpoint, method: "GET", responseLimit: 8 * 1024 * 1024 }), {
      operation: "price-history", instrument: { symbol, type }, period, tradingSessionToggle
    });
  }
}

export const __test = { safeAccountId, safeSymbol, safeType, safeIsoDate, freshnessOf };
