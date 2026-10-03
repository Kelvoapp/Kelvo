import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowUpRight, CircleAlert } from 'lucide-react';
import { HOLDER_MIN_USD, IDENTITY } from '../identity';
import { EXPLORER } from '../wallet';
import { MULTICALL3, PONS_FACTORY, POOL_MANAGER, QUOTER_V2, SWAP_ROUTER02, UNIVERSAL_ROUTER, V4_QUOTER } from '../chain-addresses';
import { PRIVACY } from '../cold/privacy-config';
import { kelvin } from '../heat-rule';
import { TRAIL_K } from '../trail';
import { fmtK, fmtUsd, rampColor, useHeat } from '../heat-client';
import { AGENT_SESSION_HOURS, AGENT_SIGN_IN } from '../agent-message';
import './pages.css';

// The docs: the rules, the contracts each page calls, the limits, the sources and the dated changelog.
const PONS = [['Pons factory', PONS_FACTORY], ['Pons launch router', '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948'], ['Pons deployer', '0x3711ceA4feaDE896C913C68F01Eda97Cb06D1A42'], ['Pons fee hook', '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044']];
const ROUTES = [['SwapRouter02', SWAP_ROUTER02], ['Universal Router', UNIVERSAL_ROUTER], ['QuoterV2', QUOTER_V2], ['V4 Quoter', V4_QUOTER], ['V4 PoolManager', POOL_MANAGER], ['Multicall3', MULTICALL3]];
const COLD = [['ETH pool', PRIVACY.ethPool], ['USDG pool', PRIVACY.usdgPool], ['USDG token', PRIVACY.usdgToken]];
const INDEX = [['heat', 'Reading heat'], ['token', 'Token pages and buys'], ['launch', 'Launch'], ['agent', 'Agent'], ['cold', 'The cold side'], ['kelvo', IDENTITY.ticker], ['status', 'Status and sources'], ['changelog', 'Changelog']];

const Contract = ({ label, address }) => <div className="kv-doc-ca"><b>{label}</b><a href={EXPLORER + '/address/' + address} target="_blank" rel="noreferrer">{address}<ArrowUpRight size={13} /></a></div>;
const Note = ({ children }) => <div className="kv-doc-note"><CircleAlert size={18} /><p>{children}</p></div>;

/** The rule worked through with the hottest token on the board right now. */
function Worked() {
  const { data } = useHeat(), t = data?.tokens?.[0];
  if (!t || t.trades24h == null) return null;
  const share = t.trades1h ? (t.buys1h ?? 0) / t.trades1h : 0.5, turn = t.liquidityUsd > 0 && t.volume1h != null ? Math.min(3, t.volume1h / t.liquidityUsd) : 0;
  const day = 30 * Math.sqrt(t.trades24h), hour = 260 * Math.log1p(t.trades1h ?? 0) * (0.75 + 0.5 * share) * (1 + turn / 2);
  const n = (v, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
  return <figure className="kv-doc-worked">
    <figcaption><span className="kv-label">Worked now</span><b>{t.symbol}</b><span>{t.address.slice(0, 6)}…{t.address.slice(-4)}</span></figcaption>
    <code>30 × √{n(t.trades24h)} = {n(day)}</code>
    <code>260 × ln(1 + {n(t.trades1h ?? 0)}) × {n(0.75 + 0.5 * share, 2)} × {n(1 + turn / 2, 2)} = {n(hour)}</code>
    <p>{n(t.trades1h ?? 0)} trades in the hour, {Math.round(share * 100)}% buys, turnover {n(turn, 2)} ({fmtUsd(t.volume1h)} over {fmtUsd(t.liquidityUsd)} of liquidity). Rounded to 10: <b style={{ color: rampColor(t.kelvin) }}>{fmtK(kelvin(t))}</b>.</p>
  </figure>;
}

export default function Docs() {
  const { hash } = useLocation();
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView(); }, [hash]);
  const gated = Boolean(IDENTITY.contract && HOLDER_MIN_USD);
  return <main className="kv-page kv-docs">
    <header className="kv-docs-head"><span className="kv-label">Documentation</span><h1>How Kelvo <em>reads</em></h1><p>The rules behind every number, the contracts each page calls, what stays in your browser and what goes on chain.</p></header>
    <div className="kv-docs-layout">
      <nav className="kv-docs-index" aria-label="Sections">{INDEX.map(([id, label]) => <a key={id} href={'#' + id}>{label}</a>)}</nav>
      <article>
        <section id="heat">
          <h2>Reading heat</h2>
          <p>Every token on the heat board gets a temperature in kelvin from how it trades. Price does not enter it: a token can run hot while it falls.</p>
          <pre className="kv-doc-rule">{'K = 30 × √(trades in 24h)\n  + 260 × ln(1 + trades in 1h)\n        × (0.75 + 0.5 × buy share of the hour)\n        × (1 + min(3, hour volume ÷ liquidity) ÷ 2)\nrounded to 10'}</pre>
          <p>The day term keeps a steady token warm. The hour term is the pulse: it grows with trades, more when most of them are buys, and more when the hour's volume is large against the pool's depth. A token with no trade in 24 hours reads 0 K. The thermal ramp runs from 0 K to 10,000 K; a reading above that keeps its number and the top colour.</p>
          <Worked />
          <p>Each token is read from its busiest pool on Robinhood Chain, from public pool feeds, every 30 seconds. Pools under $10,000 of liquidity are left off the board, because thin pools are mostly copies of a real token under the same name. Tokenized stocks are read from their own pools in the same way.</p>
        </section>

        <section id="token">
          <h2>Token pages and buys</h2>
          <p>A token page takes the temperature apart term by term, shows the chart and every pool, and buys with ETH from your own wallet. Tokens are opened by contract address, never by symbol, because many contracts share a name.</p>
          <p>Routes are Uniswap V3 through SwapRouter02 against WETH or through USDG, Uniswap V4 through the Universal Router against ETH or through USDG, and Pons bonding curves. The server builds the call, your browser builds it again and compares it byte for byte, and the exact call is dry-run from your account before the wallet opens. Kelvo adds no fee and holds nothing.</p>
          {ROUTES.map(([l, a]) => <Contract key={l} label={l} address={a} />)}
          <Note>Prices move between the quote and the block. The slippage you choose sets the least you accept. A contract you paste opens even when it is not on the board, so check the address you buy.</Note>
        </section>

        <section id="launch">
          <h2>Launch</h2>
          <p>Kelvo launches tokens on the Pons V2 curve on Robinhood Chain. The launch fee, the creator tax limit, the curve fee and the launch configuration are read from the factory in the same block before you sign, never from a constant. Before any read or launch the server checks the code of the factory, the router and the deployer against pinned hashes and stops if they changed.</p>
          <p>The agent persona you write goes into the token's own description on chain, under a plain <code>Agent persona</code> heading after what the token is, so it travels with the token. Name up to 64 bytes, symbol 16, logo an https or ipfs link, description and persona together 2,048 bytes, links https only, creator tax up to the factory's limit, slippage up to 5%. Any change after the review means a new review: the description is bound into the prepared call.</p>
          <p>Each launch carries a provenance salt that starts with <code>KELV</code> and is signed by the Kelvo server, which is how the launch list tells a Kelvo launch from any other. A launch counts as confirmed only after its receipt matches the prepared call, one more block has passed, exactly one launch event came from the factory and the token reads back the name, symbol, logo, description and links you wrote. It starts with no trades at 0 K and reads by the same heat rule as every token from its first trade.</p>
          {PONS.map(([l, a]) => <Contract key={l} label={l} address={a} />)}
          <Note>Your wallet signs the launch and any initial buy. Kelvo prepares, checks and dry-runs the call; it cannot move funds and keeps no keys.</Note>
        </section>

        <section id="agent">
          <h2>Agent</h2>
          <p>The agent answers from Kelvo's own readings: the heat board, a token's temperature, pools and route, a buy quote, your wallet, the private pools and a check of a planned withdrawal with its trail ΔT. Answers come from a hosted language model called from Kelvo's server; your questions and the readings are sent to it to be answered, and Kelvo does not store the conversation.</p>
          <p>The wallet signs one plain message that starts with <code>{AGENT_SIGN_IN}</code>. It is not a transaction and cannot move funds. The session lasts {AGENT_SESSION_HOURS} hours in that tab. {gated ? `It opens for wallets holding $${HOLDER_MIN_USD} of ${IDENTITY.ticker}, with 12 questions per 10 minutes and 80 a day per wallet.` : `Until ${IDENTITY.ticker} has a contract and a holder bar it opens for any signed-in wallet, with 6 questions per 10 minutes and 30 a day per wallet.`}</p>
          <Note>The agent cannot sign, send or approve anything. A quote opens the token page with the amount filled in, where the usual review, dry run and wallet prompt apply. It can be wrong; the numbers come from the readings shown with each answer.</Note>
        </section>

        <section id="cold">
          <h2>The cold side</h2>
          <p>The cold side is an independent interface to Privacy Cash EVM 1.3.3 on Robinhood Chain, for ETH and USDG. Your browser builds proofs with the original pinned circuit files. Connect, unlock, prepare and review are separate actions. Deposits request a wallet transaction; USDG may first need an approval for the exact amount. Withdrawals ask for an explicit confirmation before a proof goes to the external relay, which may move funds without another wallet prompt.</p>
          <p>The trail ΔT reads how far a planned withdrawal would stand out from its pool, like a warm shape on a thermal camera. Each check that stands out adds to it: {TRAIL_K.risk} K for a risk (the same amount as the deposit, within the hour of it, back to a linked wallet), {TRAIL_K.warn} K for a warning (an unusual amount, less than a day, a quiet pool) and {TRAIL_K.unknown} K for each point not given. 0 K blends in. A withdrawal below the relay minimum has no reading.</p>
          <h3 id="keys">Keys and recovery</h3>
          <p>The protocol message is <code>{PRIVACY.message}</code>, and the protocol derives your private keys from its signature. The first unlock signs it twice to check that your wallet signs consistently. Keep using the same wallet and signing method. Hardware wallets are not supported by this SDK. The signature stays in memory and is cleared on lock, on an account or network change and when you leave the page; a fingerprint of it is kept in this browser to detect a change.</p>
          {COLD.map(([l, a]) => <Contract key={l} label={l} address={a} />)}
          <Note>Privacy is not anonymity. Public transactions, timing, amounts and provider metadata can reveal links. The relay, RPC and indexer are operated by Privacy Cash, not by Kelvo. The trail ΔT is a rule of thumb from public patterns, never a guarantee.</Note>
        </section>

        <section id="kelvo">
          <h2>{IDENTITY.ticker}</h2>
          <p>Contract: {IDENTITY.contract ? <a className="kv-doc-ca-inline" href={EXPLORER + '/token/' + IDENTITY.contract} target="_blank" rel="noreferrer">{IDENTITY.contract}</a> : <b>TBA</b>}. It is published here, on the home page and on the {IDENTITY.ticker} page at the same moment. {IDENTITY.contract ? 'It launched on the Pons curve paired with ETH. Holder bar, creator fees and socials are TBA.' : 'Holder bar, creator fees, launch details and socials are TBA.'} {gated ? `The agent and the cold side open for holders of $${HOLDER_MIN_USD}.` : 'The agent and the cold side switch to holders only by themselves once ' + (IDENTITY.contract ? 'the holder bar is set' : 'the contract and the holder bar are set') + '; until then they are open with limits.'}</p>
          <Link className="kv-doc-link" to="/kelvo">The {IDENTITY.ticker} page<ArrowUpRight size={14} /></Link>
        </section>

        <section id="status">
          <h2>Status and sources</h2>
          <p>Kelvo is unaudited. The guards on amounts, approvals, recipients, relay payloads and launch calls are covered by tests; browser checks run with stand-in wallets and no funds. No funded deposit, withdrawal or launch is claimed here. Trades, volume and liquidity come from public pool feeds; balances, quotes, launches and the private pools are read on chain. Kelvo is not affiliated with Robinhood or endorsed by the protocols it integrates.</p>
        </section>

        <section id="changelog">
          <h2>Changelog</h2>
          <h3>October 3, 2026</h3>
          <p>The {IDENTITY.ticker} contract is published here, on the home page and on the {IDENTITY.ticker} page. It trades on the Pons curve paired with ETH. Same day: reading keys, the instrument chapters on the home page, and the market desk with the on-chain swap tape.</p>
          <h3>October 2, 2026</h3>
          <p>First build: the bloom drawn from the logo as a live shader whose petals are real tokens, the heat rule, the heat board, token pages with buys, the agent, the cold side with the trail ΔT, the launch, the {IDENTITY.ticker} page and these docs.</p>
        </section>
      </article>
    </div>
  </main>;
}
