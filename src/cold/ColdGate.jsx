import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, LockKeyhole, RefreshCw, Wallet } from 'lucide-react';
import { HOLDER_MIN_USD, IDENTITY } from '../identity';
import { useTerminalWallet } from '../wallet';
import { short } from '../heat-client';
import './cold.css';

const usd = (v) => '$' + v.toLocaleString('en-US', Number.isInteger(v) ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The gate turns on by itself once the $KELVO contract and the holding bar are both set; until then the cold side is open.
const GATED = Boolean(IDENTITY.contract && HOLDER_MIN_USD);

// The account the cold side will use: the injected wallet's first account, else the one connected in the tuner.
function useWorkspaceAccount(fallback) {
  const [account, setAccount] = useState(null);
  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.request) return;
    const read = () => provider.request({ method: 'eth_accounts' }).then((a) => setAccount(Array.isArray(a) && a[0] ? a[0].toLowerCase() : null)).catch(() => setAccount(null));
    read();
    const changed = (a) => setAccount(Array.isArray(a) && a[0] ? a[0].toLowerCase() : null);
    provider.on?.('accountsChanged', changed);
    return () => provider.removeListener?.('accountsChanged', changed);
  }, [fallback]);
  return account || fallback || null;
}

/** When gated, the cold side opens for wallets holding HOLDER_MIN_USD of $KELVO. The check reads a balance; nothing is signed. */
function Gate({ children }) {
  const wallet = useTerminalWallet();
  const account = useWorkspaceAccount(wallet.account);
  const [check, setCheck] = useState({ status: 'idle' });
  const run = useCallback(async () => {
    if (!account) { setCheck({ status: 'idle' }); return; }
    setCheck((c) => ({ status: 'checking', data: c.data?.account === account ? c.data : null }));
    try {
      const r = await fetch('/api/terminal?action=holder&account=' + account, { headers: { accept: 'application/json' } });
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || 'The balance could not be read.');
      setCheck({ status: data.ok ? 'open' : data.worthUsd == null ? 'unknown' : 'short', data });
    } catch (e) { setCheck({ status: 'error', error: e instanceof Error ? e.message : 'The balance could not be read.' }); }
  }, [account]);
  useEffect(() => { void run(); }, [run]);
  if (check.status === 'open' && check.data?.account === account) return children;

  const d = check.data;
  return <main className="kv-cold kv-cold-gate">
    <section className="kv-cold-gate-card" aria-live="polite">
      <LockKeyhole size={22} />
      <span className="kv-label">Robinhood Chain · holders</span>
      <h1>The <em>cold side</em></h1>
      <p>It opens for wallets holding {usd(HOLDER_MIN_USD)} of {IDENTITY.ticker}. Connect the wallet you will use here; Kelvo reads its balance on Robinhood Chain. Nothing is signed and nothing moves.</p>
      {!account ? <div className="kv-keys"><button type="button" className="kv-key" onClick={() => wallet.connect()} disabled={wallet.busy}><span>{wallet.busy ? 'Waiting for wallet' : 'Connect wallet'}</span><Wallet /></button></div>
        : <>
          <dl className="kv-cold-gate-read">
            <div><dt>Wallet</dt><dd>{short(account)}</dd></div>
            <div><dt>Holds</dt><dd>{d ? d.amount.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' ' + IDENTITY.ticker.slice(1) : '—'}</dd></div>
            <div><dt>Worth</dt><dd>{d?.worthUsd != null ? usd(d.worthUsd) : '—'}</dd></div>
            <div><dt>Needed</dt><dd>{usd(HOLDER_MIN_USD)}</dd></div>
          </dl>
          {check.status === 'checking' && <p className="kv-cold-note">Reading the {IDENTITY.ticker} balance of {short(account)}</p>}
          {check.status === 'short' && <p className="kv-cold-note">{d.amount > 0 ? `This wallet holds about ${usd(d.worthUsd)} of ${IDENTITY.ticker}. Add about ${usd(Math.max(0, HOLDER_MIN_USD - d.worthUsd))} more.` : `This wallet holds no ${IDENTITY.ticker} yet.`}</p>}
          {check.status === 'unknown' && <p className="kv-cold-note warn">The {IDENTITY.ticker} price could not be read right now. Try again in a moment.</p>}
          {check.status === 'error' && <p className="kv-cold-note warn" role="alert">{check.error}</p>}
          <div className="kv-keys">
            <Link className="kv-key" to={'/token/' + IDENTITY.contract}><span>Buy {IDENTITY.ticker}</span><ArrowUpRight /></Link>
            <button type="button" className="kv-key ink" onClick={run} disabled={check.status === 'checking'}><span>Check again</span><RefreshCw /></button>
          </div>
        </>}
      {wallet.error && <p className="kv-cold-note warn" role="alert">{wallet.error}</p>}
    </section>
  </main>;
}

export default function ColdGate({ children }) {
  return GATED ? <Gate>{children}</Gate> : children;
}
