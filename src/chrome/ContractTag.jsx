import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4);

/** The $KELVO contract as a copy key: the full address on wide screens, the short form on phones (or always, with `short`). */
export default function ContractTag({ address, compact = false, className = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1400); };
  return <button type="button" className={'kv-copy kv-ca-tag' + (compact ? ' compact' : '') + (className ? ' ' + className : '')} onClick={copy} aria-label={copied ? 'Contract copied' : 'Copy the contract ' + address} title={address}>
    <span className="kv-ca-full kv-num">{address}</span>
    <span className="kv-ca-short kv-num">{short(address)}</span>
    {copied ? <Check size={14} /> : <Copy size={14} />}
  </button>;
}
