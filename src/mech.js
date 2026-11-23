/* BREAKWATER — the player's machine: SF-07 WARDEN, a coastal-defence walker.
 * Procedural model (plated hull, cockpit interior) and procedural animation (IK legs and arms).
 *
 * Model faces +Z, so its LEFT is +X and its RIGHT is -X. API sides: -1 = left, +1 = right.
 * a.pitch > 0 looks up. a.strafe > 0 moves to the mech's right.
 *
 *   BW.Mech.DUR / BW.Mech.REACH      timings (seconds) and punch reach (metres, mech centre → target centre)
 *   BW.Mech.create() -> { group, eye, height, eyeHeight, setView('fp'|'tp'), animate(dt, a), onStep,
 *                         fist(side, out), muzzle(out), dispose() }
 *   animate(dt, a): a = { speed, strafe, turn, twist, pitch, L:{state,t}, R:{state,t}, charge, hull, dash, stagger,
 *                         cabin (optional 0..2 cockpit instrument brightness, default 1) }
 *   Arm poses are pure functions of (state, t); a 0.1–0.3 s blend covers state changes.
 *   The cockpit rides the torso, so punches and footfalls move the frame around the pilot's view.
 */
(function () {
  'use strict';
  const BW = (window.BW = window.BW || {});
  const T = THREE;
  const V = T.Vector3;
  const { clamp, lerp, sat, damp } = BW;

  const DUR = { punch: { dur: 0.62, hit: 0.24 }, slam: { dur: 0.95, hit: 0.42 }, fire: { dur: 0.5 } };
  const REACH = 60;

  // ------------------------------------------------------------------ skeleton (metres, feet at y = 0)
  const HIP_Y = 42, HIP_X = 8, THIGH = 20.5, SHIN = 20, ANKLE_H = 4, FOOT_X = 8.8;
  const WAIST = 6;                        // torso pivot above the hip
  const SH_X = 16.5, SH_Y = 19;             // shoulder, in torso space
  const UPPER = 18, FORE = 17, FIST = 22.4; // elbow→wrist, elbow→fist centre
  const HEAD_Y = 28, HEAD_Z = 2;          // head pivot, in torso space
  const EYE = new V(0, 2, 1);             // eye, in head space  → 78 m above the feet
  const TEX = 16;                         // metres per hull-texture tile

  // ------------------------------------------------------------------ paint (linear)
  const GREY = [0.150, 0.165, 0.182], GREY2 = [0.205, 0.220, 0.235], MID = [0.075, 0.080, 0.088];
  const DARK = [0.030, 0.033, 0.038], CHROME = [0.55, 0.56, 0.58], GLASS = [0.012, 0.016, 0.022];
  const ORANGE = (function () { const c = BW.ORANGE || new T.Color(0xc0362c); return [c.r * 1.15, c.g * 1.6 + 0.01, c.b * 1.1]; })();
  const L_RED = [6.0, 0.25, 0.12], L_GREEN = [0.2, 4.5, 1.0], L_WHITE = [4.2, 4.0, 3.5], L_AMBER = [3.2, 1.25, 0.25];
  const SLOT = { HULL: 0, LIGHT: 1, REACTOR: 2, DECAL: 3, THRUST: 4, CANNON: 5, INT: 6 };

  // ------------------------------------------------------------------ geometry builder
  const _m = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler(), _p = new V(), _one = new V(1, 1, 1);
  const Y_AXIS = new V(0, 1, 0);

  function Geo(seed) {
    this.slots = [];
    this.stack = [new T.Matrix4()];
    this.m = new T.Matrix4();
    this.c = GREY; this.s = 0; this.vary = 0.07;
    this.rnd = BW.rng(seed || 11);
    this.tris = 0;
  }
  Geo.prototype = {
    col(c) { this.c = c; return this; },
    mat(s) { this.s = s; return this; },
    top() { return this.stack[this.stack.length - 1]; },
    at(x, y, z, rx, ry, rz) {
      _e.set(rx || 0, ry || 0, rz || 0, 'XYZ'); _q.setFromEuler(_e);
      _m.compose(_p.set(x || 0, y || 0, z || 0), _q, _one);
      this.m.multiplyMatrices(this.top(), _m);
      return this;
    },
    push(x, y, z, rx, ry, rz) { this.at(x, y, z, rx, ry, rz); this.stack.push(this.m.clone()); return this; },
    pop() { this.stack.pop(); this.m.copy(this.top()); return this; },
    align(a, b) {                       // origin at a, +Y toward b; returns the length
      const d = new V(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const len = d.length(); d.normalize();
      _q.setFromUnitVectors(Y_AXIS, d);
      _m.compose(_p.set(a[0], a[1], a[2]), _q, _one);
      this.m.multiplyMatrices(this.top(), _m);
      return len;
    },
    _sl() { return this.slots[this.s] || (this.slots[this.s] = { p: [], n: [], u: [], c: [] }); },
    _v(sl, P, N, u, v, sh) {
      sl.p.push(P.x, P.y, P.z); sl.n.push(N.x, N.y, N.z); sl.u.push(u, v);
      sl.c.push(this.c[0] * sh, this.c[1] * sh, this.c[2] * sh);
    },
    _uv(P, N, o) {
      const ax = Math.abs(N.x), ay = Math.abs(N.y), az = Math.abs(N.z);
      if (ax >= ay && ax >= az) { o[0] = P.z / TEX; o[1] = P.y / TEX; }
      else if (ay >= az) { o[0] = P.x / TEX; o[1] = P.z / TEX; }
      else { o[0] = P.x / TEX; o[1] = P.y / TEX; }
    },
    // Convex polygon with a flat normal. `center` (local) makes the winding face away from it.
    poly(pts, center, uvs) {
      const n = pts.length, P = [];
      for (let i = 0; i < n; i++) P.push(new V(pts[i][0], pts[i][1], pts[i][2]).applyMatrix4(this.m));
      const N = new V();
      for (let i = 0; i < n; i++) {
        const a = P[i], b = P[(i + 1) % n];
        N.x += (a.y - b.y) * (a.z + b.z); N.y += (a.z - b.z) * (a.x + b.x); N.z += (a.x - b.x) * (a.y + b.y);
      }
      N.normalize();
      let flip = false;
      if (center) {
        const C = new V(center[0], center[1], center[2]).applyMatrix4(this.m);
        const cen = new V();
        for (let i = 0; i < n; i++) cen.add(P[i]);
        cen.multiplyScalar(1 / n).sub(C);
        if (N.dot(cen) < 0) { flip = true; N.negate(); }
      }
      const sh = 1 + (this.rnd() - 0.5) * 2 * this.vary;
      const sl = this._sl(), uv = [0, 0];
      for (let i = 1; i < n - 1; i++) {
        const idx = flip ? [0, i + 1, i] : [0, i, i + 1];
        for (let k = 0; k < 3; k++) {
          const j = idx[k];
          if (uvs) { uv[0] = uvs[j][0]; uv[1] = uvs[j][1]; } else this._uv(P[j], N, uv);
          this._v(sl, P[j], N, uv[0], uv[1], sh);
        }
        this.tris++;
      }
      return this;
    },
    box(w, h, d) { return this.cbox(w, h, d, 0); },
    // Chamfered box centred on the local origin.
    cbox(w, h, d, c) {
      const hw = w / 2, hh = h / 2, hd = d / 2, O = [0, 0, 0];
      c = Math.min(c || 0, hw * 0.95, hh * 0.95, hd * 0.95);
      const half = [hw, hh, hd];
      const P = (a, s) => [0, 1, 2].map((i) => s[i] * (i === a ? half[i] : half[i] - c));
      const sg = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3, k = (a + 2) % 3;
        for (const sa of [1, -1]) {
          const pts = sg.map(([sb, sk]) => { const s = [0, 0, 0]; s[a] = sa; s[b] = sb; s[k] = sk; return P(a, s); });
          this.poly(pts, O);
        }
      }
      if (c > 0) {
        for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
          const k = 3 - a - b;
          for (const sa of [1, -1]) for (const sb of [1, -1]) {
            const s1 = [0, 0, 0], s2 = [0, 0, 0];
            s1[a] = sa; s1[b] = sb; s1[k] = 1; s2[a] = sa; s2[b] = sb; s2[k] = -1;
            this.poly([P(a, s1), P(a, s2), P(b, s2), P(b, s1)], O);
          }
        }
        for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
          const s = [sx, sy, sz];
          this.poly([P(0, s), P(1, s), P(2, s)], O);
        }
      }
      return this;
    },
    // Tapered block: bottom rect (wb × db) at y = 0, top rect (wt × dt) at y = h shifted by (ox, oz).
    frustum(wb, db, wt, dt, h, ox, oz) {
      ox = ox || 0; oz = oz || 0;
      const B = [[-wb / 2, 0, -db / 2], [wb / 2, 0, -db / 2], [wb / 2, 0, db / 2], [-wb / 2, 0, db / 2]];
      const U = [[ox - wt / 2, h, oz - dt / 2], [ox + wt / 2, h, oz - dt / 2], [ox + wt / 2, h, oz + dt / 2], [ox - wt / 2, h, oz + dt / 2]];
      const C = [ox / 2, h / 2, oz / 2];
      this.poly(B, C); this.poly(U, C);
      for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; this.poly([B[i], B[j], U[j], U[i]], C); }
      return this;
    },
    // Cylinder / cone along local +Y from y = 0 (r0) to y = h (r1), smooth sides.
    cyl(r0, r1, h, n, caps) {
      n = n || 12;
      const sl = this._sl(), sh = 1 + (this.rnd() - 0.5) * 2 * this.vary;
      const slope = (r0 - r1) / h, ring0 = [], ring1 = [];
      const P = [], N = [];
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        P.push([new V(r0 * c, 0, r0 * s).applyMatrix4(this.m), new V(r1 * c, h, r1 * s).applyMatrix4(this.m)]);
        N.push(new V(c, slope, s).normalize().transformDirection(this.m));
        if (i < n) { ring0.push([r0 * c, 0, r0 * s]); ring1.push([r1 * c, h, r1 * s]); }
      }
      const rr = (r0 + r1) * 0.5;
      for (let i = 0; i < n; i++) {
        const u0 = (i / n) * 6.283 * rr / TEX, u1 = ((i + 1) / n) * 6.283 * rr / TEX, v1 = h / TEX;
        // (b0, t0, t1) and (b0, t1, b1) wind outward
        this._v(sl, P[i][0], N[i], u0, 0, sh); this._v(sl, P[i][1], N[i], u0, v1, sh); this._v(sl, P[i + 1][1], N[i + 1], u1, v1, sh);
        this._v(sl, P[i][0], N[i], u0, 0, sh); this._v(sl, P[i + 1][1], N[i + 1], u1, v1, sh); this._v(sl, P[i + 1][0], N[i + 1], u1, 0, sh);
        this.tris += 2;
      }
      if (caps !== false) {
        const C = [0, h / 2, 0];
        if (r0 > 0.01) this.poly(ring0, C);
        if (r1 > 0.01) this.poly(ring1, C);
      }
      return this;
    },
    rod(a, b, r, n, r1) { const len = this.align(a, b); return this.cyl(r, r1 === undefined ? r : r1, len, n || 10, true); },
    beam(a, b, w, d) {
      const len = this.align(a, b);
      this.m.multiply(_m.makeTranslation(0, len / 2, 0));
      return this.box(w, len, d);
    },
    // Quad in the local XY plane facing +Z, mapped to a rect of the decal atlas.
    decal(w, h, uv) {
      const v = this.vary, c = this.c, s = this.s;
      this.vary = 0; this.c = [1, 1, 1]; this.s = SLOT.DECAL;
      this.poly([[-w / 2, -h / 2, 0], [w / 2, -h / 2, 0], [w / 2, h / 2, 0], [-w / 2, h / 2, 0]], null,
        [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]]);
      this.vary = v; this.c = c; this.s = s;
      return this;
    },
    light(color) { this.s = SLOT.LIGHT; this.c = color; this._v0 = this.vary; this.vary = 0; return this; },
    hull(color) { this.s = SLOT.HULL; if (color) this.c = color; if (this._v0 !== undefined) { this.vary = this._v0; } return this; },
    build(mats) {
      let total = 0;
      for (const sl of this.slots) if (sl) total += sl.p.length / 3;
      const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2), col = new Float32Array(total * 3);
      const g = new T.BufferGeometry(), used = [];
      let o = 0;
      this.slots.forEach((sl, s) => {
        if (!sl || !sl.p.length) return;
        const n = sl.p.length / 3;
        pos.set(sl.p, o * 3); nor.set(sl.n, o * 3); uv.set(sl.u, o * 2); col.set(sl.c, o * 3);
        g.addGroup(o, n, used.length);
        used.push(mats[s]);
        o += n;
      });
      g.setAttribute('position', new T.BufferAttribute(pos, 3));
      g.setAttribute('normal', new T.BufferAttribute(nor, 3));
      g.setAttribute('uv', new T.BufferAttribute(uv, 2));
      g.setAttribute('color', new T.BufferAttribute(col, 3));
      g.computeBoundingSphere();
      const mesh = new T.Mesh(g, used);
      mesh.userData.tris = this.tris;
      return mesh;
    },
  };

  // ------------------------------------------------------------------ textures
  function makeTextures() {
    const S = 512, rnd = BW.rng(4207);
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const x = cv.getContext('2d');
    x.fillStyle = '#808080'; x.fillRect(0, 0, S, S);
    const plates = [];
    (function split(px, py, w, h, depth) {
      if (depth < 3 && rnd() < (depth === 0 ? 1 : 0.7) && Math.max(w, h) > 150) {
        const f = 0.35 + rnd() * 0.3;
        if (w >= h) { const a = Math.round(w * f); split(px, py, a, h, depth + 1); split(px + a, py, w - a, h, depth + 1); }
        else { const a = Math.round(h * f); split(px, py, w, a, depth + 1); split(px, py + a, w, h - a, depth + 1); }
      } else plates.push([px, py, w, h]);
    })(0, 0, S, S, 0);
    // second layout pass so the tile is not one giant plate tree
    const cells = plates;
    for (const [px, py, w, h] of cells) {
      const g = 124 + Math.floor(rnd() * 12);
      x.fillStyle = `rgb(${g},${g},${g})`; x.fillRect(px, py, w, h);
      if (rnd() < 0.14 && w > 50 && h > 40) {                        // louvre / vent plate
        x.fillStyle = '#5a5a5a';
        const n = Math.min(7, Math.floor(h / 9) - 1);
        for (let i = 1; i <= n; i++) x.fillRect(px + w * 0.25, py + 14 + i * 9, w * 0.5, 3);
      } else if (rnd() < 0.22 && w > 40 && h > 40) {                 // raised access hatch
        x.fillStyle = '#8c8c8c'; x.fillRect(px + w * 0.25, py + h * 0.25, w * 0.5, h * 0.5);
        x.strokeStyle = '#646464'; x.lineWidth = 1.5; x.strokeRect(px + w * 0.25, py + h * 0.25, w * 0.5, h * 0.5);
      }
      x.strokeStyle = '#4e4e4e'; x.lineWidth = 2.5; x.strokeRect(px, py, w, h);
      x.fillStyle = '#a0a0a0';
      const step = 46;
      for (let i = 9; i < w - 4; i += step) { x.fillRect(px + i, py + 6, 2.4, 2.4); x.fillRect(px + i, py + h - 8, 2.4, 2.4); }
      for (let j = 9 + step; j < h - 12; j += step) { x.fillRect(px + 6, py + j, 2.4, 2.4); x.fillRect(px + w - 8, py + j, 2.4, 2.4); }
    }
    x.strokeStyle = '#4e4e4e'; x.lineWidth = 2.5; x.strokeRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {                                    // gouges
      x.strokeStyle = `rgba(${rnd() < 0.5 ? 60 : 170},${rnd() < 0.5 ? 60 : 170},60,0.25)`; x.lineWidth = 0.8 + rnd();
      const sx = rnd() * S, sy = rnd() * S, a = rnd() * 6.28, l = 10 + rnd() * 50;
      x.beginPath(); x.moveTo(sx, sy); x.lineTo(sx + Math.cos(a) * l, sy + Math.sin(a) * l); x.stroke();
    }
    const img = x.getImageData(0, 0, S, S).data;
    const H = new Float32Array(S * S);
    const nd0 = BW.noiseTex.image.data;
    for (let i = 0; i < S * S; i++) { const xx = i % S, yy = (i / S) | 0; H[i] = img[i * 4] / 255 + (nd0[(((yy * 2) & 255) * 256 + ((xx * 2) & 255)) * 4] / 255 - 0.5) * 0.05; }
    const normalMap = BW.normalMapFromHeight(H, S, 2.0);

    const nd = BW.noiseTex.image.data, NS = BW.noiseTex.image.width;
    const nz = (xx, yy, ch) => nd[(((yy % NS) + NS) % NS * NS + (((xx % NS) + NS) % NS)) * 4 + ch] / 255;
    const alb = new Uint8Array(S * S * 4), orm = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let xx = 0; xx < S; xx++) {
      const i = y * S + xx, h = H[i];
      const n1 = nz(xx >> 1, y >> 1, 0), n2 = nz(xx >> 1, y >> 1, 1), n3 = nz(xx * 2, y * 2, 0);
      const streak = nz(xx * 3, y >> 3, 1);
      const groove = h < 0.40 ? 1 : 0;
      const wear = BW.smooth(0.60, 0.74, n1 * 0.7 + n3 * 0.3);
      const grime = BW.smooth(0.52, 0.30, n2);
      let a = 0.80 + (n3 - 0.5) * 0.16;
      a *= 1 - 0.38 * grime;
      a *= 1 - 0.20 * BW.smooth(0.5, 0.75, streak);
      a = a * (1 - groove * 0.4) + wear * 0.22;
      const rust = BW.smooth(0.55, 0.75, n2 * n1 * 2.2) * (0.35 + groove * 0.5);
      alb[i * 4] = Math.round(sat(a * (1 + rust * 0.55)) * 255);
      alb[i * 4 + 1] = Math.round(sat(a * (1 - rust * 0.12)) * 255);
      alb[i * 4 + 2] = Math.round(sat(a * (1 - rust * 0.42)) * 255);
      alb[i * 4 + 3] = 255;
      orm[i * 4] = 255;
      orm[i * 4 + 1] = Math.round(sat(0.50 + 0.26 * grime - 0.24 * wear + groove * 0.2 + rust * 0.25 + (n3 - 0.5) * 0.12) * 255);
      orm[i * 4 + 2] = Math.round(sat(0.62 + 0.33 * wear - 0.28 * grime - rust * 0.4) * 255);
      orm[i * 4 + 3] = 255;
    }
    const dt = (data, srgb) => {
      const t = new T.DataTexture(data, S, S, T.RGBAFormat, T.UnsignedByteType);
      t.wrapS = t.wrapT = T.RepeatWrapping; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter;
      t.generateMipmaps = true; t.anisotropy = 4; t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace; t.needsUpdate = true;
      return t;
    };

    // decal atlas: lettering, hazard stripes, hull number
    const dc = document.createElement('canvas'); dc.width = 1024; dc.height = 512;
    const d = dc.getContext('2d');
    const font = 'Impact, "Arial Narrow Bold", "Helvetica Neue Condensed Bold", "Arial Black", sans-serif';
    d.textBaseline = 'middle'; d.textAlign = 'center';
    d.fillStyle = '#e9e6dc'; d.font = `150px ${font}`;
    d.fillText('SF-07 WARDEN', 512, 96, 1000);
    d.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 16; i++) d.fillRect(40 + i * 62 + 20, 0, 5, 200);       // stencil bridges
    d.globalCompositeOperation = 'source-over';
    d.save(); d.beginPath(); d.rect(8, 216, 496, 288); d.clip();              // hazard stripes
    d.fillStyle = '#d2452c'; d.fillRect(0, 210, 512, 300);
    d.fillStyle = '#121212';
    for (let i = -6; i < 14; i++) { d.beginPath(); d.moveTo(i * 80, 510); d.lineTo(i * 80 + 40, 510); d.lineTo(i * 80 + 340, 210); d.lineTo(i * 80 + 300, 210); d.fill(); }
    d.restore();
    d.fillStyle = '#e9e6dc'; d.font = `300px ${font}`; d.fillText('07', 768, 372);
    d.globalCompositeOperation = 'destination-out';                            // chipped paint
    for (let i = 0; i < 900; i++) {
      const px = rnd() * 1024, py = rnd() * 512, r = rnd() * rnd() * 5;
      d.beginPath(); d.arc(px, py, r, 0, 6.3); d.fill();
    }
    for (let i = 0; i < 40; i++) { d.fillRect(rnd() * 1024, rnd() * 512, 20 + rnd() * 80, 1 + rnd() * 2); }
    const decal = new T.CanvasTexture(dc);
    decal.colorSpace = T.SRGBColorSpace; decal.anisotropy = 4;
    return { map: dt(alb, true), orm: dt(orm, false), normalMap, decal };
  }
  // atlas rects [u0, v0, u1, v1]
  const UV_NAME = [0.0, 0.62, 1.0, 1.0], UV_HAZ = [0.012, 0.02, 0.488, 0.57], UV_NUM = [0.56, 0.03, 0.94, 0.56];

  // ------------------------------------------------------------------ part builders
  const L_WARM = [2.2, 1.5, 0.75];
  function lightRow(g, n, p0, step, size, color) {
    g.light(color || L_WARM);
    for (let i = 0; i < n; i++) g.at(p0[0] + step[0] * i, p0[1] + step[1] * i, p0[2] + step[2] * i).box(size[0], size[1], size[2]);
    g.hull();
  }
  function glow(g, slot, fn) { const c = g.c; g.mat(slot).col([1, 1, 1]); g.vary = 0; fn(); g.vary = 0.07; g.mat(SLOT.HULL).col(c); }

  function buildPelvis(g) {
    g.hull(GREY).at(0, 0.8, 0).cbox(15.5, 8.6, 12.5, 1.6);
    g.col(MID).at(0, 3.6, 0).cyl(6.6, 6.6, 3.6, 16);
    g.col(DARK).at(0, -5.0, 0).cbox(7.4, 8, 10.5, 1.5);
    g.col(GREY2).at(0, -4.4, 5.2, 0.22).cbox(6, 8.5, 1.7, 0.6);
    for (const sx of [1, -1]) {
      g.col(MID).rod([sx * 4.8, 0, 0], [sx * 11.6, 0, 0], 5.0, 16);
      g.col(GREY2).at(sx * 4.7, -1.6, 6.8, 0.2, 0, 0).cbox(6.4, 9.2, 1.5, 0.5);
      g.col(GREY).at(sx * 4.8, -1.0, -6.9, -0.2, 0, 0).cbox(6.8, 8.8, 1.7, 0.5);
      g.col(CHROME).rod([sx * 2.9, -1.5, 5.0], [sx * 3.3, 5.6, 5.8], 0.42, 8);
    }
    g.col(ORANGE).at(0, 4.0, 6.36).box(9.5, 1.2, 0.3);
    lightRow(g, 5, [-3.2, 1.6, 6.3], [1.6, 0, 0], [0.42, 0.42, 0.12]);
  }

  function buildThigh(g, sx) {
    g.hull(DARK).at(0, -THIGH, 0).frustum(5.8, 6.2, 7.2, 7.6, THIGH);
    g.col(GREY).at(sx * 3.0, -1.2, 0).cbox(7, 8.6, 10.4, 1.5);
    g.col(GREY).at(0, -10.6, 3.6, -0.04).cbox(9.2, 16, 3.1, 1.0);
    g.col(GREY2).at(0, -9.5, 5.3, -0.04).cbox(5.2, 8, 0.7, 0.25);
    g.col(GREY2).at(sx * 4.3, -10, 0, 0, 0, sx * 0.04).cbox(2.6, 15, 9, 0.9);
    g.col(GREY).at(0, -11.5, -3.8).cbox(7.2, 11.5, 2.1, 0.7);
    g.col(ORANGE).at(0, -4.3, 5.17).box(9.2, 1.4, 0.2);
    g.col(MID).rod([-sx * 3.5, -2.5, -1.2], [-sx * 3.8, -11.5, -1.0], 0.9, 8);
    g.col(CHROME).rod([-sx * 3.8, -11.5, -1.0], [-sx * 3.6, -19, -0.6], 0.52, 8);
    g.at(sx * 5.68, -10.2, 0, 0, sx * Math.PI / 2, 0).decal(7.2, 4.0, UV_HAZ);
  }

  function buildShin(g, sx) {
    g.hull(MID).rod([-4.8, 0, 0], [4.8, 0, 0], 4.4, 16);
    g.col(GREY2).at(0, 0.6, 4.6, -0.14).cbox(8.2, 8, 2.9, 1.1);
    g.col(ORANGE).at(0, 2.0, 6.02, -0.14).box(5.4, 1.3, 0.2);
    g.col(DARK).at(0, -SHIN, 0).frustum(6.6, 7.6, 5.8, 5.8, SHIN);
    g.col(GREY).at(0, -11, 1.3).cbox(10.2, 15.5, 8.4, 1.5);
    g.col(GREY2).at(0, -9.5, -4.6).cbox(7, 11, 3.5, 1.0);
    g.col(GREY2).at(sx * 5.4, -10, 0.8).cbox(1.4, 11.5, 6.2, 0.5);
    g.col(MID).rod([-4.1, -SHIN, 0], [4.1, -SHIN, 0], 3.2, 12);
    g.col(DARK).rod([0, -6, -6.0], [0, -8.8, -7.8], 1.5, 10, 2.1);
    glow(g, SLOT.THRUST, () => g.rod([0, -8.75, -7.75], [0, -8.85, -7.82], 1.7, 10));
    g.light(L_AMBER).at(0, -3.9, 5.6).box(3.2, 0.45, 0.25);
    g.hull(GREY);
  }

  function buildFoot(g) {
    g.hull(GREY).at(0, -2, 3).cbox(11.2, 4, 20, 1.2);
    g.col(GREY2).at(0, -1.3, 11).cbox(11.8, 5.4, 6.2, 1.3);
    g.col(MID).at(0, -1.5, -6.2).cbox(9, 5, 5.4, 1.0);
    g.col(MID).at(0, 0.6, 1.5).cbox(7.6, 2.2, 8.6, 0.8);
  }

  function buildTorso(g) {
    // abdomen
    g.hull(MID).at(0, 3.0, 0).cbox(13, 6.2, 11.2, 1.2);
    g.col(DARK).at(0, 6.9, 0).cbox(15, 2.4, 12.2, 0.8);
    g.col(GREY).at(0, 9.6, 0).cbox(21.5, 4.8, 14.6, 1.5);
    // chest
    g.col(GREY).at(0, 15.6, -0.5).cbox(26.5, 12.6, 16.6, 2.3);
    g.col(GREY2).at(0, 21.3, 7.0, -0.10).cbox(17.5, 3.2, 2.0, 0.5);
    g.at(0, 21.41, 8.06, -0.10).decal(15.8, 2.15, UV_NAME);
    for (const sx of [1, -1]) {
      g.col(CHROME).rod([sx * 4.6, 0.5, 5.6], [sx * 5.6, 8.0, 6.6], 0.5, 8);
      g.col(MID).rod([sx * 4.9, 4.4, 6.0], [sx * 5.7, 8.4, 6.7], 0.85, 8);
      g.col(GREY2).at(sx * 7.9, 15.0, 7.9, -0.14, sx * 0.12, 0).cbox(9.6, 9.4, 2.4, 0.9);
      g.col(ORANGE).at(sx * 11.2, 11.2, 8.4, -0.14, sx * 0.12, 0).box(2.8, 1.2, 1.0);
      // shoulder yoke
      g.col(GREY).at(sx * 14.2, SH_Y, 0).cbox(8.6, 9.2, 13, 1.6);
      g.col(MID).rod([sx * 12.2, SH_Y, 0], [sx * 19, SH_Y, 0], 5.0, 16);
      // collar
      g.col(GREY2).at(sx * 7.2, 24.0, -1.0, 0, 0, -sx * 0.22).cbox(2.8, 6.6, 12.4, 1.0);
      // exhaust stacks: a ship's funnels behind the shoulders
      g.push(sx * 8.4, 19.6, -8.8, -0.2, 0, 0);
      g.col(MID).at(0, 0, 0).frustum(5, 5.4, 3.9, 4.3, 13);
      g.col(ORANGE).at(0, 10.8, 0).box(4.36, 1.2, 4.76);
      g.col(DARK).at(0, 13, 0).frustum(3.1, 3.5, 3.1, 3.5, 0.5);
      g.col(GREY2);
      for (let i = 0; i < 7; i++) g.at(0, 1.4 + i * 1.25, -(2.78 - i * 0.055)).box(1.3, 0.16, 0.22);   // ladder
      g.light(L_RED).at(0, 13.8, 0).box(0.7, 0.7, 0.7);
      g.hull();
      g.pop();
      // navigation lights: red to port (left, +X), green to starboard
      g.light(sx > 0 ? L_RED : L_GREEN).at(sx * 12.3, 20.9, 7.72).box(1.3, 0.8, 0.4);
      g.light(L_WHITE).at(sx * 10.6, 9.2, 7.42).box(2.0, 0.85, 0.3);
      g.hull();
      lightRow(g, 3, [sx * 6.6, 10.6, 7.36], [sx * 1.3, 0, 0], [0.4, 0.4, 0.12]);
      // back thrusters
      g.col(DARK).rod([sx * 5.4, 9, -12.6], [sx * 5.9, 5.4, -15.4], 2.1, 12, 2.8);
      glow(g, SLOT.THRUST, () => g.rod([sx * 5.89, 5.46, -15.35], [sx * 5.91, 5.36, -15.43], 2.35, 12));
      // handrail along the chest top
      g.col(MID);
      for (const px of [5, 8, 11]) g.beam([sx * px, 21.9, 6.2], [sx * px, 23.1, 6.2], 0.16, 0.16);
      g.beam([sx * 5, 23.1, 6.2], [sx * 11, 23.1, 6.2], 0.16, 0.16);
    }
    g.col(GREY2).at(0, 24.6, -7.4).cbox(14, 6.6, 2.8, 1.0);
    g.col(GREY2).at(0, 22.8, 6.0, -0.5).cbox(10, 2.2, 2.8, 0.6);
    g.col(MID).at(0, 21.5, 1).cyl(4.3, 4.3, 6.5, 14);
    // reactor intake: louvres over the glow
    g.col(DARK).at(0, 14.4, 8.0).cbox(9.8, 6.4, 1.8, 0.5);
    glow(g, SLOT.REACTOR, () => g.at(0, 14.4, 8.93).box(8.4, 5.0, 0.1));
    g.col(GREY2);
    for (let i = -2; i <= 2; i++) g.at(0, 14.4 + i * 1.02, 9.3, 0.6, 0, 0).box(8.8, 0.3, 0.95);
    g.col(MID);
    for (const sx of [1, -1]) g.at(sx * 4.6, 14.4, 9.25).box(0.6, 5.9, 1.2);
    g.at(0, 17.25, 9.25).box(9.8, 0.5, 1.2); g.at(0, 11.55, 9.25).box(9.8, 0.5, 1.2);
    // back pack
    g.col(GREY).at(0, 14.2, -10.6).cbox(19.5, 14.4, 5.6, 1.5);
    g.col(GREY2).at(0, 19, -13.5).cbox(12.5, 3.3, 0.6, 0.2);
    g.at(0, 19, -13.84, 0, Math.PI, 0).decal(11.6, 1.8, UV_NAME);
    g.col(DARK).at(0, 12.4, -13.5).cbox(8, 6.2, 0.8, 0.3);
    lightRow(g, 6, [-4, 8.3, -13.44], [1.6, 0, 0], [0.42, 0.42, 0.12]);
  }

  function buildUpperArm(g, sx) {
    g.push(sx * 2.8, 1.4, 0, 0, 0, -sx * 0.12);
    g.hull(GREY).at(0, 0, 0).cbox(11.8, 9.6, 14.4, 2.1);
    g.col(ORANGE).at(sx * 0.4, 4.95, 0).cbox(7.4, 0.6, 10, 0.2);
    g.at(sx * 5.98, -0.2, 0, 0, sx * Math.PI / 2, 0).decal(5.0, 4.2, UV_NUM);
    g.light(sx > 0 ? L_RED : L_GREEN).at(sx * 2.4, 0.6, 7.3).box(1.5, 0.8, 0.3);
    g.hull(MID);
    for (const pz of [-4.6, 0, 4.6]) g.beam([sx * 3.8, 4.8, pz], [sx * 3.8, 6.4, pz], 0.16, 0.16);        // handrail
    g.beam([sx * 3.8, 6.4, -4.6], [sx * 3.8, 6.4, 4.6], 0.16, 0.16);
    g.pop();
    g.col(GREY2).at(sx * 7.0, -5.2, 0, 0, 0, sx * 0.14).cbox(2.2, 7, 11.4, 0.8);
    g.col(DARK).at(0, -UPPER, 0).frustum(5.4, 5.4, 6.4, 6.4, UPPER);
    g.col(GREY).at(sx * 0.5, -10.8, 0.3).cbox(7.8, 10, 7.8, 1.2);
    g.col(MID).rod([0, -4, -4.0], [0, -10.5, -4.2], 0.9, 8);
    g.col(CHROME).rod([0, -10.5, -4.2], [0, -17, -3.4], 0.52, 8);
  }

  function buildForearm(g, sx, right) {
    g.hull(MID).rod([-4.4, 0, 0], [4.4, 0, 0], 4.0, 16);
    g.col(GREY).at(0, -16.6, 0).frustum(9.8, 9.8, 7.4, 7.4, 14.8);
    g.col(GREY2).at(sx * 4.8, -10, 0).cbox(2.0, 12.4, 9.4, 0.8);
    g.at(sx * 5.86, -10, 0, 0, sx * Math.PI / 2, 0).decal(7.6, 4.2, UV_HAZ);
    g.col(ORANGE).at(0, -15.7, 0).box(10.2, 1.5, 10.2);
    g.col(MID).at(0, -19.0, 0).cyl(3.8, 3.8, 2.4, 14);
    // fist
    g.col(MID).at(0, -22.6, 0).cbox(8.8, 7.6, 9.2, 1.6);
    g.col(GREY2);
    for (const kx of [-3.2, -1.07, 1.07, 3.2]) g.at(kx, -26.6, 0.4).cbox(1.9, 1.6, 7.6, 0.5);
    g.col(MID).at(-sx * 4.9, -22, 2.3).cbox(1.7, 5.2, 4, 0.6);
    g.col(GREY).at(0, -22, 4.9).cbox(7.6, 5.2, 1.1, 0.4);
    if (right) {
      // forearm cannon on the dorsal side (+Z here; it faces up when the arm points forward)
      g.col(MID).at(0, -8.8, 6.1).cbox(5.8, 13.4, 4.8, 1.0);
      g.col(GREY2).at(0, -3.8, 6.4).cbox(6.6, 2.8, 5.2, 0.6);
      g.col(DARK).rod([0, -14.8, 6.4], [0, -23.4, 6.4], 1.9, 14);
      g.col(GREY2).rod([0, -22.1, 6.4], [0, -23.7, 6.4], 2.45, 14);
      g.col(CHROME).rod([2.4, -7.6, 8.7], [2.4, -19, 7.4], 0.36, 6);
      glow(g, SLOT.CANNON, () => {
        g.rod([0, -23.72, 6.4], [0, -23.8, 6.4], 1.5, 14);
        for (const cy of [-6.2, -9, -11.8]) g.at(0, cy, 6.1).box(6.05, 0.45, 5.05);
      });
    } else {
      // bulwark plate on the left forearm
      g.col(GREY).at(0, -9.6, 5.4).cbox(8.4, 16, 2.2, 1.0);
      g.col(ORANGE).at(0, -3.3, 6.55).box(8.4, 1.3, 0.2);
      g.col(GREY2).at(0, -10.4, 6.7).cbox(4.6, 8.4, 0.8, 0.3);
    }
  }

  function buildHead(g) {
    g.hull(GREY).at(0, 1.5, -0.6).cbox(11.2, 8.6, 12.6, 2.0);
    g.col(GREY2).at(0, 5.0, 3.7, 0.2).cbox(11.8, 2.2, 7, 0.7);
    g.col(GLASS).at(0, 2.2, 5.6).cbox(9.6, 2.7, 1.2, 0.4);
    g.col(ORANGE).at(0, 6.3, -1.6).cbox(2.3, 1.6, 10.5, 0.5);
    g.col(MID).at(0, -2.7, 4.9, 0.3).cbox(5.6, 3.6, 3.6, 0.8);
    for (const sx of [1, -1]) {
      g.col(GLASS).at(sx * 5.45, 2.2, 2.6).cbox(0.6, 2.5, 6, 0.25);
      g.col(GREY).at(sx * 4.7, -1.7, 3.6, 0, 0, sx * 0.25).cbox(3.4, 5.2, 6.6, 0.8);
      g.col(MID).rod([sx * 5.4, 1, -2.4], [sx * 6.9, 1, -2.4], 2.1, 12);
    }
    g.col(MID).at(-3.7, 5.6, -4.2).cyl(0.4, 0.25, 7.8, 6);
    g.col(MID).at(3.9, 5.6, -5.2).cyl(0.22, 0.12, 4.6, 5);
    g.light(L_WHITE).at(-3.7, 13.7, -4.2).box(0.6, 0.6, 0.6);
    g.light([1.3, 0.6, 0.16]).at(0, 2.2, 6.24).box(8.8, 0.3, 0.06);
    g.hull(GREY);
    lightRow(g, 4, [-2.1, -0.4, 5.72], [1.4, 0, 0], [0.36, 0.36, 0.1]);
  }

  function buildRadar(g) {
    g.hull(MID).at(0, 0, 0).cyl(0.5, 0.4, 1.6, 6);
    g.col(GREY2).at(0, 2.1, 0).cbox(6.6, 1.2, 0.5, 0.15);
  }

  // Cockpit interior, real scale, built around the eye point (local origin = eye).
  // +Z forward, +X = pilot's left. Open canopy: windshield, quarter lights, skylights.
  function buildCockpit(g) {
    const IN0 = [0.016, 0.018, 0.021], IN1 = [0.034, 0.038, 0.044], IN2 = [0.058, 0.062, 0.068], STRAP = [0.30, 0.045, 0.03];
    const AMB = [0.95, 0.36, 0.07], CYN = [0.11, 0.60, 0.76], RED = [1.3, 0.1, 0.05];
    const lit = (c) => { g.mat(SLOT.LIGHT).col(c); g.vary = 0; return g; };
    const dull = (c) => { g.mat(SLOT.INT).col(c); g.vary = 0.05; return g; };
    const FL = -1.6, SILL = -1.32, HDR = 1.72, WZ = 2.65, WX = 2.05, SWX = 2.45;
    // shell
    dull(IN0).at(0, FL - 0.05, 0.7).box(5.3, 0.1, 5.2);
    g.at(0, 0.0, -1.5).box(5.3, 3.4, 0.12);                       // back wall
    g.at(0, 1.1, -0.6).box(5.3, 0.1, 1.9);                        // solid roof behind the skylights
    for (const sx of [1, -1]) {
      dull(IN0).at(sx * SWX, (FL - 1.0) / 2, 0.55).box(0.12, 0.6, 4.3);                 // side wall below the sill
      g.at(sx * SWX, 0.0, -0.95).box(0.12, 2.3, 1.15);                                  // rear quarter panel
      g.col(IN1).beam([sx * WX, SILL - 0.1, WZ + 0.1], [sx * WX, HDR, WZ - 0.12], 0.075, 0.11);  // A-pillar
      g.beam([sx * SWX, -1.0, 1.55], [sx * SWX, 1.38, 1.55], 0.07, 0.1);                // quarter pillar
      g.beam([sx * SWX, -1.0, -0.36], [sx * SWX, 1.1, -0.36], 0.1, 0.16);               // B-pillar
      g.beam([sx * WX, HDR, WZ - 0.12], [sx * SWX, 1.38, 1.55], 0.08, 0.08);            // roof rail, front
      g.beam([sx * SWX, 1.38, 1.55], [sx * SWX, 1.1, -0.36], 0.08, 0.08);               // roof rail, rear
      g.beam([sx * WX, SILL, WZ + 0.08], [sx * SWX, -1.0, 1.55], 0.08, 0.1);            // quarter-light sill
      g.beam([sx * SWX, -1.0, 1.55], [sx * SWX, -1.0, -0.36], 0.08, 0.1);               // side sill
      g.col(IN0).poly([[sx * WX, FL, WZ + 0.1], [sx * WX, SILL, WZ + 0.1], [sx * SWX, -1.0, 1.55], [sx * SWX, FL, 1.55]]);
      g.col(IN1).beam([sx * 0.72, HDR, WZ - 0.12], [sx * 0.72, 1.12, 0.3], 0.055, 0.07);  // skylight rib
      g.beam([sx * 0.62, HDR + 0.02, WZ - 0.1], [sx * WX, 0.98, WZ - 0.02], 0.06, 0.06);  // corner gusset
      g.beam([sx * 0.72, 1.42, 1.45], [sx * SWX, 1.38, 1.55], 0.045, 0.045);              // cross tie
      g.col(IN2).beam([sx * (WX - 0.02), 0.25, WZ - 0.06], [sx * (WX - 0.02), 0.6, WZ - 0.1], 0.04, 0.2);  // grab handle
      // side console with instrument strips
      dull(IN1).at(sx * 2.02, -1.22, 0.6).box(0.7, 0.5, 2.4);
      g.col(IN2).at(sx * 1.98, -0.95, 0.6, 0, 0, sx * 0.25).box(0.62, 0.05, 2.3);
      for (let i = 0; i < 9; i++) lit(i % 4 === 1 ? CYN : AMB).at(sx * (1.98 + (i % 2) * 0.12), -0.9 - (i % 2) * 0.03, -0.3 + i * 0.2, 0, 0, sx * 0.25).box(0.09, 0.012, 0.05);
    }
    dull(IN1).at(0, HDR, WZ - 0.12).box(4.25, 0.1, 0.14);                               // windshield header
    g.at(0, 1.12, 0.33).box(5.0, 0.09, 0.14);                                           // skylight rear frame
    g.at(0, 1.42, 1.45).box(1.5, 0.045, 0.05);
    g.col(IN2).beam([-0.25, SILL + 0.06, WZ + 0.02], [1.25, SILL + 0.16, WZ - 0.02], 0.025, 0.03);  // parked wiper
    g.beam([0.5, SILL + 0.02, WZ + 0.04], [0.5, SILL + 0.11, WZ], 0.03, 0.03);
    // overhead pod
    g.col(IN2).at(0, 1.6, 2.36, 0.35).cbox(0.46, 0.1, 0.24, 0.02);
    lit(AMB).at(0, 1.548, 2.335, 0.35).box(0.26, 0.008, 0.03);
    // dash: slopes down toward the windshield so its top faces the pilot
    dull(IN0).at(0, (FL + SILL) / 2 - 0.05, 2.05).box(4.9, 0.5, 1.5);
    g.col(IN1).poly([[-2.45, -1.02, 1.3], [2.45, -1.02, 1.3], [WX + 0.1, SILL, WZ + 0.1], [-WX - 0.1, SILL, WZ + 0.1]]);
    g.col(IN0).poly([[-2.45, -1.02, 1.3], [2.45, -1.02, 1.3], [2.45, FL, 1.3], [-2.45, FL, 1.3]]);
    g.col(IN2).at(0, -1.0, 1.32).box(4.9, 0.04, 0.05);                                  // coaming lip
    for (const px of [-1.5, 1.5]) g.col(IN0).at(px, -1.13, 2.0, -0.27, 0, 0).box(0.9, 0.012, 0.9);   // glare panels
    // binnacle: the central instrument pod
    g.push(0, -0.96, 1.92, -0.5, 0, 0);
    dull(IN1).at(0, 0, 0).cbox(0.96, 0.3, 0.3, 0.05);
    g.col(IN0).at(0, 0, -0.145).box(0.86, 0.22, 0.02);
    for (let i = 0; i < 9; i++) {                                                       // bar gauges
      const hgt = 0.03 + 0.09 * (0.5 + 0.5 * Math.sin(i * 2.3 + 1));
      lit(AMB).at(-0.37 + i * 0.04, -0.07 + hgt / 2, -0.158).box(0.022, hgt, 0.006);
    }
    lit(CYN).at(0.2, 0.05, -0.158).box(0.3, 0.014, 0.006);
    g.at(0.15, 0.015, -0.158).box(0.2, 0.014, 0.006);
    g.at(0.18, -0.02, -0.158).box(0.26, 0.014, 0.006);
    lit(AMB).at(0.2, -0.062, -0.158).box(0.3, 0.014, 0.006);
    lit(RED).at(-0.38, 0.075, -0.158).box(0.03, 0.02, 0.006);
    g.pop();
    dull(IN1).beam([0, -1.25, 1.9], [0, -1.05, 1.92], 0.26, 0.18);
    // tell-tales along the windshield base
    for (let i = -8; i <= 8; i++) {
      if (i === 0) continue;
      lit(Math.abs(i) % 4 === 2 ? CYN : AMB).at(i * 0.215, SILL + 0.075, WZ - 0.1).box(0.05, 0.016, 0.02);
    }
    // second station, forward right (-X): the other pilot's empty seat and harness
    g.push(-1.26, -0.13, 1.2, 0.1, 0.12, 0);
    dull(IN1).at(0, -1.02, 0).cbox(0.54, 0.9, 0.12, 0.05);
    g.col(IN2).at(0, -0.50, -0.01).cbox(0.28, 0.2, 0.11, 0.04);
    g.col(IN1).at(0, -0.63, 0).box(0.09, 0.12, 0.06);
    g.col(STRAP).at(-0.13, -0.98, -0.07).box(0.05, 0.74, 0.012);
    g.at(0.13, -0.98, -0.07).box(0.05, 0.74, 0.012);
    g.col(IN2).at(0, -0.95, -0.08).box(0.32, 0.045, 0.014);
    g.col(IN0).at(0, -1.5, 0.22).box(0.54, 0.12, 0.5);
    g.pop();
    dull(IN1).beam([-1.26, -1.6, 1.28], [-1.26, -1.1, 1.24], 0.1, 0.1);
  }

  // ------------------------------------------------------------------ IK helpers
  const _d = new V(), _pp = new V(), _bx = new V(), _by = new V(), _bz = new V(), _mb = new T.Matrix4();
  // Two-bone IK. Writes the elbow into E and the reachable hand into Hd.
  function ik2(S, Tg, l1, l2, pole, E, Hd) {
    _d.subVectors(Tg, S);
    let dist = _d.length();
    _d.multiplyScalar(1 / Math.max(dist, 1e-4));
    dist = clamp(dist, Math.abs(l1 - l2) + 0.2, (l1 + l2) * 0.988);
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
    _pp.copy(pole).addScaledVector(_d, -pole.dot(_d));
    if (_pp.lengthSq() < 1e-6) _pp.set(0, 0, -1);
    _pp.normalize();
    E.copy(S).addScaledVector(_d, a).addScaledVector(_pp, h);
    Hd.copy(S).addScaledVector(_d, dist);
  }
  // Quaternion for a bone built along local -Y pointing along `dir`, local +X kept near parent +X.
  // `dorsal` (optional) pulls local +Z (the back of the forearm) toward that direction by weight w.
  const _bw = new V();
  function boneQuat(dir, q, dorsal, w) {
    _by.copy(dir).negate();
    _bx.set(1, 0, 0);
    if (Math.abs(_by.x) > 0.93) _bx.set(0, 0, 1);
    _bx.addScaledVector(_by, -_bx.dot(_by)).normalize();
    _bz.crossVectors(_bx, _by);
    if (dorsal && w > 0.001) {
      _bw.copy(dorsal).addScaledVector(_by, -dorsal.dot(_by));
      if (_bw.lengthSq() > 1e-4) {
        _bz.lerp(_bw.normalize(), w).addScaledVector(_by, -_bz.dot(_by)).normalize();
        _bx.crossVectors(_by, _bz);
      }
    }
    _mb.makeBasis(_bx, _by, _bz);
    return q.setFromRotationMatrix(_mb);
  }
  const ease = (u) => { u = sat(u); return u * u * (3 - 2 * u); };

  // ------------------------------------------------------------------ arm poses
  // Pure functions of (state, t). Positions are in torso base space with x > 0 = outward.
  const A_IDLE = new V(14.5, -8, 8), A_COCK = new V(19, 13, -8), A_HIT = new V(3.5, 24, 48);
  const A_UP = new V(7, 47, 6), A_SLAM = new V(4, 18, 43), A_BLOCK = new V(2, 21.5, 25), A_AIM = new V(10, 16.5, 38);
  const P_IDLE = new V(0.6, -0.3, -1), P_PUNCH = new V(1, -0.35, -0.5), P_UP = new V(1, 0, -0.4), P_BLOCK = new V(1, 0.1, 0.1), P_AIM = new V(0.45, -1, -0.3), P_DOWN = new V(0.4, -1, -0.25);
  const DORSAL_FWD = new V(0, 0.3, 1).normalize();
  const _idle = new V();
  function armPose(st, t, ctx, o) {
    const P = o.p, pole = o.pole;
    _idle.copy(A_IDLE); _idle.z += ctx.swing * 4.5; _idle.y += Math.abs(ctx.swing) * 1.0;
    o.yaw = 0; o.lean = 0; o.roll = 0;
    const pt = Math.tan(clamp(ctx.pitch, -0.5, 0.5));
    if (st === 'punch') {
      const h = DUR.punch.hit, d = DUR.punch.dur, tw = h * 0.42, hold = 0.07;
      const hy = A_HIT.y + pt * 34;
      if (t < tw) {
        const u = ease(t / tw);
        P.lerpVectors(_idle, A_COCK, u); pole.lerpVectors(P_IDLE, P_PUNCH, u);
        o.yaw = -0.16 * u; o.lean = -0.03 * u;
      } else if (t < h) {
        let u = (t - tw) / (h - tw); u = Math.pow(u, 1.5);
        P.lerpVectors(A_COCK, A_HIT, u); P.y = lerp(A_COCK.y, hy, u); P.x += Math.sin(u * Math.PI) * 4.5;
        pole.copy(P_PUNCH);
        o.yaw = lerp(-0.16, 0.42, u); o.lean = lerp(-0.03, 0.13, u);
      } else if (t < h + hold) {
        P.copy(A_HIT); P.y = hy; P.z += 2.5 * ((t - h) / hold); pole.copy(P_PUNCH);
        o.yaw = 0.44; o.lean = 0.14;
      } else {
        const u = ease((t - h - hold) / (d - h - hold));
        P.copy(A_HIT); P.y = hy; P.z += 2.5; P.lerp(_idle, u); pole.lerpVectors(P_PUNCH, P_IDLE, u);
        o.yaw = 0.44 * (1 - u); o.lean = 0.14 * (1 - u);
      }
    } else if (st === 'slam') {
      const h = DUR.slam.hit, d = DUR.slam.dur, tr = h * 0.62, hold = 0.12;
      const sy = A_SLAM.y + pt * 22;
      if (t < tr) {
        const u = ease(t / tr);
        P.lerpVectors(_idle, A_UP, u); P.z += Math.sin(u * Math.PI) * 9; pole.lerpVectors(P_IDLE, P_UP, u);
        o.lean = -0.07 * u;
      } else if (t < h) {
        let u = (t - tr) / (h - tr); u = Math.pow(u, 1.7);
        P.lerpVectors(A_UP, A_SLAM, u); P.y = lerp(A_UP.y, sy, u); P.z += Math.sin(u * Math.PI) * 10; pole.lerpVectors(P_UP, P_DOWN, sat(u * 1.6));
        o.lean = lerp(-0.07, 0.15, u);
      } else if (t < h + hold) {
        P.copy(A_SLAM); P.y = sy - 3 * ((t - h) / hold); pole.copy(P_DOWN); o.lean = 0.16;
      } else {
        const u = ease((t - h - hold) / (d - h - hold));
        P.copy(A_SLAM); P.y = sy - 3; P.lerp(_idle, u); pole.lerpVectors(P_DOWN, P_IDLE, u); o.lean = 0.16 * (1 - u);
      }
    } else if (st === 'block') {
      P.copy(A_BLOCK); P.y += pt * 14 + Math.sin(ctx.time * 9) * 0.12; pole.copy(P_BLOCK); o.lean = -0.025; o.yaw = 0.05; o.roll = 1;
    } else if (st === 'charge') {
      P.copy(A_AIM); P.y += pt * 33;
      const j = ctx.charge * 0.22;
      P.x += Math.sin(ctx.time * 61) * j; P.y += Math.sin(ctx.time * 47 + 1) * j;
      pole.copy(P_AIM); o.yaw = 0.10;
    } else if (st === 'fire') {
      const k = Math.exp(-t * 7);
      P.copy(A_AIM); P.y += pt * 33 + 2.0 * k; P.z -= 11 * k; P.x += 1.5 * k;
      pole.copy(P_AIM); o.yaw = 0.10 - 0.16 * k; o.lean = -0.035 * k;
    } else {
      P.copy(_idle); pole.copy(P_IDLE);
    }
  }

  // ------------------------------------------------------------------ create
  function create() {
    const tex = makeTextures();
    const hullMat = new T.MeshStandardMaterial({
      vertexColors: true, map: tex.map, normalMap: tex.normalMap, normalScale: new T.Vector2(1.0, 1.0),
      roughnessMap: tex.orm, metalnessMap: tex.orm, roughness: 1, metalness: 1, envMapIntensity: 1.15,
    });
    const decalMat = new T.MeshStandardMaterial({
      map: tex.decal, alphaTest: 0.5, roughness: 0.62, metalness: 0.25, vertexColors: true,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const lightMat = new T.MeshBasicMaterial({ vertexColors: true });
    const cabLightMat = new T.MeshBasicMaterial({ vertexColors: true });
    const reactorMat = new T.MeshBasicMaterial({ color: 0xffffff });
    const thrustMat = new T.MeshBasicMaterial({ color: 0x000000 });
    const cannonMat = new T.MeshBasicMaterial({ color: 0x000000 });
    const intMat = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.1, envMapIntensity: 0.3 });
    const mats = [];
    mats[SLOT.HULL] = hullMat; mats[SLOT.LIGHT] = lightMat; mats[SLOT.REACTOR] = reactorMat; mats[SLOT.DECAL] = decalMat;
    mats[SLOT.THRUST] = thrustMat; mats[SLOT.CANNON] = cannonMat; mats[SLOT.INT] = intMat;
    const cabMats = mats.slice(); cabMats[SLOT.LIGHT] = cabLightMat;

    let tris = 0;
    const part = (fn, seed, a, b, m) => { const g = new Geo(seed); fn(g, a, b); const mesh = g.build(m || mats); tris += g.tris; return mesh; };

    const group = new T.Group(); group.name = 'mech';
    const body = new T.Group(); body.position.y = HIP_Y; group.add(body);
    body.add(part(buildPelvis, 21));

    const legs = [1, -1].map((sx, i) => {
      const thigh = part(buildThigh, 31 + i, sx);
      thigh.position.set(sx * HIP_X, 0, 0); body.add(thigh);
      const shin = part(buildShin, 41 + i, sx);
      shin.position.set(0, -THIGH, 0); thigh.add(shin);
      const foot = part(buildFoot, 51 + i);
      foot.position.set(0, -SHIN, 0); shin.add(foot);
      return { sx, side: -sx, thigh, shin, foot, off: sx > 0 ? 0 : 0.5, prevP: sx > 0 ? 0 : 0.5, qT: new T.Quaternion(), qS: new T.Quaternion() };
    });

    const torso = new T.Group(); torso.position.set(0, WAIST, 0); body.add(torso);
    torso.add(part(buildTorso, 61));

    const arms = [1, -1].map((sx, i) => {
      const upper = part(buildUpperArm, 71 + i, sx);
      upper.position.set(sx * SH_X, SH_Y, 0); torso.add(upper);
      const fore = part(buildForearm, 81 + i, sx, sx < 0);
      fore.position.set(0, -UPPER, 0); upper.add(fore);
      const fistAnchor = new T.Object3D(); fistAnchor.position.set(0, -FIST, 0); fore.add(fistAnchor);
      const mk = () => ({ p: new V().copy(A_IDLE), pole: new V().copy(P_IDLE), yaw: 0, lean: 0, roll: 0 });
      return { sx, side: -sx, upper, fore, fistAnchor, state: 'idle', lastT: 0, w: 1, bd: 0.12, cur: mk(), from: mk(), tgt: mk(), S: new V(sx * SH_X, SH_Y, 0) };
    });
    const muzzleAnchor = new T.Object3D(); muzzleAnchor.position.set(0, -24.2, 6.4); arms[1].fore.add(muzzleAnchor);

    const head = new T.Group(); head.position.set(0, HEAD_Y, HEAD_Z); head.rotation.order = 'YXZ'; torso.add(head);
    const headExt = part(buildHead, 91); head.add(headExt);
    const radar = part(buildRadar, 95); radar.position.set(2.9, 5.9, -3.4); head.add(radar);
    const cockpit = part(buildCockpit, 97, 0, 0, cabMats); cockpit.position.copy(EYE); head.add(cockpit);
    const eye = new T.Object3D(); eye.position.copy(EYE); head.add(eye);
    // The cockpit surrounds the camera: its bounding sphere must never be culled away.
    cockpit.frustumCulled = false;

    const st = {
      time: 0, phase: 0, gait: 0, gaitMove: 0, dirX: 0, dirZ: 1, twist: 0, pitch: 0, jolt: 0, joltV: 0, view: 'tp',
      stagger: 0, dash: 0,
    };
    const ctx = { swing: 0, pitch: 0, charge: 0, time: 0 };
    const _S = new V(), _T = new V(), _E = new V(), _H = new V(), _pole = new V(), _dir = new V(), _w = new V();
    const _qa = new T.Quaternion(), _qb = new T.Quaternion(), _qx = new T.Quaternion(), _qe = new T.Quaternion(), _qi = new T.Quaternion();
    const X_AXIS = new V(1, 0, 0), KNEE_POLE = new V(0, 0, 1);

    const mech = {
      group, eye, height: 85, eyeHeight: HIP_Y + WAIST + HEAD_Y + EYE.y, onStep: null,
      triangles: tris,
      setView(mode) {
        st.view = mode;
        const fp = mode === 'fp';
        headExt.visible = !fp; radar.visible = !fp; cockpit.visible = fp;
      },
      fist(side, out) { return arms[side > 0 ? 1 : 0].fistAnchor.getWorldPosition(out); },
      muzzle(out) { return muzzleAnchor.getWorldPosition(out); },
      dispose() {
        group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
        [hullMat, decalMat, lightMat, cabLightMat, reactorMat, thrustMat, cannonMat, intMat].forEach((m) => m.dispose());
        [tex.map, tex.orm, tex.normalMap, tex.decal].forEach((t) => t.dispose());
        if (group.parent) group.parent.remove(group);
      },
      animate(dt, a) {
        a = a || {};
        const speed = a.speed || 0, strafe = a.strafe || 0, turn = a.turn || 0;
        const hull = a.hull === undefined ? 1 : a.hull, charge = sat(a.charge || 0);
        st.time += dt;
        const time = st.time;
        st.twist = damp(st.twist, clamp(a.twist || 0, -1.0, 1.0), 14, dt);
        st.pitch = damp(st.pitch, clamp(a.pitch || 0, -1.2, 1.2), 14, dt);
        st.stagger = damp(st.stagger, sat(a.stagger || 0), 16, dt);
        st.dash = damp(st.dash, sat(a.dash || 0), 10, dt);

        // ---- gait
        const v = Math.hypot(speed, strafe), veff = v + Math.abs(turn) * 9;
        st.gait = damp(st.gait, sat(veff / 5), 5, dt);
        st.gaitMove = damp(st.gaitMove, sat(v / 6), 5, dt);
        if (v > 0.5) { st.dirX = damp(st.dirX, -strafe / v, 8, dt); st.dirZ = damp(st.dirZ, speed / v, 8, dt); }
        const sf = sat(v / 32);
        const stride = lerp(30, 56, sf);
        if (veff > 0.4) st.phase += (dt * Math.max(veff, 5)) / stride;
        const ph = st.phase, w = st.gait, TAU = Math.PI * 2;
        const lat = Math.sin(TAU * (ph - 0.05));               // +1 mid left stance

        // heavy-footfall spring
        st.joltV += (-70 * st.jolt - 10 * st.joltV) * dt;
        st.jolt += st.joltV * dt;

        body.position.set(
          1.5 * w * lat,
          HIP_Y - 1.1 * w * (0.4 + sf) - 1.25 * w * Math.cos(2 * TAU * ph) + st.jolt + Math.sin(time * 0.9) * 0.12 - 1.2 * st.stagger,
          -2.5 * st.stagger
        );
        const yawWalk = 0.075 * w * lat;
        body.rotation.set(0.05 * sf * Math.sign(speed || 1) * (speed < 0 ? 0.5 : 1) + 0.09 * st.dash - 0.10 * st.stagger, yawWalk, -0.02 * w * lat + 0.03 * st.stagger * Math.sin(time * 31));
        body.updateMatrix();

        // ---- legs (IK in body space)
        _qi.copy(body.quaternion).invert();
        const A = 0.25 * stride * st.gaitMove, ST = 0.6;
        for (const leg of legs) {
          const p = ((ph + leg.off) % 1 + 1) % 1;
          let along, lift = 0;
          if (p < ST) along = lerp(A, -A, p / ST);
          else { const u = (p - ST) / (1 - ST); along = lerp(-A, A, ease(u)); lift = Math.sin(u * Math.PI); }
          _T.set(leg.sx * FOOT_X + st.dirX * along, ANKLE_H + lift * (4 + 7 * sf) * w, st.dirZ * along);
          if (p < leg.prevP - 0.5 && w > 0.25 && dt > 0) {       // swing → stance: the foot plants
            const strength = 0.4 + 0.6 * sf;
            st.joltV -= 4.5 * strength;
            if (mech.onStep) {
              group.updateWorldMatrix(true, false);
              _w.set(_T.x, 0, _T.z).applyMatrix4(group.matrixWorld);
              mech.onStep(leg.side, _w, strength);
            }
          }
          leg.prevP = p;
          _T.sub(body.position).applyQuaternion(_qi);
          _S.set(leg.sx * HIP_X, 0, 0);
          ik2(_S, _T, THIGH, SHIN, KNEE_POLE, _E, _H);
          boneQuat(_dir.subVectors(_E, _S).normalize(), leg.qT);
          boneQuat(_dir.subVectors(_H, _E).normalize(), leg.qS);
          leg.thigh.quaternion.copy(leg.qT);
          leg.shin.quaternion.copy(leg.qT).invert().multiply(leg.qS);
          leg.foot.quaternion.copy(leg.qS).invert().multiply(_qi);   // keep the sole flat
          if (lift > 0) leg.foot.quaternion.multiply(_qx.setFromAxisAngle(X_AXIS, 0.25 * Math.sin(lift * Math.PI) * w));
        }

        // ---- arms: pose targets
        ctx.pitch = st.pitch; ctx.charge = charge; ctx.time = time;
        let exYaw = 0, exLean = 0;
        for (const arm of arms) {
          const in_ = (arm.side > 0 ? a.R : a.L) || { state: 'idle', t: 0 };
          const s = in_.state || 'idle', t = in_.t || 0;
          if (s !== arm.state || t < arm.lastT - 0.02) {
            arm.from.p.copy(arm.cur.p); arm.from.pole.copy(arm.cur.pole); arm.from.yaw = arm.cur.yaw; arm.from.lean = arm.cur.lean; arm.from.roll = arm.cur.roll;
            arm.w = 0; arm.bd = s === 'idle' ? 0.3 : s === 'block' || s === 'charge' ? 0.18 : 0.1;
            arm.state = s;
          }
          arm.lastT = t;
          ctx.swing = -arm.sx * Math.cos(TAU * ph) * w * (0.4 + 0.6 * sf);
          armPose(s, t, ctx, arm.tgt);
          arm.w = Math.min(1, arm.w + dt / arm.bd);
          const k = ease(arm.w);
          arm.cur.p.lerpVectors(arm.from.p, arm.tgt.p, k);
          arm.cur.pole.lerpVectors(arm.from.pole, arm.tgt.pole, k);
          arm.cur.yaw = lerp(arm.from.yaw, arm.tgt.yaw, k);
          arm.cur.lean = lerp(arm.from.lean, arm.tgt.lean, k);
          arm.cur.roll = lerp(arm.from.roll, arm.tgt.roll, k);
          exYaw += -arm.sx * arm.cur.yaw;
          exLean += arm.cur.lean;
        }
        // ---- torso
        _qa.setFromAxisAngle(Y_AXIS, st.twist - 1.35 * yawWalk + exYaw);
        _qe.setFromAxisAngle(X_AXIS, exLean);
        torso.quaternion.copy(_qa).multiply(_qe);
        // extra rotation relative to the aim frame, to keep hand targets in aim space
        _qb.setFromAxisAngle(Y_AXIS, exYaw).multiply(_qe).invert();
        for (const arm of arms) {
          _T.set(arm.sx * arm.cur.p.x, arm.cur.p.y, arm.cur.p.z).applyQuaternion(_qb);
          _pole.set(arm.sx * arm.cur.pole.x, arm.cur.pole.y, arm.cur.pole.z).applyQuaternion(_qb);
          ik2(arm.S, _T, UPPER, FIST, _pole, _E, _H);
          boneQuat(_dir.subVectors(_E, arm.S).normalize(), _qa);
          arm.upper.quaternion.copy(_qa);
          boneQuat(_dir.subVectors(_H, _E).normalize(), _qx, _w.copy(DORSAL_FWD).applyQuaternion(_qb), arm.cur.roll);
          arm.fore.quaternion.copy(_qa).invert().multiply(_qx);
        }
        // ---- head: stays near level through torso lean, follows half the pilot's pitch
        head.rotation.set(-exLean * 0.85 - 0.5 * st.pitch - body.rotation.x * 0.8, -(exYaw - 0.35 * yawWalk) * 0.92, 0);
        radar.rotation.y += dt * 1.3;

        // ---- emissives
        let flick = 1;
        if (hull < 0.3) { const f = Math.sin(time * 37) + Math.sin(time * 23.7) + Math.sin(time * 61.3); flick = f > 1.1 ? 0.15 : f < -1.6 ? 0.5 : 1; }
        lightMat.color.setScalar(flick);
        cabLightMat.color.setScalar((hull < 0.3 ? 0.55 + 0.45 * flick : 1) * (a.cabin === undefined ? 1 : a.cabin));
        const pulse = (1 + 0.14 * Math.sin(time * 2.3) + 0.05 * Math.sin(time * 13.1)) * (0.25 + 0.75 * flick) * (1 + st.dash * 0.8 + charge * 0.4);
        const hot = sat((0.45 - hull) / 0.45);
        reactorMat.color.setRGB(lerp(0.35, 3.2, hot) * pulse, lerp(1.9, 0.7, hot) * pulse, lerp(2.4, 0.2, hot) * pulse);
        const th = st.dash;
        thrustMat.color.setRGB(0.008 + th * 3.2 * (0.85 + 0.15 * Math.sin(time * 71)), 0.01 + th * 5.0, 0.016 + th * 8.5);
        const R = a.R || { state: 'idle', t: 0 };
        const flash = R.state === 'fire' ? Math.exp(-(R.t || 0) * 9) : 0;
        const cg = 0.025 + charge * charge * 5.5 * (0.9 + 0.1 * Math.sin(time * 53)) + flash * 12;
        cannonMat.color.setRGB(cg * 0.35 + flash * 4, cg * 1.0, cg * 1.3);
      },
    };
    return mech;
  }

  BW.Mech = { DUR, REACH, create };
})();
