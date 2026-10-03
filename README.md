<p align="center"><img src="public/brand/kelvo-512.png" width="120" alt="Kelvo"></p>

<h1 align="center">Kelvo</h1>

<p align="center">Every token on Robinhood Chain read as a temperature in kelvin, from how it trades on chain.</p>

<p align="center"><a href="https://github.com/Kelvoapp/Kelvo/actions/workflows/ci.yml"><img src="https://github.com/Kelvoapp/Kelvo/actions/workflows/ci.yml/badge.svg" alt="Checks"></a></p>

---

Kelvo is a web app for Robinhood Chain. It reads every token on the board every 30 seconds from its busiest pool and turns the trading into one number in kelvin. A token nobody trades sits at 0 K. A token trading hard while buyers turn over its pool reads past 10,000 K. Hot means busy, never good or safe.

The same reading drives the rest of the app: a market desk, token pages with a buy, an agent that reads but never transacts, a launch flow on the Pons curve, and a cold side where the goal is the opposite, to read 0 K and blend into a private pool.

**$KELVO contract:** [`0x911fc0efa2219152e42faa8282697edbd4d28830`](https://robinhoodchain.blockscout.com/token/0x911fc0efa2219152e42faa8282697edbd4d28830) on Robinhood Chain, launched on the Pons curve paired with ETH. The same address is on the home page, the $KELVO page and the docs. Anything else trading as Kelvo is not this project.

## Pages

| Route | What it does |
| --- | --- |
| `/` | The bloom: the logo drawn as a WebGL2 shader whose petals are real tokens coloured by their kelvin, one pinned stage through the chapters |
| `/heat` | Market desk: heat map, warming, cooling and newest lanes, six windows per token (5m to 24h), and a tape of swaps as they land on chain |
| `/token/:address` | The temperature broken down term by term with the token's own numbers, its pools, and a buy with ETH |
| `/agent` | Chat over read-only tools: the board, a token report, a buy quote, a wallet's holdings, the private pools and a withdrawal check |
| `/cold` | Private ETH and USDG pools with the trail check before a withdrawal |
| `/launch` | Launch a token on the Pons V2 curve paired with ETH, with an agent persona written into its description on chain |
| `/kelvo`, `/docs` | The $KELVO page (contract, launch venue, what holding it opens) and the documentation |

## The heat rule

```
K = 30 × √(trades in 24h)
  + 260 × ln(1 + trades in 1h) × (0.75 + 0.5 × buy share) × (1 + min(3, volume 1h / liquidity) / 2)
```

Rounded to the nearest 10. No trades means 0 K. The day term counts a busy day without letting it run away; the hour term warms a token fast on its first trades and slower after; buys add up to a quarter, sells take up to a quarter off; volume against the pool's depth multiplies the hour up to 2.5 times. Source: [`src/heat-rule.js`](src/heat-rule.js).

## How a buy works

The server builds the route (Uniswap V3, Uniswap V4 or the Pons curve), the browser re-encodes the call and compares it byte for byte, the exact call is dry run from the connected account, and only then does the wallet open. Kelvo holds nothing and adds no fee. The wallet is found through EIP-6963 and switched to Robinhood Chain on connect.

## The cold side

Deposits and withdrawals go through the Privacy Cash EVM SDK 1.3.3 pools for ETH and USDG; the proving artifacts are copied from the installed SDK at build time to `/circuits` and pinned by hash in the tests. Before a withdrawal the trail check reads the plan and adds kelvin for what stands out:

| Finding | Trail |
| --- | --- |
| Same amount as the deposit, within the hour of it, or back to a linked wallet | +40 K each |
| An unusual amount, under a day since the deposit, or a quiet pool | +15 K each |
| Something the check could not read | +5 K |
| A withdrawal that would not go through (below the minimum, fee above the amount) | no reading |

0 K blends in with the pool. These are rules of thumb from public patterns, not a guarantee. Source: [`src/trail.js`](src/trail.js).

## Launch

Launches go through the Pons V2 factory and router on Robinhood Chain. The server reads the protocol values on chain at one block, checks the contracts' code hashes and wiring, simulates the call, and signs the salt with an HMAC (`KELV` prefix) so the app can prove which launches came from it. The browser re-checks the prepared call before the wallet opens; receipts are verified against the event logs, the token's stored info and one extra block. Source: [`server/launch.ts`](server/launch.ts), [`src/launch/pons.ts`](src/launch/pons.ts).

## Contracts read or called

All on Robinhood Chain. Kelvo deploys no contract of its own.

| Contract | Address |
| --- | --- |
| Pons V2 factory | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| Uniswap V3 factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| Uniswap V3 QuoterV2 | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| Uniswap SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| Uniswap V4 PoolManager | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| Uniswap V4 Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| Uniswap Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| USDG | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| Multicall3 | `0xca11bde05977b3631167028862be2a173976ca11` |

The full list, with the launch router, deployer and hook, is in [`src/chain-addresses.js`](src/chain-addresses.js) and [`src/launch/pons.ts`](src/launch/pons.ts).

## Run it locally

Node 22.14 or newer and pnpm 10.

```bash
pnpm install
pnpm dev        # http://localhost:5596, API routes served by the same dev server
pnpm test       # node:test suites in tests/
pnpm build      # static site in dist/
pnpm check      # browser audit at 1366x768 and 390x844; CHECK_URL=<site> to audit a deployment
```

Server environment variables. All are server only; none is read by the browser bundle.

| Variable | Used for |
| --- | --- |
| `ROBINHOOD_RPC_URL` | A dedicated Robinhood Chain RPC; public endpoints are used when it is unset |
| `KELVO_INTENT_SECRET` | 64 or 128 hex characters, signs launch salts so the app can prove its own launches |
| `KELVO_LAUNCH_START_BLOCK` | Floor block for the launch index |
| `KELVO_SITE_ORIGINS` | Extra origins allowed to POST, comma separated |
| `AGENT_API_URL`, `AGENT_API_KEY`, `AGENT_MODEL` | Any OpenAI compatible chat endpoint with tool calls; the key also signs agent sessions, and the agent page says it is not switched on while they are unset |

## Layout

```
api/        Vercel functions: heat, terminal, agent, privacy, launch
server/     heat reading, swap tape, quotes and routes, agent loop and tools, launch prepare and verify
src/        React app: home, heat desk, token page, agent, cold side, launch, docs, key styles
tests/      node:test suites (heat, tape, agent, launch, privacy, artifact integrity)
scripts/    Playwright audits used before each deploy
public/     brand files
```

## Boundaries

- Never holds funds, keys or seed phrases. Every transaction is built in the open, dry run, and signed in your own wallet.
- An unknown value shows as a dash, never as zero.
- The agent has read-only tools. It can quote a buy and hand over the link; it cannot send anything.
- Privacy on the cold side depends on how the pools are used. The trail check gives rules of thumb, not anonymity.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the software and names this project relies on. No open-source license has been selected yet.
