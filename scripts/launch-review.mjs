// Review the launch flow end to end without moving anything: a throwaway provenance secret held in memory, a stand-in
// wallet that reports one funded address (simulation only) and refuses to send, Vite in-process on the allowed port 5597.
// node scripts/launch-review.mjs [1366x768 390x844]
import { randomBytes } from 'node:crypto';
import { createServer } from 'vite';
import { launch } from './browser.mjs';

process.env.KELVO_INTENT_SECRET = randomBytes(32).toString('hex');
const ACCOUNT = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'; // a funded address, used only as the dry-run sender
const vite = await createServer({ server: { port: 5597, strictPort: true, hmr: false }, logLevel: 'warn' });
await vite.listen();
console.log('vite listening');
const sizes = process.argv.slice(2).filter((a) => /^\d+x\d+$/.test(a)).map((a) => a.split('x').map(Number));
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  for (const [w, h] of sizes.length ? sizes : [[1366, 768], [390, 844]]) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
    const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
    await p.addInitScript((account) => {
      localStorage.setItem('kelvo.wallet.v1', 'injected');
      localStorage.removeItem('kelvo.launch-draft.v1');
      window.ethereum = { request: async ({ method }) => method === 'eth_accounts' || method === 'eth_requestAccounts' ? [account] : method === 'eth_chainId' ? '0x1237' : Promise.reject(Object.assign(new Error('Request cancelled in the wallet.'), { code: 4001 })), on() {}, removeListener() {} };
    }, ACCOUNT);
    await p.goto('http://localhost:5597/launch', { waitUntil: 'domcontentloaded' });
    console.log(w, 'page loaded');
    await p.waitForTimeout(3000);
    await p.getByPlaceholder('Kelvin Coin').fill('Kelvo Review');
    await p.getByPlaceholder('KELV', { exact: true }).fill('KVRW');
    await p.getByPlaceholder('https://…/logo.png').fill('https://kelvo.vercel.app/brand/kelvo-512.png');
    await p.getByPlaceholder('One or two plain sentences about the token.').fill('A review launch that is never sent.');
    await p.getByPlaceholder('How its agent talks, what it cares about, what it never says.').fill('Speaks in temperatures. Never gives price targets.');
    await p.getByRole('button', { name: '0.001 ETH' }).click();
    console.log(w, 'form filled');
    await p.getByRole('button', { name: /Review the launch/ }).click({ timeout: 45000 });
    console.log(w, 'review clicked');
    await p.waitForSelector('.kv-ln-checked, .kv-ln-note.warn', { timeout: 60000 }).catch(() => {});
    const checked = await p.locator('.kv-ln-checked').textContent().catch(() => null);
    const warn = await p.locator('.kv-ln-note.warn').allTextContents();
    await p.locator('.kv-ln-side').scrollIntoViewIfNeeded();
    await p.screenshot({ path: `artifacts/shots/launch-review-${w}.png` });
    if (checked) { await p.getByRole('button', { name: /Sign the launch/ }).click(); await p.waitForTimeout(1500); }
    const after = await p.locator('.kv-ln-note.warn').allTextContents();
    const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    console.log(w, '| prepared:', checked ? checked.slice(0, 160) : 'no', '| warnings:', warn.join(' / ') || 'none', '| after sign:', after.join(' / ') || 'none', '|', over > 0 ? 'overflow ' + over : 'no overflow', '|', errs.length ? 'errors: ' + errs.join(' | ').slice(0, 300) : 'no errors');
    await p.close();
  }
} finally { await b.close(); await vite.close(); process.exit(0); }
