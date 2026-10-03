import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { formatUnits, parseEther } from "viem";
import { HOLDER_MIN_USD, IDENTITY } from "../src/identity.js";
import { AGENT_MAX_INPUT, AGENT_SESSION_HOURS, agentSignInMessage } from "../src/agent-message.js";
import { getBalances, getCandles, getCoin, getHolder, getList, getQuote } from "./terminal.js";
import { getHeat } from "./heat.js";
import { health as privacyHealth } from "../api/privacy.js";
import { POOLS, chain, poolActivity } from "./pools.js";
import { TRAIL_K, withdrawCheck } from "../src/trail.js";

export { TRAIL_K, withdrawCheck };

/**
 * The Kelvo agent: a hosted language model with read-only tools over the heat board, the token pages and the private pools.
 * Any OpenAI-compatible chat endpoint with tool calls works: AGENT_API_URL, AGENT_API_KEY and AGENT_MODEL are set on the server.
 * It reads the heat, a token, a buy quote, the signed-in wallet, the pools, and checks a planned private withdrawal.
 * It never signs, sends or approves anything: a quote becomes a card that opens the token page's own review, a withdrawal
 * plan points to the cold side. A wallet signs one message to open it; the session is an HMAC token keyed from the
 * server's API key, so no store is needed. Once the $KELVO contract and HOLDER_MIN_USD are set it opens for holders only;
 * until then any signed-in wallet gets it on tighter limits. Limits are kept in memory per instance.
 */
export class AgentError extends Error { constructor(message, status = 400, extra = null) { super(message); this.status = status; this.extra = extra; } }

const apiKey = () => (process.env.AGENT_API_URL && process.env.AGENT_API_KEY) || null;
const MODEL = () => process.env.AGENT_MODEL || "Qwen/Qwen3.6-35B-A3B";
// the tools carry the reasoning, so the model answers without a long think first (fast, and the first token arrives sooner)
const REASONING = () => process.env.AGENT_REASONING || "none";
const addr = (v) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);
const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
const round = (v, d = 6) => (v == null ? null : Number(v.toPrecision(d)));


const memo = new Map();
async function cached(key, ttl, load) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  memo.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- sessions
const b64 = (v) => Buffer.from(v).toString("base64url");
const secret = () => createHash("sha256").update("kelvo-agent-session-v1\0").update(apiKey() || "").digest();
export function issueToken(account, now = Date.now()) {
  const body = b64(JSON.stringify({ a: account, e: now + AGENT_SESSION_HOURS * 3600e3 }));
  return body + "." + b64(createHmac("sha256", secret()).update(body).digest());
}
export function readToken(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 400) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", secret()).update(body).digest(), got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const { a, e } = JSON.parse(Buffer.from(body, "base64url").toString());
    return addr(a) && Number.isFinite(e) && e > now ? { account: addr(a), expiresAt: e } : null;
  } catch { return null; }
}

// The holder gate turns on by itself once the contract and the bar are both set.
export const GATED = Boolean(IDENTITY.contract && HOLDER_MIN_USD);
export function status() { return { configured: Boolean(apiKey()), gated: GATED, minUsd: GATED ? HOLDER_MIN_USD : null, sessionHours: AGENT_SESSION_HOURS }; }

/** Verify the signed sign-in message, then the $KELVO holding when the gate is on, then issue a session token. */
export async function openSession(body) {
  if (!apiKey()) throw new AgentError("The agent is not configured yet.", 503);
  const b = body && typeof body === "object" ? body : {};
  const account = addr(b.account);
  const issued = typeof b.issued === "string" && b.issued.length < 40 ? b.issued : null, t = issued ? Date.parse(issued) : NaN;
  const nonce = typeof b.nonce === "string" && /^[0-9a-f]{16,64}$/.test(b.nonce) ? b.nonce : null;
  const signature = typeof b.signature === "string" && /^0x[0-9a-fA-F]{130,4000}$/.test(b.signature) ? b.signature : null;
  if (!account || !nonce || !signature || !Number.isFinite(t)) throw new AgentError("Invalid sign-in request.", 400);
  if (Math.abs(Date.now() - t) > 10 * 60e3) throw new AgentError("This sign-in has expired. Sign again.", 401);
  const valid = await chain.verifyMessage({ address: account, message: agentSignInMessage(account, issued, nonce), signature }).catch(() => false);
  if (!valid) throw new AgentError("The signature does not match this wallet.", 401);
  let holder = null;
  if (GATED) {
    holder = await getHolder(account);
    if (holder.worthUsd == null) throw new AgentError(`The ${IDENTITY.ticker} price could not be read right now. Try again in a moment.`, 503);
    if (!holder.ok) throw new AgentError(`The agent opens for wallets holding $${HOLDER_MIN_USD} of ${IDENTITY.ticker}.`, 403, { holder });
  }
  const token = issueToken(account);
  return { token, account, expiresAt: readToken(token).expiresAt, holder: holder ? { amount: holder.amount, worthUsd: holder.worthUsd } : null };
}

// ---------------------------------------------------------------- limits
// Open to any signed-in wallet while there is no holder gate, so the limits are tighter and the instance has a ceiling too.
const LIMITS = GATED ? { burst: 12, day: 80, hour: Infinity } : { burst: 6, day: 30, hour: 240 };
const hits = new Map(), recent = [];
function limit(account) {
  const now = Date.now(), list = (hits.get(account) || []).filter((t) => now - t < 24 * 3600e3);
  while (recent.length && now - recent[0] > 3600e3) recent.shift();
  if (recent.length >= LIMITS.hour) throw new AgentError("The agent is busy this hour. Ask again a little later.", 429);
  if (list.filter((t) => now - t < 10 * 60e3).length >= LIMITS.burst) throw new AgentError(`That is ${LIMITS.burst} questions in 10 minutes. Wait a few minutes and ask again.`, 429);
  if (list.length >= LIMITS.day) throw new AgentError(`This wallet reached today's ${LIMITS.day} questions. It opens again tomorrow.`, 429);
  list.push(now); hits.set(account, list); recent.push(now);
}
function history(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 40) throw new AgentError("Invalid conversation.", 400);
  const out = raw.slice(-12).map((m) => {
    const role = m?.role === "assistant" ? "assistant" : m?.role === "user" ? "user" : null;
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    if (!role || !text || text.length > (role === "user" ? AGENT_MAX_INPUT : 6000)) throw new AgentError("Invalid conversation.", 400);
    return { role, content: text };
  });
  while (out.length && out[0].role !== "user") out.shift();
  if (!out.length || out[out.length - 1].role !== "user") throw new AgentError("Invalid conversation.", 400);
  for (let i = 1; i < out.length; i++) if (out[i].role === out[i - 1].role) throw new AgentError("Invalid conversation.", 400);
  return out;
}

// ---------------------------------------------------------------- tools
/** Holder count from the token feed (refreshed by the feed itself every so often), or null. */
async function holders(address) {
  return cached("holders:" + address, 5 * 60e3, async () => {
    const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${address}/info`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) return null;
    const h = (await r.json())?.data?.attributes?.holders;
    return Number.isFinite(h?.count) ? { count: h.count, updatedAt: h.last_updated || null } : null;
  }).catch(() => null);
}
const fmtAmount = (raw, decimals) => { if (raw == null || decimals == null) return null; const n = Number(formatUnits(BigInt(raw), decimals)); return round(n, 6); };
const whole = (v) => (v == null ? null : Math.round(v));
const heatRow = (t) => ({ symbol: t.symbol, name: t.name, address: t.address, group: t.group, kelvin: t.kelvin, trades1h: t.trades1h, trades24h: t.trades24h, buyShare1h: t.buyShare1h, priceUsd: t.priceUsd, change24h: t.change24h == null ? null : round(t.change24h, 4), liquidityUsd: whole(t.liquidityUsd), volume24h: whole(t.volume24h), venue: t.pool?.venue ?? null, routable: t.pool?.routable ?? false });
const coinTemp = (c) => {
  const trades1h = c.buys1h != null ? c.buys1h + (c.sells1h ?? 0) : null, trades24h = c.buys24h != null ? c.buys24h + (c.sells24h ?? 0) : null;
  return { kelvin: c.kelvin ?? null, trades1h, trades24h, buyShare1h: trades1h ? Math.round(((c.buys1h ?? 0) / trades1h) * 100) : null, volume1h: whole(c.volume1h), turnover1h: c.volume1h != null && c.liquidityUsd > 0 ? round(c.volume1h / c.liquidityUsd, 3) : null };
};
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 20) * 10; };

export const TOOLS = [
  { name: "heat_board", description: "Tokens on the Kelvo heat board (Robinhood Chain memes and tokenized stocks), each with its temperature in kelvin read from its trading, trades in the last hour and day, the buy share of the last hour, price, 24h change, liquidity, 24h volume and whether the token page can route a buy. Hottest first, or coldest first. Optional search by symbol, name or contract. Also returns the board's size and median temperature.", input_schema: { type: "object", properties: { query: { type: "string", description: "Symbol, name or contract to search" }, group: { type: "string", enum: ["memes", "stocks"] }, order: { type: "string", enum: ["hottest", "coldest"] }, limit: { type: "integer", minimum: 1, maximum: 15 } } } },
  { name: "token_report", description: "One token by contract address: its temperature in kelvin with the inputs of the rule (trades in the last hour and day, buy share, last hour volume against liquidity), price and its source, 24h change, volume, liquidity, buys and sells, market cap, holder count, its pools, the buy route, and the last 24 hourly candles summarised.", input_schema: { type: "object", properties: { address: { type: "string", description: "0x contract address" } }, required: ["address"] } },
  { name: "quote_buy", description: "Quote buying a token with ETH through the token page's route. Read only, nothing is sent. Returns the route, the expected amount and the minimum at 1% slippage. The user reviews and signs it on the token page.", input_schema: { type: "object", properties: { address: { type: "string", description: "0x contract address" }, eth: { type: "string", description: "ETH to spend, decimal string such as 0.05" } }, required: ["address", "eth"] } },
  { name: "my_wallet", description: "The signed-in wallet: ETH balance and the board tokens it holds, each with its amount, dollar worth and temperature.", input_schema: { type: "object", properties: {} } },
  { name: "privacy_pools", description: "The ETH and USDG private pools on Robinhood Chain that the cold side uses: the withdrawal fee (a flat relay fee plus a rate), minimum deposit and withdrawal, notes in each pool and notes added in the last 24 hours.", input_schema: { type: "object", properties: {} } },
  { name: "check_withdrawal", description: "Check a planned private withdrawal before the user makes it: the fee and the amount received, privacy checks on the amount's shape, matching the deposit amount, time since the deposit, the recipient and how busy the pool is, and the trail ΔT (how far the withdrawal stands out from the pool, 0 K blends in). Rules of thumb, not a guarantee.", input_schema: { type: "object", properties: { token: { type: "string", enum: ["eth", "usdg"] }, amount: { type: "string", description: "Amount to withdraw, decimal string" }, deposit_amount: { type: "string", description: "The amount that was deposited, if the user said" }, hours_since_deposit: { type: "number", description: "Hours between the deposit and this withdrawal, if the user said" }, to_new_address: { type: "boolean", description: "true if the recipient is a fresh address with no link to the depositing wallet, false if it is the same or a linked wallet" } }, required: ["token", "amount"] } },
];

const RUN = {
  async heat_board(input) {
    const heat = await getHeat(), group = input?.group === "memes" || input?.group === "stocks" ? input.group : null;
    const read = heat.tokens.filter((t) => t.kelvin != null);
    let rows = heat.tokens.filter((t) => !group || t.group === group);
    const q = typeof input?.query === "string" ? input.query.trim().replace(/^\$/, "").toLowerCase().slice(0, 42) : "";
    if (q) rows = rows.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.address === q);
    const order = input?.order === "coldest" ? "coldest" : "hottest";
    if (order === "coldest") rows = rows.filter((t) => t.kelvin != null).sort((a, b) => a.kelvin - b.kelvin);
    const n = Math.min(15, Math.max(1, Math.floor(Number(input?.limit)) || 8));
    const tokens = rows.slice(0, n).map(heatRow);
    // $KELVO and pasted contracts open even when they are not on the board
    const direct = addr(q) || (IDENTITY.contract && q === IDENTITY.ticker.slice(1).toLowerCase() ? IDENTITY.contract : null);
    if (direct && !tokens.some((t) => t.address === direct)) {
      const c = await getCoin(direct).catch(() => null);
      if (c) tokens.unshift({ symbol: c.symbol, name: c.name, address: c.address, group: c.group, ...coinTemp(c), priceUsd: c.priceUsd, change24h: c.change24h, liquidityUsd: whole(c.liquidityUsd), volume24h: whole(c.volume24h), venue: c.route?.venue ?? null, routable: Boolean(c.route), onBoard: false });
    }
    const out = { matches: direct ? tokens.length : rows.length, order, tokens, board: { tokens: heat.tokens.length, medianKelvin: median(read.map((t) => t.kelvin)), hottest: read[0] ? { symbol: read[0].symbol, kelvin: read[0].kelvin } : null }, at: heat.at };
    const label = q ? `Searched the heat for ${q.toUpperCase().slice(0, 14)} · ${out.matches} found` : `Read the heat · ${order} ${tokens.length}`;
    return { out, card: { kind: "heat", query: q || null, order, tokens: tokens.slice(0, 9), medianKelvin: out.board.medianKelvin }, label };
  },
  async token_report(input) {
    const address = addr(input?.address);
    if (!address) throw new AgentError("That is not a contract address.");
    const [coin, holderCount] = await Promise.all([getCoin(address), holders(address)]);
    let day = null;
    if (coin.chartPool) {
      const c = (await getCandles(coin.chartPool, "1h").catch(() => null))?.candles?.slice(-24);
      if (c?.length) day = { candles: c.length, open: round(c[0].o), high: round(Math.max(...c.map((x) => x.h))), low: round(Math.min(...c.map((x) => x.l))), last: round(c[c.length - 1].c), volumeUsd: Math.round(c.reduce((s, x) => s + x.v, 0)) };
    }
    const out = { symbol: coin.symbol, name: coin.name, address, temperature: coinTemp(coin), priceUsd: coin.priceUsd, priceSource: coin.priceSource === "curve" ? "launch curve" : "pool", change24h: coin.change24h, volume24h: coin.volume24h, liquidityUsd: coin.liquidityUsd, marketCapUsd: coin.marketCapUsd ?? coin.fdvUsd, buys24h: coin.buys24h, sells24h: coin.sells24h, holders: holderCount?.count ?? null, holdersUpdatedAt: holderCount?.updatedAt ?? null, route: coin.route ? { venue: coin.route.venue, pair: coin.route.pair } : null, pools: coin.pools.slice(0, 4).map((p) => ({ pair: p.pair, venue: p.venue, liquidityUsd: p.liquidityUsd, volume24h: p.volume24h })), last24hHourly: day, isKelvo: Boolean(IDENTITY.contract) && address === IDENTITY.contract };
    return { out, card: { kind: "token", ...out, image: coin.image }, label: `Read ${coin.symbol || short(address)} · ${out.temperature.kelvin != null ? out.temperature.kelvin.toLocaleString("en-US") + " K" : "no reading"}` };
  },
  async quote_buy(input) {
    const address = addr(input?.address), eth = String(input?.eth ?? "").trim();
    if (!address) throw new AgentError("That is not a contract address.");
    if (!/^\d{1,3}(\.\d{1,18})?$/.test(eth) || !(Number(eth) > 0)) throw new AgentError("Give the ETH amount as a plain number, like 0.05.");
    if (Number(eth) > 10) throw new AgentError("The agent quotes up to 10 ETH. Use the token page for more.");
    const q = await getQuote({ address, amount: parseEther(eth).toString(), slippage: "100" });
    const out = { symbol: q.symbol, address, eth, venue: q.route?.venue ?? null, via: q.route?.via ?? null, expected: fmtAmount(q.amountOut, q.decimals), minimum: fmtAmount(q.minOut, q.decimals), slippagePercent: q.slippageBps / 100, reason: q.reason, quotedAt: q.at };
    return { out, card: { kind: "quote", ...out, link: `/token/${address}?buy=${eth}` }, label: q.reason ? `No route for ${q.symbol}` : `Quoted ${eth} ETH → ${q.symbol} on ${out.venue}` };
  },
  async my_wallet(_input, ctx) {
    const account = ctx.account;
    const [bal, list, heat] = await Promise.all([getBalances(account).catch(() => null), getList().catch(() => null), getHeat().catch(() => null)]);
    const coins = new Map([...(list?.memes || []), ...(list?.stocks || [])].map((c) => [c.address, c]));
    const temps = new Map((heat?.tokens || []).map((t) => [t.address, t.kelvin]));
    const holdings = (bal?.items || []).map((i) => { const c = coins.get(i.address); const amount = c?.decimals != null ? fmtAmount(i.raw, c.decimals) : null; return c && amount ? { symbol: c.symbol, address: c.address, amount, usd: c.priceUsd != null ? Math.round(amount * c.priceUsd * 100) / 100 : null, kelvin: temps.get(c.address) ?? null } : null; })
      .filter(Boolean).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)).slice(0, 8);
    const out = { account, eth: bal?.eth != null ? fmtAmount(bal.eth, 18) : null, holdings, project: IDENTITY.contract ? { ticker: IDENTITY.ticker, contract: IDENTITY.contract } : { ticker: IDENTITY.ticker, contract: null, note: "no contract yet" } };
    return { out, card: { kind: "wallet", ...out }, label: `Read your wallet ${short(account)}` };
  },
  async privacy_pools() {
    const [h, act] = await Promise.all([privacyHealth(), poolActivity().catch(() => null)]);
    const c = h.config, pools = {};
    for (const [k, p] of Object.entries(POOLS)) pools[k] = { symbol: p.symbol, notes: act?.[k]?.notes ?? null, notes24h: act?.[k]?.notes24h ?? null, maximumDeposit: h.pools?.[k]?.maximum ? fmtAmount(h.pools[k].maximum, p.decimals) : null, minimumDeposit: c.minimum_deposit[k], minimumWithdrawal: c.minimum_withdrawal[k], flatFee: c.rent_fees[k] };
    const out = { feeRateBps: c.fee_rate, feeRule: "withdrawal fee = flat relay fee + amount x rate", pools };
    return { out, card: { kind: "pools", ...out }, label: `Read the private pools · ${pools.eth.notes?.toLocaleString("en-US") ?? "—"} ETH notes` };
  },
  async check_withdrawal(input) {
    const [h, act] = await Promise.all([privacyHealth(), poolActivity().catch(() => null)]);
    const out = withdrawCheck(input, h.config, act);
    return { out, card: { kind: "privacy", ...out }, label: `Checked a ${out.amount} ${out.symbol} withdrawal · ${out.deltaK == null ? "blocked" : "ΔT +" + out.deltaK + " K"}` };
  },
};
const startLabel = (name, input) => ({ heat_board: input?.query ? `Searching the heat for ${String(input.query).slice(0, 20)}` : "Reading the heat", token_report: "Reading the token on chain", quote_buy: `Quoting ${String(input?.eth ?? "").slice(0, 12)} ETH`, my_wallet: "Reading your wallet", privacy_pools: "Reading the private pools", check_withdrawal: `Checking a ${String(input?.amount ?? "").slice(0, 12)} ${input?.token === "usdg" ? "USDG" : "ETH"} withdrawal` }[name] || "Reading");

const system = (account) => `You are the Kelvo agent on Robinhood Chain. Kelvo gives every token a temperature in kelvin, read from how it trades. You help the signed-in wallet read the heat, check a token, quote a buy and plan a private transfer, using Kelvo's tools.

What Kelvo is:
- Heat board: the coins and tokenized stocks on Robinhood Chain from public pool feeds, each with a temperature. The rule: K = 30 x sqrt(trades in 24h) + 260 x ln(1 + trades in the last hour) x (0.75 + 0.5 x buy share of the last hour) x (1 + min(3, last hour volume / liquidity) / 2), rounded to 10. 0 K means no trade in 24 hours. Temperature is motion, not price: a token can run hot while it falls. Never work the rule out yourself; the tools return the reading and its inputs.
- Token page: the temperature taken apart term by term, a chart, the pools and a buy with ETH from the user's own wallet through Uniswap V3, Uniswap V4 or a Pons curve. The route is checked on chain, the call is rebuilt in the browser and dry-run before the wallet opens. Kelvo adds no fee.
- Cold side: an independent interface to the Privacy Cash EVM 1.3.3 private pools for ETH and USDG on Robinhood Chain. Deposits are wallet transactions; withdrawals are proved in the browser and sent through an external relay. On a thermal camera what matches the background disappears, so check_withdrawal returns a trail ΔT: 0 K blends in with the pool, each risk adds 40 K, each warning 15 K, each unknown 5 K. Privacy is not anonymity: amounts, timing and addresses can link a deposit to a withdrawal.
- ${IDENTITY.ticker}: ${IDENTITY.contract ? `contract ${IDENTITY.contract}.` : "no contract yet. Never give or guess a contract address for it."} Holder benefits and fees are TBA. ${GATED ? `The agent opens for wallets holding $${HOLDER_MIN_USD} of ${IDENTITY.ticker}.` : `Until ${IDENTITY.ticker} exists the agent opens for any signed-in wallet with a daily limit.`}

Rules:
- Every number you give comes from a tool result for the current question. Call the tools again for each new question, even when a similar number appeared earlier. Never calculate fees or temperatures yourself. If a tool fails or a value is missing, say it is unknown. Never estimate or invent figures.
- You cannot sign, send, approve or move anything. For a buy, quote it and say the card opens it on the token page for review. For a private transfer, check the plan and point to the cold side.
- Never ask for a seed phrase, private key or signature. If someone offers one, tell them never to share it.
- No price predictions and no advice on what to buy. A hot token is busy, not good; describe what the data shows.
- Never call a plan safe, private or guaranteed. Say which checks pass and which do not, give the trail ΔT, and say the checks are rules of thumb.
- Reply in the language of the user's last message: Indonesian when they write Indonesian, English when they write English.
- Short answers: two to five sentences or a short list with "- " items. Plain words, no headings, no tables, no em dashes. Write temperatures like 1,240 K.
- Say Robinhood Chain for the network and never give its chain id. Do not name data vendors; say the pool feed or on chain. Do not name the model or who hosts it; if asked, say Kelvo runs a hosted language model.
- Tokens are identified by contract address because many share a symbol. When a search returns several, list them with short addresses and ask which one.
- The signed-in wallet is ${account}. Use my_wallet for the user's own holdings.`;

const FUNCTIONS = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
/**
 * One streamed chat completion: text deltas go to onText as they arrive, tool calls are assembled from their pieces.
 * Provider errors are not passed through to the reader.
 */
async function complete(messages, signal, onText, firstStep = false) {
  const res = await fetch(process.env.AGENT_API_URL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(55000)]),
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.AGENT_API_KEY },
    body: JSON.stringify({ model: MODEL(), messages, tools: FUNCTIONS, tool_choice: firstStep ? "required" : "auto", stream: true, stream_options: { include_usage: true }, temperature: 0.3, max_tokens: 1600, reasoning_effort: REASONING() }),
  });
  if (!res.ok || !res.body) throw new AgentError(res.status === 429 ? "The model is busy right now. Ask again in a minute." : "The model could not answer right now. Ask again.", 502);
  const reader = res.body.getReader(), dec = new TextDecoder(), calls = [];
  let buf = "", content = "", usage = { input: 0, output: 0 };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens || 0, output: chunk.usage.completion_tokens || 0 };
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) { content += delta.content; onText(delta.content); }
      for (const t of delta.tool_calls || []) {
        const at = Number.isInteger(t.index) ? t.index : calls.length;
        const c = (calls[at] ||= { id: "", name: "", args: "" });
        if (t.id) c.id = t.id;
        if (t.function?.name) c.name += t.function.name;
        if (t.function?.arguments) c.args += t.function.arguments;
      }
    }
  }
  return { content, usage, calls: calls.filter(Boolean).map((c, n) => ({ ...c, id: c.id || "call_" + n })) };
}

/** Validate the request and return a runner that streams events through emit(event, data). Throws AgentError first. */
export async function startChat(body) {
  if (!apiKey()) throw new AgentError("The agent is not configured yet.", 503);
  const session = readToken(body?.token);
  if (!session) throw new AgentError("Your agent session ended. Sign in again.", 401);
  const msgs = history(body?.messages);
  if (GATED) {
    const holder = await getHolder(session.account).catch(() => null);
    if (holder && holder.worthUsd != null && !holder.ok) throw new AgentError(`This wallet now holds less than $${HOLDER_MIN_USD} of ${IDENTITY.ticker}.`, 403);
  }
  limit(session.account);
  return agentLoop(session.account, msgs);
}

/** The model and tool loop for one signed-in wallet, after the gate. Exported for the protocol test. */
export function agentLoop(account, msgs) {
  const session = { account };
  return async (emit, signal) => {
    const convo = [{ role: "system", content: system(session.account) }, ...msgs];
    let usage = { input: 0, output: 0 };
    for (let step = 0; step < 6; step++) {
      // the first step must read something, so an answer never starts from memory
      const r = await complete(convo, signal, (delta) => emit("text", { delta }), step === 0);
      usage = { input: usage.input + r.usage.input, output: usage.output + r.usage.output };
      convo.push({ role: "assistant", content: r.content || null, ...(r.calls.length ? { tool_calls: r.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) } : {}) });
      if (!r.calls.length) break;
      for (const c of r.calls) {
        let input = {};
        try { input = c.args ? JSON.parse(c.args) : {}; } catch { /* reported below */ }
        emit("tool", { id: c.id, name: c.name, state: "run", label: startLabel(c.name, input) });
        try {
          if (!RUN[c.name]) throw new AgentError("Unknown tool.");
          if (c.args && typeof input !== "object") throw new AgentError("The tool input could not be read.");
          const out = await RUN[c.name](input, { account: session.account });
          emit("tool", { id: c.id, name: c.name, state: "done", label: out.label, card: out.card });
          convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out.out) });
        } catch (e) {
          const message = e instanceof Error ? e.message.slice(0, 200) : "The reading failed.";
          emit("tool", { id: c.id, name: c.name, state: "error", label: message });
          convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: message }) });
        }
      }
      if (step === 5) emit("text", { delta: "\n\nI stopped after several readings. Ask again with one thing at a time." });
    }
    emit("done", { usage, account: session.account });
  };
}

/** One tool by name, for the checks in scripts/agent-check.mjs. */
export const runTool = (name, input, ctx = {}) => RUN[name](input, ctx);
