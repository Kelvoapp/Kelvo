// Audit every page at 1366x768 and 390x844: console errors, horizontal overflow, the main keys hit-tested where they sit,
// then a reduced-motion pass and a pass without WebGL (the bloom must fall back to the logo).
// CHECK_URL=<site> node scripts/browser-check.mjs   (defaults to the dev server)
import { launch } from './browser.mjs';
import { PRIVATE_NAMES } from '../tests/private-names.mjs';

const base = (process.env.CHECK_URL || 'http://localhost:5596').replace(/\/$/, '');
const heat = await fetch(base + '/api/heat').then((r) => r.json()).catch(() => null);
const hottest = heat?.tokens?.[0]?.address;
const pages = ['/', '/heat', hottest ? '/token/' + hottest : null, '/agent', '/cold', '/launch', '/kelvo', '/docs', '/nowhere'].filter(Boolean);
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
let failed = 0;
const fail = (msg) => { failed++; console.log('  FAIL ' + msg); };

async function audit(path, [w, h], opts = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, reducedMotion: opts.reduce ? 'reduce' : 'no-preference' });
  const p = await ctx.newPage();
  if (opts.noGl) await p.addInitScript(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...a) { return /webgl/.test(type) ? null : get.call(this, type, ...a); }; });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(favicon|404)/.test(m.text())) errs.push(m.text()); });
  await p.goto(base + path, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  const tag = `${path} ${w}${opts.reduce ? ' reduced' : ''}${opts.noGl ? ' no-webgl' : ''}`;
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  if (over > 0) fail(`${tag}: overflows by ${over}px`);
  // every visible key in the first screen must be the element under its own centre
  const blocked = await p.evaluate(() => [...document.querySelectorAll('.kv-key, .kv-wallet, .kv-ag-send, .privacy-button')].filter((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit && !el.contains(hit);
  }).map((el) => el.textContent.trim().slice(0, 30)));
  if (blocked.length) fail(`${tag}: covered keys ${blocked.join(', ')}`);
  if (opts.noGl) {
    const fallback = await p.evaluate(() => { const c = document.querySelector('.kv-bloom-canvas'); if (!c) return 'none'; const img = c.nextElementSibling; return c.dataset.failed && img && getComputedStyle(img).display !== 'none' ? 'ok' : 'missing'; });
    if (fallback === 'missing') fail(`${tag}: the bloom has no fallback`);
  }
  if (errs.length) fail(`${tag}: ${errs.join(' | ').slice(0, 300)}`);
  console.log(`ok ${tag}${over > 0 || blocked.length || errs.length ? ' (with failures above)' : ''}`);
  await ctx.close();
}

for (const path of pages) for (const size of [[1366, 768], [390, 844]]) await audit(path, size);
for (const path of ['/', '/agent', '/cold']) { await audit(path, [1366, 768], { reduce: true }); await audit(path, [1366, 768], { noGl: true }); }
// the copy never names a data vendor, a model host, the chain id or a sibling project
const html = await (await b.newPage()).goto(base + '/docs').then(async (r) => (await r.text()));
for (const word of ['GeckoTerminal', 'DexScreener', '4663', ...PRIVATE_NAMES]) if (html.includes(word)) fail('docs html names ' + word);
await b.close();
console.log(failed ? `${failed} failure(s)` : 'all checks passed');
process.exit(failed ? 1 : 0);
