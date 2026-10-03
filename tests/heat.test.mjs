import { test } from "node:test";
import assert from "node:assert/strict";
import { kelvin } from "../server/heat.js";

test("no trade in a day reads 0 K", () => {
  assert.equal(kelvin({ trades24h: 0, trades1h: 0, buys1h: 0, volume1h: 0, liquidityUsd: 1e5 }), 0);
  assert.equal(kelvin({ trades24h: null, trades1h: null }), 0);
});

test("the rule as written: day term plus hour term, rounded to 10", () => {
  // 30 x sqrt(400) = 600; 260 x ln(1 + 50) x (0.75 + 0.5 x 0.6) x (1 + min(3, 20000 / 100000) / 2) = 260 x 3.9318 x 1.05 x 1.1
  const want = Math.round((600 + 260 * Math.log1p(50) * 1.05 * 1.1) / 10) * 10;
  assert.equal(kelvin({ trades24h: 400, trades1h: 50, buys1h: 30, volume1h: 20000, liquidityUsd: 100000 }), want);
});

test("more trades, more buying and more turnover each warm a token; turnover stops counting at 3", () => {
  const base = { trades24h: 400, trades1h: 50, buys1h: 25, volume1h: 20000, liquidityUsd: 100000 };
  assert.ok(kelvin({ ...base, trades1h: 80, buys1h: 40 }) > kelvin(base));
  assert.ok(kelvin({ ...base, buys1h: 45 }) > kelvin(base));
  assert.ok(kelvin({ ...base, volume1h: 90000 }) > kelvin(base));
  assert.equal(kelvin({ ...base, volume1h: 300000 }), kelvin({ ...base, volume1h: 900000 }));
});

test("an unknown reserve adds no turnover rather than failing", () => {
  const k = kelvin({ trades24h: 100, trades1h: 10, buys1h: 5, volume1h: 5000, liquidityUsd: null });
  assert.equal(k, Math.round((300 + 260 * Math.log1p(10) * 1 * 1) / 10) * 10);
});
