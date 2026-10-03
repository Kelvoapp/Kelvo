import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Snowflake } from 'lucide-react';
import ContractTag from '../chrome/ContractTag.jsx';
import Bloom from '../bloom/Bloom';
import { IDENTITY } from '../identity';
import { bloomPick, fmtK, fmtPct, fmtUsd, heat01, rampColor, useHeat } from '../heat-client';
import AgentBench from './finale/AgentBench';
import ColdBench from './finale/ColdBench';
import KelvoBoard from './finale/KelvoBoard';
import { EndSplit, Footer } from './finale/EndSplit';
import './home.css';
import './finale/finale.css';

const FORMULA = 'K = 30 × √(trades in 24h)\n  + 260 × ln(1 + trades in 1h)\n        × (0.75 + 0.5 × buy share)\n        × (1 + turnover ÷ 2)';

const Logo = ({ t, size = 18 }) => t.image
  ? <img className="kv-coin" src={t.image} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" />
  : <span className="kv-coin mono" style={{ width: size, height: size }}>{t.symbol.slice(0, 2)}</span>;

/** The running tape: every token with its temperature. Two copies loop seamlessly; hover pauses it. */
function Tape({ tokens }) {
  if (!tokens?.length) return null;
  const row = tokens.filter((t) => t.kelvin != null).slice(0, 28);
  const cells = (dup) => row.map((t) => <Link key={t.address + dup} to={'/token/' + t.address} className="kv-tape-cell" tabIndex={dup ? -1 : 0}>
    <Logo t={t} /><b>{t.symbol}</b><i style={{ color: rampColor(t.kelvin) }}>{fmtK(t.kelvin)}</i><em className={t.change24h > 0 ? 'up' : t.change24h < 0 ? 'down' : ''}>{fmtPct(t.change24h)}</em>
  </Link>);
  return <div className="kv-tape" aria-label="Temperatures on Robinhood Chain"><div className="kv-tape-run">{cells('')}<span aria-hidden="true" className="kv-tape-dup">{cells('-b')}</span></div></div>;
}

/** The thermometer on the stage's edge: the ramp from 0 K to 10,000 K with the bloom's tokens where they read.
 * Marks that would collide are pushed apart; a thin leader keeps each tied to its true reading on the bar. */
function Thermo({ tokens, hover, onHover }) {
  const box = useRef(null), [h, setH] = useState(0);
  useLayoutEffect(() => { const m = () => setH(box.current?.clientHeight || 0); m(); addEventListener('resize', m); return () => removeEventListener('resize', m); }, []);
  const placed = useMemo(() => {
    const rows = tokens.map((t, i) => ({ t, i, y: (1 - heat01(t.kelvin)) * h })).sort((a, b) => a.y - b.y);
    for (let j = 1; j < rows.length; j++) rows[j].y = Math.max(rows[j].y, rows[j - 1].y + 19);
    const over = rows.length ? rows[rows.length - 1].y - h : 0;
    if (over > 0) for (const r of rows) r.y -= over;
    return rows;
  }, [tokens, h]);
  return <div ref={box} className="kv-thermo" aria-label="The bloom's tokens on the kelvin scale">
    <div className="kv-thermo-bar" />
    {[0, 2000, 4000, 6000, 8000, 10000].map((k) => <span key={k} className="kv-thermo-tick" style={{ bottom: `${(k / 10000) * 100}%` }}>{k.toLocaleString('en-US')}</span>)}
    {placed.map(({ t, i, y }) => <Link key={t.address} to={'/token/' + t.address} className={'kv-thermo-mark' + (hover === i ? ' on' : '')} style={{ top: y, '--c': rampColor(t.kelvin), '--lead': `${Math.abs((1 - heat01(t.kelvin)) * h - y)}px`, '--dir': (1 - heat01(t.kelvin)) * h - y < 0 ? -1 : 1 }}
      onMouseEnter={() => onHover(i)} onMouseLeave={() => onHover(-1)}>
      <i /><b>{t.symbol}</b><span className="kv-num">{fmtK(t.kelvin)}</span>
    </Link>)}
  </div>;
}

// The last four chapters each hold an instrument; the bloom stands in a slot inside it. While the instrument is pinned
// (desktop) the bloom lands where the slot sits on screen; where it scrolls (phones, short screens) the pose is exact
// when the slot reaches the middle of the screen.
const FINALE = { agent: { open: 1, cool: 0, frost: 0, split: 0 }, cold: { open: 0.15, cool: 1, frost: 1, split: 0 }, token: { open: 0.4, cool: 0.3, frost: 0.3, split: 0 }, end: { open: 0, cool: 0, frost: 0, split: 1 } };

export default function Home() {
  const heat = useHeat(), { data, error } = heat;
  const navigate = useNavigate();
  // the bloom is the market from hot to cold: the four hottest, then readings down the list to the coldest that still moves
  const top = useMemo(() => bloomPick(data?.tokens), [data]);
  const heats = useMemo(() => (top.length === 9 ? top.map((t) => heat01(t.kelvin)) : null), [top]);
  const drive = useRef({}), spot = useRef(null), [hover, setHover] = useState(-1), hoverRef = useRef(-1), forced = useRef(-1);

  // the agent chapter reads one token at a time; its petal lifts while the agent chapter holds
  const [picked, setPicked] = useState(null);
  const selected = picked || data?.tokens?.find((t) => t.kelvin != null)?.address || null;
  const agentFocus = useRef(-1), trailK = useRef(null), kick = useRef(() => {});
  agentFocus.current = top.findIndex((t) => t.address === selected);
  const onTrail = useCallback((k) => { trailK.current = k; kick.current(); }, []);

  // where the bloom stands in each chapter, from the viewport; scroll blends between them with a hold around each pose
  const ladderEl = useRef(null), frost = useRef(null), split = useRef(null);
  useLayoutEffect(() => {
    let raf = 0, anchors = [];
    const pose = (a, W, H) => {
      const name = a?.name, phone = W < 760, s = (dw, dh) => Math.min(W * dw, H * dh);
      const box = phone ? { x: W * 0.07, y: H * 0.1, w: W * 0.52, h: H * 0.32 } : { x: W * 0.54, y: H * 0.17, w: W * 0.26, h: H * 0.68 };
      const base = { ladder: 0, open: 0, cool: 0, frost: 0, split: 0, ladderBox: box };
      if (a?.slot) {
        const f = FINALE[name], cool = name === 'cold' ? (trailK.current == null ? 1 : Math.max(0.08, 1 - trailK.current / 140)) : f.cool;
        return { ...base, ...f, cool, cx: a.slot.cx, cy: a.slot.cy, size: a.slot.size };
      }
      if (name === 'motion') return { ...base, cx: W * 0.5, cy: H * 0.5, size: s(0.2, 0.3), ladder: 1 };
      if (name === 'launch') return { ...base, cx: phone ? W * 0.5 : W * 0.72, cy: phone ? H * 0.27 : H * 0.5, size: phone ? s(0.3, 0.15) : s(0.15, 0.26), open: 0.25, cool: 0.62, frost: 0.62 };
      return { ...base, cx: phone ? W * 0.5 : W * 0.53, cy: phone ? H * 0.29 : H * 0.44, size: phone ? s(0.4, 0.19) : s(0.2, 0.34) };
    };
    const measure = () => {
      const H = innerHeight, Y = scrollY;
      anchors = [...document.querySelectorAll('section[data-pose]')].map((el) => {
        const r = el.getBoundingClientRect(), top = r.top + Y, name = el.dataset.pose;
        const slotEl = FINALE[name] && el.querySelector('[data-slot]'), hold = el.querySelector('.kf-hold');
        if (!slotEl) return { name, y: top + el.offsetHeight / 2 };
        const sr = slotEl.getBoundingClientRect(), half = Math.min(sr.width, sr.height) / 2, size = half / (0.84 + 0.12 * FINALE[name].open);
        if (hold && getComputedStyle(hold).position === 'sticky') {
          // pinned: the instrument holds at its sticky top while the section's middle passes the screen's middle
          const y = top + el.offsetHeight / 2, at = y - H / 2, hr = hold.getBoundingClientRect(), stick = parseFloat(getComputedStyle(hold).top) || 0;
          const holdTop = Math.min(Math.max(top - at, stick), top + el.offsetHeight - at - hr.height);
          return { name, y, slot: { cx: sr.left + sr.width / 2, cy: holdTop + (sr.top - hr.top) + sr.height / 2, size } };
        }
        return { name, y: sr.top + Y + sr.height / 2, slot: { cx: sr.left + sr.width / 2, cy: H / 2, size }, slotEl };
      });
    };
    const mix = (A, B, k) => {
      const o = {};
      for (const key of ['cx', 'cy', 'size', 'cool', 'ladder', 'open', 'frost', 'split']) o[key] = A[key] + (B[key] - A[key]) * k;
      o.ladderBox = A.ladder > B.ladder ? A.ladderBox : B.ladderBox;
      return o;
    };
    const update = () => {
      raf = 0;
      const W = innerWidth, H = innerHeight, c = scrollY + H / 2;
      if (!anchors.length) measure();
      let i = 0;
      while (i < anchors.length - 1 && anchors[i + 1].y <= c) i++;
      const A = anchors[i], B = anchors[Math.min(i + 1, anchors.length - 1)];
      const raw = B === A ? 0 : Math.max(0, Math.min(1, (c - A.y) / (B.y - A.y)));
      const k = Math.max(0, Math.min(1, (raw - 0.22) / 0.56)), e = k * k * (3 - 2 * k);
      const now = mix(pose(A, W, H), pose(B, W, H), e);
      const here = e < 0.5 ? A : B;
      // where the instrument scrolls (phones, short screens) the bloom rides its slot instead of waiting mid-screen
      if (here?.slotEl) { const r = here.slotEl.getBoundingClientRect(); now.cx = r.left + r.width / 2; now.cy = r.top + r.height / 2; }
      drive.current = { ...drive.current, ...now, focus: here?.name === 'agent' ? agentFocus.current : forced.current };
      if (frost.current) frost.current.style.opacity = String(now.frost * 0.95);
      if (split.current) split.current.style.opacity = String(now.split);
      const L = ladderEl.current;
      if (L) {
        L.style.opacity = String(Math.max(0, now.ladder * 1.6 - 0.6));
        L.style.setProperty('--x', now.ladderBox.x + 'px'); L.style.setProperty('--y', now.ladderBox.y + 'px');
        L.style.setProperty('--w', now.ladderBox.w + 'px'); L.style.setProperty('--h', now.ladderBox.h + 'px');
      }
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    const onResize = () => { measure(); onScroll(); };
    kick.current = onScroll;
    measure(); update();
    addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onResize);
    const ro = new ResizeObserver(onResize); ro.observe(document.body);
    return () => { removeEventListener('scroll', onScroll); removeEventListener('resize', onResize); ro.disconnect(); cancelAnimationFrame(raf); kick.current = () => {}; };
  }, []);
  // a new pick re-poses the bloom at once (its petal lifts)
  useLayoutEffect(() => { kick.current(); }, [selected, top]);

  const onFrame = useCallback(({ hover: h, pointer }) => {
    const shown = h >= 0 ? h : forced.current;
    if (shown !== hoverRef.current) { hoverRef.current = shown; setHover(shown); }
    const el = spot.current;
    if (!el) return;
    if (h >= 0 && pointer) { el.style.transform = `translate(${pointer[0]}px, ${pointer[1]}px)`; el.dataset.on = '1'; }
    else el.dataset.on = '';
  }, []);
  const pick = useCallback((i) => { const t = top[i]; if (t) navigate('/token/' + t.address); }, [top, navigate]);
  const hot = hover >= 0 ? top[hover] : null;

  return <main className="kv-home">
    <Bloom drive={drive} heats={heats} onFrame={onFrame} onPick={pick} className="kv-stage" fallback={<img className="kv-stage-fallback" src="/brand/kelvo-512.png" alt="" />} />

    <section className="kv-first" data-pose="hero" aria-labelledby="kv-hero-title">
      <div className="kv-word" aria-hidden="true">Kelvo</div>
      <div className="kv-hero-copy">
        <h1 id="kv-hero-title">Every token has <em>a temperature</em></h1>
        <p className="kv-lede">Kelvo reads how much each Robinhood Chain token moves and prints it in kelvin. Hot ones glow. Cold ones fade into the background, and so can you.</p>
        <div className="kv-keys">
          <Link className="kv-key" to="/heat"><span>Read the heat</span><ArrowUpRight /></Link>
          <Link className="kv-key ink" to="/cold"><span>Go cold</span><Snowflake /></Link>
        </div>
        <div className="kv-id">{IDENTITY.ticker} <span>·</span> {IDENTITY.contract ? <ContractTag address={IDENTITY.contract} /> : 'contract TBA'}</div>
      </div>
      {top.length > 0 && <Thermo tokens={top} hover={hover} onHover={(i) => { forced.current = i; drive.current = { ...drive.current, focus: i }; }} />}
      <div ref={spot} className="kv-spot" aria-hidden="true">
        <i className="kv-spot-x" /><i className="kv-spot-y" />
        {hot && <div className="kv-spot-read">
          <span className="kv-label">Spot</span>
          <b>{hot.symbol} <em style={{ color: rampColor(hot.kelvin) }}>{fmtK(hot.kelvin)}</em></b>
          <small>{hot.trades1h?.toLocaleString('en-US') ?? '—'} trades in the last hour · {hot.buyShare1h ?? '—'}% buys · {fmtUsd(hot.priceUsd)}</small>
        </div>}
      </div>
      <Tape tokens={data?.tokens} />
      {error && !data && <p className="kv-feed-note">{error}</p>}
    </section>

    <div ref={frost} className="kv-frost" aria-hidden="true" />
    <div ref={split} className="kf-split" aria-hidden="true" />
    <div ref={ladderEl} className="kv-ladder" aria-hidden="true">
      {top.map((t, k) => <span key={t.address} style={{ '--k': k, '--len': heat01(t.kelvin), '--c': rampColor(t.kelvin) }}><b>{t.symbol}</b><em>{fmtK(t.kelvin)}</em><small>{t.trades1h?.toLocaleString('en-US') ?? '—'} trades / 1h</small></span>)}
    </div>

    <section className="kv-ch kv-ch-motion" data-pose="motion" aria-labelledby="kv-motion">
      <div className="kv-ch-copy">
        <span className="kv-label">How heat is read</span>
        <h2 id="kv-motion">Temperature is <em>motion</em></h2>
        <p>A token reads hotter the more it trades. Kelvo counts the trades of the last hour, the share of them that were buys and how much changed hands against the depth of the pool, then adds the day's trades. A token nobody touched for a day reads 0 K.</p>
        <pre className="kv-formula" aria-label="The rule">{FORMULA}</pre>
        <p className="kv-small">Turnover is the hour's volume over the pool's liquidity, capped at 3. Every reading comes from the token's busiest pool and refreshes every 30 seconds.</p>
        <Link className="kv-key" to="/heat"><span>Read the heat</span><ArrowUpRight /></Link>
      </div>
    </section>

    <section className="kv-ch kv-ch-launch" data-pose="launch" aria-labelledby="kv-launch">
      <div className="kv-ch-copy">
        <span className="kv-label">Launch</span>
        <h2 id="kv-launch">Every launch starts <em>cold</em></h2>
        <p>Launch a token on the Pons curve from Kelvo, paired with ETH. It starts at 0 K with no trades, and only trading warms it. Give it an agent at launch: the persona goes into the token's own description on chain, so it travels with the token and needs no database.</p>
        <ul className="kv-facts">
          <li><b>Launch fee</b><span>read live from the factory before you sign</span></li>
          <li><b>The curve</b><span>graduates into a Uniswap V4 pool</span></li>
          <li><b>Your wallet</b><span>signs every step, Kelvo holds nothing</span></li>
        </ul>
        <Link className="kv-key" to="/launch"><span>Launch a token</span><ArrowUpRight /></Link>
      </div>
    </section>

    <section className="kf-ch kf-ch-agent" data-pose="agent" aria-labelledby="kv-agent">
      <div className="kf-hold"><AgentBench heat={heat} selected={selected} onSelect={setPicked} /></div>
    </section>

    <section className="kf-ch kf-ch-cold" data-pose="cold" aria-labelledby="kv-cold">
      <div className="kf-hold"><ColdBench onTrail={onTrail} /></div>
    </section>

    <section className="kf-ch kf-ch-token" data-pose="token" aria-labelledby="kv-token">
      <div className="kf-hold"><KelvoBoard /></div>
    </section>

    <section className="kf-ch kf-ch-end" data-pose="end" aria-labelledby="kv-end">
      <div className="kf-hold"><EndSplit heat={heat} /></div>
    </section>
    <Footer heat={heat} />
  </main>;
}
