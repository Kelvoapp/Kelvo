/**
 * Kelvo tape: the board's trades as they land on chain, newest first.
 *
 * A refresh (at most one per 2.5 s per instance) reads the head block, then eth_getLogs over the blocks since the last
 * refresh (at most 80, about 8 s at Robinhood Chain's ~10 blocks a second) for four events in one call:
 *   Uniswap V3 Swap from any emitter (the emitter is the pool), Uniswap V4 Swap from the PoolManager only (topics[1] is
 *   the pool id), and Pons CurveBuy / CurveSell from the curve of a board token still on its launch curve.
 * Only swaps in the feed pools of board tokens are kept: the V3 pool address or the V4 pool id as the feed writes them
 * (V4 ids are the 32-byte pool id in the pool's address field). Each trade is read from the board token's own amount:
 *   V3 amounts are the pool's deltas, so a negative base amount left the pool: the trader received it, a buy.
 *   V4 amounts are the trader's deltas, so a positive base amount went to the trader: a buy.
 *   CurveBuy carries tokensOut (a buy), CurveSell tokensIn (a sell).
 * Token order: V3 token0/token1 are read once per pool through Multicall3; V4 currency0/currency1 come from the pool
 * key in the PoolManager's Initialize record, checked against the pool id. Until a pool's order has been read, the
 * factories' own rule orders it: both sort the pair by address, and native ETH is address 0, always first.
 * Times are the block timestamps the logs carry (1 s resolution). A node that leaves them out is answered from the head
 * block read in the same refresh, each block placed back from it at the chain's measured pace (approximate; about 0.1 s
 * a block when the pace has not been measured yet).
 * The ring keeps about two minutes of trades per instance, so every client's `since` is answered from memory and the
 * chain is read once per refresh, however many clients poll.
 */
import { createPublicClient, custom, erc20Abi, formatUnits, http, parseAbi } from "viem";
import { FeedError, getBoardPools } from "./heat.js";
import { MULTICALL3, PONS_FACTORY, POOL_MANAGER } from "../src/chain-addresses.js";
import { poolIdOf } from "../src/chain-route.js";

// The dedicated endpoint first when the server has one (its URL carries a token, so it lives only in env), the public
// ones after. An endpoint that fails as a connection (timeout, refused, TLS, HTTP status such as 429) is skipped for two
// minutes, so a dead or rate-limited endpoint costs one timeout, not one per call; an error the node answers moves on without that.
const RPCS = [process.env.ROBINHOOD_RPC_URL, "https://rpc.mainnet.chain.robinhood.com", "https://evm.privacycash.org/rpc/robinhood"].filter(Boolean);
const endpoints = RPCS.map((url) => ({ down: 0, request: http(url, { timeout: 6000, retryCount: 0 })({ retryCount: 0 }).request }));
const client = createPublicClient({
  transport: custom({
    async request({ method, params }) {
      const now = Date.now(), order = [...endpoints.filter((e) => e.down <= now), ...endpoints.filter((e) => e.down > now)];
      let last = null;
      for (const e of order) {
        try { return await e.request({ method, params }); } catch (err) {
          last = err;
          if (err?.name === "HttpRequestError" || err?.name === "TimeoutError") e.down = Date.now() + 120000;
        }
      }
      throw last;
    },
  }, { retryCount: 0 }),
});

export const TOPICS = {
  v3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // Swap(address,address,int256,int256,uint160,uint128,int24)
  v4: "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f", // Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)
  curveBuy: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455", // CurveBuy(address,address,uint256,uint256,uint256,uint256)
  curveSell: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df", // CurveSell(address,address,uint256,uint256,uint256,uint256)
};
const INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
export const MAX_SPAN = 80; // blocks per read
const KEEP_BLOCKS = 1200; // the ring keeps about two minutes
const RING_CAP = 480;
export const CAP = 120; // trades per response
const TTL = 2500;

const pool3Abi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)"]);
const ponsAbi = parseAbi(["struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }", "function getLaunchedToken(address token) view returns (LaunchedToken)"]);

// ---------- budget ----------
const RPC_PER_MIN = 160;
const stamps = [];
function used() {
  const now = Date.now();
  while (stamps.length && stamps[0] < now - 60000) stamps.shift();
  return stamps.length;
}
function spend(n) {
  if (used() + n > RPC_PER_MIN) throw new FeedError("The chain reader is cooling down. Try again in a moment.", 429);
  for (let i = 0; i < n; i++) stamps.push(Date.now());
}
const room = (n, share) => used() + n <= RPC_PER_MIN * share;

// ---------- decoding (pure) ----------
const hex = (n) => "0x" + Math.max(0, Math.floor(n)).toString(16);
const word = (data, i) => BigInt("0x" + ((data || "0x").slice(2 + 64 * i, 66 + 64 * i) || "0"));
const signed = (w) => BigInt.asIntN(256, w);
const sig6 = (x) => Number(x.toPrecision(6));

/** The tape's kind of a board pool: "v3" for a 20-byte pool address, "v4" for a 32-byte pool id, null otherwise (V2 pairs, launch curves). */
export function poolKind(pool) {
  const id = String(pool?.id || "").toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(id)) return "v4";
  if (/^0x[0-9a-f]{40}$/.test(id) && !/(^|-)v2(-|$)/.test(pool?.dex || "")) return "v3";
  return null;
}
/** Board pools keyed by V3 address or V4 pool id. */
export function indexPools(pools) {
  const out = new Map();
  for (const p of pools || []) {
    const kind = poolKind(p);
    if (!kind || !p.base || !p.token) continue;
    const id = p.id.toLowerCase();
    if (!out.has(id)) out.set(id, { ...p, id, kind });
  }
  return out;
}
/** The pair in the factories' order: sorted by address (equal-length lowercase hex sorts like the numbers). */
export const sortedOrder = (pool) => (pool?.base && pool?.quote ? { c0: [pool.base, pool.quote].sort()[0], c1: [pool.base, pool.quote].sort()[1], how: "sorted" } : null);
/** A V4 pool key from the PoolManager's Initialize record. */
export function keyOf(log) {
  return {
    currency0: ("0x" + log.topics[2].slice(26)).toLowerCase(), currency1: ("0x" + log.topics[3].slice(26)).toLowerCase(),
    fee: Number(BigInt(log.data.slice(0, 66))), tickSpacing: Number(BigInt.asIntN(24, BigInt("0x" + log.data.slice(66, 130)))), hooks: ("0x" + log.data.slice(154, 194)).toLowerCase(),
  };
}

/**
 * One log as a trade on a board token, or null when it is not one.
 * ctx: { pools: Map<id, pool>, curves: Map<curve, token>, tokens: Map<address, reading>, decimals: Map<token, n>,
 *        order(pool) -> {c0, c1} | null, time(log) -> ms | null }
 */
export function tradeOf(log, ctx) {
  if (!log || log.removed || !Array.isArray(log.topics)) return null;
  const topic = log.topics[0], emitter = String(log.address || "").toLowerCase();
  let token, id, side, raw, decimals, venue;
  if (topic === TOPICS.v3 || topic === TOPICS.v4) {
    const v4 = topic === TOPICS.v4;
    if (v4 && emitter !== POOL_MANAGER) return null;
    id = v4 ? String(log.topics[1] || "").toLowerCase() : emitter;
    const pool = ctx.pools.get(id);
    if (!pool || pool.kind !== (v4 ? "v4" : "v3")) return null;
    const order = ctx.order(pool);
    const i = order?.c0 === pool.base ? 0 : order?.c1 === pool.base ? 1 : -1;
    if (i < 0) return null;
    const amt = signed(word(log.data, i));
    if (amt === 0n) return null;
    side = (v4 ? amt > 0n : amt < 0n) ? "buy" : "sell";
    raw = amt < 0n ? -amt : amt;
    token = pool.token; venue = pool.venue; decimals = pool.baseDecimals ?? ctx.decimals?.get(pool.token);
  } else if (topic === TOPICS.curveBuy || topic === TOPICS.curveSell) {
    token = ctx.curves?.get(emitter);
    if (!token) return null;
    id = emitter; venue = "Pons curve";
    side = topic === TOPICS.curveBuy ? "buy" : "sell";
    // CurveBuy(quoteIn, tokensOut, fee, tax) and CurveSell(tokensIn, quoteOut, fee, tax)
    raw = word(log.data, side === "buy" ? 1 : 0);
    if (raw === 0n) return null;
    decimals = ctx.decimals?.get(token);
  } else return null;
  const r = ctx.tokens.get(token);
  if (!r || decimals == null) return null;
  const amount = Number(formatUnits(raw, decimals));
  const ms = ctx.time ? ctx.time(log) : null;
  return {
    token, symbol: r.symbol, side, amount, usd: r.priceUsd != null ? sig6(amount * r.priceUsd) : null, venue, pool: id,
    tx: log.transactionHash, block: Number(BigInt(log.blockNumber)), logIndex: Number(BigInt(log.logIndex)),
    at: ms != null && Number.isFinite(ms) ? new Date(ms).toISOString() : null, kelvin: r.kelvin ?? null,
  };
}
/** Every board trade in a batch of logs, newest first. */
export function decodeLogs(logs, ctx) {
  const out = [];
  for (const l of logs || []) { const t = tradeOf(l, ctx); if (t) out.push(t); }
  return out.sort((a, b) => b.block - a.block || b.logIndex - a.logIndex);
}
/** Newest-first trades cut to at most `cap` on a block boundary; fromBlock is the first block the result covers in full. */
export function windowOf(trades, cap, fromBlock) {
  if (trades.length <= cap) return { trades, fromBlock };
  const cut = trades[cap].block;
  return { trades: trades.filter((t) => t.block > cut), fromBlock: cut + 1 };
}
/** A trade's time: the log's own block timestamp, else placed back from the head block at `rate` blocks a second. */
export function timeOf(log, head, headTs, rate = 10) {
  // some nodes send 0x0 for a log's block timestamp; that is unknown, not 1970
  const own = log.blockTimestamp != null ? Number(BigInt(log.blockTimestamp)) : 0;
  if (own > 0) return own * 1000;
  if (head == null || headTs == null) return null;
  return Math.round(headTs * 1000 - ((head - Number(BigInt(log.blockNumber))) / rate) * 1000);
}

// ---------- reads ----------
const orders = new Map(); // pool id -> {c0, c1, how: "read" | "key"} | {bad: true}
const retryAt = new Map(); // pool id or token -> when a failed read may run again
const known = new Map(); // token -> decimals
const verifying = new Set();
const orderOf = (pool) => { const o = orders.get(pool.id); return o ? (o.bad ? null : o) : sortedOrder(pool); };
const waiting = (k) => (retryAt.get(k) ?? 0) > Date.now();
const mark = (k, ms) => { retryAt.set(k, Date.now() + ms); if (retryAt.size > 2000) retryAt.delete(retryAt.keys().next().value); };

/** A Pons token still on its launch curve trades on the curve: the factory names the curve of each board token (one Multicall3 read, every 10 minutes). */
let curveMemo = { at: 0, ok: false, map: new Map() };
async function curvesFor(tokens) {
  if (Date.now() - curveMemo.at < (curveMemo.ok ? 600000 : 60000)) return curveMemo.map;
  const memes = tokens.filter((t) => t.group === "memes").slice(0, 150);
  curveMemo = { ...curveMemo, at: Date.now(), ok: false };
  if (!memes.length || !room(1, 0.8)) return curveMemo.map;
  try {
    spend(1);
    const res = await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0, contracts: memes.map((t) => ({ address: PONS_FACTORY, abi: ponsAbi, functionName: "getLaunchedToken", args: [t.address] })) });
    const map = new Map();
    res.forEach((r, i) => {
      const l = r.status === "success" ? r.result : null;
      if (l?.exists && Number(l.phase) === 0 && l.token.toLowerCase() === memes[i].address) map.set(l.curve.toLowerCase(), memes[i].address);
    });
    curveMemo = { at: Date.now(), ok: true, map };
  } catch { /* keep the last map */ }
  return curveMemo.map;
}

/** V3 token order and missing decimals for pools and tokens first seen in this batch, in one Multicall3 read. */
async function readMissing(logs, ctx) {
  const pools = new Map(), tokens = new Set();
  for (const l of logs) {
    const t0 = l.topics?.[0], emitter = String(l.address || "").toLowerCase();
    let token = null;
    if (t0 === TOPICS.v3 || t0 === TOPICS.v4) {
      const p = ctx.pools.get(t0 === TOPICS.v4 ? String(l.topics[1] || "").toLowerCase() : emitter);
      if (!p) continue;
      token = p.token;
      if (p.kind === "v3" && !orders.has(p.id) && !waiting(p.id)) pools.set(p.id, p);
      if (p.baseDecimals != null) continue;
    } else if (t0 === TOPICS.curveBuy || t0 === TOPICS.curveSell) token = ctx.curves.get(emitter) || null;
    if (token && !known.has(token) && !waiting(token)) tokens.add(token);
  }
  const v3 = [...pools.values()].slice(0, 80), toks = [...tokens].slice(0, 40);
  if (!v3.length && !toks.length) return;
  if (!room(1, 0.85)) return;
  try {
    spend(1);
    const contracts = [...v3.flatMap((p) => [{ address: p.id, abi: pool3Abi, functionName: "token0" }, { address: p.id, abi: pool3Abi, functionName: "token1" }]), ...toks.map((t) => ({ address: t, abi: erc20Abi, functionName: "decimals" }))];
    const res = await client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 0, contracts });
    v3.forEach((p, i) => {
      const a = res[2 * i], b = res[2 * i + 1];
      if (a?.status !== "success" || b?.status !== "success") return mark(p.id, 3600000);
      const c0 = a.result.toLowerCase(), c1 = b.result.toLowerCase();
      orders.set(p.id, c0 === p.base || c1 === p.base ? { c0, c1, how: "read" } : { bad: true });
    });
    toks.forEach((t, i) => {
      const r = res[2 * v3.length + i];
      if (r?.status === "success") known.set(t, Number(r.result)); else mark(t, 3600000);
    });
  } catch {
    for (const p of v3) mark(p.id, 120000);
    for (const t of toks) mark(t, 120000);
  }
}

/** The chain's pace in blocks a second, from the head and a block a million back (once an hour). */
let paceMemo = { at: 0, rate: null };
async function chainPace(head, headTs) {
  if (paceMemo.rate && Date.now() - paceMemo.at < 3600000) return paceMemo.rate;
  spend(1);
  const b = await client.request({ method: "eth_getBlockByNumber", params: [hex(head - 1000000), false] });
  const dt = headTs - Number(BigInt(b.timestamp));
  paceMemo = { at: Date.now(), rate: dt > 0 ? 1000000 / dt : 10 };
  return paceMemo.rate;
}
// The block at a time: interpolate from the chain's pace, then correct twice (a few reads, not a bisection).
async function blockAt(ts, head, headTs) {
  const rate = await chainPace(head, headTs);
  let guess = head - Math.round((headTs - ts) * rate);
  for (let i = 0; i < 2; i++) {
    if (guess < 1) guess = 1;
    spend(1);
    const b = await client.request({ method: "eth_getBlockByNumber", params: [hex(guess), false] });
    const off = ts - Number(BigInt(b.timestamp));
    if (Math.abs(off) < 30) break;
    guess += Math.round(off * rate);
  }
  return guess;
}
/** A V4 pool's currencies from its Initialize record near the pool's opening, checked against the pool id. */
async function verifyV4(pool, head, headTs) {
  const ts = Math.floor(Date.parse(pool.createdAt || "") / 1000);
  if (!Number.isFinite(ts)) return mark(pool.id, 86400000);
  const center = await blockAt(ts, head, headTs);
  for (const [from, to] of [[center - 4000, center + 5999], [center - 14000, center - 4001], [center + 6000, center + 15999]]) {
    const lo = Math.max(0, from), hi = Math.min(head, to);
    if (lo > hi) continue;
    spend(1);
    const logs = await client.request({ method: "eth_getLogs", params: [{ address: POOL_MANAGER, topics: [INITIALIZE, pool.id], fromBlock: hex(lo), toBlock: hex(hi) }] });
    const l = logs?.[0];
    if (!l) continue;
    const key = keyOf(l);
    if (poolIdOf(key) !== pool.id) { orders.set(pool.id, { bad: true }); return; }
    orders.set(pool.id, key.currency0 === pool.base || key.currency1 === pool.base ? { c0: key.currency0, c1: key.currency1, how: "key" } : { bad: true });
    return;
  }
  mark(pool.id, 3600000);
}
// One V4 pool that traded in this batch gets its key read per refresh, in the background and only with budget to spare.
function verifySome(trades, ctx, head, headTs) {
  if (verifying.size || !room(8, 0.5)) return;
  const pool = trades.map((t) => ctx.pools.get(t.pool)).find((p) => p?.kind === "v4" && !orders.has(p.id) && !waiting(p.id));
  if (!pool) return;
  verifying.add(pool.id);
  verifyV4(pool, head, headTs).catch(() => mark(pool.id, 600000)).finally(() => verifying.delete(pool.id));
}

// ---------- the ring ----------
let ctxMemo = { at: null, ctx: null };
async function contextFor(board) {
  if (ctxMemo.at !== board.at) {
    for (const p of board.pools) if (p.baseDecimals != null && p.token) known.set(p.token, p.baseDecimals);
    if (known.size > 4000) known.clear();
    ctxMemo = { at: board.at, ctx: { pools: indexPools(board.pools), tokens: new Map(board.tokens.map((t) => [t.address, t])) } };
  }
  const curves = await curvesFor(board.tokens);
  return { ...ctxMemo.ctx, curves, decimals: known };
}

let ring = { trades: [], head: null, headAt: null, fromBlock: null, at: null };
let inflight = null;
async function refresh() {
  const board = await getBoardPools();
  const ctx = await contextFor(board);
  spend(2);
  const hb = await client.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
  const head = Number(BigInt(hb.number)), headTs = Number(BigInt(hb.timestamp));
  if (ring.head != null && head <= ring.head) return (ring = { ...ring, at: new Date().toISOString() });
  const contiguous = ring.head != null && head - ring.head <= MAX_SPAN;
  const from = contiguous ? ring.head + 1 : head - MAX_SPAN + 1;
  const logs = await client.request({ method: "eth_getLogs", params: [{ fromBlock: hex(from), toBlock: hex(head), topics: [[TOPICS.v3, TOPICS.v4, TOPICS.curveBuy, TOPICS.curveSell]] }] });
  await readMissing(logs || [], ctx);
  const rate = paceMemo.rate ?? 10;
  const fresh = decodeLogs(logs, { ...ctx, order: orderOf, time: (l) => timeOf(l, head, headTs, rate) });
  verifySome(fresh, ctx, head, headTs);
  const floor = head - KEEP_BLOCKS + 1;
  let fromBlock = contiguous ? ring.fromBlock : from;
  if (floor > fromBlock) fromBlock = floor;
  const kept = (contiguous ? [...fresh, ...ring.trades] : fresh).filter((t) => t.block >= fromBlock);
  const w = windowOf(kept, RING_CAP, fromBlock);
  ring = { trades: w.trades, head, headAt: new Date(headTs * 1000).toISOString(), fromBlock: w.fromBlock, at: new Date().toISOString() };
  return ring;
}
async function current() {
  if (ring.at && Date.now() - Date.parse(ring.at) < TTL) return ring;
  if (!inflight) {
    inflight = refresh().catch((e) => {
      if (ring.head != null) return ring; // the last ring stands; its head and time show how old it is
      throw e instanceof FeedError ? e : new FeedError("The chain reader is unavailable right now.", 502);
    }).finally(() => { inflight = null; });
  }
  return inflight;
}

/**
 * The newest board trades: {trades, head, headAt, fromBlock, at}. Every swap in a board pool between fromBlock and head
 * is in `trades` (at most 120, cut on a block boundary). With sinceBlock, only blocks after it; when sinceBlock is older
 * than what this instance holds, fromBlock says where the tape starts.
 */
export async function getTape({ sinceBlock } = {}) {
  const r = await current();
  const since = Number.isSafeInteger(sinceBlock) && sinceBlock >= 0 ? sinceBlock : null;
  const floor = since != null && since + 1 > r.fromBlock ? since + 1 : r.fromBlock;
  const w = windowOf(r.trades.filter((t) => t.block >= floor), CAP, floor);
  return { trades: w.trades, head: r.head, headAt: r.headAt, fromBlock: w.fromBlock, at: r.at };
}
