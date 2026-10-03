import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Check, Copy, RefreshCw } from 'lucide-react';
import { formatUnits, parseEther } from 'viem';
import { SWAP_ROUTER02, UNIVERSAL_ROUTER, encodeCurveBuy, encodeV3Buy, encodeV4Buy } from '../chain-route';
import { EXPLORER, useTerminalWallet, walletError } from '../wallet';
import { WalletKey } from '../chrome/Tuner';
import { fmtK, fmtPct, fmtUsd, heat01, rampColor, short } from '../heat-client';
import './token.css';

// One token: its temperature taken apart, its chart and pools, and a buy with ETH from the visitor's own wallet.
const api = (q, init) => fetch('/api/terminal?' + new URLSearchParams(q), { signal: AbortSignal.timeout(30000), ...init }).then(async (r) => { const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || 'The terminal is unavailable.'); return b; });
const price = (p) => (p == null ? '—' : '$' + (p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 1 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : p.toLocaleString('en-US', { maximumSignificantDigits: 4 })));
const amount = (raw, decimals, max = 4) => { if (raw == null || decimals == null) return '—'; const n = Number(formatUnits(BigInt(raw), decimals)); return n === 0 ? '0' : n < 1e-4 ? n.toExponential(2) : n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : max }); };
const isAddress = (v) => /^0x[0-9a-fA-F]{40}$/.test(v);

/** The rule with this token's own numbers in it. */
function Breakdown({ c }) {
  const t24 = (c.buys24h ?? 0) + (c.sells24h ?? 0), t1 = (c.buys1h ?? 0) + (c.sells1h ?? 0);
  const share = t1 ? (c.buys1h ?? 0) / t1 : 0.5, turn = c.liquidityUsd > 0 && c.volume1h != null ? Math.min(3, c.volume1h / c.liquidityUsd) : 0;
  const day = 30 * Math.sqrt(t24), hour = 260 * Math.log1p(t1) * (0.75 + 0.5 * share) * (1 + turn / 2);
  const n = (v, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  return <div className="kv-break">
    <div><span>The day</span><code>30 × √{n(t24)}</code><b>{n(day)} K</b></div>
    <div><span>The hour</span><code>260 × ln(1 + {n(t1)}) × {n(0.75 + 0.5 * share, 2)} × {n(1 + turn / 2, 2)}</code><b>{n(hour)} K</b></div>
    <p>{n(t1)} trades in the last hour, {Math.round(share * 100)}% buys, turnover {n(turn, 2)} (hour volume {fmtUsd(c.volume1h)} over liquidity {fmtUsd(c.liquidityUsd)}).</p>
  </div>;
}

function Chart({ pool }) {
  const [frame, setFrame] = useState('1h'), [data, setData] = useState(null), [error, setError] = useState('');
  const canvas = useRef(null), [hover, setHover] = useState(null);
  useEffect(() => {
    if (!pool) return;
    let alive = true; setData(null); setError('');
    api({ action: 'candles', pool, frame }).then((d) => { if (alive) setData(d.candles); }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [pool, frame]);
  const draw = useCallback(() => {
    const cv = canvas.current; if (!cv || !data?.length) return;
    const dpr = Math.min(devicePixelRatio || 1, 2), w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const padR = 76, padT = 16, padB = 24, cw = (w - padR) / data.length;
    const lo = Math.min(...data.map((c) => c.l)), hi = Math.max(...data.map((c) => c.h)), span = hi - lo || hi * 0.01 || 1;
    const y = (v) => padT + (1 - (v - lo) / span) * (h - padT - padB);
    ctx.font = '500 11px "Martian Mono Variable", monospace'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = lo + (span * i) / 4, yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = 'rgba(239,233,225,.07)'; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
      ctx.fillStyle = '#6f6983'; ctx.fillText(price(v), w - padR + 8, yy);
    }
    data.forEach((c, i) => {
      const x = i * cw + cw / 2, up = c.c >= c.o, col = up ? '#5fe0a2' : '#ff9b8a';
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(c.h)); ctx.lineTo(Math.round(x) + 0.5, y(c.l)); ctx.stroke();
      const top = y(Math.max(c.o, c.c)), bh = Math.max(1, y(Math.min(c.o, c.c)) - top), bw = Math.max(1, cw * 0.62);
      ctx.fillRect(x - bw / 2, top, bw, bh);
    });
    const last = data[data.length - 1], ly = Math.round(y(last.c)) + 0.5;
    ctx.strokeStyle = '#ff5a1f'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w - padR, ly); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#ff5a1f'; ctx.fillRect(w - padR + 2, ly - 9, padR - 4, 18); ctx.fillStyle = '#0b0a10'; ctx.fillText(price(last.c), w - padR + 8, ly);
    if (hover != null && data[hover]) { const x = Math.round(hover * cw + cw / 2) + 0.5; ctx.strokeStyle = 'rgba(239,233,225,.35)'; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); }
  }, [data, hover]);
  useEffect(() => { draw(); const ro = new ResizeObserver(draw); if (canvas.current) ro.observe(canvas.current); return () => ro.disconnect(); }, [draw]);
  const c = hover != null && data?.[hover] ? data[hover] : data?.[data.length - 1];
  return <div className="kv-chart">
    <div className="kv-chart-bar">
      <div className="kv-ohlc">{c ? <><span>O <b>{price(c.o)}</b></span><span>H <b>{price(c.h)}</b></span><span>L <b>{price(c.l)}</b></span><span>C <b>{price(c.c)}</b></span><span>{new Date(c.t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></> : <span>Price in USD</span>}</div>
      <div className="kv-seg small" role="group" aria-label="Chart interval">{['15m', '1h', '4h', '1d'].map((f) => <button key={f} type="button" aria-selected={frame === f} onClick={() => setFrame(f)}>{f}</button>)}</div>
    </div>
    <div className="kv-chart-body">
      {data?.length ? <canvas ref={canvas} aria-label="Price chart" onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.min(data.length - 1, Math.max(0, Math.floor((e.clientX - r.left) / ((r.width - 76) / data.length))))); }} onPointerLeave={() => setHover(null)} />
        : <p className="kv-chart-state">{!pool ? 'No pool to chart' : error ? error : data ? 'No trades in this window' : 'Loading the chart'}</p>}
    </div>
  </div>;
}

function Buy({ coin, wallet, ethRaw, onSent, prefill }) {
  const [input, setInput] = useState(''), [slip, setSlip] = useState(100), [quote, setQuote] = useState(null), [qErr, setQErr] = useState(''), [quoting, setQuoting] = useState(false), [step, setStep] = useState({ kind: 'idle' }), [tick, setTick] = useState(0);
  const wei = useMemo(() => { const v = input.trim(); if (!/^\d*\.?\d*$/.test(v) || !(Number(v) > 0)) return null; try { return parseEther(v); } catch { return null; } }, [input]);
  useEffect(() => { setInput(prefill || ''); setQuote(null); setStep({ kind: 'idle' }); }, [coin.address, prefill]);
  useEffect(() => {
    if (wei == null) { setQuote(null); setQErr(''); setQuoting(false); return; }
    let alive = true; setQuoting(true);
    const t = setTimeout(() => api({ action: 'quote', address: coin.address, amount: wei.toString(), slippage: String(slip), ...(wallet.account ? { account: wallet.account } : {}) })
      .then((q) => { if (alive) { setQuote(q); setQErr(''); } }).catch((e) => { if (alive) { setQErr(e.message); setQuote(null); } }).finally(() => { if (alive) setQuoting(false); }), 350);
    return () => { alive = false; clearTimeout(t); };
  }, [wei, slip, coin.address, wallet.account, tick]);
  const lowEth = ethRaw != null && wei != null && BigInt(ethRaw) < wei;
  const run = async () => {
    if (!quote?.tx || !wallet.account) return;
    const account = wallet.account, amountIn = BigInt(quote.amountIn), minOut = BigInt(quote.minOut), r = quote.route;
    try {
      if (!wallet.onChain) { setStep({ kind: 'busy', label: 'Switching network' }); if (!(await wallet.switchChain())) throw new Error('Switch the wallet to Robinhood Chain and try again.'); }
      // the page builds the same call itself and compares it byte for byte with the server's before anything is signed
      const expected = r.kind === 'v3' ? { to: SWAP_ROUTER02, data: encodeV3Buy(r.path, account, amountIn, minOut, BigInt(quote.deadline)) }
        : r.kind === 'v4' ? { to: UNIVERSAL_ROUTER, data: encodeV4Buy(r.keys.map((k) => ({ key: { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks }, zeroForOne: k.zeroForOne })), amountIn, minOut, BigInt(quote.deadline)) }
        : { to: r.curve, data: encodeCurveBuy(amountIn, minOut, account) };
      if (expected.to.toLowerCase() !== quote.tx.to.toLowerCase() || expected.data.toLowerCase() !== quote.tx.data.toLowerCase() || quote.tx.value !== quote.amountIn) throw new Error('The prepared call does not match this page. Quote again.');
      setStep({ kind: 'busy', label: 'Dry run on the chain' });
      const sim = await api({ action: 'simulate' }, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: account, to: quote.tx.to, data: quote.tx.data, value: quote.tx.value, token: coin.address }) });
      setStep({ kind: 'busy', label: 'Confirm in your wallet' });
      const hash = await wallet.sendTransaction({ from: account, to: quote.tx.to, data: quote.tx.data, value: quote.tx.value, gas: sim.gas });
      setStep({ kind: 'sent', hash }); setInput(''); onSent?.();
    } catch (e) { setStep({ kind: 'error', message: walletError(e, 'The buy did not go through.') }); }
  };
  const busy = step.kind === 'busy' || wallet.busy;
  const label = step.kind === 'busy' ? step.label : !wallet.account ? null : !wallet.onChain ? 'Switch to Robinhood Chain' : wei == null ? 'Enter an amount' : lowEth ? 'Not enough ETH' : quote?.reason ? 'No route for this token' : quoting || !quote ? 'Getting a quote' : `Buy ${coin.symbol}`;
  const path = quote?.route ? [quote.route.venue, [...(quote.route.via || 'ETH').split(' → '), coin.symbol].join(' → ')].join(' · ') : coin.route ? `${coin.route.venue} · ${coin.route.pair}` : null;
  return <section className="kv-panel kv-buy" aria-label={`Buy ${coin.symbol}`}>
    <h2>Buy {coin.symbol}</h2>
    {!coin.route ? <p className="kv-note">No Uniswap or Pons pool against ETH or USDG was found for this token, so Kelvo does not route a buy for it.</p> : <>
      <label className="kv-in"><span>You pay</span><input inputMode="decimal" autoComplete="off" placeholder="0.00" value={input} onChange={(e) => { setInput(e.target.value.replace(',', '.')); if (step.kind !== 'busy') setStep({ kind: 'idle' }); }} aria-label="Amount of ETH" /><b>ETH</b></label>
      <div className="kv-chips" role="group" aria-label="Quick amounts">{['0.001', '0.005', '0.01', '0.05'].map((v) => <button key={v} type="button" onClick={() => setInput(v)} aria-pressed={input === v}>{v}</button>)}</div>
      <div className="kv-out"><span>You receive</span><b>{quoting ? '…' : quote?.amountOut ? amount(quote.amountOut, quote.decimals) : '—'}</b><i>{coin.symbol}</i><button type="button" className="kv-icon" aria-label="Quote again" disabled={wei == null} onClick={() => setTick((t) => t + 1)}><RefreshCw size={15} /></button></div>
      <dl className="kv-terms">
        <dt>At least</dt><dd>{quote?.minOut ? `${amount(quote.minOut, quote.decimals)} ${coin.symbol}` : '—'}</dd>
        <dt>Slippage</dt><dd><span className="kv-chips small" role="group" aria-label="Slippage">{[[50, '0.5%'], [100, '1%'], [300, '3%']].map(([b, l]) => <button key={b} type="button" aria-pressed={slip === b} onClick={() => setSlip(b)}>{l}</button>)}</span></dd>
        <dt>Route</dt><dd>{path || '—'}</dd>
      </dl>
      {quote?.reason && <p className="kv-note warn">{quote.reason}</p>}
      {qErr && <p className="kv-note warn">{qErr}</p>}
      {!wallet.account ? <WalletKey /> : <button type="button" className="kv-key kv-go" disabled={busy || (wallet.onChain && (!quote?.tx || !!quote.reason || lowEth))} onClick={() => (wallet.onChain ? void run() : void wallet.switchChain())}><span>{label}</span></button>}
      {step.kind === 'sent' && <p className="kv-note ok">Buy sent. <a href={`${EXPLORER}/tx/${step.hash}`} target="_blank" rel="noreferrer">Transaction {short(step.hash)}<ArrowUpRight size={13} /></a></p>}
      {step.kind === 'error' && <p className="kv-note warn" role="alert">{step.message}</p>}
      <p className="kv-fine">From your wallet straight to the pool. Kelvo holds nothing, adds no fee, and dry-runs the exact call from your account before the wallet opens.</p>
    </>}
  </section>;
}

export default function Token() {
  const { address } = useParams(), [search] = useSearchParams();
  const wallet = useTerminalWallet();
  const [coin, setCoin] = useState(null), [err, setErr] = useState(''), [bal, setBal] = useState(null), [copied, setCopied] = useState(false), [n, setN] = useState(0);
  const prefill = /^\d{1,3}(\.\d{1,6})?$/.test(search.get('buy') || '') && Number(search.get('buy')) > 0 ? search.get('buy') : '';
  useEffect(() => {
    if (!isAddress(address || '')) { setErr('That is not a contract address.'); return; }
    let alive = true; setCoin(null); setErr('');
    api({ action: 'coin', address }).then((c) => { if (alive) setCoin(c); }).catch((e) => { if (alive) setErr(e.message); });
    return () => { alive = false; };
  }, [address]);
  useEffect(() => {
    if (!wallet.account) { setBal(null); return; }
    let alive = true;
    api({ action: 'balances', account: wallet.account }).then((b) => { if (alive) setBal(b); }).catch(() => {});
    return () => { alive = false; };
  }, [wallet.account, n]);
  const held = bal?.items?.find((i) => i.address === address?.toLowerCase())?.raw ?? null;
  const k = coin?.kelvin ?? null, col = rampColor(k);
  if (err) return <main className="kv-token kv-token-empty"><h1>This reads <em>nothing</em></h1><p>{err}</p><Link className="kv-key" to="/heat"><span>Back to the heat</span></Link></main>;
  if (!coin) return <main className="kv-token kv-token-empty" aria-busy="true"><p>Reading the token</p></main>;
  return <main className="kv-token" style={{ '--c': col }}>
    <aside className="kv-token-side">
      <section className="kv-panel kv-id-card">
        <div className="kv-id-head">{coin.image ? <img src={coin.image} alt="" width="44" height="44" referrerPolicy="no-referrer" /> : <span className="mono">{coin.symbol.slice(0, 3)}</span>}<div><h1>{coin.symbol}</h1><p>{coin.name}</p></div></div>
        <button type="button" className="kv-copy" onClick={() => { navigator.clipboard?.writeText(coin.address); setCopied(true); setTimeout(() => setCopied(false), 1400); }}>{short(coin.address)}{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        <a className="kv-out-link" href={`${EXPLORER}/token/${coin.address}`} target="_blank" rel="noreferrer">Explorer<ArrowUpRight size={13} /></a>
      </section>
      <section className="kv-panel kv-reading-card" aria-label="Temperature">
        <span className="kv-label">Temperature</span>
        <div className="kv-big-k" style={{ color: col }}>{fmtK(k)}</div>
        <div className="kv-k-bar"><i style={{ left: `${heat01(k) * 100}%` }} /></div>
        <Breakdown c={coin} />
      </section>
    </aside>
    <section className="kv-token-main">
      <dl className="kv-stats">
        <div><dt>Price</dt><dd>{price(coin.priceUsd)}</dd></div>
        <div><dt>1h</dt><dd className={coin.change1h > 0 ? 'up' : coin.change1h < 0 ? 'down' : ''}>{fmtPct(coin.change1h)}</dd></div>
        <div><dt>24h</dt><dd className={coin.change24h > 0 ? 'up' : coin.change24h < 0 ? 'down' : ''}>{fmtPct(coin.change24h)}</dd></div>
        <div><dt>Liquidity</dt><dd>{fmtUsd(coin.liquidityUsd)}</dd></div>
        <div><dt>Volume 24h</dt><dd>{fmtUsd(coin.volume24h)}</dd></div>
        <div><dt>Market cap</dt><dd>{fmtUsd(coin.marketCapUsd ?? coin.fdvUsd)}</dd></div>
      </dl>
      <Chart pool={coin.chartPool} />
      <section className="kv-panel kv-pools" aria-label="Pools">
        <h2>Pools</h2>
        {coin.pools?.length ? <table><thead><tr><th>Pair</th><th>Venue</th><th>Liquidity</th><th>Volume 24h</th><th>24h</th></tr></thead><tbody>
          {coin.pools.map((p) => <tr key={p.address}><td>{p.pair}</td><td>{p.venue}</td><td>{fmtUsd(p.liquidityUsd)}</td><td>{fmtUsd(p.volume24h)}</td><td className={p.change24h > 0 ? 'up' : p.change24h < 0 ? 'down' : ''}>{fmtPct(p.change24h)}</td></tr>)}
        </tbody></table> : <p className="kv-note">No pools on the feed yet.</p>}
      </section>
    </section>
    <aside className="kv-token-trade">
      <section className="kv-panel kv-bal">
        <span className="kv-label">Your wallet</span>
        {wallet.account ? <dl><div><dt>ETH</dt><dd>{bal?.eth != null ? amount(bal.eth, 18, 5) : '—'}</dd></div><div><dt>{coin.symbol}</dt><dd>{held != null ? amount(held, coin.decimals) : bal ? '0' : '—'}</dd></div></dl> : <p className="kv-note">Connect a wallet to see your ETH and {coin.symbol} on Robinhood Chain.</p>}
      </section>
      <Buy coin={coin} wallet={wallet} ethRaw={bal?.eth ?? null} onSent={() => setN((x) => x + 1)} prefill={prefill} />
    </aside>
  </main>;
}
