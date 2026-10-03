// The market desk once its feeds have landed: the first view, the desk with the inspector and the tape, the table, and phones.
import { launch } from './browser.mjs';
const base = process.env.BASE_URL || 'http://localhost:5596';
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [w, h] of [[1366, 768], [390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(base + '/heat', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.kv-tape-rail li a', { timeout: 30000 }).catch(() => errs.push('tape never filled'));
  await p.waitForSelector('.kv-insp .kf-day', { timeout: 30000 }).catch(() => errs.push('day chart never drew'));
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `artifacts/shots/heat-v2-top-${w}.png` });
  await p.locator('.kv-desk').scrollIntoViewIfNeeded(); await p.evaluate(() => scrollBy(0, -90)); await p.waitForTimeout(700);
  await p.screenshot({ path: `artifacts/shots/heat-v2-desk-${w}.png` });
  if (w > 600) { await p.locator('.kv-desk-side').scrollIntoViewIfNeeded(); await p.evaluate(() => scrollBy(0, 120)); await p.waitForTimeout(500); await p.screenshot({ path: `artifacts/shots/heat-v2-side-${w}.png` }); }
  await p.locator('.kv-readings').scrollIntoViewIfNeeded(); await p.evaluate(() => scrollBy(0, -60)); await p.waitForTimeout(500);
  await p.screenshot({ path: `artifacts/shots/heat-v2-table-${w}.png` });
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(w, over > 0 ? 'overflow ' + over : 'no overflow', '|', errs.length ? errs.join(' | ').slice(0, 300) : 'no errors');
  await p.close();
}
await b.close();
