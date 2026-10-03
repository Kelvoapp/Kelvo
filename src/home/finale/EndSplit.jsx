import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Snowflake } from 'lucide-react';
import { HOLDER_MIN_USD, IDENTITY } from '../../identity.js';
import { EXPLORER } from '../../wallet.js';
import { fmtK, fmtUsd, rampColor } from '../../heat-client.js';
import { block, clock, clockS, medianK, useReading, useTape } from './data.js';
import { Coin, Lamp } from './ui.jsx';

/** Every token on the board as a tick on the kelvin scale, the median as a needle, the hottest named at its tick. */
function Spread({ read, med }) {
  const max = Math.max(10000, Math.ceil((read[0]?.kelvin ?? 0) / 1000) * 1000), x = (k) => (Math.min(k, max) / max) * 100;
  const hottest = read[0];
  return <div className="kf-spread" role="img" aria-label={`${read.length} tokens from ${fmtK(read[read.length - 1]?.kelvin)} to ${fmtK(hottest?.kelvin)}, median ${fmtK(med)}`}>
    <div className="kf-spread-bar" style={{ '--ten': `${(10000 / max) * 100}%` }} />
    {read.map((t) => <i key={t.address} style={{ left: x(t.kelvin) + '%', background: rampColor(t.kelvin) }} />)}
    {med != null && <b className="kf-spread-med" style={{ left: x(med) + '%' }}><span>median</span></b>}
    {hottest && <em className="kf-spread-top" style={{ left: x(hottest.kelvin) + '%' }}>{hottest.symbol}</em>}
    <span className="kf-spread-axis" aria-hidden="true">{[0, 5000, 10000].filter((v) => v <= max).map((v) => <small key={v} style={{ left: x(v) + '%' }}>{v.toLocaleString('en-US')}</small>)}</span>
  </div>;
}

/** The newest trades of the board as they land on chain, each with its block. */
function Landing() {
  const tape = useTape();
  const rows = tape.trades.slice(0, 4);
  return <div className="kf-landing">
    <header><span className="kv-label">Trades landing on chain</span><span className="kv-num">{tape.head ? `head ${block(tape.head)}` : tape.error ? 'no reading' : 'reading'}</span></header>
    <ol>
      {rows.map((t) => <li key={t.tx + t.logIndex}>
        <Link to={'/token/' + t.token}>
          <i data-side={t.side} aria-label={t.side} />
          <b>{t.symbol}</b>
          <span className="kv-num">{fmtUsd(t.usd)}</span>
          <em className="kv-num" style={{ color: rampColor(t.kelvin) }}>{fmtK(t.kelvin)}</em>
          <small className="kv-num">{block(t.block)}</small>
        </Link>
      </li>)}
      {!rows.length && Array.from({ length: 4 }, (_, i) => <li key={i} className="kf-landing-wait"><span>{i === 0 ? (tape.error || (tape.at ? 'No board trade in the last blocks' : 'Reading the chain')) : ''}</span></li>)}
    </ol>
  </div>;
}

/** Every note added in the last 24 hours as one mark, ETH then USDG. */
function Notes({ eth, usdg }) {
  const n = (v) => Math.min(400, v ?? 0);
  return <div className="kf-notes" role="img" aria-label={`${eth ?? 'unknown'} ETH notes and ${usdg ?? 'unknown'} USDG notes added in 24 hours`}>
    {Array.from({ length: n(eth) }, (_, i) => <i key={'e' + i} />)}
    {Array.from({ length: n(usdg) }, (_, i) => <i key={'u' + i} className="u" />)}
  </div>;
}

/** The close: the public side's numbers on the hot half, the private side's on the cold half, the bloom on the seam. */
export function EndSplit({ heat }) {
  const act = useReading('/api/privacy?action=activity', 300000);
  const tokens = heat.data?.tokens || [];
  const read = useMemo(() => tokens.filter((t) => t.kelvin != null).sort((a, b) => b.kelvin - a.kelvin), [tokens]);
  const med = heat.data?.summary?.medianKelvin ?? medianK(read.map((t) => t.kelvin)), hottest = read[0];
  const at = heat.data?.at ? Date.parse(heat.data.at) : 0;
  const e = act.data?.eth, u = act.data?.usdg;
  const added = e?.notes24h != null && u?.notes24h != null ? e.notes24h + u.notes24h : null;
  return <div className="kf-end">
    <h2 id="kv-end" className="kf-end-title">Read the <em>heat</em>, keep your <em className="cold">cool</em></h2>
    <div className="kf-end-hot">
      <div className="kf-end-num">
        <span className="kv-label">Board median</span>
        <b className="kf-big kv-num" style={{ color: med == null ? undefined : rampColor(med) }}>{fmtK(med)}</b>
        <p>{read.length ? <>{read.length} of {tokens.length} tokens read at {clockS(at)}</> : heat.error || 'Reading the board'}</p>
      </div>
      {read.length > 0 && <Spread read={read} med={med} />}
      {hottest ? <Link className="kf-pick" to={'/token/' + hottest.address}><span>Hottest</span><Coin t={hottest} size={18} /><b>{hottest.symbol}</b><em className="kv-num" style={{ color: rampColor(hottest.kelvin) }}>{fmtK(hottest.kelvin)}</em><small className="kv-num">{hottest.trades1h?.toLocaleString('en-US')} trades / 1h</small><ArrowUpRight size={14} /></Link> : <span className="kf-pick">—</span>}
      <Landing />
      <Link className="kv-key" to="/heat"><span>Read the heat</span><ArrowUpRight /></Link>
    </div>
    <div className="kf-end-seam"><div className="kf-slot" data-slot aria-hidden="true" /></div>
    <div className="kf-end-cold">
      <div className="kf-end-num">
        <span className="kv-label">Notes added to the private pools, 24h</span>
        <b className="kf-big kv-num">{added == null ? '—' : added.toLocaleString('en-US')}</b>
        <p>{act.data ? <>Pool counters read on chain at {clock(act.at)}</> : act.error ? 'The pools could not be read right now' : 'Reading the pools on chain'}</p>
      </div>
      <Notes eth={e?.notes24h} usdg={u?.notes24h} />
      <table className="kf-pools">
        <caption className="sr-only">The two private pools</caption>
        <thead><tr><th scope="col">Pool</th><th scope="col">Notes</th><th scope="col">Added 24h</th></tr></thead>
        <tbody>
          <tr><th scope="row"><i className="e" />ETH</th><td className="kv-num">{e?.notes != null ? e.notes.toLocaleString('en-US') : '—'}</td><td className="kv-num">{e?.notes24h != null ? '+' + e.notes24h : '—'}</td></tr>
          <tr><th scope="row"><i className="u" />USDG</th><td className="kv-num">{u?.notes != null ? u.notes.toLocaleString('en-US') : '—'}</td><td className="kv-num">{u?.notes24h != null ? '+' + u.notes24h : '—'}</td></tr>
        </tbody>
      </table>
      <p className="kf-notes-key">One mark is one note. The more notes pass through, the easier a withdrawal blends in.</p>
      <Link className="kv-key cold" to="/cold"><span>Go cold</span><Snowflake /></Link>
    </div>
  </div>;
}

const ROUTES = [['/heat', 'Heat', 'Every token in kelvin'], ['/launch', 'Launch', 'Starts cold at 0 K'], ['/agent', 'Agent', 'Read only, never signs'], ['/cold', 'Cold', 'The private pools'], ['/kelvo', IDENTITY.ticker, 'Contract TBA'], ['/docs', 'Docs', 'Rules, contracts, limits']];
const DOCS = [['heat', 'The heat rule'], ['token', 'Token pages and buys'], ['launch', 'Launch'], ['agent', 'Agent'], ['cold', 'Cold side'], ['keys', 'Keys and recovery'], ['kelvo', IDENTITY.ticker], ['status', 'Status and sources']];
const LOG = [
  ['2026-10-02', 'Oct 2, 2026', 'Launch on the Pons curve paired with ETH, the agent persona written into the token on chain.'],
  ['2026-10-02', 'Oct 2, 2026', 'First build: the bloom, the heat rule, the heat board, token pages, the agent, the cold side with the trail ΔT, the docs.'],
];

/** What the page is reading right now, each with its time or block. */
function Status({ heat }) {
  const tape = useTape(), cfg = useReading('/api/privacy', 60000), act = useReading('/api/privacy?action=activity', 300000);
  const items = [
    ['Board', heat.data ? 'live' : heat.error ? 'error' : 'wait', heat.data?.at ? `read ${clockS(Date.parse(heat.data.at))}` : heat.error ? 'no reading' : 'reading'],
    ['Chain head', tape.head ? 'live' : tape.error ? 'error' : 'wait', tape.head ? `${block(tape.head)} at ${clockS(tape.headAt ? Date.parse(tape.headAt) : tape.at)}` : tape.error ? 'no reading' : 'reading'],
    ['Private pools', act.data ? 'live' : act.error ? 'error' : 'wait', act.data ? `counted ${clock(act.at)}` : act.error ? 'no reading' : 'reading'],
    ['Relay terms', cfg.data ? 'live' : cfg.error ? 'error' : 'wait', cfg.data ? `checked ${clock(cfg.data.checkedAt)}` : cfg.error ? 'no reading' : 'reading'],
  ];
  return <ul className="kf-foot-status" aria-label="What this page is reading">
    {items.map(([name, state, text]) => <li key={name}><Lamp state={state} /><b>{name}</b><span className="kv-num">{text}</span></li>)}
  </ul>;
}

/** The footer: where everything is, what is still TBA, what changed when, and what the page is reading now. */
export function Footer({ heat }) {
  const tba = (v) => v || 'TBA';
  return <footer className="kf-foot">
    <Status heat={heat} />
    <div className="kf-foot-grid">
      <div className="kf-foot-brand">
        <Link to="/" className="kf-foot-mark"><img src="/brand/kelvo-64.png" alt="" width="34" height="34" /><span>Kelvo</span></Link>
        <p>Every Robinhood Chain token read as a temperature. Kelvo holds nothing: your wallet signs every step.</p>
      </div>
      <nav className="kf-foot-col" aria-label="Pages">
        <span className="kv-label">Pages</span>
        <ul>{ROUTES.map(([to, label, note]) => <li key={to}><Link to={to}><b>{label}</b><span>{note}</span></Link></li>)}</ul>
      </nav>
      <nav className="kf-foot-col" aria-label="Docs">
        <span className="kv-label">Docs</span>
        <ul className="kf-foot-docs">{DOCS.map(([id, label]) => <li key={id}><Link to={'/docs#' + id}>{label}</Link></li>)}</ul>
      </nav>
      <div className="kf-foot-col">
        <span className="kv-label">{IDENTITY.ticker}</span>
        <dl className="kf-foot-id">
          <div><dt>Contract</dt><dd className={IDENTITY.contract ? '' : 'tba'}>{tba(IDENTITY.contract)}</dd></div>
          <div><dt>Holder bar</dt><dd className={HOLDER_MIN_USD ? '' : 'tba'}>{HOLDER_MIN_USD ? '$' + HOLDER_MIN_USD : 'TBA'}</dd></div>
          <div><dt>X</dt><dd className={IDENTITY.x ? '' : 'tba'}>{tba(IDENTITY.x)}</dd></div>
          <div><dt>Telegram</dt><dd className={IDENTITY.telegram ? '' : 'tba'}>{tba(IDENTITY.telegram)}</dd></div>
          <div><dt>Source</dt><dd className={IDENTITY.repo ? '' : 'tba'}>{tba(IDENTITY.repo)}</dd></div>
          <div><dt>Network</dt><dd><a href={EXPLORER} target="_blank" rel="noreferrer">Robinhood Chain<ArrowUpRight size={12} /></a></dd></div>
        </dl>
      </div>
      <div className="kf-foot-col kf-foot-log">
        <span className="kv-label">Changelog</span>
        <ol>{LOG.map(([iso, d, t], i) => <li key={i}><time dateTime={iso}>{d}</time><span>{t}</span></li>)}</ol>
        <Link className="kf-foot-more" to="/docs#changelog">Full changelog<ArrowUpRight size={13} /></Link>
      </div>
    </div>
  </footer>;
}
