/* BREAKWATER — game: simulation (host-authoritative), co-pilot replica, camera, HUD, menus, main loop. */
(function () {
  'use strict';
  const T = THREE, BW = window.BW;
  const { clamp, lerp, damp, dampAng, angDiff, smooth } = BW;
  const G = (BW.Game = {});
  const $ = (id) => document.getElementById(id);
  const Net = BW.Net, A = BW.Audio;
  const ARM = ['idle', 'punch', 'block', 'slam', 'charge', 'fire'];
  const SPK = ['bruiser', 'crawler', 'spitter'];
  const PLASMA = new T.Color(0.35, 0.8, 1.0), BILE = new T.Color(0.55, 1.0, 0.15);
  const HULL_MAX = 1000;
  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
  const rnd = Math.random;

  let renderer, scene, fxScene, camera, post, fx, W, O, mechM, input, lights, flashLight, glowLight;
  let KS, KD, MD;                         // kaiju states / durations, mech durations
  let last = 0, simTime = 0, wallTime = 0, hitstop = 0, trauma = 0, hitFlash = 0, glitch = 0, viewMode = 'fp', resScale = 1, frameAvg = 16, resTimer = 0;
  let lightningT = 12, thunderAt = -1, bannerUntil = 0, comboUntil = 0, hudTick = 0, netTick = 0, menuKind = '', hintUntil = 0;
  const v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3(), camVel = new T.Vector3(), lastCam = new T.Vector3();
  const pool = {};                        // species key -> spare models
  const co = { yaw: 0, pitch: 0, rp: 0, sl: 0, fr: 0, f: 0, b: 0, seen: null, lastN: -1, lastEv: 0, wasLinked: false, charge: 0 };

  const sim = (G.sim = {
    phase: 'title', paused: false, wave: 0, waveState: 'idle', waveT: 0, queue: [], score: 0, kills: 0, city: 100, sync: 0, syncStrike: false,
    overReason: '', kaijus: [], shots: [], events: [], evSeq: 0, nextId: 1, lastArm: 0,
    mech: null,
  });
  function newMech() {
    return { x: -250, z: 120, yaw: -Math.PI / 2, aim: -Math.PI / 2, pitch: 0, vx: 0, vz: 0, hull: HULL_MAX, energy: 100, turn: 0,
      L: { state: 'idle', t: 0, hit: false }, R: { state: 'idle', t: 0, hit: false }, charge: 0, block: false, dashT: 0, dashCd: 0, stagger: 0, combo: 0, comboT: 0, acid: 0 };
  }
  sim.mech = newMech();

  // ===================================================================================== events
  // Everything audible / visible that happens at a moment goes through here, on the host as it happens
  // and on the co-pilot when the snapshot delivers it.
  function emit(kind, a, b, c, d, e) {
    const ev = [++sim.evSeq, kind, r1(a || 0), r1(b || 0), r1(c || 0), r1(d || 0), r1(e || 0)];
    sim.events.push(ev);
    if (sim.events.length > 14) sim.events.shift();
    playEvent(ev);
  }
  function hear(x, z) {                    // -> {pan, gain} relative to the camera
    const dx = x - camera.position.x, dz = z - camera.position.z, d = Math.hypot(dx, dz) || 1;
    const a = cameraYaw();
    return { pan: clamp((dx * -Math.cos(a) + dz * Math.sin(a)) / d, -1, 1) * Math.min(1, d / 60), gain: clamp(1.15 - d / 1700, 0.12, 1) };
  }
  function kById(id) { for (const k of sim.kaijus) if (k.id === id) return k; return null; }
  function banner(main, sub, secs) {
    $('bannerMain').textContent = main; $('bannerSub').textContent = sub || '';
    $('banner').classList.add('show'); bannerUntil = wallTime + (secs || 3.2);
  }
  function playEvent(ev) {
    const k = ev[1], a = ev[2], b = ev[3], c = ev[4], d = ev[5], e = ev[6], m = sim.mech;
    switch (k) {
      case 'hit': {
        const kj = kById(d), col = kj ? kj.glow : BILE, pw = e || 1;
        const dx = a - m.x, dz = c - m.z, l = Math.hypot(dx, dz) || 1;
        fx.ichor(a, b, c, dx / l, 0.4, dz / l, col, 14 + pw * 10, 0.8 + pw * 0.35);
        fx.sparks(a, b, c, -dx / l, 0.3, -dz / l, 8 + pw * 6, 0.8);
        fx.flash(a, b, c, 26 + pw * 16, col.r * 5 + 2, col.g * 5 + 2, col.b * 5 + 2, 0.18);
        fx.mist(a, b, c, 30, 0.3);
        if (kj && kj.model) kj.model.flash(1);
        const h = hear(a, c);
        A.play(pw >= 2 ? 'slam' : 'impact', h);
        trauma = Math.min(1, trauma + 0.3 + pw * 0.14); hitstop = 0.05 + pw * 0.035;
        O.setGlow(a, c, 70, 0.8, col); glowPulse = 1;
        break;
      }
      case 'whoosh': A.play('punch', { pan: a * 0.45 }); break;
      case 'mhit': {
        if (b) { A.play('block', {}); trauma = Math.min(1, trauma + 0.3); }
        else { A.play('hurt', {}); trauma = Math.min(1, trauma + 0.75); hitFlash = 1; glitch = 0.6; }
        mechM.eye.getWorldPosition(v1);
        const ya = cameraYaw() + c;
        fx.sparks(v1.x + Math.sin(ya) * 9, v1.y - 2, v1.z + Math.cos(ya) * 9, -Math.sin(ya), 0.2, -Math.cos(ya), b ? 26 : 16, 0.35, 0.16);
        break;
      }
      case 'roar': { const h = hear(a, b); h.size = c; A.play('roar', h); trauma = Math.min(1, trauma + 0.18 * h.gain); break; }
      case 'growl': { const h = hear(a, b); h.size = c; A.play('growl', h); break; }
      case 'emerge': {
        fx.splash(a, b, 3.2, 44); fx.splash(a + 20, b - 15, 2.2, 22); bigSplash(a, b, 110);
        A.play('emerge', hear(a, b));
        const sp = BW.Kaiju.SPECIES[SPK[c | 0]];
        if (sp) banner(sp.name + ' surfacing', sp.cls + ' · bearing ' + bearingTo(a, b) + '°', 3.4);
        break;
      }
      case 'splash': fx.splash(a, b, c || 1, 20); A.play('splash', hear(a, b)); break;
      case 'spit': A.play('spit', hear(a, c)); fx.flash(a, b, c, 30, 1.5, 3.5, 0.4, 0.2); break;
      case 'acid': m.acid = 1; A.play('acidHit', {}); break;
      case 'shot': A.play('cannon', {}); fx.flash(a, b, c, 46, 3, 7, 9, 0.16); flash(a, b, c, 1.0); trauma = Math.min(1, trauma + 0.22); break;
      case 'burst': {
        fx.burst(a, b, c, d === 2 ? BILE : PLASMA, 13, 22);
        if (d !== 2) { A.play('plasmaHit', hear(a, c)); flash(a, b, c, 1.4); }
        if (b < 4) { fx.splash(a, c, 1.6, 22); bigSplash(a, c, 50); }
        break;
      }
      case 'kill': {
        const h = hear(a, b); h.size = c; A.play('kill', h);
        bigSplash(a, b, 130);
        banner('Leviathan down', sim.kaijus.filter((q) => q.ai !== 'death').length ? 'More contacts in the bay' : 'Scanning the Gate', 3);
        break;
      }
      case 'wave': A.play('klaxon', {}); banner('Wave ' + (a | 0), (b | 0) + (b > 1 ? ' contacts' : ' contact') + ' inbound through the Golden Gate', 4.2); break;
      case 'clear': A.play('victory', {}); banner('Bay secure', 'Wave ' + (a | 0) + ' repelled · hull patched', 4); break;
      case 'city': {
        W.damageCity(a, b, 10, 1);
        const y = W.terrainH(a, b);
        fx.fireball(a, y + 14, b, 26); fx.smoke(a, y + 20, b, 30, 5, 0.03); fx.addFire(a, y + 4, b);
        A.play('cityHit', hear(a, b));
        break;
      }
      case 'sync': A.play('sync', {}); $('combo').textContent = 'Sync strike'; $('combo').classList.add('show'); comboUntil = wallTime + 1.6; break;
      case 'dash': A.play('dash', {}); break;
      case 'over': A.play('defeat', {}); break;
    }
  }
  let glowPulse = 0;
  const splashes = [{ x: 0, z: 0, r: 1, t: 9 }, { x: 0, z: 0, r: 1, t: 9 }];
  let splashIdx = 0;
  function bigSplash(x, z, r) { const s = splashes[splashIdx++ % 2]; s.x = x; s.z = z; s.r = r; s.t = 0; }
  function flash(x, y, z, power) { flashLight.position.set(x, y, z); flashLight.userData.p = power; }
  function bearingTo(x, z) {
    const m = sim.mech; let b = (Math.atan2(x - m.x, -(z - m.z)) * 180) / Math.PI;
    if (b < 0) b += 360; return String(Math.round(b)).padStart(3, '0');
  }

  // ===================================================================================== kaiju entities
  function acquire(key) {
    const list = pool[key] || (pool[key] = []);
    return list.pop() || BW.Kaiju.create(key, (rnd() * 1e6) | 0);
  }
  function addKaiju(id, key) {
    const sp = BW.Kaiju.SPECIES[key];
    const k = { id, key, sp, spIdx: SPK.indexOf(key), model: acquire(key), glow: new T.Color(sp.glow), x: 0, z: 0, yaw: 0, hp: sp.hp, maxHp: sp.hp, hpFrac: 1,
      ai: 'swim', t: 0, anim: 'swim', at: 0, next: 'swipeL', look: 0, gait: 1, poise: sp.hp * 0.22, target: 'mech', cityPt: null, emergeAt: [0, 0], atkCd: 1.5, hold: 0.5,
      hitDone: false, kvx: 0, kvz: 0, roars: false, tx: 0, tz: 0, tyaw: 0, shed: 0 };
    scene.add(k.model.group);
    sim.kaijus.push(k);
    return k;
  }
  function removeKaiju(k) {
    scene.remove(k.model.group);
    (pool[k.key] || (pool[k.key] = [])).push(k.model);
    const i = sim.kaijus.indexOf(k);
    if (i >= 0) sim.kaijus.splice(i, 1);
  }
  function setAI(k, ai, next) {
    k.ai = ai; k.t = 0; k.hitDone = false;
    if (next) k.next = next;
    const anim = ai === 'approach' ? 'walk' : ai === 'hold' || ai === 'recover' ? 'idle' : ai === 'attack' ? k.next : ai;
    if (anim !== k.anim || ai === 'attack' || ai === 'stagger') { k.anim = anim; k.at = 0; }
  }

  // ===================================================================================== host simulation
  function resetSim() {
    for (const k of sim.kaijus.slice()) removeKaiju(k);
    sim.shots.length = 0; sim.events.length = 0; sim.queue.length = 0;
    sim.mech = newMech();
    sim.wave = 0; sim.waveState = 'idle'; sim.waveT = 0; sim.score = 0; sim.kills = 0; sim.city = 100; sim.sync = 0; sim.overReason = '';
    W.resetCity(); fx.clearFires();
    trauma = hitFlash = glitch = 0;
  }
  function startWave(n) {
    sim.wave = n; sim.waveState = 'fight';
    let comp;
    if (n === 1) comp = [['bruiser', 'mech']];
    else if (n === 2) comp = [['crawler', 'mech'], ['bruiser', 'city']];
    else if (n === 3) comp = [['spitter', 'mech'], ['crawler', 'city'], ['bruiser', 'mech']];
    else { comp = []; const c = Math.min(4, 2 + Math.floor(n / 2)); for (let i = 0; i < c; i++) comp.push([SPK[(rnd() * 3) | 0], i === 1 ? 'city' : 'mech']); }
    sim.queue = comp.map((q, i) => ({ key: q[0], target: q[1], at: 2.5 + i * 5.5 }));
    sim.waveT = 0;
    emit('wave', n, comp.length);
  }
  function spawn(key, target, x, z) {
    const k = addKaiju(sim.nextId++, key);
    k.hp = k.maxHp = k.sp.hp * (1 + 0.14 * Math.max(0, sim.wave - 1));
    k.poise = k.maxHp * 0.22;
    k.target = target;
    const m = sim.mech;
    k.x = x === undefined ? -1950 - rnd() * 150 : x; k.z = z === undefined ? (rnd() - 0.5) * 700 : z;
    if (target === 'city') {
      k.cityPt = W.shoreTargets[(rnd() * W.shoreTargets.length) | 0];
      k.emergeAt = [clamp(k.cityPt[0] - 250, -1350, 1500), k.cityPt[1] - 420 - rnd() * 120];
    } else {
      // surface a few hundred metres off the pilot, on the Gate side
      const a = Math.atan2(k.x - m.x, k.z - m.z) + (rnd() - 0.5) * 0.7, d = 430 + rnd() * 160;
      k.emergeAt = [clamp(m.x + Math.sin(a) * d, -1380, 2200), clamp(m.z + Math.cos(a) * d, -600, 620)];
      for (let i = 0; i < 6 && W.terrainH(k.emergeAt[0], k.emergeAt[1]) > -15; i++) k.emergeAt[0] -= 90;
    }
    k.yaw = BW.yawTo(k.x, k.z, k.emergeAt[0], k.emergeAt[1]);
    k.roars = true;
    return k;
  }
  function turnToward(k, want, rate, dt) { const d = angDiff(k.yaw, want); k.yaw += clamp(d, -rate * dt, rate * dt); }
  function stepKaiju(k, dt) {
    const m = sim.mech, sp = k.sp, D = KD;
    k.t += dt; k.at += dt; k.atkCd -= dt;
    k.x += k.kvx * dt; k.z += k.kvz * dt;
    const kd = Math.exp(-4 * dt); k.kvx *= kd; k.kvz *= kd;
    const city = k.target === 'city' && k.cityPt;
    const tx = city ? k.cityPt[0] : m.x, tz = city ? k.cityPt[1] : m.z;
    const dx = tx - k.x, dz = tz - k.z, dist = Math.hypot(dx, dz), want = Math.atan2(dx, dz), rel = angDiff(k.yaw, want);
    k.look = city ? 0 : clamp(rel, -0.9, 0.9);
    const range = sp.reach + 14;
    const melee = sp.attacks.filter((a) => a !== 'spit' && a !== 'lunge');
    const fwd = (speed) => {
      let ya = k.yaw;
      if (W.terrainH(k.x + Math.sin(ya) * 70, k.z + Math.cos(ya) * 70) > -9 && !(city && dist < 160)) { ya += 1.1; k.yaw += 1.4 * dt; }
      k.x += Math.sin(ya) * speed * dt; k.z += Math.cos(ya) * speed * dt;
    };
    switch (k.ai) {
      case 'swim': {
        const ex = k.emergeAt[0] - k.x, ez = k.emergeAt[1] - k.z;
        turnToward(k, Math.atan2(ex, ez), 2.0, dt);
        k.x += Math.sin(k.yaw) * 105 * dt; k.z += Math.cos(k.yaw) * 105 * dt;
        if (Math.hypot(ex, ez) < 45) { setAI(k, 'emerge'); emit('emerge', k.x, k.z, k.spIdx); }
        break;
      }
      case 'emerge':
        turnToward(k, want, 0.5, dt);
        if (k.t >= D.emerge) { if (k.roars) { setAI(k, 'roar'); emit('roar', k.x, k.z, sp.height / 100); } else setAI(k, 'approach'); }
        break;
      case 'roar': turnToward(k, want, 0.5, dt); if (k.t >= D.roar) setAI(k, 'approach'); break;
      case 'approach': {
        turnToward(k, want, sp.turn, dt);
        k.gait = Math.abs(rel) < 1.0 ? 1 : 0.4;
        if (city) { if (dist < 45) setAI(k, 'smash'); else fwd(sp.speed * k.gait); break; }
        const ar = Math.abs(rel);
        if (sp.attacks.includes('spit') && dist > 190 && dist < 760 && k.atkCd <= 0 && ar < 0.45) { setAI(k, 'windup', 'spit'); break; }
        if (sp.attacks.includes('lunge') && dist > range * 1.35 && dist < range * 3.4 && k.atkCd <= 0 && ar < 0.3) { setAI(k, 'windup', 'lunge'); emit('growl', k.x, k.z, 0.5); break; }
        if (dist < range) {
          if (k.atkCd <= 0 && ar < 0.6 && melee.length) { setAI(k, 'windup', melee[(rnd() * melee.length) | 0]); if (rnd() < 0.5) emit('growl', k.x, k.z, sp.height / 100); }
          else setAI(k, 'hold');
        } else fwd(sp.speed * k.gait * (sp.attacks.includes('spit') && dist < 260 ? 0.5 : dist > 260 ? 1.7 : 1));
        break;
      }
      case 'hold':
        turnToward(k, want, sp.turn, dt);
        if (dist > range * 1.2) setAI(k, 'approach');
        else if (k.atkCd <= 0 && Math.abs(rel) < 0.6 && melee.length) setAI(k, 'windup', melee[(rnd() * melee.length) | 0]);
        break;
      case 'windup':
        turnToward(k, want, sp.turn * 0.7, dt);
        if (k.t >= D.windup) setAI(k, 'attack');
        break;
      case 'attack': {
        const AD = D[k.next] || { dur: 1, hit: 0.4 };
        if (k.next === 'lunge' && k.t < AD.hit + 0.12 && dist > sp.reach * 0.55) fwd(92);
        if (!k.hitDone && k.t >= AD.hit) { k.hitDone = true; kaijuStrike(k, dist, rel); }
        if (k.t >= AD.dur) { setAI(k, 'recover'); k.atkCd = Math.max(0.5, 1.5 - sim.wave * 0.08) + rnd() * 1.3; k.hold = 0.35 + rnd() * 0.5; }
        break;
      }
      case 'recover': if (k.t >= k.hold) setAI(k, 'approach'); break;
      case 'stagger': if (k.t >= D.stagger) { setAI(k, 'approach'); k.atkCd = Math.max(k.atkCd, 0.4); } break;
      case 'smash': {
        const AD = D.smash;
        turnToward(k, Math.atan2(0.2, 1), 0.6, dt);        // face the city
        if (!k.hitDone && k.t >= AD.hit) {
          k.hitDone = true;
          const lost = W.damageCity(k.x + Math.sin(k.yaw) * 150, k.z + Math.cos(k.yaw) * 150, 190, 4);
          sim.city = Math.max(0, sim.city - lost.length * 1.7 - 0.5);
          for (const b of lost) emit('city', b[0], b[1], b[2]);
          if (!lost.length) { k.cityPt = W.shoreTargets[(W.shoreTargets.indexOf(k.cityPt) + 1) % W.shoreTargets.length]; setAI(k, 'approach'); }
          if (sim.city <= 0) gameOver('city');
        }
        if (k.t >= AD.dur) { k.t = 0; k.at = 0; k.hitDone = false; }
        break;
      }
      case 'death': if (k.t >= D.death + 1.2) k.gone = true; break;
    }
  }
  function kaijuStrike(k, dist, rel) {
    const m = sim.mech, sp = k.sp;
    if (k.next === 'spit') {
      k.model.anchors.mouth.getWorldPosition(v1);
      mechM.eye.getWorldPosition(v2); v2.y -= 12;
      const tt = v1.distanceTo(v2) / 200;
      v2.x += m.vx * tt * 0.7; v2.z += m.vz * tt * 0.7; v2.y += 0.5 * 25 * tt * tt;
      v3.subVectors(v2, v1).normalize().multiplyScalar(200);
      sim.shots.push({ id: sim.nextId++, kind: 1, x: v1.x, y: v1.y, z: v1.z, vx: v3.x, vy: v3.y, vz: v3.z, life: 0, dmg: 55 * (1 + 0.1 * (sim.wave - 1)), from: k.id });
      emit('spit', v1.x, v1.y, v1.z);
      return;
    }
    if (dist < sp.reach + 24 && Math.abs(rel) < 0.95) {
      const base = { swipeL: 75, swipeR: 75, bite: 115, lunge: 150 }[k.next] || 70;
      damageMech(base * (1 + 0.1 * (sim.wave - 1)), k.x, k.z, k.next === 'lunge' ? 70 : 42);
    }
  }
  function damageMech(dmg, fx_, fz_, knock) {
    const m = sim.mech;
    const from = BW.yawTo(m.x, m.z, fx_, fz_);
    const blocked = (m.L.state === 'block' || m.R.state === 'block') && Math.abs(angDiff(m.aim, from)) < 1.3;
    if (blocked) dmg *= 0.2;
    m.hull -= dmg;
    const kx = -Math.sin(from), kz = -Math.cos(from), kk = blocked ? knock * 0.3 : knock;
    m.vx += kx * kk; m.vz += kz * kk;
    if (!blocked) { m.stagger = 1; m.combo = 0; }
    emit('mhit', dmg, blocked ? 1 : 0, angDiff(m.aim, from));
    if (m.hull <= 0) { m.hull = 0; gameOver('hull'); }
  }
  function damageKaiju(k, dmg, power) {
    if (k.ai === 'death') return;
    const m = sim.mech;
    k.hp -= dmg; k.poise -= dmg;
    k.target = 'mech';
    const away = BW.yawTo(m.x, m.z, k.x, k.z), kn = power >= 3 ? 46 : power === 2 ? 30 : 9;
    k.kvx += Math.sin(away) * kn; k.kvz += Math.cos(away) * kn;
    if (k.hp <= 0) {
      k.hp = 0; setAI(k, 'death');
      sim.kills++; sim.score += Math.round(k.maxHp + sim.city * 3);
      emit('kill', k.x, k.z, k.sp.height / 100);
    } else if ((k.poise <= 0 || power >= 2) && k.ai !== 'emerge' && k.ai !== 'swim') {
      k.poise = k.maxHp * 0.22; setAI(k, 'stagger');
    }
  }
  // side: -1 port, +1 starboard, 0 both. power: 1 punch, 2 hammer, 3 sync strike
  function meleeHit(side, power) {
    const m = sim.mech;
    let best = null, bd = 1e9;
    for (const k of sim.kaijus) {
      if (k.ai === 'death' || k.ai === 'swim') continue;
      const d = Math.hypot(k.x - m.x, k.z - m.z), rel = Math.abs(angDiff(m.aim, BW.yawTo(m.x, m.z, k.x, k.z)));
      if (d < BW.Mech.REACH + k.sp.radius * 0.75 + (power > 1 ? 12 : 0) && rel < (power > 1 ? 1.0 : 0.8) && d < bd) { best = k; bd = d; }
    }
    if (!best) return;
    const dmg = [0, 58, 150, 235][power] * (1 + 0.12 * Math.min(m.combo, 5)) * (1 + 0.5 * sim.sync);
    best.model.anchors.chest.getWorldPosition(v1);
    const back = BW.yawTo(best.x, best.z, m.x, m.z);
    v1.x += Math.sin(back) * best.sp.radius * 0.7; v1.z += Math.cos(back) * best.sp.radius * 0.7;
    if (power === 1) { mechM.fist(side, v2); v1.y = lerp(v1.y, v2.y, 0.5); }
    emit('hit', v1.x, v1.y, v1.z, best.id, power);
    damageKaiju(best, dmg, power);
    m.combo++; m.comboT = 1.7;
    if (side !== 0 && side !== sim.lastArm) sim.sync = Math.min(1, sim.sync + (Net.linked ? 0.05 : 0.02));
    sim.lastArm = side;
    if (power === 3) sim.sync = Math.min(1, sim.sync + 0.25);
  }
  function setArm(arm, state) { arm.state = state; arm.t = 0; arm.hit = false; }
  function tryPunch(side) {
    const m = sim.mech, arm = side < 0 ? m.L : m.R, other = side < 0 ? m.R : m.L;
    if (m.stagger > 0.5) return;
    if (arm.state !== 'idle' && !(arm.state === 'punch' && arm.t > MD.punch.dur * 0.8) && arm.state !== 'block') return;
    // two pilots landing together: the machine commits both arms
    if (Net.linked && other.state === 'punch' && other.t < 0.3 && !other.hit) {
      setArm(m.L, 'slam'); setArm(m.R, 'slam'); m.L.t = m.R.t = Math.min(other.t, MD.slam.hit * 0.5);
      sim.syncStrike = true; emit('sync');
      return;
    }
    setArm(arm, 'punch'); emit('whoosh', side);
  }
  function trySlam() {
    const m = sim.mech;
    if (m.stagger > 0.5 || m.energy < 12) return;
    if ((m.L.state !== 'idle' && m.L.state !== 'block') || (m.R.state !== 'idle' && m.R.state !== 'block')) return;
    m.energy -= 12; setArm(m.L, 'slam'); setArm(m.R, 'slam'); sim.syncStrike = false; emit('whoosh', 0);
  }
  function fireCannon(yaw, pitch) {
    const m = sim.mech;
    mechM.muzzle(v1);
    v2.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    // gentle aim assist toward whatever the pilot is looking at
    let best = 0.16;
    for (const k of sim.kaijus) {
      if (k.ai === 'death' || k.ai === 'swim') continue;
      k.model.anchors.chest.getWorldPosition(v3).sub(v1).normalize();
      const ang = Math.acos(clamp(v3.dot(v2), -1, 1));
      if (ang < best) { best = ang; v2.copy(v3); }
    }
    sim.shots.push({ id: sim.nextId++, kind: 0, x: v1.x, y: v1.y, z: v1.z, vx: v2.x * 440, vy: v2.y * 440, vz: v2.z * 440, life: 0, dmg: 70 + 240 * m.charge, charge: m.charge });
    emit('shot', v1.x, v1.y, v1.z, m.charge);
    m.vx -= v2.x * 14 * m.charge; m.vz -= v2.z * 14 * m.charge;
  }
  function stepShots(dt) {
    const m = sim.mech;
    for (let i = sim.shots.length - 1; i >= 0; i--) {
      const s = sim.shots[i];
      s.life += dt;
      if (s.kind === 1) s.vy -= 25 * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      let done = false;
      if (s.kind === 0) {
        for (const k of sim.kaijus) {
          if (k.ai === 'death' || k.ai === 'swim') continue;
          if (Math.hypot(s.x - k.x, s.z - k.z) < k.sp.radius + 9 && s.y > -4 && s.y < k.sp.height + BW.SEA_FLOOR + 8) {
            emit('burst', s.x, s.y, s.z, 1); damageKaiju(k, s.dmg, s.charge > 0.7 ? 2 : 1); done = true; break;
          }
        }
      } else if (Math.hypot(s.x - m.x, s.z - m.z) < 21 && s.y > -4 && s.y < 66) {
        emit('burst', s.x, s.y, s.z, 2);
        const before = m.hull; damageMech(s.dmg, s.x - s.vx, s.z - s.vz, 14);
        if (before - m.hull > s.dmg * 0.5) emit('acid');
        done = true;
      }
      if (!done && (s.y < 0 || W.terrainH(s.x, s.z) > s.y || s.life > 4.5)) { emit('burst', s.x, Math.max(s.y, 1), s.z, s.kind === 1 ? 2 : 0); done = true; }
      if (done) sim.shots.splice(i, 1);
    }
  }
  function stepMech(dt, inp) {
    const m = sim.mech, linked = Net.role === 'host' && Net.linked, ri = linked ? Net.remoteInput() : null;
    // --- aim and heading
    m.aim -= inp.lx; m.pitch = clamp(m.pitch + inp.ly, -0.65, 0.5);
    const d = angDiff(m.yaw, m.aim), rate = clamp(d * 3.2, -1.7, 1.7) * (m.stagger > 0.3 ? 0.4 : 1);
    m.yaw += rate * dt; m.turn = rate;
    const tw = angDiff(m.yaw, m.aim);
    if (Math.abs(tw) > 0.95) m.aim = m.yaw + clamp(tw, -0.95, 0.95);
    // --- locomotion: heavy, with inertia
    const busy = m.L.state === 'block' || m.R.state === 'block' ? 0.45 : m.L.state === 'slam' ? 0.3 : m.R.state === 'charge' ? 0.7 : 1;
    const k = busy * (m.stagger > 0.3 ? 0.25 : 1);
    const fx_ = Math.sin(m.aim), fz_ = Math.cos(m.aim), rx = -Math.cos(m.aim), rz = Math.sin(m.aim);
    const sf = inp.my >= 0 ? 34 : 19, wx = (fx_ * inp.my * sf + rx * inp.mx * 21) * k, wz = (fz_ * inp.my * sf + rz * inp.mx * 21) * k;
    m.vx = damp(m.vx, wx, 2.3, dt); m.vz = damp(m.vz, wz, 2.3, dt);
    m.dashCd -= dt; m.dashT = Math.max(0, m.dashT - dt);
    if (inp.dash && m.dashCd <= 0 && m.energy >= 15 && m.stagger < 0.5) {
      let ddx = fx_ * inp.my + rx * inp.mx, ddz = fz_ * inp.my + rz * inp.mx; const l = Math.hypot(ddx, ddz);
      if (l < 0.2) { ddx = fx_; ddz = fz_; } else { ddx /= l; ddz /= l; }
      m.vx += ddx * 78; m.vz += ddz * 78; m.energy -= 15; m.dashCd = 2.2; m.dashT = 0.55; emit('dash');
    }
    let nx = m.x + m.vx * dt, nz = m.z + m.vz * dt;
    if (W.blocked(nx, m.z, 18)) { nx = m.x; m.vx *= -0.2; }
    if (W.blocked(nx, nz, 18)) { nz = m.z; m.vz *= -0.2; }
    m.x = nx; m.z = nz;
    for (const q of sim.kaijus) {                           // bodies do not overlap
      if (q.ai === 'swim' || q.ai === 'death') continue;
      const dx = m.x - q.x, dz = m.z - q.z, dd = Math.hypot(dx, dz), min = 17 + q.sp.radius;
      if (dd < min && dd > 0.01) { const push = (min - dd) * 0.5; m.x += (dx / dd) * push; m.z += (dz / dd) * push; q.x -= (dx / dd) * push; q.z -= (dz / dd) * push; }
    }
    m.stagger = Math.max(0, m.stagger - dt * 1.6);
    m.acid = Math.max(0, m.acid - dt * 0.4);
    m.comboT -= dt; if (m.comboT <= 0) m.combo = 0;
    sim.sync = Math.max(0, sim.sync - dt * 0.018);
    // --- arms. With a co-pilot linked the starboard arm and the cannon are theirs.
    let wantR = inp.punchR, wantFire = inp.fire, slam = inp.slam, block = inp.block, fireYaw = m.aim, firePitch = m.pitch;
    if (ri) {
      const n = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
      if (!co.seen) co.seen = { rp: n(ri.rp), sl: n(ri.sl) };
      wantR = n(ri.rp) > co.seen.rp; slam = false; wantFire = !!ri.f; block = block || !!ri.b;
      co.seen.rp = n(ri.rp); co.seen.sl = n(ri.sl);
      fireYaw = m.aim + clamp(angDiff(m.aim, n(ri.y)), -1.3, 1.3); firePitch = clamp(n(ri.p), -0.65, 0.5);
      co.yaw = fireYaw; co.pitch = firePitch;
    } else co.seen = null;
    if (inp.punchL) tryPunch(-1);
    if (wantR) tryPunch(1);
    if (slam) trySlam();
    m.block = block;
    for (const side of [-1, 1]) {
      const arm = side < 0 ? m.L : m.R;
      arm.t += dt;
      if (arm.state === 'punch') {
        if (!arm.hit && arm.t >= MD.punch.hit) { arm.hit = true; meleeHit(side, 1); }
        if (arm.t >= MD.punch.dur) setArm(arm, 'idle');
      } else if (arm.state === 'slam') {
        if (side < 0 && !arm.hit && arm.t >= MD.slam.hit) { arm.hit = true; meleeHit(0, sim.syncStrike ? 3 : 2); bigSplash(m.x + fx_ * 45, m.z + fz_ * 45, 70); }
        if (arm.t >= MD.slam.dur) setArm(arm, 'idle');
      } else if (arm.state === 'fire') { if (arm.t >= MD.fire.dur) setArm(arm, 'idle'); }
      else if (arm.state === 'idle' && block && !(side > 0 && wantFire)) setArm(arm, 'block');
      else if (arm.state === 'block' && !block) setArm(arm, 'idle');
    }
    // --- cannon
    if (m.R.state === 'charge') {
      m.charge = Math.min(1, m.charge + dt / 1.15); m.energy -= 13 * dt;
      if (!wantFire || m.energy <= 0) {
        if (m.charge > 0.18) { fireCannon(fireYaw, firePitch); setArm(m.R, 'fire'); } else setArm(m.R, 'idle');
        m.charge = 0;
      }
    } else {
      m.energy = Math.min(100, m.energy + 8.5 * dt);
      if (wantFire && (m.R.state === 'idle' || m.R.state === 'block') && m.energy > 14 && m.stagger < 0.5) { setArm(m.R, 'charge'); m.charge = 0; m.energy -= 8; }
    }
    m.energy = Math.max(0, m.energy);
  }
  function stepHost(dt, inp) {
    simTime += dt;
    stepMech(dt, inp);
    for (const k of sim.kaijus) stepKaiju(k, dt);
    for (let i = 0; i < sim.kaijus.length; i++)             // leviathans keep apart from each other
      for (let j = i + 1; j < sim.kaijus.length; j++) {
        const a = sim.kaijus[i], b = sim.kaijus[j];
        if (a.ai === 'death' || b.ai === 'death') continue;
        const dx = a.x - b.x, dz = a.z - b.z, dd = Math.hypot(dx, dz), min = a.sp.radius + b.sp.radius + 10;
        if (dd < min && dd > 0.01) { const p = (min - dd) * 0.5; a.x += (dx / dd) * p; a.z += (dz / dd) * p; b.x -= (dx / dd) * p; b.z -= (dz / dd) * p; }
      }
    for (const k of sim.kaijus.slice()) if (k.gone) removeKaiju(k);
    stepShots(dt);
    // waves
    sim.waveT += dt;
    if (sim.waveState === 'idle' && sim.waveT > 2.2) startWave(sim.wave + 1);
    else if (sim.waveState === 'fight') {
      for (let i = sim.queue.length - 1; i >= 0; i--) if (sim.waveT >= sim.queue[i].at) { const q = sim.queue.splice(i, 1)[0]; spawn(q.key, q.target); }
      if (!sim.queue.length && !sim.kaijus.length) {
        sim.waveState = 'clear'; sim.waveT = 0;
        sim.mech.hull = Math.min(HULL_MAX, sim.mech.hull + 260); sim.mech.energy = 100;
        sim.score += 500 * sim.wave;
        emit('clear', sim.wave);
      }
    } else if (sim.waveState === 'clear' && sim.waveT > 7) startWave(sim.wave + 1);
    for (const k of sim.kaijus) k.hpFrac = k.hp / k.maxHp;
  }
  function gameOver(reason) {
    if (sim.phase !== 'play') return;
    sim.phase = 'over'; sim.overReason = reason;
    emit('over');
    endPlay();
  }
  function endPlay() {
    input.enabled = false;
    if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) { /* optional */ } }
    $('hud').hidden = true; $('touch').hidden = true;
    showMenu('over');
  }

  // ===================================================================================== network encode / decode
  function encode() {
    const m = sim.mech;
    return {
      n: sim.evSeq * 0 + ((performance.now() / 45) | 0), ph: sim.phase, w: sim.wave, ws: sim.waveState, sc: sim.score, ki: sim.kills, c: r1(sim.city), sy: r2(sim.sync), or: sim.overReason, pa: sim.paused ? 1 : 0,
      m: [r1(m.x), r1(m.z), r2(m.yaw), r2(m.aim), r2(m.pitch), r1(m.vx), r1(m.vz), Math.round(m.hull), Math.round(m.energy), ARM.indexOf(m.L.state), r2(m.L.t), ARM.indexOf(m.R.state), r2(m.R.t),
        r2(m.charge), m.block ? 1 : 0, r2(m.dashT), r2(m.stagger), m.combo, r2(m.turn), r2(m.acid)],
      k: sim.kaijus.map((k) => [k.id, k.spIdx, r1(k.x), r1(k.z), r2(k.yaw), r2(k.hp / k.maxHp), KS.indexOf(k.anim), r2(k.at), KS.indexOf(k.next), r2(k.look), r2(k.gait)]),
      p: sim.shots.slice(0, 8).map((s) => [s.id, s.kind, r1(s.x), r1(s.y), r1(s.z), r1(s.vx), r1(s.vy), r1(s.vz)]),
      e: sim.events,
    };
  }
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d || 0);
  function stepReplica(dt, inp) {
    simTime += dt;
    const s = Net.remoteState(), m = sim.mech;
    // my own head and controls
    co.yaw -= inp.lx; co.pitch = clamp(co.pitch + inp.ly, -0.65, 0.5);
    const rel = angDiff(m.aim, co.yaw);
    if (Math.abs(rel) > 1.3) co.yaw = m.aim + clamp(rel, -1.3, 1.3);
    if (inp.punchR || inp.punchL) { co.rp++; A.play('punch', { pan: 0.45 }); }
    co.f = inp.fire ? 1 : 0; co.b = inp.block ? 1 : 0;
    // advance what we have between snapshots
    m.x += m.vx * dt; m.z += m.vz * dt; m.L.t += dt; m.R.t += dt;
    for (const k of sim.kaijus) { k.at += dt; k.x = damp(k.x, k.tx, 10, dt); k.z = damp(k.z, k.tz, 10, dt); k.yaw = dampAng(k.yaw, k.tyaw, 10, dt); }
    for (const p of sim.shots) { p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; }
    if (!s || !Array.isArray(s.m) || s.n === co.lastN) return;
    co.lastN = s.n;
    sim.wave = num(s.w); sim.waveState = String(s.ws || ''); sim.score = num(s.sc); sim.kills = num(s.ki); sim.city = num(s.c, 100); sim.sync = num(s.sy); sim.overReason = String(s.or || '');
    sim.paused = false;
    const a = s.m;
    const ex = num(a[0]) - m.x, ez = num(a[1]) - m.z;
    if (Math.hypot(ex, ez) > 60) { m.x = num(a[0]); m.z = num(a[1]); } else { m.x += ex * 0.35; m.z += ez * 0.35; }
    m.yaw = dampAng(m.yaw, num(a[2]), 30, 0.033); m.aim = dampAng(m.aim, num(a[3]), 30, 0.033); m.pitch = num(a[4]);
    m.vx = num(a[5]); m.vz = num(a[6]); m.hull = num(a[7]); m.energy = num(a[8]);
    const ls = ARM[num(a[9]) | 0] || 'idle', rs = ARM[num(a[11]) | 0] || 'idle';
    if (ls !== m.L.state || Math.abs(m.L.t - num(a[10])) > 0.2) { m.L.state = ls; m.L.t = num(a[10]); }
    if (rs !== m.R.state || Math.abs(m.R.t - num(a[12])) > 0.2) { m.R.state = rs; m.R.t = num(a[12]); }
    m.charge = num(a[13]); m.block = !!a[14]; m.dashT = num(a[15]); m.stagger = num(a[16]); m.combo = num(a[17]); m.turn = num(a[18]);
    if (num(a[19]) > m.acid) m.acid = num(a[19]); else m.acid = num(a[19]);
    // leviathans
    const seen = {};
    if (Array.isArray(s.k)) for (const q of s.k.slice(0, 8)) {
      if (!Array.isArray(q)) continue;
      const id = num(q[0]), key = SPK[num(q[1]) | 0];
      if (!key) continue;
      seen[id] = 1;
      let k = kById(id);
      if (!k) { k = addKaiju(id, key); k.x = num(q[2]); k.z = num(q[3]); k.yaw = num(q[4]); }
      k.tx = num(q[2]); k.tz = num(q[3]); k.tyaw = num(q[4]); k.hpFrac = num(q[5]);
      const anim = KS[num(q[6]) | 0] || 'idle';
      if (anim !== k.anim || Math.abs(k.at - num(q[7])) > 0.25) { k.anim = anim; k.at = num(q[7]); }
      k.ai = anim === 'death' ? 'death' : anim === 'swim' ? 'swim' : 'x';
      k.next = KS[num(q[8]) | 0] || 'swipeL'; k.look = num(q[9]); k.gait = num(q[10], 1);
    }
    for (const k of sim.kaijus.slice()) if (!seen[k.id]) removeKaiju(k);
    sim.shots.length = 0;
    if (Array.isArray(s.p)) for (const p of s.p.slice(0, 8)) if (Array.isArray(p)) sim.shots.push({ id: num(p[0]), kind: num(p[1]), x: num(p[2]), y: num(p[3]), z: num(p[4]), vx: num(p[5]), vy: num(p[6]), vz: num(p[7]) });
    if (Array.isArray(s.e)) for (const ev of s.e.slice(-14)) {
      if (!Array.isArray(ev) || num(ev[0]) <= co.lastEv) continue;
      co.lastEv = num(ev[0]);
      if (typeof ev[1] === 'string' && ev[1] !== 'whoosh') playEvent([ev[0], ev[1], num(ev[2]), num(ev[3]), num(ev[4]), num(ev[5]), num(ev[6])]);
    }
  }
  // the co-pilot's phase follows the host's
  function followHost() {
    const s = Net.remoteState();
    if (!Net.linked) {
      if (co.wasLinked && Net.sinceLink() > 2500) { co.wasLinked = false; leaveCrew('The port pilot disconnected.'); }
      return;
    }
    co.wasLinked = true;
    const ph = s && typeof s.ph === 'string' ? s.ph : 'title';
    if (ph === 'play' && sim.phase !== 'play') {
      for (const k of sim.kaijus.slice()) removeKaiju(k);
      sim.mech = newMech(); if (s && Array.isArray(s.m)) { sim.mech.x = num(s.m[0]); sim.mech.z = num(s.m[1]); sim.mech.yaw = sim.mech.aim = num(s.m[3]); }
      co.yaw = sim.mech.aim; co.pitch = 0; co.lastEv = s && Array.isArray(s.e) && s.e.length ? num(s.e[s.e.length - 1][0]) : 0;
      W.resetCity(); fx.clearFires();
      beginPlay();
    } else if (ph === 'over' && sim.phase === 'play') { sim.phase = 'over'; sim.overReason = String((s && s.or) || 'hull'); endPlay(); }
    else if (ph === 'title' && sim.phase !== 'title') { sim.phase = 'title'; input.enabled = false; showMenu('joined'); }
  }
  function leaveCrew(note) {
    Net.leave();
    for (const k of sim.kaijus.slice()) removeKaiju(k);
    sim.shots.length = 0; sim.mech = newMech(); sim.phase = 'title'; input.enabled = false;
    $('hud').hidden = true; $('touch').hidden = true;
    showMenu('title', note);
  }

  // ===================================================================================== camera
  function cameraYaw() { return Net.role === 'co' && sim.phase === 'play' ? co.yaw : sim.mech.aim; }
  function updateCamera(dt) {
    const m = sim.mech;
    const portrait = innerWidth / innerHeight < 1;
    let fov = 74;
    if (portrait) fov = clamp((2 * Math.atan(Math.tan((60 * Math.PI) / 360) / camera.aspect) * 180) / Math.PI, 74, 104);
    if (sim.phase !== 'play') {
      const a = wallTime * 0.07 + 2.4;
      camera.position.set(m.x + Math.sin(a) * 215, 30 + Math.sin(wallTime * 0.13) * 8, m.z + Math.cos(a) * 215);
      v1.set(m.x, 34, m.z); camera.lookAt(v1);
      camera.fov = portrait ? 62 : 46;
    } else if (viewMode === 'fp') {
      mechM.eye.getWorldPosition(v1);
      camera.position.copy(v1);
      camera.rotation.set(Net.role === 'co' ? co.pitch : m.pitch, cameraYaw() + Math.PI, 0, 'YXZ');
      camera.fov = fov + m.dashT * 9;
    } else {
      const a = cameraYaw(), p = Net.role === 'co' ? co.pitch : m.pitch;
      v1.set(m.x - Math.sin(a) * 165 - Math.cos(a) * 34, 78 - p * 60, m.z - Math.cos(a) * 165 + Math.sin(a) * 34);
      camera.position.lerp(v1, 1 - Math.exp(-dt * 6));
      v2.set(m.x + Math.sin(a) * 90, 40 + p * 90, m.z + Math.cos(a) * 90); camera.lookAt(v2);
      camera.fov = portrait ? 80 : 58;
    }
    // impact shake
    trauma = Math.max(0, trauma - dt * 1.5);
    if (trauma > 0.001 && sim.phase === 'play') {
      const s = trauma * trauma, t = wallTime * 31;
      camera.rotation.x += s * 0.035 * Math.sin(t * 1.3); camera.rotation.y += s * 0.03 * Math.sin(t * 1.7 + 1.3); camera.rotation.z += s * 0.04 * Math.sin(t * 1.1 + 4.0);
      camera.position.y += s * 1.3 * Math.sin(t * 2.1);
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    camVel.subVectors(camera.position, lastCam).divideScalar(Math.max(dt, 0.001)); lastCam.copy(camera.position);
    if (camVel.length() > 200) camVel.set(0, 0, 0);
  }

  // ===================================================================================== per-frame visuals
  const spotTargets = [new T.Vector3(), new T.Vector3()], focus = new T.Vector3();
  function updateVisuals(dt, sdt) {
    const m = sim.mech, playing = sim.phase === 'play';
    BW.U.uSkyTime.value = wallTime;
    // mech
    const gy = clamp(W.terrainH(m.x, m.z), BW.SEA_FLOOR, -10);
    mechM.group.position.set(m.x, gy, m.z); mechM.group.rotation.y = m.yaw;
    const fxv = Math.sin(m.yaw), fzv = Math.cos(m.yaw);
    mechM.setView(playing && viewMode === 'fp' ? 'fp' : 'tp');
    mechM.animate(sdt, { speed: m.vx * fxv + m.vz * fzv, strafe: m.vx * -fzv + m.vz * fxv, turn: m.turn, twist: angDiff(m.yaw, m.aim), pitch: m.pitch,
      L: m.L, R: m.R, charge: m.charge, hull: m.hull / HULL_MAX, dash: m.dashT > 0 ? 1 : 0, stagger: m.stagger });
    if (m.dashT > 0.1) fx.thruster(m.x - fxv * 12, 30, m.z - fzv * 12, -Math.sin(m.aim), -Math.cos(m.aim));
    // leviathans
    let near = null, nd = 1e9, ti = 0;
    for (const k of sim.kaijus) {
      const ky = clamp(W.terrainH(k.x, k.z), BW.SEA_FLOOR, -5);
      k.model.group.position.set(k.x, ky, k.z); k.model.group.rotation.y = k.yaw;
      k.model.animate(sdt, { state: k.anim, t: k.at, speed: k.gait, look: k.look, next: k.next });
      const d = Math.hypot(k.x - m.x, k.z - m.z);
      if (k.anim !== 'death' && d < nd) { nd = d; near = k; }
      if (k.anim !== 'death' && k.anim !== 'swim' && ti < 2) k.model.anchors.chest.getWorldPosition(spotTargets[ti++]);
      if (k.anim === 'emerge' && k.at < KD.emerge) { k.shed += dt; if (k.shed > 0.05) { k.shed = 0; fx.shed(k.x, k.sp.height * 0.6 * (k.at / KD.emerge), k.z, k.sp.radius, 5); } }
      if (k.anim === 'swim' && rnd() < 0.3) fx.mist(k.x + (rnd() - 0.5) * 30, 3, k.z + (rnd() - 0.5) * 30, 26, 0.22);
    }
    focus.set(m.x, 40, m.z);
    for (; ti < 2; ti++) spotTargets[ti].set(m.x + (ti ? 60 : -40), 30, m.z + (ti ? -50 : 70));
    // projectiles
    for (const s of sim.shots) fx.bolt(s.x, s.y, s.z, s.kind === 1 ? BILE : PLASMA, s.kind === 1 ? 7 : 6 + 5 * (s.charge || 0.6));
    if (m.charge > 0.02) { mechM.muzzle(v1); fx.flash(v1.x, v1.y, v1.z, 5 + m.charge * 16, 1.5 * m.charge, 4 * m.charge, 6 * m.charge, 0.06); }
    // water: where giants stand
    const spd = Math.hypot(m.vx, m.vz) / 34;
    O.setDisturb(0, m.x + fzv * 11, m.z - fxv * 11, 24, 0.55 + spd * 0.7);
    O.setDisturb(1, m.x - fzv * 11, m.z + fxv * 11, 24, 0.55 + spd * 0.7);
    let di = 2;
    for (const k of sim.kaijus) {
      if (di >= 6) break;
      const st = k.anim === 'swim' ? 1.25 : k.anim === 'emerge' ? 1.5 : k.anim === 'death' ? 1.3 * smooth(KD.death + 1.2, KD.death * 0.3, k.at) : 0.95;
      O.setDisturb(di++, k.x, k.z, k.sp.radius * (k.anim === 'swim' ? 2.2 : 1.7), st);
    }
    for (; di < 6; di++) O.setDisturb(di, 0, 0, 1, 0);
    for (let i = 0; i < 2; i++) { const s = splashes[i]; s.t += dt; O.setDisturb(6 + i, s.x, s.z, s.r * (0.5 + s.t * 0.35), Math.max(0, 1.4 - s.t * 0.45)); }
    glowPulse = Math.max(0, glowPulse - dt * 2.5);
    if (sim.shots.length) { const s = sim.shots[0]; O.setGlow(s.x, s.z, 90, 0.5, s.kind === 1 ? BILE : PLASMA); }
    else if (glowPulse <= 0 && near) O.setGlow(near.x, near.z, near.sp.radius * 3.2, near.anim === 'swim' ? 0.5 : 0.16, near.glow);
    else if (glowPulse <= 0) O.setGlow(0, 0, 1, 0);
    // lights
    const fp = flashLight.userData.p || 0;
    flashLight.intensity = fp * 220000; flashLight.userData.p = Math.max(0, fp - dt * 5);
    if (near && near.anim !== 'swim') { near.model.anchors.chest.getWorldPosition(v1); glowLight.position.copy(v1); glowLight.color.copy(near.glow); glowLight.intensity = 1600 * (0.7 + 0.3 * Math.sin(wallTime * 3)); }
    else glowLight.intensity = 0;
    // weather
    lightningT -= dt;
    if (lightningT <= 0) {
      lightningT = 16 + rnd() * 30;
      BW.U.uFlash.value = 1; const a = rnd() * 6.28; BW.U.uFlashDir.value.set(Math.cos(a), 0.25 + rnd() * 0.3, Math.sin(a)).normalize();
      thunderAt = wallTime + 0.8 + rnd() * 2.5;
    }
    const fl = BW.U.uFlash.value;
    BW.U.uFlash.value = fl > 0.02 ? fl * Math.exp(-dt * (5 + 6 * Math.sin(wallTime * 43) ** 2)) : 0;
    lights.hemi.intensity = 0.55 + fl * 2.2;
    if (thunderAt > 0 && wallTime >= thunderAt) { thunderAt = -1; A.play('thunder', { gain: 0.8 }); }
    updateCamera(dt);
    W.update(dt, wallTime, camera, focus, spotTargets);
    W.spotPools(O.spots);
    O.update(wallTime, camera);
    fx.update(dt, wallTime, camVel);
    // audio beds
    const threat = sim.kaijus.length ? clamp(1.2 - nd / 900, 0.35, 1) : 0;
    A.update(dt, { speed: playing ? Math.min(1, spd + Math.abs(m.turn) * 0.3) : 0, hull: playing ? m.hull / HULL_MAX : 1, charge: m.charge, rain: 0.7, threat: playing ? threat : 0.15, paused: sim.paused });
    // grade
    hitFlash = Math.max(0, hitFlash - dt * 1.8); glitch = Math.max(0, glitch - dt * 1.6);
    const U = post.finalMat.uniforms;
    U.uVisor.value = playing && viewMode === 'fp' ? 1 : 0.35;
    U.uHit.value = hitFlash + (playing && m.hull < 250 ? 0.12 + 0.08 * Math.sin(wallTime * 6) : 0);
    U.uGlitch.value = glitch + (playing && m.hull < 150 ? 0.15 : 0);
    U.uDesat.value = damp(U.uDesat.value, sim.phase === 'over' ? 0.7 : 0, 2, dt);
    U.uAberr.value = 0.006 + m.dashT * 0.03 + hitstop * 0.2;
  }

  // ===================================================================================== HUD
  let hctx, hudW = 1, hudH = 1, hudDpr = 1, safeTop = 0;
  function drawHud() {
    const c = hctx; c.setTransform(hudDpr, 0, 0, hudDpr, 0, 0); c.clearRect(0, 0, hudW, hudH);
    if (sim.phase !== 'play') return;
    const m = sim.mech, yaw = cameraYaw(), u = Math.min(hudW, hudH) / 720;
    const ORANGE = '#ff5a2e', INK = 'rgba(232,238,242,0.9)', DIM = 'rgba(232,238,242,0.45)';
    c.lineWidth = 1.5; c.font = `600 ${Math.max(10, 11 * u)}px "IBM Plex Mono", ui-monospace, monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
    // compass tape
    const cw = Math.min(hudW * 0.5, 460), cx = hudW / 2, cy = 22 + safeTop + (input.kind === 'touch' ? 34 : 0) + (hudW < 560 ? 48 : 0);
    let brg = (Math.atan2(Math.sin(yaw), -Math.cos(yaw)) * 180) / Math.PI; if (brg < 0) brg += 360;
    c.strokeStyle = DIM; c.fillStyle = INK;
    const span = 110;
    for (let d = Math.ceil((brg - span / 2) / 5) * 5; d <= brg + span / 2; d += 5) {
      const x = cx + ((d - brg) / span) * cw, dd = ((d % 360) + 360) % 360, major = dd % 15 === 0;
      c.beginPath(); c.moveTo(x, cy - (major ? 7 : 3)); c.lineTo(x, cy + (major ? 7 : 3)); c.stroke();
      if (dd % 45 === 0) c.fillText(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][dd / 45], x, cy + 19);
    }
    c.strokeStyle = ORANGE; c.beginPath(); c.moveTo(cx, cy - 11); c.lineTo(cx - 5, cy - 18); c.lineTo(cx + 5, cy - 18); c.closePath(); c.stroke();
    // reticle + cannon charge
    if (viewMode === 'fp') {
      const rx = hudW / 2, ry = hudH / 2;
      c.strokeStyle = DIM; c.beginPath();
      c.moveTo(rx - 16, ry); c.lineTo(rx - 6, ry); c.moveTo(rx + 6, ry); c.lineTo(rx + 16, ry); c.moveTo(rx, ry - 16); c.lineTo(rx, ry - 6); c.moveTo(rx, ry + 6); c.lineTo(rx, ry + 16); c.stroke();
      if (m.charge > 0.01) { c.strokeStyle = '#7fdcf0'; c.lineWidth = 3; c.beginPath(); c.arc(rx, ry, 26, -Math.PI / 2, -Math.PI / 2 + m.charge * Math.PI * 2); c.stroke(); c.lineWidth = 1.5; }
    }
    // contacts: brackets, names, health; arrows when off-screen
    for (const k of sim.kaijus) {
      if (k.anim === 'death') continue;
      k.model.anchors.chest.getWorldPosition(v1);
      if (k.anim === 'swim') v1.y = 8;
      const dist = Math.hypot(k.x - m.x, k.z - m.z);
      v2.copy(v1).project(camera);
      const behind = v2.z > 1, sx = (v2.x * 0.5 + 0.5) * hudW, sy = (-v2.y * 0.5 + 0.5) * hudH;
      const on = !behind && sx > 30 && sx < hudW - 30 && sy > 40 && sy < hudH - 40;
      const col = k.target === 'city' || k.anim === 'smash' ? '#ffd23c' : ORANGE;
      if (on) {
        const s = clamp((k.sp.height * 0.55 * hudH) / (2 * Math.tan((camera.fov * Math.PI) / 360) * Math.max(dist, 30)), 16, Math.min(hudH * 0.34, hudW * 0.3)), q = s * 0.3;
        c.strokeStyle = col; c.beginPath();
        for (const [ax, ay] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { c.moveTo(sx + ax * s, sy + ay * s - ay * q); c.lineTo(sx + ax * s, sy + ay * s); c.lineTo(sx + ax * s - ax * q, sy + ay * s); }
        c.stroke();
        c.fillStyle = col; c.textAlign = 'left';
        c.fillText(k.sp.name + '  ' + Math.round(dist) + ' m', sx - s, sy - s - 12);
        c.fillStyle = 'rgba(232,238,242,0.18)'; c.fillRect(sx - s, sy + s + 6, s * 2, 4);
        c.fillStyle = col; c.fillRect(sx - s, sy + s + 6, s * 2 * clamp(k.hpFrac, 0, 1), 4);
        c.textAlign = 'center';
      } else {
        const rel = angDiff(yaw, BW.yawTo(m.x, m.z, k.x, k.z));                  // + = to the left
        const ang = -rel, ex = hudW / 2 + Math.sin(ang) * hudW * 0.42, ey = hudH / 2 - Math.cos(ang) * hudH * 0.36;
        c.save(); c.translate(ex, ey); c.rotate(ang); c.fillStyle = col;
        c.beginPath(); c.moveTo(0, -13); c.lineTo(9, 7); c.lineTo(-9, 7); c.closePath(); c.fill(); c.restore();
        c.fillStyle = col; c.fillText(Math.round(dist) + ' m', ex, ey + 22);
      }
    }
    // radar (desktop)
    if (!BW.isMobile && hudH > 520) {
      const R = 58 * Math.max(u, 0.8), rx = hudW / 2, ry = hudH - R - 44;
      c.strokeStyle = 'rgba(232,238,242,0.22)'; c.fillStyle = 'rgba(6,11,16,0.45)';
      c.beginPath(); c.arc(rx, ry, R, 0, 6.283); c.fill(); c.stroke();
      c.beginPath(); c.arc(rx, ry, R * 0.5, 0, 6.283); c.stroke();
      const sc = R / 1500;
      const plot = (x, z) => { const dx = x - m.x, dz = z - m.z, fwd = dx * Math.sin(yaw) + dz * Math.cos(yaw), rgt = dx * -Math.cos(yaw) + dz * Math.sin(yaw); let px = rgt * sc, py = -fwd * sc; const l = Math.hypot(px, py); if (l > R - 4) { px *= (R - 4) / l; py *= (R - 4) / l; } return [rx + px, ry + py]; };
      c.strokeStyle = 'rgba(192,54,44,0.9)'; c.beginPath(); let p = plot(W.BRIDGE.x, -900); c.moveTo(p[0], p[1]); p = plot(W.BRIDGE.x, 900); c.lineTo(p[0], p[1]); c.stroke();
      c.fillStyle = 'rgba(232,238,242,0.5)'; for (const s of W.shoreTargets) { p = plot(s[0], s[1] + 150); c.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3); }
      for (const k of sim.kaijus) { if (k.anim === 'death') continue; p = plot(k.x, k.z); c.fillStyle = k.target === 'city' ? '#ffd23c' : ORANGE; c.beginPath(); c.arc(p[0], p[1], 4, 0, 6.283); c.fill(); }
      c.fillStyle = INK; c.beginPath(); c.moveTo(rx, ry - 6); c.lineTo(rx + 4, ry + 4); c.lineTo(rx - 4, ry + 4); c.closePath(); c.fill();
    }
  }
  function updateHudDom() {
    const m = sim.mech, hull = m.hull / HULL_MAX;
    $('hullNum').textContent = Math.round(hull * 100);
    $('hullBar').firstElementChild.style.transform = `scaleX(${clamp(hull, 0, 1)})`;
    $('reactorNum').textContent = Math.round(m.energy);
    $('reactorBar').firstElementChild.style.transform = `scaleX(${clamp(m.energy / 100, 0, 1)})`;
    $('cityNum').textContent = Math.round(sim.city) + '%';
    $('cityBar').firstElementChild.style.transform = `scaleX(${clamp(sim.city / 100, 0, 1)})`;
    $('kills').textContent = sim.kills; $('score').textContent = sim.score.toLocaleString('en-US');
    $('wave').textContent = sim.wave ? 'Wave ' + sim.wave : 'Standby';
    $('hud').classList.toggle('low', hull < 0.25);
    $('armL').className = 'arm' + (m.L.state === 'punch' || m.L.state === 'slam' ? ' act' : m.L.state === 'block' ? ' chg' : '');
    $('armR').className = 'arm' + (m.R.state === 'punch' || m.R.state === 'slam' || m.R.state === 'fire' ? ' act' : m.R.state === 'charge' || m.R.state === 'block' ? ' chg' : '');
    $('acid').style.opacity = clamp(m.acid, 0, 1);
    const coop = Net.role !== 'solo';
    $('syncLabel').textContent = coop ? 'Crew sync ' + Math.round(sim.sync * 100) + '%' : m.dashCd > 0 ? 'Thrusters ' + m.dashCd.toFixed(1) + ' s' : 'Thrusters ready';
    const crew = $('crew');
    const want = !coop ? '' : Net.role === 'host' ? (Net.linked ? 'h1' : 'h0') : 'c';
    if (crew.dataset.k !== want) {
      crew.dataset.k = want;
      crew.innerHTML = !coop ? '' : Net.role === 'host'
        ? `<span class="chip you">Port · you</span><span class="chip ${Net.linked ? 'on' : ''}">Stbd · ${Net.linked ? 'linked' : 'open ' + Net.code}</span>`
        : `<span class="chip on">Port · linked</span><span class="chip you">Stbd · you</span>`;
    }
    if (m.combo >= 2 && wallTime > comboUntil - 1.2) { $('combo').textContent = 'Chain ×' + m.combo; $('combo').classList.add('show'); comboUntil = Math.max(comboUntil, wallTime + 0.4); }
    if (wallTime > comboUntil) $('combo').classList.remove('show');
    if (wallTime > bannerUntil) $('banner').classList.remove('show');
    if (hintUntil && wallTime > hintUntil) { $('hint').textContent = ''; hintUntil = 0; }
  }

  // ===================================================================================== menus
  const CONTROLS = {
    kbm: [['W A S D', 'Walk'], ['Mouse · arrows', 'Turn and aim'], ['Left click · J', 'Port fist'], ['Right click · K', 'Starboard fist'], ['E', 'Double hammer'], ['Space', 'Brace'],
      ['Hold F', 'Charge cannon, release to fire'], ['Shift', 'Thruster dash'], ['V', 'Outside view'], ['M · P', 'Mute · pause']],
    touch: [['Left thumb', 'Walk'], ['Right thumb, drag', 'Turn and aim'], ['Left · Right', 'Fists'], ['Slam', 'Double hammer'], ['Hold Cannon', 'Charge, release to fire'], ['Hold Block', 'Brace']],
    pad: [['Left stick', 'Walk'], ['Right stick', 'Turn and aim'], ['LB · RB', 'Fists'], ['X', 'Double hammer'], ['LT', 'Brace'], ['Hold RT', 'Charge cannon'], ['A', 'Thruster dash'], ['Y', 'Outside view']],
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function controlsHtml() { return '<div id="controls">' + (CONTROLS[input.kind] || CONTROLS.kbm).map((r) => `<kbd>${r[0]}</kbd><span>${r[1]}</span>`).join('') + '</div>'; }
  function showMenu(kind, note) {
    menuKind = kind;
    const el = $('menuCol'), menu = $('menu');
    if (!kind) { menu.hidden = true; el.innerHTML = ''; return; }
    menu.hidden = false;
    let h = '';
    const btn = (act, label, small, cls, dis) => `<button class="btn ${cls || ''}" type="button" data-act="${act}" ${dis ? 'disabled' : ''}><span>${label}</span><small>${small || ''}</small></button>`;
    if (kind === 'title') {
      h += `<div class="kicker">San Francisco Bay · blue hour</div><h1 class="stencil">Break<span>water</span></h1>`;
      h += `<p>Something is coming in under the Golden Gate. You see it from inside the head of an 85-metre harbour-defence machine, hip-deep in the bay. Keep it off the waterfront.</p>`;
      if (note) h += `<p style="color:var(--orange)">${esc(note)}</p>`;
      h += '<div class="stack">' + btn('solo', 'Deploy solo', 'One pilot, whole machine', 'primary');
      h += btn('host', 'Host a two-pilot crew', 'You: port arm and legs', '', !Net.available);
      h += btn('join', 'Join a crew', Net.available ? (Net.hosts.length ? Net.hosts.length + ' recruiting' : 'Starboard arm and cannon') : '', '', !Net.available) + '</div>';
      if (!Net.available) h += `<div id="lobbyNote">${Net.ready ? 'Two-pilot link is offline in this view. It connects when you and your co-pilot are both signed in and the page has been shared with them.' : 'Checking for the two-pilot link…'}</div>`;
      h += controlsHtml();
    } else if (kind === 'host') {
      h += `<div class="kicker">Crew code</div><div id="code" class="stencil">${esc(Net.code)}</div>`;
      h += `<p>${Net.linked ? 'Second pilot linked. They have the starboard fist and the cannon; you have the port fist, the legs and the heading.' : 'Waiting for a second pilot. They open this same page and choose Join a crew. You can deploy now and they can drop in mid-fight.'}</p>`;
      h += `<p>Throw your punches together, within a third of a second, and the machine commits both arms to a sync strike.</p>`;
      h += '<div class="stack">' + btn('deploy', Net.linked ? 'Deploy together' : 'Deploy now', Net.linked ? 'Starboard linked' : 'Co-pilot can drop in', 'primary') + btn('back', 'Stand down', 'Back') + '</div>';
    } else if (kind === 'join') {
      h += `<div class="kicker">Crews recruiting</div><h1 class="stencil" style="font-size:clamp(34px,8vmin,64px)">Join a crew</h1>`;
      if (Net.hosts.length) h += '<div class="stack">' + Net.hosts.map((c) => btn('joincode:' + esc(c.code), 'Crew ' + esc(c.code), c.full ? 'Seat taken' : 'Starboard seat open', 'primary', c.full)).join('') + '</div>';
      else h += `<p>No crew is recruiting yet. Ask your co-pilot to open this page and choose Host a two-pilot crew; their code will appear here.</p>`;
      h += '<div class="stack">' + btn('back', 'Back', '') + '</div>';
    } else if (kind === 'joined') {
      h += `<div class="kicker">Crew ${esc(Net.code)}</div><h1 class="stencil" style="font-size:clamp(34px,8vmin,64px)">${Net.linked ? 'Linked' : 'Linking…'}</h1>`;
      h += `<p>You are the starboard pilot: right fist and the forearm cannon. Look around freely; the cannon fires where you look. The port pilot walks the machine.</p><p>Waiting for the port pilot to deploy.</p>`;
      h += '<div class="stack">' + btn('leave', 'Leave crew', '') + '</div>' + controlsHtml();
    } else if (kind === 'pause') {
      h += `<div class="kicker">Reactor idling</div><h1 class="stencil" style="font-size:clamp(40px,10vmin,84px)">Paused</h1>`;
      h += '<div class="stack">' + btn('resume', 'Resume', '', 'primary') + btn('mute', A.muted ? 'Sound on' : 'Sound off', '') + btn('view', 'Switch view', viewMode === 'fp' ? 'Now: cockpit' : 'Now: outside') + btn('quit', 'Abandon sortie', '') + '</div>' + controlsHtml();
    } else if (kind === 'over') {
      const cityLost = sim.overReason === 'city';
      h += `<div class="kicker">${cityLost ? 'The waterfront is gone' : 'Hull breach'}</div><h1 class="stencil" style="font-size:clamp(40px,10vmin,84px)">${cityLost ? 'City lost' : 'Warden down'}</h1>`;
      h += `<div><div class="stat"><span>Waves repelled</span><span>${Math.max(0, sim.wave - 1)}</span></div><div class="stat"><span>Leviathans killed</span><span>${sim.kills}</span></div>` +
        `<div class="stat"><span>City standing</span><span>${Math.round(sim.city)}%</span></div><div class="stat"><span>Score</span><span>${sim.score.toLocaleString('en-US')}</span></div></div>`;
      if (Net.role === 'co') h += `<p>Waiting for the port pilot to redeploy.</p><div class="stack">` + btn('leave', 'Leave crew', '') + '</div>';
      else h += '<div class="stack">' + btn('redeploy', 'Redeploy', '', 'primary') + btn('quit', 'Back to the hangar', '') + '</div>';
    }
    el.innerHTML = h;
    const first = el.querySelector('.btn:not([disabled])');
    if (first && !BW.isMobile) first.focus({ preventScroll: true });
  }
  function beginPlay() {
    sim.phase = 'play'; sim.paused = false;
    showMenu('');
    $('hud').hidden = false;
    $('touch').hidden = input.kind !== 'touch';
    $('hud').classList.toggle('touching', input.kind === 'touch');
    input.enabled = true; input.lock();
    viewMode = 'fp';
    const hint = Net.role === 'co' ? 'You are starboard: right fist and cannon. The cannon fires where you look.'
      : input.kind === 'touch' ? 'Left thumb walks. Drag on the right to turn. Fists, cannon and brace are under your right thumb.'
      : input.kind === 'pad' ? 'Sticks walk and turn. LB and RB are your fists. Hold RT to charge the cannon.'
      : 'WASD walks, the mouse turns. Click for fists. Hold F to charge the cannon. Space braces.';
    $('hint').textContent = hint; hintUntil = wallTime + 11;
    if (Net.role === 'host' || Net.role === 'solo') banner('Warden online', 'Hold the line east of the bridge', 3);
  }
  function onMenu(act) {
    A.init(); A.resume(); A.play('ui', {});
    if (act === 'solo') { Net.leave(); resetSim(); beginPlay(); }
    else if (act === 'host') { Net.host(); showMenu('host'); }
    else if (act === 'deploy' || act === 'redeploy') { resetSim(); beginPlay(); }
    else if (act === 'join') showMenu('join');
    else if (act.indexOf('joincode:') === 0) { Net.join(act.slice(9)); co.lastN = -1; co.wasLinked = false; showMenu('joined'); }
    else if (act === 'back') { Net.leave(); showMenu('title'); }
    else if (act === 'leave') leaveCrew();
    else if (act === 'resume') togglePause(false);
    else if (act === 'mute') { A.setMuted(!A.muted); showMenu('pause'); }
    else if (act === 'view') { viewMode = viewMode === 'fp' ? 'tp' : 'fp'; showMenu('pause'); }
    else if (act === 'quit') { Net.leave(); resetSim(); sim.phase = 'title'; sim.paused = false; input.enabled = false; $('hud').hidden = true; $('touch').hidden = true; showMenu('title'); }
  }
  function togglePause(on) {
    if (sim.phase !== 'play') return;
    sim.paused = on === undefined ? !sim.paused : on;
    if (Net.role === 'co') sim.paused = false;
    if (sim.paused) { input.enabled = false; if (document.exitPointerLock) { try { document.exitPointerLock(); } catch (e) { /* optional */ } } showMenu('pause'); }
    else { showMenu(''); input.enabled = true; input.lock(); }
  }

  // ===================================================================================== boot + loop
  function resize() {
    const w = innerWidth, h = innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, BW.Q.maxPixelRatio) * resScale;
    renderer.setSize(Math.floor(w * pr), Math.floor(h * pr), false);
    post.setSize(Math.floor(w * pr), Math.floor(h * pr));
    camera.aspect = w / h; camera.updateProjectionMatrix();
    const hc = $('hud2d'); hudDpr = Math.min(window.devicePixelRatio || 1, 2); hudW = w; hudH = h;
    hc.width = Math.floor(w * hudDpr); hc.height = Math.floor(h * hudDpr);
    safeTop = parseFloat(getComputedStyle(document.documentElement).paddingTop) || 0;
  }
  function frame(now) {
    requestAnimationFrame(frame);
    const raw = (now - last) / 1000; last = now;
    const dt = clamp(raw, 0.001, 0.05);
    wallTime += dt;
    const inp = input.poll(dt);
    netTick += dt; if (netTick > 0.2) { netTick = 0; Net.poll(); }
    if (inp.pause && sim.phase === 'play') { if (Net.role === 'co') { /* the co-pilot cannot stop the machine */ } else togglePause(); }
    if (inp.mute) A.setMuted(!A.muted);
    if (inp.view && sim.phase === 'play') viewMode = viewMode === 'fp' ? 'tp' : 'fp';
    hitstop = Math.max(0, hitstop - dt);
    const sdt = sim.paused ? 0 : dt * (hitstop > 0 ? 0.07 : 1);
    if (Net.role === 'co') {
      followHost();
      if (sim.phase === 'play') stepReplica(sdt, inp);
      Net.sendInput({ y: r2(co.yaw), p: r2(co.pitch), rp: co.rp, sl: co.sl, f: co.f, b: co.b }, now);
    } else {
      if (sim.phase === 'play' && !sim.paused && !G.freeze) stepHost(sdt, inp);
      if (Net.role === 'host') Net.sendState(encode(), now);
    }
    updateVisuals(dt, sim.phase === 'play' && !G.freeze ? sdt : dt);
    post.render(scene, fxScene, camera, wallTime);
    drawHud();
    hudTick += dt; if (hudTick > 0.09) { hudTick = 0; if (sim.phase === 'play') updateHudDom(); }
    // adapt resolution to the device
    frameAvg = lerp(frameAvg, raw * 1000, 0.05); resTimer += dt;
    if (resTimer > 2.5 && !G.fixedRes) {
      resTimer = 0;
      if (frameAvg > 26 && resScale > 0.5) { resScale = Math.max(0.5, resScale * 0.85); resize(); }
      else if (frameAvg < 14 && resScale < 1) { resScale = Math.min(1, resScale * 1.12); resize(); }
    }
    G.frames = (G.frames || 0) + 1;
    if (G.frames > 4) window.__ready = true;
  }
  G.boot = function () {
    KS = BW.Kaiju.STATES; KD = BW.Kaiju.DUR; MD = BW.Mech.DUR;
    const canvas = $('gl');
    renderer = new T.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, stencil: false });
    renderer.setPixelRatio(1);
    scene = new T.Scene(); fxScene = new T.Scene();
    camera = new T.PerspectiveCamera(74, innerWidth / innerHeight, 0.5, 40000);
    camera.rotation.order = 'YXZ';
    scene.add(BW.makeSkyDome(1000));
    lights = BW.addLights(scene);
    BW.buildEnvironment(renderer, scene);
    flashLight = new T.PointLight(0x9fdcff, 0, 900, 2); glowLight = new T.PointLight(0xffffff, 0, 600, 2);
    scene.add(flashLight, glowLight);
    W = BW.World.create(scene, fxScene);
    O = BW.Ocean.create(scene);
    fx = BW.FX.create(fxScene);
    post = BW.Post.create(renderer);
    mechM = BW.Mech.create();
    scene.add(mechM.group);
    mechM.onStep = function (side, pos, strength) {
      const s = strength === undefined ? 1 : strength;
      fx.splash(pos.x, pos.z, 0.8 + s * 0.7, 12);
      if (sim.phase === 'play') { A.play('step', { pan: side * 0.3, gain: 0.5 + s * 0.5 }); if (viewMode === 'fp') trauma = Math.min(1, trauma + 0.1 * s); }
    };
    for (const key of SPK) (pool[key] = pool[key] || []).push(BW.Kaiju.create(key, 7 + SPK.indexOf(key)));
    input = BW.Input.create(canvas);
    input.onUnlock = () => { if (sim.phase === 'play' && !sim.paused && Net.role !== 'co') togglePause(true); };
    input.onKind = (k) => { if (sim.phase === 'play') { $('touch').hidden = k !== 'touch'; $('hud').classList.toggle('touching', k === 'touch'); } else if (menuKind === 'title' || menuKind === 'pause' || menuKind === 'joined') showMenu(menuKind); };
    hctx = $('hud2d').getContext('2d');
    $('menuCol').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b && !b.disabled) onMenu(b.dataset.act); });
    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => { if (document.hidden && sim.phase === 'play' && Net.role === 'solo') togglePause(true); });
    Net.onChange = () => { if (menuKind === 'title' || menuKind === 'host' || menuKind === 'join' || menuKind === 'joined') showMenu(menuKind); };
    Net.init();
    resize();
    showMenu('title');
    $('boot').hidden = true;
    last = performance.now();
    requestAnimationFrame(frame);
    // dev / test hooks
    G.debug = {
      start() { onMenu('solo'); }, gameOver, sim, Net, spawn, setAI, stepHost, emit, damageKaiju, kById,
      advance(sec, inp) { const i = Object.assign({ mx: 0, my: 0, lx: 0, ly: 0 }, inp || {}); for (let t = 0; t < sec; t += 1 / 60) { stepHost(1 / 60, i); i.lx = i.ly = 0; i.punchL = i.punchR = i.slam = i.dash = false; } },
      view(v) { viewMode = v; }, get camera() { return camera; }, get renderer() { return renderer; },
    };
  };
})();
