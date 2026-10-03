import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, CircleHelp, Snowflake, TriangleAlert, X } from 'lucide-react';
import { TRAIL_K, withdrawCheck } from '../../trail.js';
import { clock, useReading } from './data.js';
import { Seg } from './ui.jsx';

// The thermal palette of the camera view: the Kelvo ramp with a darker floor, so the pool reads as a cold scene.
const STOPS = [[0, [5, 7, 20]], [0.16, [15, 31, 99]], [0.36, [46, 143, 255]], [0.52, [169, 155, 216]], [0.7, [232, 55, 31]], [0.86, [255, 90, 31]], [1, [255, 210, 122]]];
function pal(v) {
  const t = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) if (t <= STOPS[i][0]) {
    const [t0, a] = STOPS[i - 1], [t1, b] = STOPS[i], u = (t - t0) / (t1 - t0);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }
  return STOPS[STOPS.length - 1][1];
}
const css = (v, a = 1) => { const [r, g, b] = pal(v); return `rgba(${r | 0},${g | 0},${b | 0},${a})`; };
const CROWD = 0.4, SPAN = 0.58, FULL = 120;
/** Where on the palette a withdrawal sits: the crowd's own value at 0 K, hotter as the trail rises. */
const warmth = (dK) => (dK == null ? 0 : Math.min(1, dK / FULL));
export const trailColor = (dK) => css(CROWD + SPAN * warmth(dK));

// value noise for the thermal ground
const h2 = (x, y) => { let n = (x * 374761393 + y * 668265263) | 0; n = (n ^ (n >>> 13)) * 1274126177; return ((n ^ (n >>> 16)) >>> 0) / 4294967295; };
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/**
 * The camera: the pool as a thermal scene. Each mark is one note added to the pool in the last 24 hours (the real count);
 * the withdrawal is one more note, as warm as its trail ΔT. At 0 K it is the crowd's own temperature and disappears.
 */
function Thermal({ deltaK, blocked, count, seed }) {
  const box = useRef(null), cv = useRef(null), props = useRef({});
  props.current = { target: blocked ? 0 : warmth(deltaK), blocked, count: Math.min(400, count || 0), seed };
  useEffect(() => {
    const el = cv.current, ctx = el.getContext('2d');
    if (!ctx) return undefined;
    const low = document.createElement('canvas'), lx = low.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, W = 0, H = 0, dpr = 1, img = null, notes = [], made = '', d = props.current.target, last = 0, seen = true, dirty = true;
    const size = () => {
      const r = box.current.getBoundingClientRect();
      dpr = Math.min(2, devicePixelRatio || 1); W = Math.max(1, r.width); H = Math.max(1, r.height);
      el.width = Math.round(W * dpr); el.height = Math.round(H * dpr);
      low.width = Math.max(8, Math.ceil(W / 7)); low.height = Math.max(8, Math.ceil(H / 7));
      img = lx.createImageData(low.width, low.height); dirty = true;
    };
    const crowd = () => {
      const { count: n, seed: s } = props.current, key = n + ':' + s;
      if (key === made) return;
      made = key; const r = rng(s);
      notes = Array.from({ length: n }, () => ({ x: r(), y: r(), a: r() * Math.PI, l: 0.75 + r() * 0.5, j: (r() - 0.5) * 0.05, vx: (r() - 0.5) * 0.004, vy: (r() - 0.5) * 0.003 }));
    };
    const cap = (x, y, a, len, wid, color) => {
      const dx = Math.cos(a) * len / 2, dy = Math.sin(a) * len / 2;
      ctx.strokeStyle = color; ctx.lineWidth = wid; ctx.beginPath(); ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); ctx.stroke();
    };
    const draw = (now) => {
      const t = reduce ? 0 : now / 1000, p = props.current;
      crowd();
      // the ground: slow thermal drift, upscaled from a coarse grid for the camera's soft look
      const gw = low.width, gh = low.height, data = img.data;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
        const v = 0.1 + 0.11 * noise(x * 0.07 + t * 0.05, y * 0.07 - t * 0.03) + 0.05 * noise(x * 0.21 - t * 0.08, y * 0.21 + 7.3);
        const c = pal(v), i = (y * gw + x) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 255;
      }
      lx.putImageData(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(low, 0, 0, el.width, el.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.lineCap = 'round';
      const unit = Math.min(W, H) / 22, sx = W * 0.5, sy = H * 0.54;
      // the crowd: every note added in 24 hours, at the pool's own temperature
      for (const n of notes) {
        if (!reduce) { n.x = (n.x + n.vx * 0.016 + 1) % 1; n.y = (n.y + n.vy * 0.016 + 1) % 1; }
        const x = 14 + n.x * (W - 28), y = 14 + n.y * (H - 28), len = unit * 1.5 * n.l;
        cap(x, y, n.a, len, unit * 0.62, css(CROWD - 0.06 + n.j, 0.28));
        cap(x, y, n.a, len, unit * 0.42, css(CROWD + n.j, 1));
      }
      // the withdrawal: one more note, as warm as its trail
      if (!p.blocked) {
        const len = unit * 1.5 * (1 + 1.2 * d), wid = unit * 0.42 * (1 + 0.9 * d), v = CROWD + SPAN * d;
        if (d > 0.01) {
          const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, unit * (1.2 + 5 * d));
          g.addColorStop(0, css(v, 0.55 * d)); g.addColorStop(1, css(v, 0));
          ctx.fillStyle = g; ctx.fillRect(sx - unit * 7, sy - unit * 7, unit * 14, unit * 14);
          cap(sx, sy, -0.5, len, wid * 1.6, css(v - 0.08, 0.35 * d));
        }
        cap(sx, sy, -0.5, len, wid, css(v, 1));
        if (d > 0.35) cap(sx, sy, -0.5, len * 0.45, wid * 0.4, css(Math.min(1, v + 0.12), 0.85));
      }
      // sensor grain
      ctx.globalAlpha = 0.06;
      for (let i = 0; i < 260; i++) { ctx.fillStyle = Math.random() > 0.5 ? '#fff' : '#000'; ctx.fillRect(Math.random() * W, Math.random() * H, 1, 1); }
      ctx.globalAlpha = 1;
      box.current.parentElement?.style.setProperty('--d', d.toFixed(3));
    };
    const frame = (now) => {
      raf = requestAnimationFrame(frame);
      try {
        if (!seen) return;
        const target = props.current.target, moving = Math.abs(target - d) > 0.002;
        if (!reduce && !moving && !dirty && now - last < 66) return;
        if (reduce && !moving && !dirty && made === props.current.count + ':' + props.current.seed) return;
        d = reduce ? target : d + (target - d) * 0.09;
        last = now; dirty = false; draw(now);
      } catch (e) { cancelAnimationFrame(raf); console.warn('thermal view', e); }
    };
    size();
    const ro = new ResizeObserver(size); ro.observe(box.current);
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; }); io.observe(box.current);
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); };
  }, []);
  return <div ref={box} className="kf-thermal-img"><canvas ref={cv} aria-hidden="true" /></div>;
}

const LEVEL = { pass: [Check, 'Pass'], warn: [TriangleAlert, 'Watch'], risk: [X, 'Risk'], block: [X, 'Blocked'], unknown: [CircleHelp, 'Not given'] };
const HOURS = { hour: 0.5, day: 8, days: 30 };

/** The cold chapter: a planned withdrawal, three switches only you know, and the camera that shows how far it stands out. */
export default function ColdBench({ onTrail }) {
  const cfg = useReading('/api/privacy', 60000), act = useReading('/api/privacy?action=activity', 300000);
  const [token, setToken] = useState('eth'), [amount, setAmount] = useState('0.1');
  const [same, setSame] = useState('same'), [time, setTime] = useState('hour'), [to, setTo] = useState('linked');
  const sym = token.toUpperCase();
  const check = useMemo(() => {
    if (!cfg.data?.config) return null;
    try {
      const deposit = same === 'same' ? amount : same === 'diff' ? String(Number((Number(amount) * 1.6).toPrecision(6))) : undefined;
      return withdrawCheck({ token, amount, deposit_amount: deposit, hours_since_deposit: HOURS[time], to_new_address: to === 'fresh' ? true : to === 'linked' ? false : undefined }, cfg.data.config, act.data);
    } catch (e) { return { error: e.message }; }
  }, [cfg.data, act.data, token, amount, same, time, to]);
  const dK = check && !check.error ? check.deltaK : null, blocked = Boolean(check && !check.error && check.deltaK == null);
  useEffect(() => { onTrail?.(check && !check.error ? (blocked ? FULL : dK) : null); }, [check, dK, blocked, onTrail]);
  const pool = act.data?.[token], blockedBy = blocked ? check.checks.find((c) => c.level === 'block') : null;
  const minimum = cfg.data?.config?.minimum_withdrawal?.[token];
  const fee = cfg.data?.config;
  return <div className="kf-cold">
    <div className="kf-head kf-cold-head">
      <span className="kv-label">The cold side</span>
      <h2 id="kv-cold">What matches the background <em>disappears</em></h2>
      <p>The private pools are the background. Set what you would do and watch the withdrawal sink into the notes around it, or stand out. A plan only: nothing here is sent.</p>
    </div>
    <div className="kf-cold-left">
      <div className="kf-plan">
        <div className="kf-plan-amt">
          <Seg label="Pool" value={token} options={[['eth', 'ETH'], ['usdg', 'USDG']]} onChange={(v) => { setToken(v); setAmount(v === 'eth' ? '0.1' : '100'); }} />
          <label className="kf-field"><span className="kf-seg-label">Withdraw</span><span className="kf-field-in"><input size={1} inputMode="decimal" autoComplete="off" spellCheck="false" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, '').slice(0, 14))} aria-describedby="kf-min" /><em>{sym}</em></span></label>
        </div>
        <Seg wide label="Same amount as the deposit" value={same} options={[['same', 'Same'], ['diff', 'Different'], ['unset', 'Not given']]} onChange={setSame} />
        <Seg wide label="Time since the deposit" value={time} options={[['hour', 'Under 1h'], ['day', 'Hours'], ['days', 'A day +'], ['unset', 'Not given']]} onChange={setTime} />
        <Seg wide label="Recipient" value={to} options={[['linked', 'My wallet'], ['fresh', 'Fresh'], ['unset', 'Not given']]} onChange={setTo} />
        <p className="kf-plan-fee" id="kf-min">{fee ? <>Minimum <b className="kv-num">{minimum} {sym}</b> · fee <b className="kv-num">{fee.rent_fees[token]} {sym}</b> + <b className="kv-num">{(fee.fee_rate / 100).toFixed(2)}%</b>{check?.receive != null && <> · you receive <b className="kv-num">{check.receive} {sym}</b></>} · relay terms at {clock(cfg.data.checkedAt)}</> : cfg.error ? 'The relay terms could not be read. The camera waits for them.' : 'Reading the relay terms'}</p>
      </div>
      <Link className="kv-key cold" to="/cold"><span>Go cold</span><Snowflake /></Link>
    </div>

    <figure className="kf-thermal" data-blocked={blocked ? '1' : undefined}>
      <div className="kf-cam">
        <Thermal deltaK={dK} blocked={blocked || !check || Boolean(check?.error)} count={pool?.notes24h} seed={token === 'eth' ? 4663 : 6} />
        <div className="kf-cam-hud" aria-hidden="true">
          <span className="tl">{sym} pool · <b className="kv-num">{pool?.notes24h ?? '—'}</b> notes added in 24h</span>
          <span className="bl"><b className="kv-num">{pool?.notes != null ? pool.notes.toLocaleString('en-US') : '—'}</b> notes in total · read at {clock(act.at)}</span>
          <span className="tr">1 mark = 1 note</span>
        </div>
        <div className="kf-reticle" data-lock={dK != null && dK > 0 && !blocked ? '1' : '0'} aria-hidden="true"><i /><span>{blocked ? 'refused' : dK == null ? '—' : dK > 0 ? `+${dK} K` : 'no contrast'}</span></div>
        <div className="kf-cam-scale" aria-hidden="true"><i style={{ bottom: `${Math.min(100, ((blocked ? FULL : dK ?? 0) / FULL) * 100)}%` }} /><span style={{ bottom: '100%' }}>{FULL}+ K</span><span style={{ bottom: '50%' }}>{FULL / 2}</span><span style={{ bottom: '0%' }}>0</span></div>
        {blocked && <p className="kf-cam-block">{blockedBy?.detail || 'The relay would refuse this withdrawal.'}</p>}
        {check?.error && <p className="kf-cam-block">{check.error}</p>}
      </div>
      <figcaption className="kf-cam-read" aria-live="polite">
        <span className="kv-label">Trail ΔT</span>
        <b className="kv-num" style={{ color: blocked ? 'var(--kv-down)' : trailColor(dK) }}>{!check || check.error ? '—' : blocked ? 'blocked' : dK === 0 ? '0 K' : `+${dK} K`}</b>
        <small>{!check || check.error ? 'Waiting for the relay terms' : blocked ? 'The relay would refuse it' : dK === 0 ? 'Blends in with the pool' : `${check.passed} of ${check.of} checks pass`}</small>
      </figcaption>
    </figure>

    <div className="kf-cold-right">
      <div className="kf-slot" data-slot aria-hidden="true" />
      <ul className="kf-checks" aria-label="What the trail is made of">
        {(check?.checks || Array.from({ length: 6 }, (_, i) => ({ id: 's' + i, level: 'unknown', title: '—' }))).map((c) => {
          const [Icon, word] = LEVEL[c.level] || LEVEL.unknown;
          return <li key={c.id} data-level={check ? c.level : 'wait'}><Icon size={14} aria-label={word} /><span title={c.detail}>{c.title}</span><em className="kv-num">{c.level === 'block' ? '' : check ? `+${TRAIL_K[c.level] ?? 0} K` : ''}</em></li>;
        })}
      </ul>
      <p className="kf-small">40 K per risk, 15 K per warning, 5 K per point not given. Rules of thumb from public patterns: privacy is not anonymity.</p>
    </div>
  </div>;
}
