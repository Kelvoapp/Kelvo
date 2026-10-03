import { test } from "node:test";
import assert from "node:assert/strict";
import { TOPICS, decodeLogs, timeOf, windowOf } from "../server/tape.js";

const BASE = "0x1111111111111111111111111111111111111111";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const POOL3 = "0x2222222222222222222222222222222222222222";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POOL4 = "0x" + "ab".repeat(32);
const w = (n) => (BigInt.asUintN(256, BigInt(n))).toString(16).padStart(64, "0");
const ctx = (extra = {}) => ({
  pools: new Map([
    [POOL3, { id: POOL3, kind: "v3", token: BASE, base: BASE, quote: WETH, venue: "Uniswap V3", baseDecimals: 18 }],
    [POOL4, { id: POOL4, kind: "v4", token: BASE, base: BASE, quote: "0x0000000000000000000000000000000000000000", venue: "Uniswap V4", baseDecimals: 18 }],
  ]),
  curves: new Map(), decimals: new Map(), tokens: new Map([[BASE, { symbol: "TEST", priceUsd: 2, kelvin: 4200 }]]),
  order: (p) => (p.kind === "v3" ? { c0: BASE, c1: WETH } : { c0: "0x0000000000000000000000000000000000000000", c1: BASE }),
  time: () => 1.7e12, ...extra,
});
const log = (topic, address, topics1, data, block, index = 0) => ({ address, topics: [topic, topics1 ?? "0x" + "00".repeat(32)], data, blockNumber: "0x" + block.toString(16), logIndex: "0x" + index.toString(16), transactionHash: "0x" + "cd".repeat(32) });

test("a V3 swap where the pool sends the base token out is a buy, and its amount and dollar value are read", () => {
  // amount0 (base) negative: the pool paid it out
  const t = decodeLogs([log(TOPICS.v3, POOL3, null, "0x" + w(-3n * 10n ** 18n) + w(10n ** 15n), 100)], ctx())[0];
  assert.equal(t.side, "buy");
  assert.equal(t.amount, 3);
  assert.equal(t.usd, 6);
  assert.equal(t.kelvin, 4200);
});

test("a V3 swap where the base token goes into the pool is a sell", () => {
  const t = decodeLogs([log(TOPICS.v3, POOL3, null, "0x" + w(5n * 10n ** 17n) + w(-(10n ** 14n)), 101)], ctx())[0];
  assert.equal(t.side, "sell");
  assert.equal(t.amount, 0.5);
});

test("a V4 swap reads the base token's side from the PoolManager's signed delta", () => {
  // base is currency1; a positive delta for the caller means base left the pool: a buy
  const buy = decodeLogs([log(TOPICS.v4, POOL_MANAGER, POOL4, "0x" + w(-(10n ** 16n)) + w(2n * 10n ** 18n), 102)], ctx())[0];
  assert.equal(buy.side, "buy");
  assert.equal(buy.amount, 2);
  const sell = decodeLogs([log(TOPICS.v4, POOL_MANAGER, POOL4, "0x" + w(10n ** 16n) + w(-(4n * 10n ** 18n)), 103)], ctx())[0];
  assert.equal(sell.side, "sell");
  assert.equal(sell.amount, 4);
});

test("swaps in pools the board does not know, and V4 logs from another address, are left out", () => {
  const other = "0x3333333333333333333333333333333333333333";
  assert.equal(decodeLogs([log(TOPICS.v3, other, null, "0x" + w(-1n) + w(1n), 104)], ctx()).length, 0);
  assert.equal(decodeLogs([log(TOPICS.v4, other, POOL4, "0x" + w(-1n) + w(1n), 105)], ctx()).length, 0);
});

test("trades come newest first and a window is cut on a block boundary", () => {
  const ts = decodeLogs([log(TOPICS.v3, POOL3, null, "0x" + w(-(10n ** 18n)) + w(1n), 200, 0), log(TOPICS.v3, POOL3, null, "0x" + w(-(10n ** 18n)) + w(1n), 202, 1), log(TOPICS.v3, POOL3, null, "0x" + w(-(10n ** 18n)) + w(1n), 202, 3)], ctx());
  assert.deepEqual(ts.map((t) => [t.block, t.logIndex]), [[202, 3], [202, 1], [200, 0]]);
  const cut = windowOf(ts, 2, 190);
  assert.deepEqual(cut.trades.map((t) => t.block), [202, 202]);
  assert.equal(cut.fromBlock, 201);
});

test("a log's own timestamp is used, a zero timestamp is unknown, and unknown times are placed back from the head", () => {
  assert.equal(timeOf({ blockTimestamp: "0x6700a000", blockNumber: "0x10" }, 20, 1.7e9), 0x6700a000 * 1000);
  // a node that answers 0x0 must not put the trade in 1970
  assert.equal(timeOf({ blockTimestamp: "0x0", blockNumber: "0x" + (990).toString(16) }, 1000, 1700000000, 10), 1700000000 * 1000 - 1000);
  assert.equal(timeOf({ blockNumber: "0x" + (995).toString(16) }, 1000, 1700000000, 10), 1700000000 * 1000 - 500);
  assert.equal(timeOf({ blockNumber: "0x1" }, null, null), null);
});
