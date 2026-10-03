import { kelvin } from '../heat-rule';
import { price } from '../home/finale/data';
import './readings.css';

// Readings shared by the market desk and the home's agent chapter: the heat rule taken apart from a board reading,
// trades a minute in each of the feed's windows, and the last 24 hourly closes.
/** The heat rule, term by term, from the inputs the board used for this token's reading. */
export function rule(t) {
  if (!t || t.trades24h == null) return null;
  const t24 = t.trades24h, t1 = t.trades1h ?? 0;
  const share = t1 > 0 ? Math.min(1, Math.max(0, (t.buys1h ?? 0) / t1)) : 0.5;
  const raw = t.liquidityUsd > 0 && t.volume1h != null ? t.volume1h / t.liquidityUsd : 0, turnover = Math.min(3, raw);
  const day = 30 * Math.sqrt(t24), hour = t24 === 0 && t1 === 0 ? 0 : 260 * Math.log1p(t1) * (0.75 + 0.5 * share) * (1 + turnover / 2);
  return { t24, t1, share, raw, turnover, day, hour, sum: day + hour, k: kelvin({ trades24h: t24, trades1h: t1, buys1h: t.buys1h, volume1h: t.volume1h, liquidityUsd: t.liquidityUsd }) };
}

/** Trades per minute in each of the feed's windows, newest first on the left. Above the day's line means warming. */
export const WINDOWS = [['m5', '5m', 5], ['m15', '15m', 15], ['m30', '30m', 30], ['h1', '1h', 60], ['h6', '6h', 360], ['h24', '24h', 1440]];
export function Pace({ windows }) {
  const rows = WINDOWS.map(([k, label, min]) => { const w = windows?.[k]; return { label, v: w && w.buys != null ? (w.buys + (w.sells ?? 0)) / min : null }; });
  const max = Math.max(...rows.map((r) => r.v ?? 0), 0.0001), day = rows[5].v;
  if (rows.every((r) => r.v == null)) return <div className="kf-mini empty">—</div>;
  const fmt = (v) => (v == null ? '—' : v >= 10 ? Math.round(v).toString() : v.toFixed(1));
  return <div className="kf-pace" role="img" aria-label={'Trades per minute: ' + rows.map((r) => `${r.label} ${fmt(r.v)}`).join(', ')}>
    {day != null && <i className="kf-pace-day" style={{ bottom: `calc(16px + ${(day / max) * 100}% * .62)` }} />}
    {rows.map((r) => <span key={r.label} style={{ '--h': r.v == null ? 0 : Math.max(0.04, r.v / max), '--c': r.v != null && day != null && r.v > day * 1.05 ? 'var(--kv-hot)' : 'var(--kv-lilac)' }}>
      <b className="kv-num">{fmt(r.v)}</b><i /><em>{r.label}</em>
    </span>)}
  </div>;
}

/** The last 24 hourly candles: closes as a line over the hour's volume. */
export function Day({ candles }) {
  const c = candles.slice(-24);
  if (c.length < 2) return <div className="kf-mini empty">—</div>;
  const W = 300, H = 64, closes = c.map((x) => x.c), lo = Math.min(...closes), hi = Math.max(...closes), vmax = Math.max(...c.map((x) => x.v), 1);
  const x = (i) => (i / (c.length - 1)) * W, y = (v) => 6 + (1 - (hi === lo ? 0.5 : (v - lo) / (hi - lo))) * (H - 24);
  const line = closes.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return <svg className="kf-day" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Hourly closes over ${c.length} hours, from ${price(closes[0])} to ${price(closes[closes.length - 1])}`}>
    {c.map((k, i) => { const h = Math.max(1, (k.v / vmax) * 14); return <rect key={k.t} x={x(i) - 3} y={H - h} width="6" height={h} className="kf-day-v" />; })}
    <path d={line} className="kf-day-line" vectorEffect="non-scaling-stroke" />
    <circle cx={x(c.length - 1)} cy={y(closes[closes.length - 1])} r="2.5" className="kf-day-dot" />
  </svg>;
}
