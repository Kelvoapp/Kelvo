import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, PenLine, RefreshCw, Rocket, Wallet } from 'lucide-react';
import { formatUnits, parseUnits } from 'viem';
import Bloom from '../bloom/Bloom';
import { EXPLORER, useTerminalWallet, walletError } from '../wallet';
import { bloomPick, fmtK, heat01, rampColor, short, useHeat } from '../heat-client';
import { LAUNCH_LIMITS, NATIVE_QUOTE, quoteInitialBuy, utf8Bytes, validateLaunchRequest } from './pons';
import { ApiError, checkLaunchReceipt, fetchLaunchPolicy, fetchLaunches, prepareCheckedLaunch, sendLaunch } from './launch-client';
import { clearPendingLaunch, pendingEvent, readPendingLaunch } from './pending-launch';
import './launch.css';

// Launch a token on the Pons V2 curve paired with ETH. The agent persona rides in the token's own description on chain.
// Kelvo prepares and dry-runs the call on the server, the browser checks it again, the wallet signs; nothing else moves funds.
const DRAFT = 'kelvo.launch-draft.v1';
const EMPTY = { name: '', symbol: '', logo: '', about: '', persona: '', website: '', twitter: '', telegram: '', taxPct: '0', recipient: '', buy: '0', slippageBps: 100 };
const PERSONA_HEAD = 'Agent persona';
/** The description written on chain: what the token is, then the persona under a plain heading. */
export const composeDescription = (about, persona) => [about.trim(), persona.trim() ? `${PERSONA_HEAD}\n${persona.trim()}` : ''].filter(Boolean).join('\n\n');
const eth = (wei, max = 6) => (wei == null ? '—' : Number(formatUnits(BigInt(wei), 18)).toLocaleString('en-US', { maximumFractionDigits: max }));
const tokens = (raw) => (raw == null ? '—' : Number(formatUnits(BigInt(raw), 18)).toLocaleString('en-US', { maximumFractionDigits: 0 }));
const pct = (bps) => (bps == null ? '—' : (bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%');

function useDraft() {
  const [draft, setDraft] = useState(() => { try { return { ...EMPTY, ...JSON.parse(localStorage.getItem(DRAFT) || '{}') }; } catch { return EMPTY; } });
  useEffect(() => { try { localStorage.setItem(DRAFT, JSON.stringify(draft)); } catch { /* private mode */ } }, [draft]);
  return [draft, (k, v) => setDraft((d) => ({ ...d, [k]: v }))];
}

/** Launches whose provenance salt verifies as Kelvo's, newest first, each with its temperature when it can be read. */
function Launches() {
  const [index, setIndex] = useState(null), [temps, setTemps] = useState({}), { data } = useHeat();
  useEffect(() => {
    const ac = new AbortController();
    fetchLaunches(null, ac.signal).then(setIndex).catch((e) => { if (!ac.signal.aborted) setIndex({ items: [], status: 'unavailable', error: e.message }); });
    return () => ac.abort();
  }, []);
  useEffect(() => {
    const board = new Map((data?.tokens || []).map((t) => [t.address, t.kelvin]));
    for (const l of (index?.items || []).slice(0, 8)) {
      const a = l.token.toLowerCase();
      if (board.has(a)) setTemps((t) => ({ ...t, [a]: board.get(a) }));
      else fetch('/api/terminal?action=coin&address=' + a).then((r) => (r.ok ? r.json() : null)).then((c) => setTemps((t) => ({ ...t, [a]: c?.kelvin ?? null }))).catch(() => {});
    }
  }, [index, data]);
  const items = index?.items || [];
  return <section className="kv-ln-list" aria-labelledby="kv-ln-list">
    <header><h2 id="kv-ln-list">Launched from <em>Kelvo</em></h2><p>Every launch here carries a provenance salt signed by Kelvo's server and checked on its receipt. Each reads by the same heat rule as every token.</p></header>
    {!index ? <p className="kv-ln-quiet">Reading the launch log</p>
      : index.status === 'unavailable' ? <p className="kv-ln-quiet">{index.error || 'The launch log could not be read right now.'}</p>
      : !items.length ? <p className="kv-ln-quiet">No Kelvo launch yet in the blocks read so far. The first one shows here with its reading.</p>
      : <ol>{items.map((l) => { const k = temps[l.token.toLowerCase()]; return <li key={l.token}><Link to={'/token/' + l.token}>
          {l.logo && /^https:\/\//.test(l.logo) ? <img src={l.logo} alt="" width="34" height="34" referrerPolicy="no-referrer" loading="lazy" /> : <span className="mono">{l.symbol.slice(0, 2)}</span>}
          <span><b>{l.symbol}</b><small>{l.name} · {short(l.token)}</small></span>
          <em style={{ color: k != null ? rampColor(k) : undefined }}>{fmtK(k)}</em>
          <time>{l.blockTime ? new Date(l.blockTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</time><ArrowUpRight size={14} />
        </Link></li>; })}</ol>}
  </section>;
}

export default function Launch() {
  const wallet = useTerminalWallet(), account = wallet.account;
  const [draft, set] = useDraft();
  const [policy, setPolicy] = useState(null), [policyError, setPolicyError] = useState(''), [rev, setRev] = useState(0);
  const [prepared, setPrepared] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState(() => readPendingLaunch()), [done, setDone] = useState(null), [clock, setClock] = useState(Date.now());
  const lock = useRef(false);
  const { data } = useHeat();

  useEffect(() => {
    const ac = new AbortController();
    setPolicyError('');
    fetchLaunchPolicy({ account }, ac.signal).then((p) => { if (p.pairToken.toLowerCase() !== NATIVE_QUOTE || (p.account || null)?.toLowerCase() !== (account || null)?.toLowerCase()) throw new Error('The terms do not match this wallet. Read them again.'); setPolicy(p); })
      .catch((e) => { if (!ac.signal.aborted) setPolicyError(e.message); });
    const t = setInterval(() => setRev((r) => r + 1), 60000);
    return () => { ac.abort(); clearInterval(t); };
  }, [account, rev]);
  useEffect(() => { const sync = () => setPending(readPendingLaunch()); addEventListener(pendingEvent, sync); return () => removeEventListener(pendingEvent, sync); }, []);
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(t); }, []);
  // any change to the ticket voids a preparation: the description, salt and fingerprint are bound to it
  useEffect(() => { setPrepared(null); setError(''); }, [draft, account]);

  const description = composeDescription(draft.about, draft.persona), bytes = utf8Bytes(description);
  const taxBps = Math.round(Number(draft.taxPct || 0) * 100);
  const input = useCallback(() => {
    if (!account) throw new Error('Connect your wallet first.');
    if (!wallet.onChain) throw new Error('Switch your wallet to Robinhood Chain.');
    if (bytes > LAUNCH_LIMITS.descriptionBytes) throw new Error(`The description and persona come to ${bytes} bytes; the limit is ${LAUNCH_LIMITS.descriptionBytes}.`);
    return validateLaunchRequest({ account, launch: { name: draft.name.trim(), symbol: draft.symbol.trim(), logo: draft.logo.trim(), description, socials: { website: draft.website.trim(), twitter: draft.twitter.trim(), telegram: draft.telegram.trim(), discord: '', farcaster: '' }, creatorFeeRecipient: (draft.recipient.trim() || account), creatorTaxBps: taxBps, buybackEnabled: false, pairToken: NATIVE_QUOTE, initialBuy: draft.buy.trim() || '0', slippageBps: draft.slippageBps, configId: policy?.configId ?? 0 } });
  }, [account, wallet.onChain, bytes, draft, description, taxBps, policy]);

  // the opening buy on the curve, quoted in the browser from the live terms (the server quotes it again before signing)
  const quote = useMemo(() => {
    if (!policy) return null;
    try {
      const wei = parseUnits(draft.buy.trim() || '0', 18);
      if (wei <= 0n) return null;
      return quoteInitialBuy(wei, BigInt(policy.supply), BigInt(policy.phantomQuote), BigInt(policy.graduationThreshold), BigInt(policy.curveFeeBps), BigInt(taxBps), draft.slippageBps, policy.decimals);
    } catch { return null; }
  }, [policy, draft.buy, draft.slippageBps, taxBps]);
  let total = null;
  try { total = policy ? BigInt(policy.launchFee) + parseUnits(draft.buy.trim() || '0', 18) : null; } catch { total = null; }

  async function review() {
    if (lock.current) return;
    lock.current = true; setBusy('review'); setError(''); setNotice('');
    try { const p = await prepareCheckedLaunch(input()); setPrepared(p); setPolicy(p.policy); }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : 'The launch could not be prepared.'); }
    finally { lock.current = false; setBusy(''); }
  }
  async function sign() {
    if (lock.current || !prepared) return;
    lock.current = true; setBusy('wallet'); setError('');
    try {
      if (prepared.simulation !== 'passed') throw new Error('Review the launch again.');
      const hash = await sendLaunch(prepared, input());
      setPending(hash); setPrepared(null); setNotice('Sent. Waiting for the receipt and its provenance check.');
    } catch (e) { setError(walletError(e, e instanceof Error ? e.message : 'The wallet did not send the launch.')); }
    finally { lock.current = false; setBusy(''); }
  }
  // poll the pending launch while the tab is visible, 12 checks at most per visit
  useEffect(() => {
    if (!pending) return;
    let n = 0, stop = false;
    const tick = async () => {
      if (stop || document.hidden || n++ >= 12) return;
      const r = await checkLaunchReceipt(pending).catch(() => null);
      if (!r || stop) return;
      if (r.state === 'confirmed') { setDone(r.launch); setPending(null); setNotice(''); }
      else if (r.state !== 'waiting') { setPending(null); setError(r.message); }
      else setNotice(r.message);
    };
    tick(); const t = setInterval(tick, 7000);
    return () => { stop = true; clearInterval(t); };
  }, [pending]);

  // the bloom: the market's petals, and the new token joining as the coldest one, lifted
  const market = useMemo(() => bloomPick(data?.tokens).slice(0, 8), [data]);
  const heats = useMemo(() => (market.length >= 3 ? [...market.map((t) => heat01(t.kelvin)), 0] : null), [market]);
  const stage = useRef(null), drive = useRef({});
  useEffect(() => {
    const el = stage.current; if (!el) return;
    const place = () => { const w = el.clientWidth, h = el.clientHeight; drive.current = { ...drive.current, cx: w * 0.5, cy: h * 0.5, size: Math.min(w * 0.32, h * 0.36), cool: 0.25, open: 0.25 }; };
    place(); const ro = new ResizeObserver(place); ro.observe(el); return () => ro.disconnect();
  }, []);
  useEffect(() => { drive.current = { ...drive.current, focus: heats ? heats.length - 1 : -1, open: busy ? 0.6 : 0.25 }; }, [heats, busy]);

  const left = prepared ? Math.max(0, Math.round((Date.parse(prepared.expiresAt) - clock) / 1000)) : 0;
  const symbol = draft.symbol.trim().toUpperCase() || 'TOKEN';
  const field = (k, label, hint, props = {}) => <label className="kv-ln-field"><span>{label}{hint && <small>{hint}</small>}</span><input value={draft[k]} onChange={(e) => set(k, e.target.value)} autoComplete="off" spellCheck={false} {...props} /></label>;

  let key;
  if (!account) key = <button type="button" className="kv-key kv-ln-go" onClick={() => wallet.connect()} disabled={wallet.busy}><span>{wallet.busy ? 'Waiting for wallet' : 'Connect wallet'}</span><Wallet /></button>;
  else if (!wallet.onChain) key = <button type="button" className="kv-key kv-ln-go" onClick={() => wallet.switchChain()} disabled={wallet.busy}><span>Switch to Robinhood Chain</span><RefreshCw /></button>;
  else if (pending) key = <button type="button" className="kv-key ink kv-ln-go" disabled><span>Waiting for the receipt</span><RefreshCw className="kv-spin" /></button>;
  else if (prepared && left > 0) key = <button type="button" className="kv-key kv-ln-go" onClick={sign} disabled={Boolean(busy)}><span>{busy === 'wallet' ? 'Confirm in your wallet' : `Sign the launch · ${left}s`}</span><PenLine /></button>;
  else key = <button type="button" className="kv-key kv-ln-go" onClick={review} disabled={Boolean(busy) || !policy}><span>{busy === 'review' ? 'Checking and dry-running' : prepared ? 'Review again' : 'Review the launch'}</span><Rocket /></button>;

  return <main className="kv-page kv-launch">
    <header className="kv-ln-head">
      <span className="kv-label">Launch · Pons V2 curve · paired with ETH</span>
      <h1>Every launch starts <em className="cold">cold</em></h1>
      <p>Write the token and the agent that speaks for it. The persona goes into the token's own description on chain, so it travels with the token. It starts at 0 K with no trades, and only trading warms it.</p>
    </header>

    <div className="kv-ln-grid">
      <form className="kv-ln-ticket" onSubmit={(e) => { e.preventDefault(); void review(); }}>
        <fieldset><legend><i>01</i>The token</legend>
          <div className="kv-ln-row">{field('name', 'Name', `${utf8Bytes(draft.name)} / ${LAUNCH_LIMITS.nameBytes}`, { placeholder: 'Kelvin Coin', maxLength: 64 })}{field('symbol', 'Symbol', `${utf8Bytes(draft.symbol)} / ${LAUNCH_LIMITS.symbolBytes}`, { placeholder: 'KELV', maxLength: 16 })}</div>
          <div className="kv-ln-logo">{draft.logo && /^https:\/\//.test(draft.logo) ? <img src={draft.logo} alt="" width="52" height="52" referrerPolicy="no-referrer" /> : <span className="mono">{symbol.slice(0, 2)}</span>}{field('logo', 'Logo URL', 'https or ipfs, square image', { placeholder: 'https://…/logo.png', inputMode: 'url' })}</div>
        </fieldset>

        <fieldset><legend><i>02</i>What it is and who speaks for it</legend>
          <label className="kv-ln-field"><span>About</span><textarea rows={3} value={draft.about} onChange={(e) => set('about', e.target.value)} placeholder="One or two plain sentences about the token." /></label>
          <label className="kv-ln-field"><span>Agent persona<small>optional</small></span><textarea rows={4} value={draft.persona} onChange={(e) => set('persona', e.target.value)} placeholder="How its agent talks, what it cares about, what it never says." /></label>
          <div className={'kv-ln-bytes' + (bytes > LAUNCH_LIMITS.descriptionBytes ? ' over' : '')}><i style={{ width: Math.min(100, (bytes / LAUNCH_LIMITS.descriptionBytes) * 100) + '%' }} /><span>{bytes.toLocaleString('en-US')} / {LAUNCH_LIMITS.descriptionBytes.toLocaleString('en-US')} bytes on chain</span></div>
          {description && <pre className="kv-ln-desc" aria-label="The description written on chain">{description}</pre>}
        </fieldset>

        <fieldset><legend><i>03</i>Links</legend>
          <div className="kv-ln-row three">{field('website', 'Website', 'https', { placeholder: 'https://', inputMode: 'url' })}{field('twitter', 'X', 'https', { placeholder: 'https://x.com/…', inputMode: 'url' })}{field('telegram', 'Telegram', 'https', { placeholder: 'https://t.me/…', inputMode: 'url' })}</div>
        </fieldset>

        <fieldset><legend><i>04</i>Terms</legend>
          <div className="kv-ln-row">
            {field('taxPct', 'Creator tax %', policy ? `up to ${pct(policy.maxCreatorTaxBps)}` : '', { inputMode: 'decimal', placeholder: '0' })}
            {field('recipient', 'Creator fees go to', 'empty means your wallet', { placeholder: account ? short(account) : '0x…' })}
          </div>
          <label className="kv-ln-field"><span>Opening buy<small>ETH, optional, bought in the same transaction</small></span>
            <div className="kv-ln-amount"><input value={draft.buy} onChange={(e) => set('buy', e.target.value)} inputMode="decimal" placeholder="0" /><b>ETH</b></div></label>
          <div className="kv-ln-chips" role="group" aria-label="Opening buy">{['0', '0.001', '0.01', '0.05'].map((v) => <button type="button" key={v} aria-pressed={draft.buy === v} onClick={() => set('buy', v)}>{v === '0' ? 'None' : v + ' ETH'}</button>)}</div>
          <div className="kv-ln-chips" role="group" aria-label="Slippage">{[50, 100, 200, 500].map((v) => <button type="button" key={v} aria-pressed={draft.slippageBps === v} onClick={() => set('slippageBps', v)}>{pct(v)} slippage</button>)}</div>
        </fieldset>
      </form>

      <aside className="kv-ln-side">
        <div ref={stage} className="kv-ln-stage">
          <Bloom drive={drive} heats={heats} className="kv-ln-bloom" fallback={<img className="kv-ln-fallback" src="/brand/kelvo-512.png" alt="" />} />
          <div className="kv-ln-read"><span className="kv-label">Starts at</span><b>{symbol} <em>0 K</em></b></div>
        </div>

        <section className="kv-ln-terms" aria-label="Live terms">
          <header><b>Terms read from the factory</b><span>{policy ? `block ${Number(policy.blockNumber).toLocaleString('en-US')}` : policyError ? 'unavailable' : 'reading'}</span></header>
          <dl>
            <div><dt>Launch fee</dt><dd>{policy ? eth(policy.launchFee) + ' ETH' : '—'}</dd></div>
            <div><dt>Curve fee</dt><dd>{pct(policy?.curveFeeBps)}</dd></div>
            <div><dt>Fee after the curve</dt><dd>{pct(policy?.hookFeeBps)}</dd></div>
            <div><dt>Creator tax</dt><dd>{pct(taxBps)}<small> of {pct(policy?.maxCreatorTaxBps)} allowed</small></dd></div>
            {quote && <><div><dt>Opening buy gets</dt><dd>{tokens(quote.tokensOut)} {symbol}</dd></div><div><dt>At least</dt><dd>{tokens(quote.minTokensOut)} {symbol}</dd></div></>}
            <div className="total"><dt>Your wallet pays</dt><dd>{total != null ? eth(total.toString()) + ' ETH' : '—'}<small> plus gas</small></dd></div>
          </dl>
          {policyError && <p className="kv-ln-note warn" role="alert">{policyError} <button type="button" onClick={() => setRev((r) => r + 1)}>Read again</button></p>}
          {policy && account && policy.canLaunch === false && <p className="kv-ln-note warn">The factory does not allow this wallet to launch right now.</p>}
        </section>

        {prepared && left > 0 && <section className="kv-ln-checked" aria-live="polite"><Check size={16} /><p>Prepared and dry-run on chain for {short(account)}: {prepared.transaction ? `${eth(prepared.transaction.value)} ETH to the ${prepared.quote && BigInt(prepared.quote.quoteIn) > 0n ? 'launch router' : 'factory'}, gas ${Number(prepared.transaction.gas).toLocaleString('en-US')}` : 'needs an approval first'}. Your browser rebuilt the call and it matched. It expires in {left}s.</p></section>}
        {key}
        {error && <p className="kv-ln-note warn" role="alert">{error}</p>}
        {notice && <p className="kv-ln-note">{notice}</p>}
        {pending && <p className="kv-ln-note">Launch <a href={EXPLORER + '/tx/' + pending} target="_blank" rel="noreferrer">{short(pending)}</a> is waiting for its receipt. <button type="button" onClick={() => { clearPendingLaunch(); setPending(null); }}>Forget it</button> only if it was dropped from your wallet.</p>}
        {done && <section className="kv-ln-done"><span className="kv-label">Launched and verified</span><b>{done.symbol}</b><Link className="kv-key cold" to={'/token/' + done.token}><span>Open its token page</span><ArrowUpRight /></Link></section>}
        <p className="kv-ln-fine">Kelvo prepares the call, dry-runs it from your account and your browser compares it byte for byte before the wallet opens. Kelvo adds no fee and keeps no keys. <Link to="/docs#launch">How launches are checked</Link></p>
      </aside>
    </div>

    <Launches />
  </main>;
}
