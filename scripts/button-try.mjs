// Try a button stylesheet on the real pages without touching the source: the CSS is injected after load and each page
// is shot where its keys sit, at 1366x768 and 390x844, plus hover and focus shots of the main keys.
// node scripts/button-try.mjs <css file or "none"> <out dir>
import { launch } from './browser.mjs';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const [cssArg = 'none', outArg = 'artifacts/buttons/try'] = process.argv.slice(2);
const css = cssArg === 'none' ? null : resolve(cssArg), out = resolve(outArg);
mkdirSync(out, { recursive: true });
const base = process.env.BASE_URL || 'http://localhost:5596';
const heat = await fetch(base + '/api/heat').then((r) => r.json()).catch(() => null);
const token = heat?.tokens?.[0]?.address || '0xba1a2d9783ebe2b76493c5c12eb9813a0e062843';
// [path, name, element to bring into view (or null for the first screen)]
const SHOTS = [
  ['/', 'home', null],
  ['/', 'home-end', '.kv-ch-end'],
  ['/launch', 'launch', '.kv-ln-go'],
  ['/launch', 'launch-chips', '.kv-ln-chips'],
  ['/cold', 'cold', '.privacy-form-actions'],
  ['/cold', 'cold-side', '.privacy-sidebar .privacy-button'],
  ['/token/' + token, 'token', '.kv-buy'],
  ['/heat', 'heat', '.kv-heat-tools'],
  ['/kelvo', 'kelvo', '.kv-kelvo-copy .kv-keys'],
];
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const files = [];
for (const [w, h] of [[1366, 768], [390, 844]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
  for (const [path, name, sel] of SHOTS) {
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(base + path, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3200);
    if (css) await p.addStyleTag({ path: css });
    if (sel) { await p.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {}); await p.evaluate(() => scrollBy(0, -120)); }
    await p.waitForTimeout(700);
    const file = `${out}/${name}-${w}.png`;
    await p.screenshot({ path: file }); files.push(file);
    if (w === 1366 && (name === 'home' || name === 'launch' || name === 'cold')) {
      const key = name === 'home' ? '.kv-first .kv-key' : name === 'launch' ? '.kv-ln-go' : '.privacy-form-actions .privacy-button';
      await p.locator(key).first().hover().catch(() => {}); await p.waitForTimeout(450);
      await p.screenshot({ path: `${out}/${name}-hover-${w}.png` }); files.push(`${out}/${name}-hover-${w}.png`);
      if (name === 'home') {
        await p.mouse.move(5, 760); await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
        await p.locator('.kv-first .kv-key').first().focus().catch(() => {}); await p.waitForTimeout(300);
        await p.screenshot({ path: `${out}/home-focus-${w}.png` }); files.push(`${out}/home-focus-${w}.png`);
        await p.locator('.kv-tuner .kv-wallet').hover().catch(() => {}); await p.waitForTimeout(400);
        await p.screenshot({ path: `${out}/tuner-hover-${w}.png`, clip: { x: 200, y: 0, width: 966, height: 90 } }); files.push(`${out}/tuner-hover-${w}.png`);
      }
    }
    if (errs.length) console.log('page error on', path, errs[0].slice(0, 160));
    await p.close();
  }
  await ctx.close();
}
await b.close();
console.log(files.join('\n'));
