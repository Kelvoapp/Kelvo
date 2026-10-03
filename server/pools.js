import { createPublicClient, fallback, http, parseAbi } from "viem";

// Readings of the Privacy Cash pools on Robinhood Chain that the agent and the cold side share.
const RPCS = [process.env.ROBINHOOD_RPC_URL, "https://evm.privacycash.org/rpc/robinhood", "https://rpc.mainnet.chain.robinhood.com"].filter(Boolean);
export const chain = createPublicClient({ transport: fallback(RPCS.map((u) => http(u, { timeout: 12000, retryCount: 0 }))) });
export const POOLS = { eth: { address: "0xEC5266c9e44631e1ba22FD6377C38130c1F3B738", symbol: "ETH", decimals: 18 }, usdg: { address: "0xBB0C7F576B7bdAa8f2a119cb295076aCD0C9013f", symbol: "USDG", decimals: 6 } };
const indexAbi = parseAbi(["function nextIndex() view returns (uint32)"]);

const memo = new Map();
async function cached(key, ttl, load) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** Notes in each private pool now and 24 hours ago (the pool's own counter read at an older block). */
export async function poolActivity() {
  return cached("pool:activity", 5 * 60e3, async () => {
    const head = await chain.getBlockNumber();
    const rate = await cached("pool:rate", 3600e3, async () => {
      const [a, b] = await Promise.all([chain.getBlock({ blockNumber: head }), chain.getBlock({ blockNumber: head - 100000n })]);
      return Number(a.timestamp - b.timestamp) / 100000;
    });
    const back = BigInt(Math.round(86400 / Math.max(0.01, rate)));
    const out = {};
    for (const [k, p] of Object.entries(POOLS)) {
      const [now, then] = await Promise.all([head, head - back].map((blockNumber) => chain.readContract({ address: p.address, abi: indexAbi, functionName: "nextIndex", blockNumber }).then(Number).catch(() => null)));
      out[k] = { notes: now, notes24h: now != null && then != null ? now - then : null };
    }
    return out;
  });
}
