// The cold side in withdraw mode with a plan typed in, to review the trail ΔT. Nothing is connected or signed.
import { launch } from './browser.mjs';
const base = process.env.BASE_URL || 'http://localhost:5596';
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [w, h] of [[1366, 768], [390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(base + '/cold', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.getByRole('button', { name: 'Withdraw' }).click();
  await p.fill('input[aria-label="Payment amount"]', '0.137');
  await p.fill('input[aria-label="Recipient wallet"]', '0x3333333333333333333333333333333333333333');
  await p.getByLabel('Deposited').fill('0.137');
  await p.getByLabel('Hours since deposit').fill('2');
  await p.waitForTimeout(2500);
  await p.screenshot({ path: `artifacts/shots/cold-trail-top-${w}.png` });
  await p.locator('.kv-trail').scrollIntoViewIfNeeded(); await p.waitForTimeout(600);
  await p.screenshot({ path: `artifacts/shots/cold-trail-${w}.png` });
  const read = await p.locator('.kv-cold-read b').textContent();
  const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(w, 'ΔT', read, over > 0 ? 'overflow ' + over : 'no overflow', errs.length ? 'errors: ' + errs.join(' | ').slice(0, 300) : 'no errors');
  await p.close();
}
await b.close();
