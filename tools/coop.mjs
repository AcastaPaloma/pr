// Two-pilot smoke test against the dev server's mock room: node tools/coop.mjs outDir
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium; try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
const log = (n) => (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/deprecated with r150|GPU stall|ERR_|Failed to load resource/.test(m.text())) console.log(`[${n} ${m.type()}]`, m.text().slice(0, 400)); };
const A = await ctx.newPage(), B = await ctx.newPage();
A.on('console', log('A')); B.on('console', log('B'));
A.on('pageerror', (e) => console.log('[A pageerror]', String(e.stack || e).slice(0, 600)));
B.on('pageerror', (e) => console.log('[B pageerror]', String(e.stack || e).slice(0, 600)));
const url = (process.env.BW_BASE || 'http://localhost:8080/') + '?mock';
await A.goto(url); await B.goto(url);
await A.waitForFunction('window.__ready === true', null, { timeout: 60000 });
await B.waitForFunction('window.__ready === true', null, { timeout: 60000 });
await A.bringToFront();
await A.click('[data-act="host"]');
const code = await A.textContent('#code');
console.log('host code', code);
await B.bringToFront();
await B.waitForTimeout(1500);
await B.click('[data-act="join"]');
await B.waitForSelector('[data-act^="joincode:"]', { timeout: 15000 });
await B.click('[data-act^="joincode:"]');
await B.waitForTimeout(1500);
await A.bringToFront();
await A.waitForTimeout(1500);
console.log('A menu:', (await A.textContent('#menuCol')).slice(0, 120));
await A.click('[data-act="deploy"]');
await A.evaluate(`BW.Game.fixedRes = true; const D = BW.Game.debug; D.advance(3); D.sim.queue.length = 0; const k = D.spawn('bruiser','mech',-330,125); D.setAI(k,'hold'); k.yaw = Math.PI/2; k.atkCd = 99; 1`);
await A.waitForTimeout(1500);
await B.bringToFront();
await B.waitForTimeout(3000);
console.log('B after deploy:', await B.evaluate(`({phase: BW.Game.sim.phase, role: BW.Net.role, linked: BW.Net.linked, k: BW.Game.sim.kaijus.map(k => [k.key, k.anim, Math.round(k.x)]), mech: [Math.round(BW.Game.sim.mech.x), Math.round(BW.Game.sim.mech.z)], bytes: window.__presenceBytes})`));
// co-pilot punches (right arm) and charges the cannon
await B.keyboard.press('KeyK');
await B.waitForTimeout(1200);
await A.bringToFront(); await A.waitForTimeout(1500);
console.log('A after co punch:', await A.evaluate(`({R: BW.Game.sim.mech.R.state, hp: Math.round(BW.Game.sim.kaijus[0].hp), linked: BW.Net.linked, bytes: window.__presenceBytes, combo: BW.Game.sim.mech.combo})`));
await A.screenshot({ path: out + '/coA.png' });
await B.bringToFront(); await B.waitForTimeout(1500);
console.log('B hud:', await B.evaluate(`({hpFrac: BW.Game.sim.kaijus[0] && BW.Game.sim.kaijus[0].hpFrac, crew: document.getElementById('crew').textContent, sync: document.getElementById('syncLabel').textContent})`));
await B.screenshot({ path: out + '/coB.png' });
// host leaves -> co-pilot returns to the hangar
await A.close();
await B.waitForTimeout(7000);
console.log('B after host left:', await B.evaluate(`({phase: BW.Game.sim.phase, role: BW.Net.role, menu: document.getElementById('menuCol').textContent.slice(0, 160)})`));
await browser.close();
