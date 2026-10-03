import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { formatUnits, parseEther } from 'viem';
import { fmtK, fmtPct, fmtUsd, heat01, rampColor, short } from '../../heat-client.js';
import { SUGGESTIONS } from '../../agent-message.js';
import { amt, clock, clockS, int, medianK, price, useReading } from './data.js';
import { Day, Pace, rule } from '../../heat/readings';
import { Coin, Lamp, Seg, ToolHead } from './ui.jsx';

/** heat_board, with the tool's own inputs as switches. A row picks the token the other two tools read. */
function HeatBoardTool({ heat, selected, onSelect }) {
  const [order, setOrder] = useState('hottest'), [group, setGroup] = useState('all');
  const all = heat.data?.tokens || [];
  const rows = useMemo(() => {
    let r = all.filter((t) => group === 'all' || t.group === group);
    if (order === 'coldest') r = r.filter((t) => t.kelvin != null).sort((a, b) => a.kelvin - b.kelvin);
    return r.slice(0, 8);
  }, [all, order, group]);
  const read = all.filter((t) => t.kelvin != null), med = medianK(read.map((t) => t.kelvin));
  const at = heat.data?.at ? Date.parse(heat.data.at) : heat.at;
  const args = [['order', `"${order}"`], ...(group === 'all' ? [] : [['group', `"${group}"`]]), ['limit', '8']];
  return <article className="kf-tool kf-tool-board" aria-label="heat_board reading">
    <ToolHead name="heat_board" args={args} state={heat.data ? 'live' : heat.error ? 'error' : 'wait'} at={at} />
    <div className="kf-tool-in">
      <Seg label="order" value={order} options={[['hottest', 'Hottest'], ['coldest', 'Coldest']]} onChange={setOrder} />
      <Seg label="group" value={group} options={[['all', 'All'], ['memes', 'Memes'], ['stocks', 'Stocks']]} onChange={setGroup} />
    </div>
    <div className="kf-board-head" aria-hidden="true"><span>Token</span><span>Temperature</span><span>Trades 1h</span><span>Buys</span></div>
    <ol className="kf-board">
      {!rows.length && Array.from({ length: 8 }, (_, i) => <li key={i} className="kf-skel" aria-hidden="true"><i /></li>)}
      {rows.map((t, i) => <li key={t.address}>
        <button type="button" aria-pressed={selected === t.address} onClick={() => onSelect(t.address)} title={`Read ${t.symbol} with token_report`}>
          <em className="kv-num">{i + 1}</em>
          <span className="kf-board-id"><Coin t={t} size={16} /><b>{t.symbol}</b></span>
          <span className="kf-board-k">
            <span className="kf-cap"><i style={{ width: `${Math.max(3, heat01(t.kelvin) * 100)}%`, background: rampColor(t.kelvin) }} /></span>
            <span className="kv-num" style={{ color: t.kelvin == null ? undefined : rampColor(t.kelvin) }}>{fmtK(t.kelvin)}</span>
          </span>
          <span className="kv-num">{int(t.trades1h)}</span>
          <span className="kv-num">{t.buyShare1h == null ? '—' : t.buyShare1h + '%'}</span>
        </button>
      </li>)}
    </ol>
    <footer className="kf-tool-foot">
      <span>Board <b className="kv-num">{all.length || '—'}</b> tokens</span>
      <span>Median <b className="kv-num" style={{ color: med == null ? undefined : rampColor(med) }}>{fmtK(med)}</b></span>
      <span className="kf-src">public pool feed</span>
    </footer>
  </article>;
}

function TokenReportTool({ address, row, boardAt }) {
  const coin = useReading(address ? '/api/terminal?action=coin&address=' + address : null, 60000);
  const c = coin.data?.address === address ? coin.data : null;
  const candles = useReading(c?.chartPool ? `/api/terminal?action=candles&pool=${c.chartPool}&frame=1h` : null, 300000);
  // the rule from the board's own inputs, so the report sums to the temperature the board and the petal show
  const r = useMemo(() => rule(row), [row]);
  const k = r ? r.k : c?.kelvin ?? null, t = row || c;
  const cs = candles.data?.pool === c?.chartPool ? candles.data?.candles || [] : [];
  const cAt = c?.at ? Date.parse(c.at) : 0, drift = c?.kelvin != null && r && c.kelvin !== r.k;
  const venue = c?.route ? `${c.route.venue} · ${c.route.pair}` : row?.pool?.venue ? `${row.pool.venue} · ${row.pool.pair}` : '—';
    return <article className="kf-tool kf-tool-report" aria-label="token_report reading">
    <ToolHead name="token_report" args={[['address', short(address)]]} state={c ? 'live' : coin.error ? 'error' : 'wait'} at={cAt} />
    <div className="kf-rep-id">
      <Coin t={t} size={28} />
      <div><b>{t?.symbol || '—'}</b><span>{t?.name || ''}</span></div>
      <div className="kf-rep-route"><small>{venue}</small>{address && <Link className="kf-open" to={'/token/' + address}>Token page<ArrowUpRight size={13} /></Link>}</div>
    </div>
    <div className="kf-rep-k">
      <b className="kv-num" style={{ color: k == null ? undefined : rampColor(k) }}>{fmtK(k)}</b>
      <div className="kf-ramp" aria-hidden="true"><i style={{ left: `${heat01(k) * 100}%`, opacity: k == null ? 0 : 1 }} /><span>0</span><span>5,000</span><span>10,000 K</span></div>
    </div>
    <dl className="kf-terms" aria-label="The heat rule, term by term">
      <div><dt>Day</dt><dd>30 × √{int(r?.t24)}</dd><dd className="kv-num">{r ? int(r.day) + ' K' : '—'}</dd></div>
      <div><dt>Hour</dt><dd>260 × ln(1 + {int(r?.t1)}) × {r ? (0.75 + 0.5 * r.share).toFixed(2) : '—'} × {r ? (1 + r.turnover / 2).toFixed(2) : '—'}</dd><dd className="kv-num">{r ? int(r.hour) + ' K' : '—'}</dd></div>
      <div className="kf-terms-sum">
        <dt>Sum</dt>
        <dd><span className="kf-stack" aria-hidden="true"><i className="d" style={{ flexGrow: r ? r.day : 1 }} /><i className="h" style={{ flexGrow: r ? r.hour : 1 }} /></span></dd>
        <dd className="kv-num">{r ? `${int(r.sum)} → ${fmtK(r.k)}` : '—'}</dd>
      </div>
    </dl>
    <p className="kf-terms-in">{r
      ? <>{(0.75 + 0.5 * r.share).toFixed(2)} from {Math.round(r.share * 100)}% buys · {(1 + r.turnover / 2).toFixed(2)} from turnover {r.raw.toFixed(2)}{r.raw > 3 ? ', capped at 3' : ''} ({fmtUsd(row.volume1h)} in the hour on {fmtUsd(row.liquidityUsd)}) · inputs as heat_board read them at {clockS(boardAt)}</>
      : 'Reading the inputs of the rule'}</p>
    {drift && <p className="kf-drift">token_report read <b className="kv-num" style={{ color: rampColor(c.kelvin) }}>{fmtK(c.kelvin)}</b> at {clockS(cAt)}: the pool moved since the board read it.</p>}
    <div className="kf-rep-charts">
      <div><span className="kv-label">Trades a minute{row?.pace != null ? `, hour at ${row.pace}× the day` : ''}</span><Pace windows={row?.windows} /></div>
      <div><span className="kv-label">Price, 24 hourly closes{cs.length ? ` to ${clock(cs[cs.length - 1].t * 1000)}` : ''}</span>{cs.length ? <Day candles={cs} /> : <div className="kf-mini empty">{candles.error ? 'No candles right now' : c && !c.chartPool ? 'No pool to chart' : '—'}</div>}</div>
    </div>
    <dl className="kf-rep-stats">
      <div><dt>Price</dt><dd className="kv-num">{price(c?.priceUsd ?? row?.priceUsd)}</dd></div>
      <div><dt>24h</dt><dd className="kv-num" data-dir={(row?.change24h ?? c?.change24h) > 0 ? 'up' : (row?.change24h ?? c?.change24h) < 0 ? 'down' : undefined}>{fmtPct(row?.change24h ?? c?.change24h)}</dd></div>
      <div><dt>Liquidity</dt><dd className="kv-num">{fmtUsd(c?.liquidityUsd ?? row?.liquidityUsd)}</dd></div>
      <div><dt>24h volume</dt><dd className="kv-num">{fmtUsd(c?.volume24h ?? row?.volume24h)}</dd></div>
    </dl>
  </article>;
}

/** quote_buy: nothing is read until an amount is picked; then the same read-only quote the token page asks for. */
const AMOUNTS = ['0.01', '0.05', '0.1'];
function QuoteTool({ address, symbol }) {
  const [eth, setEth] = useState(null), [q, setQ] = useState({ state: 'idle' });
  useEffect(() => { setEth(null); setQ({ state: 'idle' }); }, [address]);
  useEffect(() => {
    if (!eth || !address) return undefined;
    const ctl = new AbortController();
    setQ({ state: 'wait' });
    fetch(`/api/terminal?action=quote&address=${address}&amount=${parseEther(eth).toString()}`, { signal: ctl.signal, headers: { accept: 'application/json' } })
      .then(async (r) => { const d = await r.json().catch(() => null); if (!r.ok || !d) throw new Error(d?.error || 'The quote could not be read right now.'); setQ({ state: 'live', data: d, at: Date.now() }); })
      .catch((e) => { if (e.name !== 'AbortError') setQ({ state: 'error', error: e.message }); });
    return () => ctl.abort();
  }, [eth, address]);
  const d = q.data, out = d?.amountOut != null && d.decimals != null ? Number(formatUnits(BigInt(d.amountOut), d.decimals)) : null;
  const min = d?.minOut != null && d.decimals != null ? Number(formatUnits(BigInt(d.minOut), d.decimals)) : null;
  const to = '/token/' + address + (eth ? '?buy=' + eth : '');
  return <article className="kf-tool kf-tool-quote" aria-label="quote_buy">
    <ToolHead name="quote_buy" args={[['address', short(address)], ['eth', eth ? `"${eth}"` : '?']]} state={q.state} at={d?.at ? Date.parse(d.at) : q.at} idle="waits for an amount" />
    <div className="kf-quote">
      <div className="kf-amts" role="radiogroup" aria-label="ETH to spend">
        {AMOUNTS.map((x) => <button key={x} type="button" role="radio" aria-checked={eth === x} className={'kf-amt' + (eth === x ? ' on' : '')} onClick={() => setEth(x)}><b className="kv-num">{x}</b><span>ETH</span></button>)}
      </div>
      <dl className="kf-quote-read" aria-live="polite">
        <div><dt>Expect</dt><dd className="kv-num">{q.state === 'live' && out != null ? <><b>{amt(out)}</b> {symbol}</> : q.state === 'wait' ? 'quoting' : '—'}</dd></div>
        <div><dt>At least</dt><dd className="kv-num">{q.state === 'live' && min != null ? `${amt(min)} at ${(d.slippageBps / 100).toFixed(0)}%` : '—'}</dd></div>
        <div><dt>Route</dt><dd>{q.state === 'live' && d.route ? `${d.route.venue} via ${d.route.via}` : q.state === 'live' && d.reason ? 'none' : '—'}</dd></div>
      </dl>
      <Link className="kf-review" to={to}><span>{eth ? 'Review on the token page' : 'Open the token page'}</span><ArrowUpRight size={15} /></Link>
    </div>
    <p className="kf-tool-note">{q.state === 'error' ? q.error : q.state === 'live' && d.reason ? d.reason : `Read only. The token page quotes ${symbol || 'it'} again, dry-runs the exact call, and your wallet asks before anything moves.`}</p>
  </article>;
}

/** The agent chapter: the bloom opened in the middle, its tools around it, read live by this page. */
export default function AgentBench({ heat, selected, onSelect }) {
  const status = useReading('/api/agent?action=status', 120000);
  const row = heat.data?.tokens?.find((t) => t.address === selected) || null;
  const on = status.data?.configured;
  const boardAt = heat.data?.at ? Date.parse(heat.data.at) : heat.at;
  return <div className="kf-agent">
    <div className="kf-agent-mid">
      <div className="kf-head center">
        <span className="kv-label">Agent</span>
        <h2 id="kv-agent">Ask the <em>bloom</em></h2>
        <p>Three of the agent's own tools, called by this page with the inputs you set. Readings, not answers: no model wrote a word here.</p>
      </div>
      <div className="kf-slot" data-slot aria-hidden="true" />
      <div className="kf-ask">
        <p className="kf-ask-state"><Lamp state={!status.data ? (status.error ? 'error' : 'wait') : on ? 'live' : 'wait'} /><span>{!status.data ? (status.error ? 'The agent status could not be read.' : 'Reading the agent status') : on ? `The model is on (${clock(status.at)}): 6 questions per 10 minutes, 30 a day, any signed-in wallet.` : `The model is not switched on yet (${clock(status.at)}). These tools read without it.`}</span></p>
        <ul className="kf-chips" aria-label="Questions to ask on the agent page">{SUGGESTIONS.slice(0, 3).map((s) => <li key={s}><Link to="/agent"><span>{s}</span><ArrowUpRight size={14} /></Link></li>)}</ul>
      </div>
    </div>
    <div className="kf-agent-left"><HeatBoardTool heat={heat} selected={selected} onSelect={onSelect} /></div>
    <div className="kf-agent-right">
      <TokenReportTool address={selected} row={row} boardAt={boardAt} />
      <QuoteTool address={selected} symbol={row?.symbol} />
    </div>
  </div>;
}
