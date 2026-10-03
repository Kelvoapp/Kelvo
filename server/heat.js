/**
 * Kelvo heat: every Robinhood Chain token on the public pool feed, read as a temperature.
 *
 * Temperature is motion. A token's kelvin comes only from how it trades, with the rule printed on the docs page:
 *   K = 30 * sqrt(trades in 24h)
 *     + 260 * ln(1 + trades in the last hour) * (0.75 + 0.5 * buy share of that hour) * (1 + min(3, hour volume / liquidity) / 2)
 * A token with no trade in 24 hours reads 0 K. Numbers come from the token's own pool on the feed; the feed is never
 * named in the interface. Budgets and caches keep the feed's rate limit.
 */
export { NATIVE };
export class FeedError extends Error { constructor(message, status = 503) { super(message); this.status = status; } }

import { NATIVE, USDG, WETH } from "../src/chain-addresses.js";

const FEED = "https://api.geckoterminal.com/api/v2/networks/robinhood";

// Tokenized stocks on Robinhood Chain, one contract per company (several impostors share names and symbols).
export const STOCKS = {
  "0x117cc2133c37b721f49de2a7a74833232b3b4c0c": "SPY", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec": "NVDA", "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea": "SPCX",
  "0xaf3d76f1834a1d425780943c99ea8a608f8a93f9": "AAPL", "0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3": "GOOGL", "0x322f0929c4625ed5bad873c95208d54e1c003b2d": "TSLA",
  "0xc0d6457c16cc70d6790dd43521c899c87ce02f35": "META", "0x6330d8c3178a418788df01a47479c0ce7ccf450b": "COIN", "0x12f190a9f9d7d37a250758b26824b97ce941bf54": "AMZN",
  "0xec262a75e413fafd0df80480274532c79d42da09": "MSTR", "0xe93237c50d904957cf27e7b1133b510c669c2e74": "MSFT", "0x894e1ec2d74ffe5aef8dc8a9e84686accb964f2a": "PLTR",
  "0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5": "CRCL", "0xc72b96e0e48ecd4dc75e1e45396e26300bc39681": "INTC", "0x1b0e319c6a659f002271b69db8a7df2f911c153e": "GME",
  "0x58ffe4a942d3885baa22d7520691f611ef09e7aa": "TSM",
};
const DEXES = { "uniswap-v3-robinhood": "Uniswap V3", "uniswap-v4-robinhood": "Uniswap V4", "pons-v2": "Pons curve", "pons-v2-dex": "Uniswap V4" };
// Names kept off the board.
const EXCLUDE_NAMES = /boner/i;

// An absent figure stays unknown: null and "" are not zero.
const num = (v) => { if (v == null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const count = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

// ---------- budgets and caches ----------
const stamps = [];
function budget(n, limit = 24) {
  const now = Date.now();
  while (stamps.length && stamps[0] < now - 60000) stamps.shift();
  if (stamps.length + n > limit) throw new FeedError("The heat reader is cooling down. Try again in a moment.", 429);
  for (let i = 0; i < n; i++) stamps.push(now);
}
const cache = new Map(), inflight = new Map();
export async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (inflight.has(key)) return inflight.get(key);
  const p = load().then((value) => { cache.set(key, { at: Date.now(), value }); if (cache.size > 600) cache.delete(cache.keys().next().value); return value; })
    .catch((e) => { if (hit) return hit.value; throw e; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
export async function feed(path, ttl = 60000) {
  return cached("feed:" + path, ttl, async () => {
    budget(1);
    const r = await fetch(FEED + path, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    if (r.status === 429) throw new FeedError("The pool feed is busy. Try again shortly.", 429);
    if (!r.ok) throw new FeedError("The pool feed is unavailable right now.", 502);
    return r.json();
  });
}

// ---------- temperature ----------
import { kelvin } from "../src/heat-rule.js";
export { kelvin };

// ---------- windows, pace, age ----------
/** The feed's trading windows, shortest first. */
export const WINDOWS = ["m5", "m15", "m30", "h1", "h6", "h24"];
/** Each window as {buys, sells, buyers, sellers, volumeUsd, change}; a figure the feed leaves out is null, a window with no figure at all is null. */
export function windowsOf(attributes) {
  const tx = attributes?.transactions || {}, vol = attributes?.volume_usd || {}, ch = attributes?.price_change_percentage || {};
  const out = {};
  for (const w of WINDOWS) {
    const t = tx[w] || {};
    const row = { buys: count(t.buys), sells: count(t.sells), buyers: count(t.buyers), sellers: count(t.sellers), volumeUsd: num(vol[w]), change: num(ch[w]) };
    out[w] = Object.values(row).every((v) => v == null) ? null : row;
  }
  return out;
}
/** Trades in the last hour over the day's hourly average, to 2 decimals: above 1 the hour runs hotter than the day, below 1 cooler. Unknown without a day of trades. */
export function paceOf(trades1h, trades24h) {
  if (trades1h == null || trades24h == null || !(trades24h > 0)) return null;
  return Math.round((trades1h / (trades24h / 24)) * 100) / 100;
}
/** Hours since the pool opened, to 0.1 h, at the board's reading time. */
export function ageHoursOf(createdAt, now = Date.now()) {
  const t = Date.parse(createdAt || "");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((now - t) / 360000) / 10);
}

const included = (json) => new Map((json.included || []).map((x) => [x.id, x]));
const idAddress = (id) => (typeof id === "string" ? id.split("_").pop().toLowerCase() : null);
/** A pool on the feed as the board reads it. */
export function poolRow(p, inc) {
  const a = p.attributes, rel = p.relationships || {};
  const tx = a.transactions || {}, vol = a.volume_usd || {}, ch = a.price_change_percentage || {};
  const dex = rel.dex?.data?.id || null;
  return {
    address: a.address?.toLowerCase(), name: a.name, venue: DEXES[dex] || null, routable: Boolean(DEXES[dex]),
    base: idAddress(rel.base_token?.data?.id), quote: idAddress(rel.quote_token?.data?.id), baseToken: inc?.get(rel.base_token?.data?.id)?.attributes || null,
    priceUsd: num(a.base_token_price_usd), change1h: num(ch.h1), change24h: num(ch.h24), liquidityUsd: num(a.reserve_in_usd),
    volume1h: num(vol.h1), volume24h: num(vol.h24), fdvUsd: num(a.fdv_usd), marketCapUsd: num(a.market_cap_usd),
    buys1h: tx.h1?.buys ?? null, sells1h: tx.h1?.sells ?? null, buys24h: tx.h24?.buys ?? null, sells24h: tx.h24?.sells ?? null,
    createdAt: a.pool_created_at || null,
    dex, windows: windowsOf(a),
  };
}
/** One token's reading from its pool. `now` dates the pool's age. */
export function reading(token, pool, group, now = Date.now()) {
  const address = token.address.toLowerCase();
  const trades1h = pool && pool.buys1h != null ? pool.buys1h + (pool.sells1h ?? 0) : null;
  const trades24h = pool && pool.buys24h != null ? pool.buys24h + (pool.sells24h ?? 0) : null;
  const k = pool ? kelvin({ trades24h, trades1h, buys1h: pool.buys1h, volume1h: pool.volume1h, liquidityUsd: pool.liquidityUsd }) : null;
  return {
    address, symbol: String(token.symbol || STOCKS[address] || "").slice(0, 16), name: String(token.name || "").replace(/&amp;/g, "&").slice(0, 80), group,
    image: group !== "stocks" && /^https:\/\//.test(token.image_url || "") && !/missing/.test(token.image_url) ? token.image_url : null,
    kelvin: k, priceUsd: pool?.priceUsd ?? null, change1h: pool?.change1h ?? null, change24h: pool?.change24h ?? null,
    // a reserve of 0 is the feed not knowing it (the board already treats it so), never an empty pool
    liquidityUsd: pool?.liquidityUsd || null, volume1h: pool?.volume1h ?? null, volume24h: pool?.volume24h ?? null, fdvUsd: pool?.fdvUsd ?? null,
    trades1h, trades24h, buys1h: pool?.buys1h ?? null, sells1h: pool?.sells1h ?? null,
    buyShare1h: trades1h ? Math.round(((pool.buys1h ?? 0) / trades1h) * 100) : null,
    pool: pool ? { address: pool.address, venue: pool.venue, pair: pool.name, routable: pool.routable, createdAt: pool.createdAt } : null,
    windows: pool?.windows ?? null, pace: paceOf(trades1h, trades24h), ageHours: pool ? ageHoursOf(pool.createdAt, now) : null,
  };
}

// ---------- the board's summary ----------
const ref = (t) => ({
  address: t.address, symbol: t.symbol, name: t.name, group: t.group, image: t.image, kelvin: t.kelvin, pace: t.pace,
  trades1h: t.trades1h, trades24h: t.trades24h, buyShare1h: t.buyShare1h, change1h: t.change1h, change24h: t.change24h, priceUsd: t.priceUsd, ageHours: t.ageHours,
});
/**
 * The board at a glance. Sums count only the readings that know the figure; a sum with no known figure is null.
 * buyShare1h is buys over trades in the last hour across every reading that knows both, in percent like a reading's.
 */
export function boardSummary(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  const ks = list.map((t) => t.kelvin).filter((k) => k != null).sort((a, b) => a - b);
  const mid = ks.length ? (ks.length % 2 ? ks[(ks.length - 1) / 2] : (ks[ks.length / 2 - 1] + ks[ks.length / 2]) / 2) : null;
  const sum = (key) => { const v = list.map((t) => t[key]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  let buys = 0, trades = 0;
  for (const t of list) if (t.buys1h != null && t.trades1h > 0) { buys += t.buys1h; trades += t.trades1h; }
  const moving = list.filter((t) => t.kelvin > 0).sort((a, b) => b.kelvin - a.kelvin);
  return {
    count: list.length,
    medianKelvin: mid == null ? null : Math.round(mid / 10) * 10,
    totalVolume24h: sum("volume24h"), totalTrades1h: sum("trades1h"),
    buyShare1h: trades > 0 ? Math.round((buys / trades) * 100) : null,
    hottest: moving[0] ? ref(moving[0]) : null,
    coldest: moving.length ? ref(moving[moving.length - 1]) : null,
    warmingFastest: list.filter((t) => t.pace != null && t.trades1h >= 20).sort((a, b) => b.pace - a.pace).slice(0, 5).map(ref),
    coolingFastest: list.filter((t) => t.pace != null && t.trades24h >= 200).sort((a, b) => a.pace - b.pace).slice(0, 5).map(ref),
    newest: list.filter((t) => t.ageHours != null).sort((a, b) => a.ageHours - b.ageHours).slice(0, 5).map(ref),
  };
}

// ---------- the board ----------
// A venue's plain name from the feed's dex id ("ramses-v3-robinhood" reads "Ramses V3").
export const venueName = (dex) => DEXES[dex] || (dex ? dex.replace(/-robinhood$/, "").split("-").filter(Boolean).map((w) => (/^(v\d+|cl|clmm|amm)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ") : null);
const poolRef = (pool, decimals) => ({ id: pool.address, dex: pool.dex, venue: venueName(pool.dex), token: pool.base, base: pool.base, quote: pool.quote, baseDecimals: decimals ?? null, createdAt: pool.createdAt });

/** The board and every feed pool of its tokens (the tape maps on-chain swaps through these). */
async function loadBoard() {
  return cached("heat:board", 45000, async () => {
    const now = Date.now();
    const pages = await Promise.all([1, 2, 3].map((page) => feed(`/pools?page=${page}&include=base_token,quote_token,dex`, 60000).catch(() => null)));
    const best = new Map(), rows = [];
    for (const json of pages.filter(Boolean)) {
      const inc = included(json);
      for (const p of json.data || []) {
        const pool = poolRow(p, inc), token = pool.baseToken;
        if (!token || !pool.base || pool.base === WETH || pool.base === USDG || /^W?ETH$/i.test(token.symbol || "") || STOCKS[pool.base] || / • Robinhood Token$/.test(token.name || "") || EXCLUDE_NAMES.test(token.name || "")) continue;
        rows.push(pool);
        const prev = best.get(pool.base);
        // the busiest pool of a token speaks for it
        const score = (x) => (x.buys24h ?? 0) + (x.sells24h ?? 0) + (x.liquidityUsd ?? 0) / 1e6;
        if (!prev || score(pool) > score(prev.pool)) best.set(pool.base, { token: { ...token, address: pool.base }, pool });
      }
    }
    // Thin pools are mostly copies of a real coin under the same name; keep them off the board (an unknown reserve stays).
    const memes = [...best.values()].filter(({ pool }) => !(pool.liquidityUsd > 0 && pool.liquidityUsd < 10000)).map(({ token, pool }) => reading(token, pool, "memes", now));
    const onBoard = new Set(memes.map((t) => t.address)), seen = new Set();
    const pools = rows.filter((p) => onBoard.has(p.base) && p.address && !seen.has(p.address) && seen.add(p.address)).map((p) => poolRef(p, num(p.baseToken?.decimals)));
    let stocks = [];
    try {
      const json = await feed(`/tokens/multi/${Object.keys(STOCKS).join(",")}?include=top_pools`, 120000);
      const inc = included(json);
      stocks = (json.data || []).map((t) => {
        const own = (t.relationships?.top_pools?.data || []).map((x) => inc.get(x.id)).filter(Boolean).map((p) => poolRow(p, inc));
        const address = t.attributes.address.toLowerCase(), mine = own.filter((p) => p.base === address);
        if (STOCKS[address]) for (const p of mine) if (p.address && !seen.has(p.address) && seen.add(p.address)) pools.push(poolRef(p, num(t.attributes.decimals)));
        const pool = [...mine].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))[0] || null;
        return reading(t.attributes, pool, "stocks", now);
      }).filter((c) => STOCKS[c.address]);
    } catch { stocks = []; }
    const tokens = [...memes, ...stocks].sort((a, b) => (b.kelvin ?? -1) - (a.kelvin ?? -1));
    if (!tokens.length) throw new FeedError("The pool feed returned no tokens right now.", 502);
    const at = new Date(now).toISOString();
    return { heat: { tokens, summary: boardSummary(tokens), at }, pools };
  });
}

/** Every token on the board with its temperature, hottest first, and the board's summary. */
export async function getHeat() {
  return (await loadBoard()).heat;
}
/** The board's readings and the feed pools of its tokens: {tokens, pools: [{id, dex, venue, token, base, quote, baseDecimals, createdAt}], at}. */
export async function getBoardPools() {
  const { heat, pools } = await loadBoard();
  return { tokens: heat.tokens, pools, at: heat.at };
}
