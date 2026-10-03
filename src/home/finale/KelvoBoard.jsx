import { Link } from 'react-router-dom';
import { ArrowUpRight, ShieldAlert } from 'lucide-react';
import { HOLDER_MIN_USD, IDENTITY } from '../../identity.js';
import { fmtK, heat01, rampColor } from '../../heat-client.js';
import { clock, useReading } from './data.js';
import { Lamp } from './ui.jsx';

/** A two-way switch drawn in its position. Not a control: the position follows the contract and the holder bar. */
const Switch = ({ gated }) => <span className="kf-switch" data-pos={gated ? 'holders' : 'open'} role="img" aria-label={gated ? 'Set to holders only' : 'Set to open with limits'}>
  <em>Open</em><span className="kf-switch-track"><b /></span><em>Holders</em>
</span>;

/** The $KELVO chapter: what the token unlocks, each circuit's state today, and the empty contract slot. */
export default function KelvoBoard() {
  const agent = useReading('/api/agent?action=status', 120000), pools = useReading('/api/privacy', 60000);
  const ca = IDENTITY.contract, gated = Boolean(ca && HOLDER_MIN_USD);
  const coin = useReading(ca ? '/api/terminal?action=coin&address=' + ca : null, 60000);
  const k = ca ? coin.data?.kelvin ?? null : null;
  const cfg = pools.data?.config;
  const circuits = [
    {
      name: 'Agent', to: '/agent', lamp: agent.data ? (agent.data.configured ? 'live' : 'wait') : agent.error ? 'error' : 'wait',
      state: gated ? `Holders of $${HOLDER_MIN_USD}` : 'Open with limits',
      reads: agent.data
        ? [['Who', gated ? `$${HOLDER_MIN_USD} of ${IDENTITY.ticker}` : 'any signed-in wallet'], ['Limit', gated ? '12 per 10 min, 80 a day' : '6 per 10 min, 30 a day'], ['Model', agent.data.configured ? `on at ${clock(agent.at)}` : `not switched on yet, ${clock(agent.at)}`]]
        : [['Status', agent.error ? 'could not be read' : 'reading']],
    },
    {
      name: 'Cold side', to: '/cold', lamp: pools.data ? 'live' : pools.error ? 'error' : 'wait',
      state: gated ? `Holders of $${HOLDER_MIN_USD}` : 'Open',
      reads: cfg
        ? [['Who', gated ? `$${HOLDER_MIN_USD} of ${IDENTITY.ticker}` : 'any wallet'], ['Pools', `ETH and USDG verified on chain at ${clock(pools.data.checkedAt)}`], ['Relay', `${(cfg.fee_rate / 100).toFixed(2)}% plus ${cfg.rent_fees.eth} ETH or ${Number(cfg.rent_fees.usdg.toPrecision(4))} USDG`]]
        : [['Status', pools.error ? 'the pools could not be checked' : 'checking the pools on chain']],
    },
  ];
  return <div className="kf-kelvo">
    <div className="kf-kelvo-stage">
      <div className="kf-slot" data-slot aria-hidden="true" />
      <p className="kf-kelvo-cap"><span className="kv-label">The bloom now</span>Nine petals, nine tokens as the board reads them. {IDENTITY.ticker} is read by the same rule the moment it trades.</p>
    </div>
    <div className="kf-kelvo-main">
      <div className="kf-head">
        <span className="kv-label">{IDENTITY.ticker}</span>
        <h2 id="kv-token">The key to the <em>cold side</em></h2>
      </div>

      <section className="kf-board-sw" aria-label={IDENTITY.ticker + ' switchboard'}>
        <header><b>What {IDENTITY.ticker} unlocks</b><span>Both switch to holders by themselves once the contract and the bar are set</span></header>
        {circuits.map((c) => <Link key={c.name} to={c.to} className="kf-circuit">
          <Lamp state={c.lamp} />
          <span className="kf-circuit-name"><b>{c.name}</b><small>{c.state}</small></span>
          <Switch gated={gated} />
          <dl className="kf-circuit-read">{c.reads.map(([dt, dd]) => <div key={dt}><dt>{dt}</dt><dd>{dd}</dd></div>)}</dl>
          <ArrowUpRight size={15} className="kf-circuit-go" />
        </Link>)}
        <div className="kf-circuit tba">
          <Lamp state="off" />
          <span className="kf-circuit-name"><b>Holder bar</b><small>{HOLDER_MIN_USD ? `$${HOLDER_MIN_USD}` : 'TBA'}</small></span>
          <span className="kf-circuit-note">The dollar holding that flips both switches. Posted here and in the docs once set.</span>
        </div>
        <div className="kf-circuit tba">
          <Lamp state="off" />
          <span className="kf-circuit-name"><b>Creator fees</b><small>TBA</small></span>
          <span className="kf-circuit-note">Where they go is posted on the docs page.</span>
        </div>
      </section>

      <section className="kf-ca" aria-label="Contract">
        <div className="kf-ca-slot">
          <span className="kv-label">Contract</span>
          <div className={'kf-ca-plate' + (ca ? ' set' : '')}>{ca ? <b className="kv-num">{ca}</b> : <><i aria-hidden="true">0x</i><span aria-hidden="true" /><b>TBA</b></>}</div>
          <small>Published here, on the {IDENTITY.ticker} page and in the docs at the same moment. Robinhood Chain.</small>
        </div>
        <div className="kf-ca-gauge" aria-label={ca && k != null ? `${IDENTITY.ticker} reads ${fmtK(k)}` : `${IDENTITY.ticker} has no reading yet`}>
          <span className="kv-label">Its temperature</span>
          <div className={'kf-petal' + (ca && k != null ? ' lit' : '')} style={ca && k != null ? { '--c': rampColor(k) } : undefined}><b className="kv-num">{ca ? fmtK(k) : '— K'}</b></div>
          <div className="kf-ramp sm" aria-hidden="true"><i style={{ left: `${heat01(k) * 100}%`, opacity: ca && k != null ? 1 : 0 }} /><span>0</span><span>10,000 K</span></div>
          <small>{ca ? 'By the same rule as every token' : 'Empty until it trades'}</small>
        </div>
      </section>

      {!ca && <p className="kf-fake" role="note"><ShieldAlert size={18} /><span><b>No {IDENTITY.ticker} contract exists yet.</b> Any token using the name before the address appears here is not ours.</span></p>}
    </div>
  </div>;
}
