import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpRight, Search } from 'lucide-react';
import { fmtK, fmtPct, fmtUsd, heat01, rampColor, short, useHeat } from '../heat-client';
import { block, clockS, int, price, useReading, useTape } from '../home/finale/data';
import { Day, Pace, rule } from './readings';
import './heat.css';

// The market desk: the board's temperature at a glance, who is warming and cooling, the thermogram with an inspector
// beside it, every swap landing on chain, and every reading with its six windows of activity.

/** Squarified treemap: rows of tiles whose aspect stays near square. Values must be positive. */
function squarify(items, x, y, w, h) {
  const out = [], total = items.reduce((s, i) => s + i.v, 0);
  if (!total) return out;
  const scale = (w * h) / total;
  let rest = items.map((i) => ({ ...i, a: i.v * scale })), box = { x, y, w, h };
  const worst = (row, side) => { const s = row.reduce((t, r) => t + r.a, 0), mx = Math.max(...row.map((r) => r.a)), mn = Math.min(...row.map((r) => r.a)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
  while (rest.length) {
    const side = Math.min(box.w, box.h), row = [rest[0]];
    let i = 1;
    while (i < rest.length && worst([...row, rest[i]], side) <= worst(row, side)) row.push(rest[i++]);
    rest = rest.slice(i);
    const s = row.reduce((t, r) => t + r.a, 0);
    if (box.w >= box.h) {
      const cw = s / box.h; let cy = box.y;
      for (const r of row) { const ch = r.a / cw; out.push({ ...r, x: box.x, y: cy, w: cw, h: ch }); cy += ch; }
      box = { x: box.x + cw, y: box.y, w: box.w - cw, h: box.h };
    } else {
      const rh = s / box.w; let cx = box.x;
      for (const r of row) { const cw = r.a / rh; out.push({ ...r, x: cx, y: box.y, w: cw, h: rh }); cx += cw; }
      box = { x: box.x, y: box.y + rh, w: box.w, h: box.h - rh };
    }
  }
  return out;
}

const age = (h) => (h == null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const paceText = (p) => (p == null ? '—' : p === 0 ? '0×' : `${p.toFixed(p >= 10 ? 0 : 1)}×`);
const paceTone = (p) => (p == null ? '' : p >= 1.15 ? 'up' : p <= 0.85 ? 'down' : '');
const Logo = ({ t, size = 20 }) => (t?.image
  ? <img className="kv-coin" src={t.image} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" />
  : <span className="kv-coin mono" style={{ width: size, height: size }}>{t?.symbol?.slice(0, 2) || '·'}</span>);

/** Six windows of activity, oldest to newest, each lit by trades a minute on a log scale shared by the whole board. */
const SPEC = [['h24', 1440], ['h6', 360], ['h1', 60], ['m30', 30], ['m15', 15], ['m5', 5]];
const rate = (t, k, min) => { const w = t.windows?.[k]; return w && w.buys != null ? (w.buys + (w.sells ?? 0)) / min : null; };
function Spectrum({ t, top }) {
  return <span className="kv-spec" aria-label={'Trades a minute: ' + SPEC.map(([k, m]) => `${k} ${rate(t, k, m)?.toFixed(1) ?? 'unknown'}`).join(', ')}>
    {SPEC.map(([k, m]) => { const v = rate(t, k, m); return <i key={k} style={v == null ? undefined : { background: rampColor(Math.log1p(v) / Math.log1p(top) * 10000) }} />; })}
  </span>;
}

/** A lane: five tokens ranked by one reading. */
function Lane({ title, note, rows, value, top }) {
  return <section className="kv-lane">
    <header><h2>{title}</h2><span>{note}</span></header>
    <ol>
      {rows?.length ? rows.map((t) => <li key={t.address}><Link to={'/token/' + t.address}>
        <Logo t={t} size={18} /><b>{t.symbol}</b>
        <Spectrum t={t} top={top} />
        <em className="kv-num" style={{ color: rampColor(t.kelvin) }}>{fmtK(t.kelvin)}</em>
        <span className="kv-num">{value(t)}</span>
      </Link></li>) : Array.from({ length: 5 }, (_, i) => <li key={i} className="kv-lane-wait"><i /></li>)}
    </ol>
  </section>;
}

/** The inspector: one token's temperature taken apart, its six windows, its day, and the way to it. */
function Inspector({ t, at }) {
  const coin = useReading(t ? '/api/terminal?action=coin&address=' + t.address : null, 60000);
  const c = coin.data?.address === t?.address ? coin.data : null;
  const candles = useReading(c?.chartPool ? `/api/terminal?action=candles&pool=${c.chartPool}&frame=1h` : null, 300000);
  const cs = candles.data?.candles || [];
  const r = useMemo(() => rule(t), [t]);
  if (!t) return <aside className="kv-insp kv-insp-empty">Pick a tile or a row to read it here.</aside>;
  return <aside className="kv-insp" aria-label={t.symbol + ' reading'}>
    <header>
      <Logo t={t} size={30} />
      <div><b>{t.symbol}</b><span>{t.name}</span></div>
      <small className="kv-num">{short(t.address)}</small>
    </header>
    <div className="kv-insp-k">
      <b className="kv-num" style={{ color: rampColor(t.kelvin) }}>{fmtK(t.kelvin)}</b>
      <div className="kv-insp-ramp"><i style={{ left: heat01(t.kelvin) * 100 + '%' }} /></div>
    </div>
    {r && <dl className="kv-insp-rule">
      <div><dt>Day</dt><dd>30 × √{int(r.t24)}</dd><dd className="kv-num">{int(r.day)} K</dd></div>
      <div><dt>Hour</dt><dd>260 × ln(1 + {int(r.t1)}) × {(0.75 + 0.5 * r.share).toFixed(2)} × {(1 + r.turnover / 2).toFixed(2)}</dd><dd className="kv-num">{int(r.hour)} K</dd></div>
    </dl>}
    <div className="kv-insp-charts">
      <div><span className="kv-label">Trades a minute{t.pace != null ? ` · hour at ${t.pace}× the day` : ''}</span><Pace windows={t.windows} /></div>
      <div><span className="kv-label">Price, 24 hourly closes</span>{cs.length ? <Day candles={cs} /> : <div className="kf-mini empty">{c && !c.chartPool ? 'No pool to chart' : candles.error || '—'}</div>}</div>
    </div>
    <dl className="kv-insp-stats">
      <div><dt>Price</dt><dd className="kv-num">{price(t.priceUsd)}</dd></div>
      <div><dt>1h</dt><dd className={'kv-num ' + (t.change1h > 0 ? 'up' : t.change1h < 0 ? 'down' : '')}>{fmtPct(t.change1h)}</dd></div>
      <div><dt>24h</dt><dd className={'kv-num ' + (t.change24h > 0 ? 'up' : t.change24h < 0 ? 'down' : '')}>{fmtPct(t.change24h)}</dd></div>
      <div><dt>Liquidity</dt><dd className="kv-num">{fmtUsd(t.liquidityUsd)}</dd></div>
      <div><dt>Buyers 1h</dt><dd className="kv-num">{int(t.windows?.h1?.buyers)}</dd></div>
      <div><dt>Pool age</dt><dd className="kv-num">{age(t.ageHours)}</dd></div>
    </dl>
    <footer>
      <Link className="kv-key" to={'/token/' + t.address}><span>Open {t.symbol}</span><ArrowUpRight /></Link>
      <small>{t.pool?.venue ? `${t.pool.venue} · ${t.pool.pair}` : 'Busiest pool'} · read {clockS(at)}</small>
    </footer>
  </aside>;
}

/** Every swap on a board token as it lands on chain, newest first. */
function Tape() {
  const tape = useTape(3500);
  const rows = tape.trades.slice(0, 18);
  // the span of the shown trades by their own times; rows without a sound time are left out of the rate
  const timed = rows.filter((x) => Date.parse(x.at) > 1.6e12);
  const span = timed.length > 1 ? (Date.parse(timed[0].at) - Date.parse(timed[timed.length - 1].at)) / 1000 : 0;
  const perSec = span > 0 ? (timed.length - 1) / span : null;
  return <section className="kv-tape-rail" aria-label="Swaps on chain">
    <header><h2>On chain now</h2><span className="kv-num">{tape.head ? block(tape.head) : tape.error ? 'no reading' : 'reading'}</span></header>
    <p className="kv-tape-rate"><b className="kv-num">{perSec == null ? '—' : perSec.toFixed(perSec >= 10 ? 0 : 1)}</b> board swaps a second, last {Math.round(span) || '—'} s</p>
    <ol>
      {rows.map((x) => <li key={x.tx + x.logIndex}><Link to={'/token/' + x.token}>
        <i data-side={x.side} aria-label={x.side} />
        <b>{x.symbol}</b>
        <span className="kv-num">{fmtUsd(x.usd)}</span>
        <em className="kv-num" style={{ color: rampColor(x.kelvin) }}>{fmtK(x.kelvin)}</em>
        <small>{x.venue}</small>
      </Link></li>)}
      {!rows.length && <li className="kv-tape-wait">{tape.error || 'Reading the chain'}</li>}
    </ol>
  </section>;
}

const COLS = [
  ['kelvin', 'Temperature'], ['spec', 'Activity 24h → 5m'], ['pace', 'Pace'], ['trades1h', 'Trades 1h'], ['buyers1h', 'Buyers 1h'], ['buyShare1h', 'Buys'],
  ['priceUsd', 'Price'], ['change1h', '1h'], ['change24h', '24h'], ['liquidityUsd', 'Liquidity'], ['volume24h', 'Volume 24h'], ['ageHours', 'Age'],
];
const sortValue = (t, key) => (key === 'buyers1h' ? t.windows?.h1?.buyers : key === 'spec' ? rate(t, 'm5', 5) : t[key]);

export default function HeatBoard() {
  const { data, error } = useHeat();
  const loc = useLocation();
  const [group, setGroup] = useState('all'), [q, setQ] = useState(''), [sort, setSort] = useState(['kelvin', -1]), [picked, setPicked] = useState(null);
  const map = useRef(null), [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const m = () => { const r = map.current?.getBoundingClientRect(); if (r) setSize({ w: r.width, h: r.height }); };
    m(); const ro = new ResizeObserver(m); if (map.current) ro.observe(map.current);
    return () => ro.disconnect();
  }, []);

  const all = data?.tokens || [], sum = data?.summary;
  const tokens = useMemo(() => {
    const s = q.trim().replace(/^\$/, '').toLowerCase();
    return all.filter((t) => (group === 'all' || t.group === group) && (!s || t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || t.address === s));
  }, [all, group, q]);
  const top = useMemo(() => Math.max(1, ...all.map((t) => rate(t, 'm5', 5) ?? 0), ...all.map((t) => rate(t, 'h1', 60) ?? 0)), [all]);
  const tiles = useMemo(() => {
    if (!size.w || !size.h) return [];
    const list = tokens.filter((t) => t.kelvin != null).slice(0, 40).map((t) => ({ t, v: Math.sqrt(Math.max(1000, t.volume24h || 0)) })).sort((a, b) => b.v - a.v);
    return squarify(list, 0, 0, size.w, size.h);
  }, [tokens, size]);
  const dupes = useMemo(() => { const c = new Map(); for (const t of tokens) c.set(t.symbol, (c.get(t.symbol) || 0) + 1); return new Set([...c].filter(([, n]) => n > 1).map(([sym]) => sym)); }, [tokens]);
  const rows = useMemo(() => {
    const [key, dir] = sort;
    return [...tokens].sort((a, b) => { const x = sortValue(a, key) ?? -Infinity, y = sortValue(b, key) ?? -Infinity; return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  }, [tokens, sort]);
  useEffect(() => { if (loc.hash && data) document.getElementById('row-' + loc.hash.slice(1))?.scrollIntoView({ block: 'center' }); }, [loc.hash, data]);
  const selected = all.find((t) => t.address === picked) || all.find((t) => t.kelvin != null) || null;
  const at = data?.at ? Date.parse(data.at) : 0, frozen = all.filter((t) => t.kelvin === 0).length;
  // the summary lists name tokens; the lanes show them with their full readings (windows included)
  const byAddr = useMemo(() => new Map(all.map((t) => [t.address, t])), [all]);
  const full = (list) => list?.map((t) => byAddr.get(t.address) || t);

  return <main className="kv-heat">
    <header className="kv-heat-head">
      <div>
        <span className="kv-label">Heat · Robinhood Chain</span>
        <h1>The market, <em>in kelvin</em></h1>
      </div>
      <dl className="kv-heat-sum">
        <div className="lead"><dt>Market temperature</dt><dd className="kv-num" style={{ color: sum ? rampColor(sum.medianKelvin) : undefined }}>{fmtK(sum?.medianKelvin)}</dd><small>median of the board</small></div>
        <div><dt>Tokens</dt><dd className="kv-num">{data ? all.length : '—'}</dd><small>{data ? `${frozen} at 0 K` : ''}</small></div>
        <div><dt>Trades 1h</dt><dd className="kv-num">{int(sum?.totalTrades1h)}</dd><small>across the board</small></div>
        <div><dt>Buys</dt><dd className="kv-num">{sum?.buyShare1h == null ? '—' : sum.buyShare1h + '%'}</dd><small>last hour</small></div>
        <div><dt>Volume 24h</dt><dd className="kv-num">{fmtUsd(sum?.totalVolume24h)}</dd><small>busiest pools</small></div>
        <div><dt>Read</dt><dd className="kv-num">{data ? clockS(at) : '—'}</dd><small>every 30 s</small></div>
      </dl>
    </header>

    <div className="kv-lanes">
      <Lane title="Warming" note="hour above the day's pace" rows={full(sum?.warmingFastest)} value={(t) => <span className={paceTone(t.pace)}>{paceText(t.pace)}</span>} top={top} />
      <Lane title="Cooling" note="hour below the day's pace" rows={full(sum?.coolingFastest)} value={(t) => <span className={paceTone(t.pace)}>{paceText(t.pace)}</span>} top={top} />
      <Lane title="Newest pools" note="youngest on the board" rows={full(sum?.newest)} value={(t) => age(t.ageHours)} top={top} />
    </div>

    <div className="kv-heat-tools">
      <div className="kv-seg" role="tablist" aria-label="Group">
        {[['all', 'All'], ['memes', 'Memes'], ['stocks', 'Stocks']].map(([v, l]) => <button key={v} type="button" role="tab" aria-selected={group === v} onClick={() => setGroup(v)}>{l}</button>)}
      </div>
      <label className="kv-find"><Search size={15} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a token or paste a contract" aria-label="Search tokens" spellCheck={false} /></label>
      <div className="kv-scale" aria-label="Colour scale"><span>0 K</span><i /><span>10,000 K</span></div>
    </div>

    <div className="kv-desk">
      <section className="kv-map" ref={map} aria-label="Heat map: area is 24h volume, colour is temperature">
        {!data && !error && <div className="kv-map-wait">Reading the pools</div>}
        {error && !data && <div className="kv-map-wait warn">{error}</div>}
        {tiles.map(({ t, x, y, w, h }) => {
          const k = heat01(t.kelvin), dark = k > 0.6, big = w > 150 && h > 96, mid = w > 74 && h > 52, twin = dupes.has(t.symbol), on = selected?.address === t.address;
          return <button key={t.address} type="button" onClick={() => setPicked(t.address)} aria-pressed={on} className={'kv-tile' + (dark ? ' dark' : '') + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: h, '--c': rampColor(t.kelvin), '--k': k }} title={`${t.symbol} ${fmtK(t.kelvin)}`}>
            {mid && <span className="kv-tile-sym">{t.symbol}{twin && <small>{short(t.address)}</small>}</span>}
            {mid && <span className="kv-tile-k" style={{ fontSize: Math.max(15, Math.min(30, w / 5.6)) }}>{fmtK(t.kelvin)}</span>}
            {big && <span className="kv-tile-meta">{t.trades1h?.toLocaleString('en-US') ?? '—'} trades/1h · {paceText(t.pace)} pace</span>}
          </button>;
        })}
      </section>
      <div className="kv-desk-side">
        <Inspector t={selected} at={at} />
        <Tape />
      </div>
    </div>
    <p className="kv-map-note">Area is 24 hour volume, colour is temperature. Pick a tile to read it beside the map.</p>

    <section className="kv-readings" aria-label="Every reading">
      <div className="kv-table-wrap">
        <table className="kv-table">
          <thead><tr><th scope="col">Token</th>{COLS.map(([key, label]) => <th key={key} scope="col" aria-sort={sort[0] === key ? (sort[1] < 0 ? 'descending' : 'ascending') : 'none'}>
            <button type="button" onClick={() => setSort(([k0, d]) => [key, k0 === key ? -d : -1])}>{label}{sort[0] === key && (sort[1] < 0 ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</button></th>)}</tr></thead>
          <tbody>
            {rows.map((t) => <tr key={t.address} id={'row-' + t.address} className={(loc.hash === '#' + t.address ? 'on ' : '') + (selected?.address === t.address ? 'sel' : '')} onClick={() => setPicked(t.address)}>
              <th scope="row"><Link to={'/token/' + t.address} onClick={(e) => e.stopPropagation()}><Logo t={t} size={22} /><b>{t.symbol}</b><small>{short(t.address)}</small></Link></th>
              <td><span className="kv-temp"><i style={{ width: `${Math.max(3, heat01(t.kelvin) * 100)}%`, background: rampColor(t.kelvin) }} /><b style={{ color: rampColor(t.kelvin) }}>{fmtK(t.kelvin)}</b></span></td>
              <td><Spectrum t={t} top={top} /></td>
              <td className={'kv-num ' + paceTone(t.pace)}>{paceText(t.pace)}</td>
              <td className="kv-num">{int(t.trades1h)}</td>
              <td className="kv-num">{int(t.windows?.h1?.buyers)}</td>
              <td className="kv-num">{t.buyShare1h == null ? '—' : t.buyShare1h + '%'}</td>
              <td className="kv-num">{price(t.priceUsd)}</td>
              <td className={'kv-num ' + (t.change1h > 0 ? 'up' : t.change1h < 0 ? 'down' : '')}>{fmtPct(t.change1h)}</td>
              <td className={'kv-num ' + (t.change24h > 0 ? 'up' : t.change24h < 0 ? 'down' : '')}>{fmtPct(t.change24h)}</td>
              <td className="kv-num">{fmtUsd(t.liquidityUsd)}</td>
              <td className="kv-num">{fmtUsd(t.volume24h)}</td>
              <td className="kv-num">{age(t.ageHours)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="kv-map-note">Read from each token's busiest pool on the public pool feed every 30 seconds; swaps from the chain every few seconds. Activity lights each window by trades a minute, on one scale for the whole board. Pace is the last hour against the day's average. The rule is on the <Link to="/docs#heat">docs page</Link>. A dash is a value the feed did not give.</p>
    </section>
  </main>;
}
