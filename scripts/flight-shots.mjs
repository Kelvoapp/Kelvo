// One screenshot per chapter pose: node scripts/flight-shots.mjs [w]x[h]
import { launch } from './browser.mjs';
const [w, h] = (process.argv[2] || '1366x768').split('x').map(Number);
const base = process.env.BASE_URL || 'http://localhost:5596';
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto(base + '/', { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(5000);
const poses = await p.evaluate(() => [...document.querySelectorAll('section[data-pose]')].map((el) => ({ name: el.dataset.pose, y: el.offsetTop + el.offsetHeight / 2 - innerHeight / 2 })));
for (const { name, y } of poses) {
  await p.evaluate((v) => scrollTo(0, v), Math.max(0, y)); await p.waitForTimeout(2200);
  await p.screenshot({ path: `artifacts/shots/flight-${name}-${w}.png` });
}
const over = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
console.log('poses', poses.map((x) => x.name).join(' '), '| overflow', over, '|', errs.length ? errs.join(' | ').slice(0, 300) : 'no errors');
await b.close();
