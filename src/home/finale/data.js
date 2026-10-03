import { useEffect, useRef, useState } from 'react';

// Readings from Kelvo's own endpoints, shared by every instrument on the page: one request per URL however many
// instruments show it, re-read on an interval while the tab is visible. Each reading keeps the time it was taken.
const EMPTY = Object.freeze({ data: null, at: 0, error: null });
const stores = new Map();
function storeFor(url) {
  if (!stores.has(url)) stores.set(url, { state: EMPTY, subs: new Set(), inflight: null, timer: 0 });
  return stores.get(url);
}
function load(url) {
  const s = storeFor(url);
  if (s.inflight) return s.inflight;
  s.inflight = fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) })
    .then(async (r) => {
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) throw new Error(d?.error || 'This reading is unavailable right now.');
      s.state = { data: d, at: Date.now(), error: null };
    })
    .catch((e) => { s.state = { ...s.state, error: e?.name === 'TimeoutError' ? 'The reading took too long. It retries by itself.' : e?.message || 'This reading is unavailable right now.' }; })
    .finally(() => { s.inflight = null; s.subs.forEach((f) => f(s.state)); });
  return s.inflight;
}
export function useReading(url, every = 0) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!url) return undefined;
    const s = storeFor(url), sub = () => set((n) => n + 1);
    s.subs.add(sub);
    if (!s.state.at || (every && Date.now() - s.state.at > every)) load(url);
    if (every && !s.timer) s.timer = setInterval(() => { if (document.visibilityState === 'visible') load(url); }, every);
    return () => { s.subs.delete(sub); if (!s.subs.size) { clearInterval(s.timer); s.timer = 0; } };
  }, [url, every]);
  return url ? storeFor(url).state : EMPTY;
}

// The tape: the board's trades as they land on chain. One poller for the page, `since` the last head it saw, so each
// poll returns only the new blocks; the page keeps the newest few dozen. Every trade carries its block.
const tape = { trades: [], head: null, headAt: null, at: 0, error: null, subs: new Set(), timer: 0, busy: false };
async function pollTape() {
  if (tape.busy || document.visibilityState !== 'visible') return;
  tape.busy = true;
  try {
    const r = await fetch('/api/heat?action=tape' + (tape.head ? '&since=' + tape.head : ''), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) throw new Error(d?.error || 'The tape is unavailable right now.');
    const seen = new Set(tape.trades.map((t) => t.tx + ':' + t.logIndex));
    const fresh = (d.trades || []).filter((t) => !seen.has(t.tx + ':' + t.logIndex));
    tape.trades = [...fresh, ...tape.trades].sort((a, b) => b.block - a.block || b.logIndex - a.logIndex).slice(0, 48);
    if (d.head != null) { tape.head = d.head; tape.headAt = d.headAt || null; }
    tape.at = Date.now(); tape.error = null;
  } catch (e) { tape.error = e?.message || 'The tape is unavailable right now.'; }
  finally { tape.busy = false; tape.subs.forEach((f) => f()); }
}
export function useTape(every = 4000) {
  const [, set] = useState(0);
  useEffect(() => {
    const sub = () => set((n) => n + 1);
    tape.subs.add(sub);
    if (!tape.at) pollTape();
    if (!tape.timer) tape.timer = setInterval(pollTape, every);
    return () => { tape.subs.delete(sub); if (!tape.subs.size) { clearInterval(tape.timer); tape.timer = 0; } };
  }, [every]);
  return tape;
}

/** A value that only changes once a new one has stood for a moment; keeps layout calm while readings land. */
export function useLatch(value) {
  const ref = useRef(value);
  if (value != null) ref.current = value;
  return ref.current;
}

/** Local wall-clock time of a reading, 24-hour. */
export const clock = (t) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—');
/** The same with seconds, for readings that move every few seconds. */
export const clockS = (t) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export const int = (v) => (v == null ? '—' : Math.round(v).toLocaleString('en-US'));
export const block = (n) => (n == null ? '—' : '#' + Number(n).toLocaleString('en-US'));
/** A median of kelvins, rounded to 10 like the heat rule (the agent's heat_board does the same). */
export const medianK = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 20) * 10; };
export const price = (v) => (v == null ? '—' : v >= 1 ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v === 0 ? '$0' : '$' + v.toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 12 }));
/** Token amounts, short: 1.23M, 45.6K, 789, 0.0123. */
export const amt = (v) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
  if (a >= 1) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return v.toPrecision(3);
};
