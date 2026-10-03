import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import { HOLDER_MIN_USD, IDENTITY } from '../identity';
import { EXPLORER } from '../wallet';
import { fmtK, heat01, rampColor } from '../heat-client';
import './pages.css';

// $KELVO: what it is, what it opens, and every fact that does not exist yet written as TBA. The reading appears on its own
// the moment the contract is set in identity.js, read by the same rule as every other token.
function useReading(address) {
  const [coin, setCoin] = useState(null);
  useEffect(() => {
    if (!address) return;
    let alive = true;
    fetch('/api/terminal?action=coin&address=' + address).then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setCoin(d); }).catch(() => {});
    return () => { alive = false; };
  }, [address]);
  return coin;
}

export default function Kelvo() {
  const ca = IDENTITY.contract, coin = useReading(ca), k = coin?.kelvin ?? null;
  const gated = Boolean(ca && HOLDER_MIN_USD);
  const fill = (ca && k != null ? Math.max(0.02, heat01(k)) : 0) * 100 + '%';
  const opens = gated ? `holders of $${HOLDER_MIN_USD} of ${IDENTITY.ticker}` : 'any signed-in wallet, with a daily limit, until the contract and the holder bar are set';
  const rows = [
    ['Ticker', IDENTITY.ticker],
    ['Network', 'Robinhood Chain'],
    ['Contract', ca ? <a href={EXPLORER + '/token/' + ca} target="_blank" rel="noreferrer">{ca}<ArrowUpRight size={13} /></a> : 'TBA'],
    ['Temperature', ca ? fmtK(k) : 'Reads once it trades, by the same rule as every token'],
    ['Launch', 'TBA'],
    ['Holder bar', gated ? `$${HOLDER_MIN_USD}` : 'TBA'],
    ['Agent', 'Open to ' + opens],
    ['Cold side', 'Open to ' + opens],
    ['Creator fees', 'Where they go is TBA and will be posted on the docs page'],
    ['X', IDENTITY.x || 'TBA'],
    ['Telegram', IDENTITY.telegram || 'TBA'],
    ['Source', IDENTITY.repo || 'TBA'],
  ];
  return <main className="kv-page kv-kelvo">
    <section className="kv-kelvo-hero" aria-labelledby="kv-kelvo-title">
      <div className="kv-kelvo-gauge" aria-label={ca ? `Temperature ${fmtK(k)}` : 'No reading yet'}>
        <div className="kv-kelvo-tube"><i style={{ height: fill, '--fill': fill, background: rampColor(k) }} /></div>
        {[10000, 7500, 5000, 2500, 0].map((v) => <span key={v} style={{ bottom: (v / 10000) * 100 + '%' }}>{v.toLocaleString('en-US')}</span>)}
        <b className="kv-kelvo-read" style={{ color: ca && k != null ? rampColor(k) : undefined }}>{ca ? fmtK(k) : '— K'}</b>
      </div>
      <div className="kv-kelvo-copy">
        <span className="kv-label">Robinhood Chain</span>
        <h1 id="kv-kelvo-title" className="kv-kelvo-ticker">{IDENTITY.ticker}</h1>
        <p className="kv-kelvo-lede">The key to the <em>cold side</em>. Holding it is planned to open the agent and the private pools once its contract is live. Until then both are open to any wallet, with limits.</p>
        <div className="kv-kelvo-ca"><span className="kv-label">Contract</span><b>{ca || 'TBA'}</b><small>Published here, on the home page and in the docs at the same moment.</small></div>
        <div className="kv-keys">
          {ca ? <Link className="kv-key" to={'/token/' + ca}><span>Buy {IDENTITY.ticker}</span><ArrowUpRight /></Link> : <Link className="kv-key" to="/heat"><span>Read the heat</span><ArrowUpRight /></Link>}
          <Link className="kv-key ink" to="/docs#kelvo"><span>Read the docs</span><ArrowUpRight /></Link>
        </div>
      </div>
    </section>

    <section className="kv-sheet" aria-label={IDENTITY.ticker + ' facts'}>
      <dl>{rows.map(([dt, dd]) => <div key={dt}><dt>{dt}</dt><dd className={dd === 'TBA' ? 'tba' : ''}>{dd}</dd></div>)}</dl>
    </section>

    {!ca && <section className="kv-notice" role="note"><ShieldAlert size={20} /><p><b>No {IDENTITY.ticker} contract exists yet.</b> Any token using the name before the address appears on this page is not ours. Check the address here and in the docs before you buy anything called Kelvo.</p></section>}
  </main>;
}
