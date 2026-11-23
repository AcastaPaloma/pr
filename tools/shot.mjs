// Screenshot a page of the dev server in headless Chromium (software WebGL).
//   node tools/shot.mjs "<path?query>" out.png [--w 1280] [--h 720] [--wait 800] [--eval "js"] [--touch]
// Waits for window.__ready === true (set by the page after it has rendered a few frames), runs the
// optional --eval snippet in the page, waits --wait ms more, then captures. Console errors are printed.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2);
const url = args[0], out = args[1];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1280), H = +opt('h', 720), wait = +opt('wait', 800);
const base = process.env.BW_BASE || 'http://localhost:8080/';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: args.includes('--touch') });
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/deprecated with r150|GPU stall/.test(m.text())) console.log(`[${m.type()}]`, m.text().slice(0, 600)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e.stack || e).slice(0, 900)));
await page.goto(new URL(url, base).href);
try { await page.waitForFunction('window.__ready === true', null, { timeout: +opt('timeout', 45000) }); }
catch { console.log('[shot] __ready never became true'); }
const ev = opt('eval', null);
if (ev) { const r = await page.evaluate(ev); if (r !== undefined) console.log('[eval]', JSON.stringify(r)); }
await page.waitForTimeout(wait);
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
