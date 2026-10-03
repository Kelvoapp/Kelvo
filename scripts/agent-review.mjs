// Review the agent page with a stand-in model: a local OpenAI-format stub answers, the tools read live data,
// the session is minted with a throwaway key and the wallet is a stand-in that only reports an address.
// node scripts/agent-review.mjs [1366x768 390x844 ...]
import http from 'node:http';
import { createServer } from 'vite';
import { launch } from './browser.mjs';

const ACCOUNT = '0x00000000000000000000000000000000000c0ffe';
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw), msgs = body.messages, last = msgs.at(-1), ask = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (last.role !== 'tool') {
      const call = /plan|withdraw/i.test(ask)
        ? { name: 'check_withdrawal', arguments: JSON.stringify({ token: 'eth', amount: '0.137', deposit_amount: '0.137', hours_since_deposit: 1, to_new_address: false }) }
        : { name: 'heat_board', arguments: JSON.stringify({ limit: 6 }) };
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_' + msgs.length, function: call }] } }] });
    } else {
      const out = JSON.parse(last.content);
      const text = out.tokens ? `The board reads ${out.board.tokens} tokens with a median of ${out.board.medianKelvin.toLocaleString('en-US')} K. The hottest right now:\n\n${out.tokens.slice(0, 5).map((t) => `- **${t.symbol}** ${t.kelvin.toLocaleString('en-US')} K, ${t.trades1h} trades in the last hour, ${t.buyShare1h}% buys`).join('\n')}\n\nHot means busy, not good. Each one opens on its token page.`
        : out.checks ? `That plan stands out: trail ΔT ${out.deltaK == null ? 'blocked' : '+' + out.deltaK + ' K'}. ${out.passed} of ${out.of} checks pass.\n\n- Withdrawing the same amount you deposited pairs the two\n- One hour after the deposit is too soon\n- Your own wallet links them directly\n\nWithdraw a round amount like 0.1 ETH a day later to a fresh address. These are rules of thumb, not a guarantee.`
        : `The reading failed: ${out.error || 'unknown'}.`;
      for (const part of text.match(/.{1,24}/gs)) send({ choices: [{ delta: { content: part } }] });
      send({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 120 } });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.AGENT_API_URL = `http://127.0.0.1:${stub.address().port}/v1`;
process.env.AGENT_API_KEY = 'review-only-throwaway-key';
const vite = await createServer({ server: { port: 5597, strictPort: true, hmr: false }, logLevel: 'warn' });
await vite.listen();
const { issueToken, readToken } = await import('../server/agent.js');
const token = issueToken(ACCOUNT), session = JSON.stringify({ account: ACCOUNT, token, expiresAt: readToken(token).expiresAt });

const sizes = process.argv.slice(2).filter((a) => /^\d+x\d+$/.test(a)).map((a) => a.split('x').map(Number));
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  for (const [w, h] of sizes.length ? sizes : [[1366, 768], [390, 844]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
    const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await p.addInitScript(([account, s]) => {
      localStorage.setItem('kelvo.wallet.v1', 'injected');
      sessionStorage.setItem('kelvo.agent.session.v1', s);
      // stand-in wallet: reports one address on Robinhood Chain and refuses everything else
      window.ethereum = { request: async ({ method }) => method === 'eth_accounts' || method === 'eth_requestAccounts' ? [account] : method === 'eth_chainId' ? '0x1237' : Promise.reject(Object.assign(new Error('stand-in wallet'), { code: 4200 })), on() {}, removeListener() {} };
    }, [ACCOUNT, session]);
    await p.goto('http://localhost:5597/agent', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(3500);
    await p.screenshot({ path: `artifacts/shots/agent-empty-${w}.png` });
    for (const [i, q] of ['What are the five hottest tokens right now?', 'Check my plan: deposit 0.137 ETH, withdraw it in an hour to my own wallet'].entries()) {
      await p.fill('#kv-ag-input', q); await p.keyboard.press('Enter');
      await p.waitForFunction((n) => document.querySelectorAll('.kv-ag-turn.agent .kv-ag-prose').length >= n && !document.querySelector('.kv-ag-mark.live'), i + 1, { timeout: 60000 }).catch(() => errs.push('answer ' + (i + 1) + ' timed out'));
      await p.waitForTimeout(2200);
      await p.screenshot({ path: `artifacts/shots/agent-answer${i + 1}-${w}.png` });
      console.log(w, 'answer', i + 1, await p.evaluate(() => ({ y: Math.round(scrollY), view: innerHeight, doc: document.documentElement.scrollHeight })));
    }
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    console.log(w, over > 0 ? 'overflow ' + over + 'px' : 'no overflow', '|', errs.length ? 'errors: ' + errs.join(' | ').slice(0, 400) : 'no errors');
    await p.close();
  }
} finally { await b.close(); await vite.close(); stub.close(); process.exit(0); }
