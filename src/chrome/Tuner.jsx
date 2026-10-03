import { useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Menu, Wallet, X } from 'lucide-react';
import { useTerminalWallet } from '../wallet';

export const ROUTES = [['/heat', 'Heat'], ['/launch', 'Launch'], ['/agent', 'Agent'], ['/cold', 'Cold'], ['/kelvo', '$KELVO'], ['/docs', 'Docs']];

export function WalletKey({ compact }) {
  const w = useTerminalWallet();
  if (w.account) return <button type="button" className="kv-wallet on" onClick={() => w.disconnect()} title="Disconnect"><Wallet size={15} /><span>{w.account.slice(0, 6)}…{w.account.slice(-4)}</span></button>;
  return <button type="button" className="kv-wallet" onClick={() => w.connect()} disabled={w.busy}><Wallet size={15} /><span>{w.busy ? 'Waiting' : compact ? 'Connect' : 'Connect wallet'}</span></button>;
}

/**
 * The tuner: Kelvo's navigation as an instrument. The routes sit on a kelvin ruler and a needle slides to the page
 * you are on; the wallet is the widest key on it. On phones the ruler folds into a drop-down scale.
 */
export default function Tuner() {
  const loc = useLocation(), scale = useRef(null), [needle, setNeedle] = useState(null), [open, setOpen] = useState(false);
  const active = ROUTES.find(([to]) => loc.pathname === to || loc.pathname.startsWith(to + '/'))?.[0] || null;
  useLayoutEffect(() => {
    setOpen(false);
    const place = () => {
      const el = scale.current?.querySelector(`a[href="${active}"]`);
      if (!el) { setNeedle(null); return; }
      const b = el.getBoundingClientRect(), s = scale.current.getBoundingClientRect();
      setNeedle(b.left - s.left + b.width / 2);
    };
    place(); addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [active]);
  return <header className={'kv-tuner' + (open ? ' open' : '')}>
    <Link to="/" className="kv-tuner-mark" aria-label="Kelvo home"><img src="/brand/kelvo-64.png" alt="" width="30" height="30" /><span>Kelvo</span></Link>
    <nav ref={scale} className="kv-tuner-scale" aria-label="Main">
      <i className="kv-tuner-ticks" aria-hidden="true" />
      {ROUTES.map(([to, label]) => <NavLink key={to} to={to}>{label}</NavLink>)}
      {needle != null && <i className="kv-tuner-needle" style={{ transform: `translateX(${needle}px)` }} aria-hidden="true" />}
    </nav>
    <div className="kv-tuner-end">
      <WalletKey compact />
      <button type="button" className="kv-tuner-menu" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X size={18} /> : <Menu size={18} />}</button>
    </div>
  </header>;
}
