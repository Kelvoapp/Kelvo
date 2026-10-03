// Review screenshots with the GPU on (the bloom is a shader): node scripts/shots.mjs <path> <name> [w,h ...] [--hover x,y] [--scroll px]
import { launch } from './browser.mjs';
const args = process.argv.slice(2), path = args[0] || '/', name = args[1] || 'home';
const sizes = args.filter((a) => /^\d+x\d+$/.test(a)).map((a) => a.split('x').map(Number));
const hover = args.includes('--hover') ? args[args.indexOf('--hover') + 1].split(',').map(Number) : null;
const scroll = args.includes('--scroll') ? Number(args[args.indexOf('--scroll') + 1]) : 0;
const base = process.env.BASE_URL || 'http://localhost:5596';
const b = await launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const [w, h] of sizes.length ? sizes : [[1366, 768], [390, 844]]) {
  const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 600 ? 2 : 1 });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await p.goto(base + path, { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(4500);
  if (scroll) { await p.evaluate((y) => scrollTo(0, y), scroll); await p.waitForTimeout(1600); }
  if (hover) { await p.mouse.move(hover[0], hover[1]); await p.waitForTimeout(900); }
  const out = `artifacts/shots/${name}-${w}.png`;
  await p.screenshot({ path: out });
  const fam = await p.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family).filter((v, i, a) => a.indexOf(v) === i).join(', '));
  console.log(out, '| fonts:', fam, '|', errs.length ? 'errors: ' + errs.join(' | ').slice(0, 300) : 'no errors');
  await p.close();
}
await b.close();
