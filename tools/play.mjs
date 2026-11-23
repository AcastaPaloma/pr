// Scripted play-through for screenshots: node tools/play.mjs outDir [--w 1280 --h 720] [--mock]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pwPath = (() => { try { return require.resolve('playwright'); } catch { return '/opt/node-tools/node_modules/playwright'; } })();
const { chromium, devices } = require(pwPath);
const args = process.argv.slice(2), out = args[0];
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1280), H = +opt('h', 720);
const steps = JSON.parse(opt('steps', '[]'));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const dev = opt('device', null);
let ctxOpts = { viewport: { width: W, height: H }, deviceScaleFactor: 1, hasTouch: args.includes('--touch') };
if (dev) { ctxOpts = Object.assign({}, devices[dev]); delete ctxOpts.defaultBrowserType; if (args.includes('--landscape')) ctxOpts.viewport = { width: ctxOpts.viewport.height, height: ctxOpts.viewport.width }; }
const page = await browser.newPage(ctxOpts);
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/deprecated with r150|GPU stall|ERR_|Failed to load resource/.test(m.text())) console.log(`[${m.type()}]`, m.text().slice(0, 500)); });
page.on('pageerror', (e) => console.log('[pageerror]', String(e.stack || e).slice(0, 900)));
await page.goto((process.env.BW_BASE || 'http://localhost:8080/') + (args.includes('--mock') ? '?mock' : ''));
await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
for (const [name, js, wait] of steps) {
  const r = await page.evaluate(js);
  if (r !== undefined && r !== null) console.log(`[${name}]`, JSON.stringify(r));
  await page.waitForTimeout(wait || 700);
  if (name[0] !== '_') await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
