#!/usr/bin/env node
import readline from "node:readline";
import { PublicMarketData } from "../publicMarketData.js";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_INFO = { name: "phoenix-market-data-readonly", version: "1.0.0" };

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const service = new PublicMarketData({ environment: process.env, auditPath: arg("audit") });
const instrumentSchema = {
  type: "object",
  properties: {
    symbol: { type: "string", description: "Ticker or OSI option symbol." },
    type: { type: "string", enum: ["EQUITY", "OPTION", "CRYPTO", "INDEX"] }
  },
  required: ["symbol", "type"],
  additionalProperties: false
};

const TOOLS = [
  {
    name: "market_quotes",
    description: "Read current Public.com quotes for up to 20 instruments. Returns provider timestamps and an explicit freshness assessment. No account, portfolio, preflight, or order access.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: { instruments: { type: "array", minItems: 1, maxItems: 20, items: instrumentSchema } }, required: ["instruments"], additionalProperties: false }
  },
  {
    name: "market_option_expirations",
    description: "Read available option expiration dates for an equity or index-option underlying.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: { symbol: { type: "string" }, type: { type: "string", enum: ["EQUITY", "UNDERLYING_SECURITY_FOR_INDEX_OPTION"] } }, required: ["symbol"], additionalProperties: false }
  },
  {
    name: "market_option_chain",
    description: "Read an option chain with bid/ask, volume, open interest, and provider-supplied Greeks. Output is bounded; request specific expirations and use strike limits when possible.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        type: { type: "string", enum: ["EQUITY", "UNDERLYING_SECURITY_FOR_INDEX_OPTION"] },
        expirationDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        strikeMin: { type: "number" }, strikeMax: { type: "number" },
        maxContractsPerSide: { type: "integer", minimum: 1, maximum: 150, default: 80 }
      },
      required: ["symbol", "expirationDate"], additionalProperties: false
    }
  },
  {
    name: "market_option_greeks",
    description: "Read provider-supplied Greeks for up to 50 normalized OSI option symbols.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: "object", properties: { osiSymbols: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } } }, required: ["osiSymbols"], additionalProperties: false }
  },
  {
    name: "market_price_history",
    description: "Read Public.com OHLCV price history for one instrument and an allowlisted period.",
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" }, type: { type: "string", enum: ["EQUITY", "OPTION", "CRYPTO", "INDEX"] },
        period: { type: "string", enum: ["DAY", "WEEK", "MONTH", "QUARTER", "HALF_YEAR", "YEAR", "FIVE_YEARS", "TEN_YEARS", "ALL", "YTD"] },
        tradingSessionToggle: { type: "string", enum: ["REGULAR_HOURS", "REGULAR_AND_EXTENDED_HOURS", "ALL_SESSIONS"] }
      },
      required: ["symbol", "type", "period"], additionalProperties: false
    }
  }
];

function compactContract(contract) {
  return {
    instrument: contract?.instrument,
    outcome: contract?.outcome,
    last: contract?.last,
    lastTimestamp: contract?.lastTimestamp,
    bid: contract?.bid,
    bidSize: contract?.bidSize,
    bidTimestamp: contract?.bidTimestamp,
    ask: contract?.ask,
    askSize: contract?.askSize,
    askTimestamp: contract?.askTimestamp,
    volume: contract?.volume,
    openInterest: contract?.openInterest,
    optionDetails: contract?.optionDetails
  };
}

function boundedChain(result, args) {
  const min = Number.isFinite(Number(args.strikeMin)) ? Number(args.strikeMin) : -Infinity;
  const max = Number.isFinite(Number(args.strikeMax)) ? Number(args.strikeMax) : Infinity;
  const limit = Math.min(150, Math.max(1, Number(args.maxContractsPerSide) || 80));
  const keep = (contracts) => (Array.isArray(contracts) ? contracts : [])
    .filter((contract) => {
      const strike = Number(contract?.optionDetails?.strikePrice);
      return !Number.isFinite(strike) || (strike >= min && strike <= max);
    })
    .slice(0, limit).map(compactContract);
  return { ...result, data: { baseSymbol: result.data?.baseSymbol, calls: keep(result.data?.calls), puts: keep(result.data?.puts) } };
}

async function callTool(name, args) {
  let result;
  if (name === "market_quotes") result = await service.quotes(args);
  else if (name === "market_option_expirations") result = await service.optionExpirations(args);
  else if (name === "market_option_chain") result = boundedChain(await service.optionChain(args), args);
  else if (name === "market_option_greeks") result = await service.optionGreeks(args);
  else if (name === "market_price_history") result = await service.bars(args);
  else throw new Error(`Unknown market-data tool '${name}'.`);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 160_000) {
    throw new Error("Provider response is too large for an agent context. Request a narrower option range or shorter history period.");
  }
  return result;
}

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
async function handle(message) {
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  try {
    if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    if (method === "server/discover") return send({ jsonrpc: "2.0", id, result: { serverInfo: SERVER_INFO, capabilities: { tools: {} } } });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    if (method === "tools/call") {
      const result = await callTool(params.name, params.arguments ?? {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: `Market data error: ${error.message}` }] } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => { try { handle(JSON.parse(line)); } catch { /* ignore malformed protocol input */ } });
