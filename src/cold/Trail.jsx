import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Check, CircleHelp, TriangleAlert, X } from 'lucide-react';
import Bloom from '../bloom/Bloom';
import { bloomPick, heat01, useHeat } from '../heat-client';
import { TRAIL_K, withdrawCheck } from '../trail';

/** Notes added to each pool in the last 24 hours; the server reads the pools' own counters now and a day of blocks back. */
function useActivity() {
  const [activity, setActivity] = useState(null);
  useEffect(() => {
    let alive = true;
    const read = () => fetch('/api/privacy?action=activity', { signal: AbortSignal.timeout(20000) }).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive && d?.eth) setActivity(d); }).catch(() => {});
    read();
    const t = setInterval(() => { if (!document.hidden) read(); }, 5 * 60e3);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return activity;
}

/** The trail of a planned withdrawal, from what the form knows plus what the visitor adds. Unknown stays unknown. */
export function useTrail({ mode, token, amount, recipient, account, config }) {
  const activity = useActivity();
  const [deposit, setDeposit] = useState(''), [hours, setHours] = useState(''), [fresh, setFresh] = useState(false);
  const linked = Boolean(account) && recipient.trim().toLowerCase() === account.toLowerCase();
  const check = useMemo(() => {
    if (mode !== 'withdraw' || !config || !amount) return null;
    try {
      return withdrawCheck({ token, amount, deposit_amount: deposit.trim() || undefined, hours_since_deposit: hours.trim() === '' ? undefined : Number(hours), to_new_address: linked ? false : fresh ? true : undefined }, config, activity);
    } catch { return null; }
  }, [mode, token, amount, deposit, hours, fresh, linked, config, activity]);
  return { check, deposit, setDeposit, hours, setHours, fresh, setFresh, linked };
}

const deltaText = (check) => (!check ? '—' : check.deltaK == null ? 'blocked' : `+${check.deltaK} K`);

/** The page head: the bloom sits frozen on the cold side, and a withdrawal that stands out warms it by its trail. */
export function ColdHead({ trail }) {
  const { data } = useHeat();
  const market = useMemo(() => bloomPick(data?.tokens), [data]);
  const heats = useMemo(() => (market.length >= 3 ? market.map((t) => heat01(t.kelvin)) : null), [market]);
  const stage = useRef(null), drive = useRef({});
  const check = trail.check, cool = !check ? 1 : check.deltaK == null ? 0.05 : Math.max(0.1, 1 - check.deltaK / 140);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const place = () => { const w = el.clientWidth, h = el.clientHeight; drive.current = { ...drive.current, cx: w * (w < 520 ? 0.62 : 0.56), cy: h * 0.5, size: Math.min(w * 0.3, h * 0.34) }; };
    place();
    const ro = new ResizeObserver(place); ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { drive.current = { ...drive.current, cool, open: 0.15 }; }, [cool]);
  return <header className="kv-cold-head">
    <div className="kv-cold-copy">
      <span className="kv-label">Robinhood Chain · private pools</span>
      <h1>The <em>cold side</em></h1>
      <p>Deposit ETH or USDG into the Privacy Cash pools and withdraw to a fresh address through the relay. Proofs are built in this browser. Before a withdrawal, the trail ΔT reads how far it would stand out from the pool: 0 K blends in.</p>
      <div className="kv-keys"><Link className="kv-key ink" to="/docs#cold"><span>Keys and recovery</span><ArrowUpRight /></Link></div>
    </div>
    <div ref={stage} className="kv-cold-stage">
      <Bloom drive={drive} heats={heats} className="kv-cold-bloom" fallback={<img className="kv-cold-fallback" src="/brand/kelvo-512.png" alt="" />} />
      <div className="kv-cold-read" aria-live="polite"><span className="kv-label">Trail ΔT</span><b>{deltaText(check)}</b><small>{check ? `${check.passed} of ${check.of} checks pass` : 'Plan a withdrawal to read it'}</small></div>
    </div>
  </header>;
}

const LEVEL = { pass: [Check, 'Pass'], warn: [TriangleAlert, 'Watch'], risk: [X, 'Risk'], block: [X, 'Blocked'], unknown: [CircleHelp, 'Not given'] };

/** Beside the withdrawal form: the trail ΔT, what it is made of, and the three things only the visitor knows. */
export function TrailPanel({ trail }) {
  const c = trail.check;
  return <section className="kv-trail" aria-label="Trail ΔT">
    <div className="kv-trail-head"><span className="kv-label">Trail ΔT</span><b>{deltaText(c)}</b></div>
    <div className="kv-trail-bar"><i style={{ width: !c ? '0%' : c.deltaK == null ? '100%' : Math.min(100, (c.deltaK / 160) * 100) + '%' }} /></div>
    <div className="kv-trail-inputs">
      <label>Deposited<input inputMode="decimal" placeholder="optional" value={trail.deposit} onChange={(e) => trail.setDeposit(e.target.value)} autoComplete="off" /></label>
      <label>Hours since deposit<input inputMode="decimal" placeholder="optional" value={trail.hours} onChange={(e) => trail.setHours(e.target.value)} autoComplete="off" /></label>
      <label className="kv-trail-fresh"><input type="checkbox" checked={trail.linked ? false : trail.fresh} disabled={trail.linked} onChange={(e) => trail.setFresh(e.target.checked)} />{trail.linked ? 'The recipient is the connected wallet' : 'The recipient has never received funds from the depositing wallet'}</label>
    </div>
    {c ? <ul className="kv-trail-checks">{c.checks.map((x) => { const [Icon, word] = LEVEL[x.level] || LEVEL.unknown; return <li key={x.id} data-level={x.level}><Icon size={15} aria-label={word} /><span><b>{x.title}</b>{x.detail}</span><em>{x.level === 'block' ? '' : `+${TRAIL_K[x.level] ?? 0} K`}</em></li>; })}</ul>
      : <p className="kv-trail-note">Enter an amount to read the trail.</p>}
    <p className="kv-trail-note">40 K for each risk, 15 K for each warning, 5 K for each point not given. Rules of thumb from public patterns, not a guarantee. Privacy is not anonymity.</p>
  </section>;
}
