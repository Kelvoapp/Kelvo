// The heat rule, shared by the server, the token page and the docs. K = 30 x sqrt(trades in 24h)
// + 260 x ln(1 + trades in 1h) x (0.75 + 0.5 x buy share of the hour) x (1 + min(3, hour volume / liquidity) / 2), rounded to 10.
export function kelvin({ trades24h, trades1h, buys1h, volume1h, liquidityUsd }) {
  const t24 = Math.max(0, trades24h ?? 0), t1 = Math.max(0, trades1h ?? 0);
  if (t24 === 0 && t1 === 0) return 0;
  const share = t1 > 0 ? Math.min(1, Math.max(0, (buys1h ?? 0) / t1)) : 0.5;
  const turnover = liquidityUsd > 0 && volume1h != null ? Math.min(3, volume1h / liquidityUsd) : 0;
  const k = 30 * Math.sqrt(t24) + 260 * Math.log1p(t1) * (0.75 + 0.5 * share) * (1 + turnover / 2);
  return Math.round(k / 10) * 10;
}
