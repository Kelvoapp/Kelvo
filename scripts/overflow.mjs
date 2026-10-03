// Which elements stick out past the viewport on a page: node scripts/overflow.mjs <path> [width]
import { launch } from './browser.mjs';
const [path = '/', width = '390'] = process.argv.slice(2);
const b = await launch();
const p = await b.newPage({ viewport: { width: Number(width), height: 844 } });
await p.goto((process.env.BASE_URL || 'http://localhost:5596') + path, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(9000); console.log('scrollWidth over', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth));
console.log(JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map((el) => ({ el: el.tagName.toLowerCase() + '.' + [...el.classList].join('.'), right: Math.round(el.getBoundingClientRect().right), w: Math.round(el.getBoundingClientRect().width), text: el.textContent.trim().slice(0, 40) }))), null, 1));
await b.close();
