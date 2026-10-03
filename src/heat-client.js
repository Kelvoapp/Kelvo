import { useEffect, useState } from 'react';

// The board's temperatures, shared by every page that shows them. Re-read every 30 s while the tab is visible.
let store = { data: null, error: null, at: 0 };
const subs = new Set();
let timer = 0, inflight = null;
async function load() {
  if (inflight) return inflight;
  inflight = fetch('/api/heat', { headers: { accept: 'application/json' } })
    .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d?.error || 'The heat reader is unavailable.'); store = { data: d, error: null, at: Date.now() }; })
    .catch((e) => { store = { ...store, error: e.message || 'The heat reader is unavailable.' }; })
    .finally(() => { inflight = null; subs.forEach((f) => f(store)); });
  return inflight;
}
function tick() { if (document.visibilityState === 'visible') load(); }
export function useHeat() {
  const [s, set] = useState(store);
  useEffect(() => {
    subs.add(set);
    if (!store.data || Date.now() - store.at > 30000) load();
    if (!timer) { timer = setInterval(tick, 30000); }
    return () => { subs.delete(set); if (!subs.size) { clearInterval(timer); timer = 0; } };
  }, []);
  return s;
}

/** 0..1 on the thermal ramp (0 K .. 10,000 K). */
export const heat01 = (k) => (k == null ? 0 : Math.max(0, Math.min(1, k / 10000)));
const STOPS = [[0, [15, 31, 99]], [0.18, [46, 143, 255]], [0.42, [169, 155, 216]], [0.66, [232, 55, 31]], [0.82, [255, 90, 31]], [1, [255, 210, 122]]];
/** The ramp colour of a temperature, for type and marks. */
export function rampColor(k) {
  const t = heat01(k);
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1], [t1, c1] = STOPS[i], u = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * u)).join(',')})`;
    }
  }
  return 'rgb(255,210,122)';
}
export const fmtK = (k) => (k == null ? '—' : `${Math.round(k).toLocaleString('en-US')} K`);
export const fmtUsd = (v) => {
  if (v == null) return '—';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  if (v >= 1) return '$' + v.toFixed(2);
  if (v === 0) return '$0';
  return '$' + v.toPrecision(3);
};
export const fmtPct = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 100 ? 0 : 1) + '%');
export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—');

/** The bloom's nine petals from a board: the four hottest, then readings down the list to the coldest that still moves. */
export function bloomPick(tokens) {
  const seen = new Set(), list = (tokens || []).filter((t) => t.kelvin > 0 && !seen.has(t.symbol) && seen.add(t.symbol));
  if (list.length < 9) return list.slice(0, 9);
  const at = [0, 1, 2, 3, .3, .5, .68, .84, 1].map((q, i) => (i < 4 ? q : Math.round(q * (list.length - 1))));
  return [...new Set(at)].map((i) => list[i]).slice(0, 9);
}
