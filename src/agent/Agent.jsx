import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUp, ArrowUpRight, Check, CircleHelp, LockKeyhole, PenLine, RefreshCw, Snowflake, Square, TriangleAlert, Wallet, X } from 'lucide-react';
import Bloom from '../bloom/Bloom';
import { HOLDER_MIN_USD, IDENTITY } from '../identity';
import { useTerminalWallet, walletError } from '../wallet';
import { AGENT_MAX_INPUT, AGENT_SESSION_HOURS, SUGGESTIONS, agentSignInMessage } from '../agent-message';
import { bloomPick, fmtK, fmtPct, fmtUsd, heat01, rampColor, short, useHeat } from '../heat-client';
import './agent.css';

// The agent: the bloom holds whatever it last read, the conversation runs beside it. Read only; it never signs or sends.
const KEY = 'kelvo.agent.session.v1';
const usd = (v) => (v == null ? '—' : '$' + v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : 2 }));
const price = (v) => (v == null ? '—' : v >= 1 ? usd(v) : '$' + v.toPrecision(4));
const amt = (v) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: v >= 1000 ? 0 : 6 }));
const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

/** Agent text: paragraphs, "- " lists and **bold**. Everything else stays plain text. */
function Prose({ text }) {
  const blocks = text.replace(/\s*—\s*/g, ', ').trim().split(/\n{2,}/);
  const inline = (s, k) => s.split(/(\*\*[^*]+\*\*)/).map((x, i) => (x.startsWith('**') && x.endsWith('**') ? <b key={k + '-' + i}>{x.slice(2, -2)}</b> : x));
  return blocks.map((b, i) => {
    const lines = b.split('\n');
    if (lines.every((l) => /^\s*([-•*]|\d+\.)\s+/.test(l))) return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-•*]|\d+\.)\s+/, ''), i + '-' + j)}</li>)}</ul>;
    return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l, i + '-' + j)}</span>)}</p>;
  });
}

const LEVEL = { pass: [Check, 'Pass'], warn: [TriangleAlert, 'Watch'], risk: [X, 'Risk'], block: [X, 'Blocked'], unknown: [CircleHelp, 'Not given'] };
const Temp = ({ k }) => <b className="kv-ag-k" style={{ color: rampColor(k) }}>{fmtK(k)}</b>;

function Card({ card }) {
  if (card.kind === 'heat') return <div className="kv-ag-card">
    <header><b>{card.query ? `Heat · ${card.query.toUpperCase()}` : card.order === 'coldest' ? 'Coldest on the board' : 'Hottest on the board'}</b><span>median {fmtK(card.medianKelvin)}</span></header>
    <ol className="kv-ag-rows">{card.tokens.map((t) => <li key={t.address}><Link to={'/token/' + t.address}>
      <i style={{ '--c': rampColor(t.kelvin), '--w': Math.max(0.04, heat01(t.kelvin)) }} /><span><b>{t.symbol}</b><small>{short(t.address)}</small></span>
      <Temp k={t.kelvin} /><em className={tone(t.change24h)}>{fmtPct(t.change24h)}</em><ArrowUpRight size={14} />
    </Link></li>)}</ol>
  </div>;
  if (card.kind === 'token') { const T = card.temperature || {}; return <div className="kv-ag-card" style={{ '--c': rampColor(T.kelvin) }}>
    <header><b>{card.symbol}</b><span>{short(card.address)}{card.holders != null ? ` · ${card.holders.toLocaleString('en-US')} holders` : ''}</span></header>
    <div className="kv-ag-big"><Temp k={T.kelvin} /><div className="kv-ag-bar"><i style={{ left: heat01(T.kelvin) * 100 + '%' }} /></div></div>
    <dl className="kv-ag-grid">
      <div><dt>Price</dt><dd>{price(card.priceUsd)}<small className={tone(card.change24h)}>{fmtPct(card.change24h)}</small></dd></div>
      <div><dt>Trades 1h</dt><dd>{T.trades1h ?? '—'}<small>{T.buyShare1h != null ? T.buyShare1h + '% buys' : ''}</small></dd></div>
      <div><dt>Trades 24h</dt><dd>{T.trades24h ?? '—'}</dd></div>
      <div><dt>Liquidity</dt><dd>{fmtUsd(card.liquidityUsd)}</dd></div>
      <div><dt>Volume 24h</dt><dd>{fmtUsd(card.volume24h)}</dd></div>
      <div><dt>Route</dt><dd>{card.route ? card.route.venue : 'None'}</dd></div>
    </dl>
    <Link className="kv-key ink" to={'/token/' + card.address}><span>Open the token page</span><ArrowUpRight /></Link>
  </div>; }
  if (card.kind === 'quote') return <div className="kv-ag-card">
    <header><b>Buy {card.symbol}</b><span>{card.venue ? `${card.venue} · via ${card.via}` : 'No route'}</span></header>
    {card.reason ? <p className="kv-ag-note">{card.reason}</p> : <dl className="kv-ag-list">
      <div><dt>You pay</dt><dd>{card.eth} ETH</dd></div>
      <div><dt>You receive about</dt><dd>{amt(card.expected)} {card.symbol}</dd></div>
      <div><dt>At least</dt><dd>{amt(card.minimum)} {card.symbol} · {card.slippagePercent}% slippage</dd></div>
    </dl>}
    {!card.reason && <><Link className="kv-key" to={card.link}><span>Review on the token page</span><ArrowUpRight /></Link>
      <p className="kv-ag-note">Opens the token page with {card.eth} ETH filled in. It quotes again, dry-runs the call, and your wallet asks before anything moves.</p></>}
  </div>;
  if (card.kind === 'wallet') return <div className="kv-ag-card">
    <header><b>Your wallet</b><span>{short(card.account)}</span></header>
    <dl className="kv-ag-list">
      <div><dt>ETH</dt><dd>{amt(card.eth)}</dd></div>
      <div><dt>{card.project.ticker}</dt><dd>{card.project.contract ? 'see holdings' : 'no contract yet'}</dd></div>
    </dl>
    {card.holdings.length > 0 && <ol className="kv-ag-rows">{card.holdings.map((h) => <li key={h.address}><Link to={'/token/' + h.address}>
      <i style={{ '--c': rampColor(h.kelvin), '--w': Math.max(0.04, heat01(h.kelvin)) }} /><span><b>{h.symbol}</b><small>{amt(h.amount)}</small></span>
      <Temp k={h.kelvin} /><em>{usd(h.usd)}</em><ArrowUpRight size={14} />
    </Link></li>)}</ol>}
  </div>;
  if (card.kind === 'pools') return <div className="kv-ag-card">
    <header><b>Private pools</b><span>fee = flat + {card.feeRateBps / 100}%</span></header>
    <table className="kv-ag-table"><thead><tr><th /><th>ETH</th><th>USDG</th></tr></thead><tbody>
      {[['Notes', (p) => p.notes?.toLocaleString('en-US') ?? '—'], ['New in 24h', (p) => p.notes24h ?? '—'], ['Min. deposit', (p) => amt(p.minimumDeposit)], ['Min. withdrawal', (p) => amt(p.minimumWithdrawal)], ['Flat fee', (p) => amt(p.flatFee == null ? null : Number(p.flatFee.toPrecision(4)))]].map(([label, f]) =>
        <tr key={label}><th>{label}</th><td>{f(card.pools.eth)}</td><td>{f(card.pools.usdg)}</td></tr>)}
    </tbody></table>
  </div>;
  if (card.kind === 'privacy') return <div className="kv-ag-card">
    <header><b>Withdrawal check · {card.amount} {card.symbol}</b><span>{card.passed} of {card.of} pass</span></header>
    <div className="kv-ag-delta">
      <span className="kv-label">Trail ΔT</span><b>{card.deltaK == null ? 'blocked' : `+${card.deltaK} K`}</b>
      <div className="kv-ag-delta-bar"><i style={{ width: card.deltaK == null ? '100%' : Math.min(100, (card.deltaK / 160) * 100) + '%' }} /></div>
      <small>0 K blends in with the pool</small>
    </div>
    <dl className="kv-ag-list">
      <div><dt>Fee</dt><dd>{card.fee == null ? '—' : `${amt(card.fee)} ${card.symbol}`}<small>{card.flatFee != null && card.feeRateBps != null ? ` ${card.flatFee} flat + ${card.feeRateBps / 100}%` : ''}</small></dd></div>
      <div><dt>You receive</dt><dd>{card.receive == null ? '—' : `${amt(card.receive)} ${card.symbol}`}</dd></div>
    </dl>
    <ul className="kv-ag-checks">{card.checks.map((c) => { const [Icon, word] = LEVEL[c.level] || LEVEL.unknown; return <li key={c.id} data-level={c.level}><Icon size={15} aria-label={word} /><span><b>{c.title}</b>{c.detail}</span></li>; })}</ul>
    <Link className="kv-key cold" to="/cold"><span>Open the cold side</span><Snowflake /></Link>
    <p className="kv-ag-note">{card.note}</p>
  </div>;
  return null;
}

function Turn({ m }) {
  if (m.role === 'user') return <div className="kv-ag-turn user"><p>{m.text}</p></div>;
  return <div className="kv-ag-turn agent">
    <img className={'kv-ag-mark' + (m.live ? ' live' : '')} src="/brand/kelvo-64.png" alt="" width="26" height="26" />
    <div className="kv-ag-body">
      {!m.parts.length && m.live && <p className="kv-ag-wait">Reading</p>}
      {m.parts.map((p, i) => p.type === 'text' ? <div className="kv-ag-prose" key={i}><Prose text={p.text} /></div>
        : p.type === 'tool' ? <div className="kv-ag-tool" key={i} data-state={p.state}><span className="kv-ag-dot" />{p.label}{p.card && p.state === 'done' && <Card card={p.card} />}</div>
        : <p className="kv-ag-error" role="alert" key={i}>{p.text}</p>)}
    </div>
  </div>;
}

async function* events(response) {
  const reader = response.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      let event = 'message', data = '';
      for (const line of chunk.split('\n')) { if (line.startsWith('event: ')) event = line.slice(7); else if (line.startsWith('data: ')) data += line.slice(6); }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}
const wire = (m) => (m.role === 'user' ? { role: 'user', text: m.text } : { role: 'assistant', text: m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('').trim() || 'I could not answer that.' });
function readSession(account) {
  try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); return s && s.account === account && s.expiresAt > Date.now() + 60e3 ? s : null; } catch { return null; }
}

/** What the bloom holds: the tokens of the last reading that named some, else the market. A withdrawal check cools it by its ΔT. */
function useHeld(messages, market) {
  return useMemo(() => {
    let card = null;
    for (let i = messages.length - 1; i >= 0 && !card; i--) {
      const parts = messages[i].parts || [];
      for (let j = parts.length - 1; j >= 0; j--) { const c = parts[j].type === 'tool' && parts[j].state === 'done' && parts[j].card; if (c && ['heat', 'token', 'wallet', 'privacy'].includes(c.kind)) { card = c; break; } }
    }
    const base = { tokens: market, focus: -1, cool: 0, delta: null };
    if (!card) return base;
    if (card.kind === 'heat') { const t = card.tokens.filter((x) => x.kelvin != null); return t.length >= 3 ? { ...base, tokens: t.slice(0, 9) } : base; }
    if (card.kind === 'wallet') { const t = card.holdings.filter((x) => x.kelvin != null); return t.length >= 3 ? { ...base, tokens: t.slice(0, 9) } : base; }
    if (card.kind === 'token') {
      const me = { symbol: card.symbol, address: card.address, kelvin: card.temperature?.kelvin ?? null };
      if (me.kelvin == null) return base;
      const tokens = [...market.filter((t) => t.address !== me.address).slice(0, 8), me].sort((a, b) => b.kelvin - a.kelvin);
      return { ...base, tokens, focus: tokens.indexOf(me) };
    }
    return { ...base, cool: card.deltaK == null ? 0 : Math.max(0.15, 1 - card.deltaK / 140), delta: card.deltaK };
  }, [messages, market]);
}

export default function Agent() {
  const wallet = useTerminalWallet(), account = wallet.account, navigate = useNavigate();
  const { data } = useHeat();
  const market = useMemo(() => bloomPick(data?.tokens), [data]);
  const [status, setStatus] = useState(null);
  const [holder, setHolder] = useState({ state: 'idle' });
  const [session, setSession] = useState(null);
  const [sign, setSign] = useState({ state: 'idle' });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef(null), field = useRef(null), stick = useRef(true), stage = useRef(null), drive = useRef({});
  const held = useHeld(messages, market);
  const heats = useMemo(() => (held.tokens.length >= 3 ? held.tokens.map((t) => heat01(t.kelvin)) : null), [held]);
  const [hover, setHover] = useState(-1);

  // the bloom sits in its stage; it opens while the agent reads and cools with a quiet withdrawal plan
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const place = () => { const w = el.clientWidth, h = el.clientHeight, phone = innerWidth < 860; drive.current = { ...drive.current, cx: w * 0.5, cy: h * (phone ? 0.39 : 0.42), size: Math.min(w * (phone ? 0.3 : 0.34), h * (phone ? 0.3 : 0.32)) }; };
    place();
    const ro = new ResizeObserver(place); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { drive.current = { ...drive.current, open: busy ? 0.75 : 0.3, cool: held.cool, focus: hover >= 0 ? hover : held.focus }; }, [busy, held, hover]);
  const pick = useCallback((i) => { const t = held.tokens[i]; if (t) navigate('/token/' + t.address); }, [held, navigate]);

  useEffect(() => { fetch('/api/agent?action=status').then((r) => r.json()).then(setStatus).catch(() => setStatus({ configured: false, error: true })); }, []);
  useEffect(() => { setSession(account ? readSession(account) : null); setMessages([]); }, [account]);

  const gated = Boolean(status?.gated);
  const check = useCallback(async () => {
    if (!account) { setHolder({ state: 'idle' }); return; }
    setHolder((h) => ({ state: 'checking', data: h.data?.account === account ? h.data : null }));
    try {
      const r = await fetch('/api/terminal?action=holder&account=' + account), d = await r.json();
      if (!r.ok) throw new Error(d?.error || 'The balance could not be read.');
      setHolder({ state: d.ok ? 'open' : d.worthUsd == null ? 'unknown' : 'short', data: d });
    } catch (e) { setHolder({ state: 'error', error: e.message }); }
  }, [account]);
  useEffect(() => { if (status?.configured && gated && !session) void check(); }, [status?.configured, gated, session, check]);
  const canSign = !gated || holder.state === 'open';

  const signIn = async () => {
    setSign({ state: 'busy' });
    try {
      const issued = new Date().toISOString(), nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      const signature = await wallet.signMessage(agentSignInMessage(account, issued, nonce), account);
      const r = await fetch('/api/agent?action=session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account, issued, nonce, signature }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'The sign-in did not go through.');
      const s = { account: d.account, token: d.token, expiresAt: d.expiresAt };
      try { sessionStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
      setSession(s); setSign({ state: 'idle' });
    } catch (e) { setSign({ state: 'error', error: walletError(e, e instanceof Error ? e.message : 'The sign-in did not go through.') }); }
  };
  const signOut = () => { try { sessionStorage.removeItem(KEY); } catch { /* private mode */ } setSession(null); setMessages([]); };

  const ask = async (text) => {
    const q = text.trim().slice(0, AGENT_MAX_INPUT);
    if (!q || busy || !session) return;
    const next = [...messages, { role: 'user', text: q }, { role: 'assistant', parts: [], live: true }];
    stick.current = true; setMessages(next); setInput(''); setBusy(true);
    const ac = new AbortController(); abort.current = ac;
    const patch = (fn) => setMessages((ms) => { const copy = ms.slice(), last = { ...copy[copy.length - 1] }; last.parts = fn(last.parts.slice()); copy[copy.length - 1] = last; return copy; });
    try {
      const r = await fetch('/api/agent?action=chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: session.token, messages: next.slice(0, -1).map(wire) }), signal: ac.signal });
      if (!r.ok || !(r.headers.get('content-type') || '').includes('text/event-stream')) {
        const d = await r.json().catch(() => ({}));
        if (r.status === 401 || r.status === 403) signOut();
        throw new Error(d.error || 'The agent could not answer.');
      }
      for await (const { event, data: d } of events(r)) {
        if (event === 'text') patch((parts) => { const last = parts[parts.length - 1]; if (last?.type === 'text') parts[parts.length - 1] = { ...last, text: last.text + d.delta }; else parts.push({ type: 'text', text: d.delta }); return parts; });
        else if (event === 'tool') patch((parts) => { const i = parts.findIndex((p) => p.type === 'tool' && p.id === d.id); const part = { ...(i >= 0 ? parts[i] : {}), type: 'tool', ...d }; if (i >= 0) parts[i] = part; else parts.push(part); return parts; });
        else if (event === 'error') patch((parts) => [...parts, { type: 'error', text: d.error }]);
      }
    } catch (e) {
      if (e?.name !== 'AbortError') patch((parts) => [...parts, { type: 'error', text: e instanceof Error ? e.message : 'The agent could not answer.' }]);
    } finally {
      setMessages((ms) => { const copy = ms.slice(); if (copy.length) copy[copy.length - 1] = { ...copy[copy.length - 1], live: false }; return copy; });
      setBusy(false); abort.current = null; field.current?.focus({ preventScroll: true });
    }
  };
  // follow the answer while it streams; only the reader's own scroll up stops it, and reaching the end again resumes it
  useEffect(() => {
    const up = (e) => { if (e.type !== 'wheel' || e.deltaY < 0) stick.current = false; };
    const keys = (e) => { if (['PageUp', 'ArrowUp', 'Home'].includes(e.key) && e.target === document.body) stick.current = false; };
    const end = () => { if (innerHeight + scrollY >= document.documentElement.scrollHeight - 80) stick.current = true; };
    addEventListener('wheel', up, { passive: true }); addEventListener('touchmove', up, { passive: true }); addEventListener('keydown', keys); addEventListener('scroll', end, { passive: true });
    return () => { removeEventListener('wheel', up); removeEventListener('touchmove', up); removeEventListener('keydown', keys); removeEventListener('scroll', end); };
  }, []);
  useEffect(() => { if (stick.current && messages.length) scrollTo({ top: document.documentElement.scrollHeight }); }, [messages]);
  useEffect(() => () => abort.current?.abort(), []);

  const d = holder.data;
  let gate = null;
  if (!status) gate = <div className="kv-ag-gate" aria-busy="true"><p className="kv-ag-note">Checking the agent</p></div>;
  else if (!status.configured) gate = <div className="kv-ag-gate"><LockKeyhole size={22} /><h2>The agent is not switched on yet</h2><p>It opens here as soon as its service key is set. The heat board and the token pages work without it.</p></div>;
  else if (!account) gate = <div className="kv-ag-gate"><Wallet size={22} />
    <h2>{gated ? `Hold ${usd(HOLDER_MIN_USD)} of ${IDENTITY.ticker} to ask` : 'Connect a wallet to ask'}</h2>
    <p>{gated ? `Connect the wallet you hold ${IDENTITY.ticker} in. Kelvo reads the balance on Robinhood Chain, then you sign one message.` : `Sign one message with any wallet to open the agent for ${AGENT_SESSION_HOURS} hours. While ${IDENTITY.ticker} has no contract, each wallet gets a daily number of questions.`}</p>
    <div className="kv-ag-keys"><button type="button" className="kv-key" onClick={() => wallet.connect()} disabled={wallet.busy}><span>{wallet.busy ? 'Waiting for wallet' : 'Connect wallet'}</span><Wallet /></button></div>
    {wallet.error && <p className="kv-ag-note warn" role="alert">{wallet.error}</p>}
  </div>;
  else if (!session) gate = <div className="kv-ag-gate">
    {canSign ? <PenLine size={22} /> : <LockKeyhole size={22} />}
    <h2>{canSign ? 'Sign in to the agent' : `Hold ${usd(HOLDER_MIN_USD)} of ${IDENTITY.ticker} to ask`}</h2>
    <p>{canSign ? `Your wallet signs one message. It is not a transaction and cannot move funds. The session lasts ${AGENT_SESSION_HOURS} hours in this tab.` : `Kelvo reads the ${IDENTITY.ticker} balance of ${short(account)} on Robinhood Chain.`}</p>
    {gated && <dl className="kv-ag-list">
      <div><dt>Holds</dt><dd>{d ? amt(Math.round(d.amount)) + ' ' + IDENTITY.ticker.slice(1) : '—'}</dd></div>
      <div><dt>Worth</dt><dd>{d?.worthUsd != null ? usd(d.worthUsd) : '—'}</dd></div>
      <div><dt>Needed</dt><dd>{usd(HOLDER_MIN_USD)}</dd></div>
    </dl>}
    {gated && holder.state === 'short' && <p className="kv-ag-note">{d.amount > 0 ? `This wallet holds about ${usd(d.worthUsd)} of ${IDENTITY.ticker}. Add about ${usd(Math.max(0, HOLDER_MIN_USD - d.worthUsd))} more.` : `This wallet holds no ${IDENTITY.ticker} yet.`}</p>}
    {gated && holder.state === 'unknown' && <p className="kv-ag-note warn">The {IDENTITY.ticker} price could not be read right now. Try again in a moment.</p>}
    {gated && holder.state === 'error' && <p className="kv-ag-note warn" role="alert">{holder.error}</p>}
    {canSign && <pre className="kv-ag-message" aria-label="The message you sign">{agentSignInMessage(account, '<now>', '<random>')}</pre>}
    {sign.state === 'error' && <p className="kv-ag-note warn" role="alert">{sign.error}</p>}
    <div className="kv-ag-keys">
      {canSign ? <button type="button" className="kv-key" onClick={signIn} disabled={sign.state === 'busy'}><span>{sign.state === 'busy' ? 'Waiting for the signature' : 'Sign in'}</span><PenLine /></button>
        : <Link className="kv-key" to={'/token/' + IDENTITY.contract}><span>Buy {IDENTITY.ticker}</span><ArrowUpRight /></Link>}
      {!canSign && <button type="button" className="kv-key ink" onClick={check} disabled={holder.state === 'checking'}><span>{holder.state === 'checking' ? 'Reading' : 'Check again'}</span><RefreshCw /></button>}
    </div>
  </div>;

  const legend = held.tokens.map((t, i) => ({ t, i })).sort((a, b) => (b.t.kelvin ?? 0) - (a.t.kelvin ?? 0));
  return <main className="kv-agent">
    <aside ref={stage} className="kv-ag-stage" aria-label="The tokens the agent last read">
      <Bloom drive={drive} heats={heats} onPick={pick} className="kv-ag-bloom" fallback={<img className="kv-ag-fallback" src="/brand/kelvo-512.png" alt="" />} />
      {legend.length > 0 && <ol className="kv-ag-legend">{legend.map(({ t, i }) => <li key={t.address} className={(hover === i || held.focus === i) ? 'on' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}>
        <Link to={'/token/' + t.address}><i style={{ background: rampColor(t.kelvin) }} /><b>{t.symbol}</b><span className="kv-num">{fmtK(t.kelvin)}</span></Link>
      </li>)}</ol>}
      {held.delta != null && <div className="kv-ag-trail"><span className="kv-label">Trail ΔT</span><b>+{held.delta} K</b></div>}
    </aside>

    <section className="kv-ag-talk" aria-label="Agent conversation">
      <header className="kv-ag-head">
        <span className="kv-label">Agent · read only</span>
        <h1>Ask the <em>bloom</em></h1>
        <p>It reads the heat board, any token, a buy quote, your wallet and the private pools, then answers with those readings attached. It never signs, sends or asks for a key.</p>
      </header>
      {gate || <>
        <div className="kv-ag-log" aria-live="polite">
          {!messages.length && <div className="kv-ag-suggest">{SUGGESTIONS.map((s) => <button type="button" key={s} onClick={() => ask(s)}><span>{s}</span><ArrowUpRight size={14} /></button>)}</div>}
          {messages.map((m, i) => <Turn m={m} key={i} />)}
        </div>
        <form className="kv-ag-compose" onSubmit={(e) => { e.preventDefault(); void ask(input); }}>
          <label className="sr-only" htmlFor="kv-ag-input">Ask the agent</label>
          <textarea id="kv-ag-input" ref={field} rows={1} value={input} maxLength={AGENT_MAX_INPUT} placeholder="Ask about a token, a buy or a private withdrawal" onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(input); } }} />
          {busy ? <button type="button" className="kv-ag-send stop" onClick={() => abort.current?.abort()} aria-label="Stop the answer"><Square size={16} /></button>
            : <button type="submit" className="kv-ag-send" disabled={!input.trim()} aria-label="Send"><ArrowUp size={18} /></button>}
          <p className="kv-ag-session">{short(session.account)} · until {new Date(session.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · <button type="button" onClick={signOut}>Sign out</button></p>
        </form>
      </>}
    </section>
  </main>;
}
