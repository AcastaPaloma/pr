/* BREAKWATER — input: keyboard + mouse (pointer lock when available), touch (stick, drag-look, buttons), gamepad.
 * poll() returns one merged snapshot per frame:
 *   mx, my        move, -1..1 (my = forward)
 *   lx, ly        look delta this frame in radians (lx > 0 turns right, ly > 0 looks up)
 *   block, fire   held
 *   punchL, punchR, slam, dash, view, pause, mute     pressed this frame
 */
(function () {
  'use strict';
  const BW = window.BW;
  const I = (BW.Input = {});
  I.create = function (canvas) {
    const keys = Object.create(null);
    const edge = { punchL: 0, punchR: 0, slam: 0, dash: 0, view: 0, pause: 0, mute: 0 };
    const held = { block: 0, fire: 0 };
    let lx = 0, ly = 0;
    const st = { mx: 0, my: 0, lx: 0, ly: 0, block: false, fire: false, punchL: false, punchR: false, slam: false, dash: false, view: false, pause: false, mute: false };
    const input = { kind: BW.isMobile ? 'touch' : 'kbm', enabled: false, locked: false, onKind: null };
    const setKind = (k) => { if (input.kind !== k) { input.kind = k; if (input.onKind) input.onKind(k); } };

    // ---------------- keyboard
    const KEYMAP = { KeyJ: 'punchL', KeyK: 'punchR', KeyE: 'slam', ShiftLeft: 'dash', ShiftRight: 'dash', KeyV: 'view', KeyP: 'pause', Escape: 'pause', KeyM: 'mute' };
    addEventListener('keydown', (e) => {
      if (e.repeat) { if (input.enabled && /^(Space|Arrow)/.test(e.code)) e.preventDefault(); return; }
      keys[e.code] = true;
      if (KEYMAP[e.code]) edge[KEYMAP[e.code]] = 1;
      if (input.enabled && /^(Space|Arrow|Tab)/.test(e.code)) e.preventDefault();
      setKind('kbm');
    });
    addEventListener('keyup', (e) => { keys[e.code] = false; });
    addEventListener('blur', () => { for (const k in keys) keys[k] = false; held.block = held.fire = 0; mouseL = mouseR = false; });

    // ---------------- mouse
    let mouseL = false, mouseR = false, dragging = false, lastX = 0, lastY = 0, lTime = -1, rTime = -1;
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    input.lock = function () {
      if (BW.isMobile || !canvas.requestPointerLock) return;
      try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* optional */ }
    };
    document.addEventListener('pointerlockchange', () => {
      const was = input.locked;
      input.locked = document.pointerLockElement === canvas;
      if (was && !input.locked && input.onUnlock) input.onUnlock();
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!input.enabled) return;
      setKind('kbm');
      if (!input.locked) { input.lock(); dragging = true; lastX = e.clientX; lastY = e.clientY; }
      const now = performance.now();
      if (e.button === 0) { mouseL = true; edge.punchL = 1; lTime = now; }
      if (e.button === 2) { mouseR = true; edge.punchR = 1; rTime = now; }
      if (e.button === 1) { held.fire = 1; e.preventDefault(); }
      if (Math.abs(lTime - rTime) < 110) { edge.slam = 1; edge.punchL = edge.punchR = 0; }
    });
    addEventListener('mouseup', (e) => {
      if (e.button === 0) mouseL = false;
      if (e.button === 2) mouseR = false;
      if (e.button === 1) held.fire = 0;
      if (!mouseL && !mouseR) dragging = false;
    });
    addEventListener('mousemove', (e) => {
      if (!input.enabled) return;
      if (input.locked) { lx += e.movementX * 0.0021; ly -= e.movementY * 0.0021; }
      else if (dragging) { lx += (e.clientX - lastX) * 0.004; ly -= (e.clientY - lastY) * 0.004; lastX = e.clientX; lastY = e.clientY; }
    });

    // ---------------- touch
    const stick = document.getElementById('stick'), knob = stick ? stick.firstElementChild : null;
    let stickId = null, sx = 0, sy = 0, tmx = 0, tmy = 0, lookId = null, lkx = 0, lky = 0;
    canvas.addEventListener('touchstart', (e) => {
      if (!input.enabled) return;
      e.preventDefault(); setKind('touch');
      for (const t of e.changedTouches) {
        if (t.clientX < innerWidth * 0.42 && stickId === null) {
          stickId = t.identifier; sx = t.clientX; sy = t.clientY;
          if (stick) { stick.style.left = sx - 62 + 'px'; stick.style.top = sy - 62 + 'px'; stick.style.bottom = 'auto'; }
        } else if (lookId === null) { lookId = t.identifier; lkx = t.clientX; lky = t.clientY; }
      }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
      if (!input.enabled) return;
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) {
          let dx = (t.clientX - sx) / 56, dy = (t.clientY - sy) / 56;
          const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
          tmx = dx; tmy = -dy;
          if (knob) knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
        } else if (t.identifier === lookId) {
          lx += (t.clientX - lkx) * 0.0052; ly -= (t.clientY - lky) * 0.0042; lkx = t.clientX; lky = t.clientY;
        }
      }
    }, { passive: false });
    const tend = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier === stickId) { stickId = null; tmx = tmy = 0; if (knob) knob.style.transform = ''; }
        if (t.identifier === lookId) lookId = null;
      }
    };
    canvas.addEventListener('touchend', tend); canvas.addEventListener('touchcancel', tend);
    function button(id, down, up) {
      const el = document.getElementById(id);
      if (!el) return;
      const d = (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('down'); setKind('touch'); down(); };
      const u = (e) => { e.preventDefault(); el.classList.remove('down'); if (up) up(); };
      el.addEventListener('pointerdown', d); el.addEventListener('pointerup', u); el.addEventListener('pointercancel', u); el.addEventListener('pointerleave', u);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    button('tL', () => (edge.punchL = 1)); button('tR', () => (edge.punchR = 1)); button('tSlam', () => (edge.slam = 1));
    button('tDash', () => (edge.dash = 1)); button('tView', () => (edge.view = 1)); button('tPause', () => (edge.pause = 1));
    button('tBlock', () => (held.block = 1), () => (held.block = 0)); button('tFire', () => (held.fire = 1), () => (held.fire = 0));

    // ---------------- gamepad
    const prevPad = [];
    function pad(dt) {
      const out = { mx: 0, my: 0, block: false, fire: false };
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = pads && (pads[0] || pads[1] || pads[2] || pads[3]);
      if (!gp || !gp.connected) return out;
      const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
      out.mx = dz(gp.axes[0] || 0); out.my = -dz(gp.axes[1] || 0);
      const rx = dz(gp.axes[2] || 0), ry = dz(gp.axes[3] || 0);
      lx += rx * Math.abs(rx) * 2.6 * dt; ly -= ry * Math.abs(ry) * 1.7 * dt;
      const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4));
      const press = (i, name) => { const v = b(i); if (v && !prevPad[i]) { edge[name] = 1; setKind('pad'); } prevPad[i] = v; };
      press(4, 'punchL'); press(5, 'punchR'); press(2, 'slam'); press(0, 'dash'); press(3, 'view'); press(9, 'pause');
      out.block = b(6) || b(1); out.fire = b(7);
      if (out.mx || out.my || rx || ry) setKind('pad');
      return out;
    }

    input.poll = function (dt) {
      const p = pad(dt);
      let mx = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + tmx + p.mx;
      let my = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) + tmy + p.my;
      // arrow keys turn and tilt, for when the mouse cannot be captured
      lx += ((keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0)) * 1.9 * dt;
      ly += ((keys.ArrowUp ? 1 : 0) - (keys.ArrowDown ? 1 : 0)) * 1.1 * dt;
      const l = Math.hypot(mx, my); if (l > 1) { mx /= l; my /= l; }
      st.mx = mx; st.my = my;
      st.lx = BW.clamp(lx, -0.6, 0.6); st.ly = BW.clamp(ly, -0.6, 0.6); lx = ly = 0;
      st.block = !!(keys.Space || keys.KeyQ || held.block || p.block);
      st.fire = !!(keys.KeyF || keys.KeyL || held.fire || p.fire);
      for (const k in edge) { st[k] = !!edge[k]; edge[k] = 0; }
      if (!input.enabled) { st.mx = st.my = st.lx = st.ly = 0; st.block = st.fire = st.punchL = st.punchR = st.slam = st.dash = st.view = false; }
      return st;
    };
    return input;
  };
})();
