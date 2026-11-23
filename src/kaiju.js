/* BREAKWATER — kaiju: three sea monsters from one parametric rig.
 *
 * Geometry is swept, noise-displaced tubes (elliptical cross-sections) merged per bone, plus blades,
 * teeth, claws and scutes. One MeshStandardMaterial per creature: albedo from vertex colours, procedural
 * scale normal/roughness maps, and an emissive vein map gated by vertex alpha
 * (alpha 0..1 scales the veins, alpha 1..2 adds solid glow: eyes, gullet, sacs).
 *
 * Animation is procedural: a pose vector is computed from (state, t) and exponentially smoothed.
 * Group origin = feet on the sea floor, facing +Z. Water surface is at local y = -BW.SEA_FLOOR (+22).
 */
(function () {
  'use strict';
  const BW = (window.BW = window.BW || {});
  const T = THREE;
  const lerp = (a, b, t) => a + (b - a) * t;
  const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smooth = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const WATER = -(BW.SEA_FLOOR || -22);

  // ------------------------------------------------------------------ species
  const SPECIES = {
    bruiser: {
      key: 'bruiser', name: 'MUDSHARK', cls: 'CLASS III', hp: 900, speed: 17, turn: 0.85, reach: 50, radius: 23, height: 84,
      glow: 0x7dff4a, attacks: ['swipeL', 'swipeR', 'bite', 'lunge'],
      hide: [0.046, 0.054, 0.058], belly: [0.200, 0.172, 0.130], horn: [0.060, 0.052, 0.044], tooth: [0.52, 0.47, 0.36],
      gait: 2.3, armK: 1, rear: 0, jawMax: 0.95, splay: 0.10, zOff: -10,
      dim: { hipH: 36, hipW: 10, thL: 19, thR: 8.6, shL: 17, shR: 6.2, footL: 13,
        s1L: 17, s1W: 15, s1D: 13, s2L: 19, s2W: 20, s2D: 16,
        neckN: 1, neckL: 9, neckR: 8.6, head: { l: 21, w: 10.5, h: 8.2 },
        shW: 19.5, shY: 0.70, uaL: 21, uaR: 6.8, faL: 21, faR: 7.4, handL: 8, claw: 9,
        tailN: 5, tailL: 31, tailR: 9.0 },
      rest: { pitch: 0.56, s2p: 0.14, neckP: -0.42, headP: 0.10, aF: 0.10, aA: 0.24, e: 0.42, w: 0.15, th: 0.35, kn: 0.70, tailP: -0.40, tailCurl: 0.09, jaw: 0.08 },
    },
    crawler: {
      key: 'crawler', name: 'RAKEBACK', cls: 'CLASS II', hp: 700, speed: 25, turn: 1.25, reach: 50, radius: 26, height: 62,
      glow: 0xff4a3d, attacks: ['bite', 'lunge', 'swipeL', 'swipeR'],
      hide: [0.060, 0.048, 0.044], belly: [0.220, 0.158, 0.112], horn: [0.075, 0.060, 0.048], tooth: [0.50, 0.44, 0.34],
      gait: 3.4, armK: 0.62, rear: 0.42, jawMax: 0.85, splay: 0.16, zOff: -45,
      dim: { hipH: 40, hipW: 13, thL: 21, thR: 8.2, shL: 20, shR: 5.6, footL: 12,
        s1L: 26, s1W: 16, s1D: 12.5, s2L: 24, s2W: 17, s2D: 13,
        neckN: 1, neckL: 11, neckR: 8.2, head: { l: 27, w: 11, h: 6.6 },
        shW: 16, shY: 0.74, uaL: 22, uaR: 7, faL: 21, faR: 5.6, handL: 7, claw: 7,
        tailN: 9, tailL: 62, tailR: 9 },
      rest: { pitch: 1.36, s2p: 0.06, neckP: -0.22, headP: 0.08, aF: 0.08, aA: 0.14, e: 0.25, w: 0.0, th: 0.30, kn: 0.60, tailP: -0.12, tailCurl: 0.02, jaw: 0.10 },
    },
    spitter: {
      key: 'spitter', name: 'GALLOWGLASS', cls: 'CLASS IV', hp: 620, speed: 15, turn: 1.0, reach: 44, radius: 18, height: 100,
      glow: 0xb44dff, attacks: ['spit', 'spit', 'swipeL', 'swipeR', 'bite'],
      hide: [0.048, 0.046, 0.062], belly: [0.180, 0.168, 0.176], horn: [0.055, 0.050, 0.058], tooth: [0.50, 0.47, 0.42],
      gait: 2.0, armK: 1, rear: 0.05, jawMax: 1.05, splay: 0.08, zOff: -10,
      dim: { hipH: 42, hipW: 7.5, thL: 23, thR: 5.5, shL: 22, shR: 4.2, footL: 12,
        s1L: 16, s1W: 10.5, s1D: 10, s2L: 16, s2W: 11.5, s2D: 11,
        neckN: 3, neckL: 10, neckR: 5.0, head: { l: 20, w: 6.6, h: 5.6 },
        shW: 10.5, shY: 0.70, uaL: 15, uaR: 3.2, faL: 17, faR: 2.9, handL: 5, claw: 9,
        tailN: 9, tailL: 66, tailR: 6.6 },
      rest: { pitch: 0.74, s2p: 0.10, neckP: -0.84, headP: 0.12, aF: 0.30, aA: 0.16, e: 1.25, w: 0.5, th: 0.40, kn: 0.80, tailP: -0.10, tailCurl: 0.03, jaw: 0.06 },
    },
  };

  const STATES = ['swim', 'emerge', 'idle', 'walk', 'windup', 'swipeL', 'swipeR', 'bite', 'lunge', 'spit', 'stagger', 'roar', 'smash', 'death'];
  const DUR = {
    emerge: 2.6, windup: 0.75,
    swipeL: { dur: 0.95, hit: 0.28 }, swipeR: { dur: 0.95, hit: 0.28 },
    bite: { dur: 1.0, hit: 0.30 }, lunge: { dur: 1.35, hit: 0.42 }, spit: { dur: 1.2, hit: 0.38 },
    stagger: 0.9, roar: 2.2, smash: { dur: 1.6, hit: 0.70 }, death: 4.5,
  };

  // ------------------------------------------------------------------ shared procedural textures
  let TEX = null;
  function textures() {
    if (TEX) return TEX;
    const S = 256, rnd = BW.rng(90210);
    const nd = BW.noiseTex.image.data, ns = BW.noiseTex.image.width;
    const fbm = (x, y) => nd[((((y | 0) % ns) + ns) % ns * ns + ((((x | 0) % ns) + ns) % ns)) * 4] / 255;
    function worley(g) {                       // tileable F1/F2 on a g x g jittered grid
      const px = new Float32Array(g * g), py = new Float32Array(g * g);
      for (let i = 0; i < g * g; i++) { px[i] = 0.1 + rnd() * 0.8; py[i] = 0.1 + rnd() * 0.8; }
      const F1 = new Float32Array(S * S), F2 = new Float32Array(S * S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const fx = (x / S) * g, fy = (y / S) * g, ci = Math.floor(fx), cj = Math.floor(fy);
        let a = 9, b = 9;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj, k = (((jj % g) + g) % g) * g + (((ii % g) + g) % g);
          const d = Math.hypot(ii + px[k] - fx, jj + py[k] - fy);
          if (d < a) { b = a; a = d; } else if (d < b) b = d;
        }
        F1[y * S + x] = a; F2[y * S + x] = b;
      }
      return { F1, F2 };
    }
    const C = worley(7), F = worley(19);
    const H = new Float32Array(S * S);
    const rough = new Uint8Array(S * S * 4), veins = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const ec = C.F2[i] - C.F1[i], ef = F.F2[i] - F.F1[i];
      const n = fbm(x, y), n2 = fbm(x * 3 + 71, y * 3 + 13);
      const plateC = smooth(0.0, 0.22, ec), plateF = smooth(0.0, 0.30, ef);
      H[i] = 0.50 * plateC * (0.8 + 0.2 * (1 - C.F1[i])) + 0.30 * plateF + 0.20 * n2;
      // wet plate tops are glossy, the grooves between them are matte
      const r = 0.30 + 0.38 * (1 - plateC * plateF) + 0.14 * (n - 0.5);
      rough[i * 4] = 255; rough[i * 4 + 1] = Math.round(sat(r) * 255); rough[i * 4 + 2] = 0; rough[i * 4 + 3] = 255;
      // bioluminescence lives in the grooves between the big plates, in blotchy patches
      const lineC = 1 - smooth(0.0, 0.055, ec), lineF = 1 - smooth(0.0, 0.11, ef);
      const blot = smooth(0.53, 0.65, n);                       // roughly a fifth of the hide carries light
      const wide = smooth(0.50, 0.60, n);
      const spot = smooth(0.86, 0.97, 1 - F.F1[i] * 2.0) * smooth(0.5, 0.62, n2) * wide * 0.8;
      const v = sat(lineC * blot * 0.9 + lineF * blot * 0.55 + spot);
      veins[i * 4] = veins[i * 4 + 1] = veins[i * 4 + 2] = Math.round(v * 255); veins[i * 4 + 3] = 255;
    }
    const dt = (data) => {
      const t = new T.DataTexture(data, S, S, T.RGBAFormat, T.UnsignedByteType);
      t.wrapS = t.wrapT = T.RepeatWrapping; t.minFilter = T.LinearMipmapLinearFilter; t.magFilter = T.LinearFilter;
      t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true; return t;
    };
    TEX = { normal: BW.normalMapFromHeight(H, S, 5.5), rough: dt(rough), veins: dt(veins) };
    return TEX;
  }

  function makeMaterial(sp) {
    const tx = textures();
    const m = new T.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 1.0, metalness: 0.0,
      normalMap: tx.normal, roughnessMap: tx.rough,
      emissive: new T.Color(sp.glow), emissiveMap: tx.veins, emissiveIntensity: 3.0, envMapIntensity: 1.5,
    });
    m.normalScale.set(1.4, 1.4);
    const uFlash = { value: 0 };
    m.userData.uFlash = uFlash;
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uFlash = uFlash;
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uFlash;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          #ifdef USE_COLOR_ALPHA
            totalEmissiveRadiance = totalEmissiveRadiance * min(vColor.a, 1.0) + emissive * max(vColor.a - 1.0, 0.0);
          #endif
          totalEmissiveRadiance += vec3(1.0, 0.82, 0.62) * uFlash;`);
    };
    m.customProgramCacheKey = () => 'bw-kaiju-1';
    return m;
  }

  // ------------------------------------------------------------------ geometry helpers
  class Builder {
    constructor() { this.p = []; this.n = []; this.u = []; this.c = []; this.i = []; }
    // prim: { p, n, u, c, i } plain arrays; m: optional Matrix4
    add(prim, m) {
      const base = this.p.length / 3, P = prim.p, N = prim.n;
      if (m) {
        const e = m.elements, nm = new T.Matrix3().getNormalMatrix(m).elements;
        for (let k = 0; k < P.length; k += 3) {
          const x = P[k], y = P[k + 1], z = P[k + 2];
          this.p.push(e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]);
          const a = N[k], b = N[k + 1], c = N[k + 2];
          let nx = nm[0] * a + nm[3] * b + nm[6] * c, ny = nm[1] * a + nm[4] * b + nm[7] * c, nz = nm[2] * a + nm[5] * b + nm[8] * c;
          const l = Math.hypot(nx, ny, nz) || 1;
          this.n.push(nx / l, ny / l, nz / l);
        }
        const flip = m.determinant() < 0;
        for (let k = 0; k < prim.i.length; k += 3) {
          if (flip) this.i.push(prim.i[k] + base, prim.i[k + 2] + base, prim.i[k + 1] + base);
          else this.i.push(prim.i[k] + base, prim.i[k + 1] + base, prim.i[k + 2] + base);
        }
      } else {
        for (let k = 0; k < P.length; k++) { this.p.push(P[k]); this.n.push(N[k]); }
        for (let k = 0; k < prim.i.length; k++) this.i.push(prim.i[k] + base);
      }
      for (let k = 0; k < prim.u.length; k++) this.u.push(prim.u[k]);
      for (let k = 0; k < prim.c.length; k++) this.c.push(prim.c[k]);
      return this;
    }
    get tris() { return this.i.length / 3; }
    build() {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new T.Float32BufferAttribute(this.n, 3));
      g.setAttribute('uv', new T.Float32BufferAttribute(this.u, 2));
      g.setAttribute('color', new T.Float32BufferAttribute(this.c, 4));
      g.setIndex(this.p.length / 3 > 65535 ? new T.Uint32BufferAttribute(this.i, 1) : new T.Uint16BufferAttribute(this.i, 1));
      g.computeBoundingSphere();
      return g;
    }
  }

  // Smooth normals for an indexed prim (plain arrays).
  function computeNormals(p, idx) {
    const n = new Float32Array(p.length);
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k] * 3, b = idx[k + 1] * 3, c = idx[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      n[a] += nx; n[a + 1] += ny; n[a + 2] += nz; n[b] += nx; n[b + 1] += ny; n[b + 2] += nz; n[c] += nx; n[c + 1] += ny; n[c + 2] += nz;
    }
    for (let k = 0; k < n.length; k += 3) {
      const l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    return n;
  }

  /* Swept tube along a path in the bone's YZ plane.
   * rings: [[y, z, rx, rd], ...]  centre (0,y,z), half-width along X, half-depth along the in-plane normal n2 = (0,-tz,ty).
   * o: seg, tile (m per texture repeat), ventral (+1/-1: which side of n2 is the belly), amp (noise), seed,
   *    capA/capB (end cap length factor, 0 = open), ridge (dorsal crest), hide/belly ([r,g,b]), glow (scale),
   *    glowFn(s01, v, cosTheta) -> alpha, bulge(s01, theta) -> radius multiplier */
  function tube(rings, o) {
    const seg = o.seg || 14, tile = o.tile || 22, ventral = o.ventral === undefined ? 1 : o.ventral;
    const amp = o.amp === undefined ? 0.07 : o.amp, seed = o.seed || 0;
    const n = rings.length, R = [];
    const tang = (i) => {
      const a = rings[Math.max(0, i - 1)], b = rings[Math.min(n - 1, i + 1)];
      const ty = b[0] - a[0], tz = b[1] - a[1], l = Math.hypot(ty, tz) || 1;
      return [ty / l, tz / l];
    };
    const capA = o.capA === undefined ? 0.9 : o.capA, capB = o.capB === undefined ? 0.9 : o.capB;
    if (capA > 0) {
      const [ty, tz] = tang(0), r0 = rings[0], L = Math.min(r0[2], r0[3]) * capA;
      for (let j = 3; j >= 1; j--) {
        const a = (j / 3) * Math.PI * 0.5, sc = Math.max(Math.cos(a), 0.04);
        R.push({ y: r0[0] - ty * L * Math.sin(a), z: r0[1] - tz * L * Math.sin(a), rx: r0[2] * sc, rd: r0[3] * sc, ty, tz, s: 0 });
      }
    }
    for (let i = 0; i < n; i++) { const [ty, tz] = tang(i); R.push({ y: rings[i][0], z: rings[i][1], rx: rings[i][2], rd: rings[i][3], ty, tz, s: n > 1 ? i / (n - 1) : 0 }); }
    if (capB > 0) {
      const [ty, tz] = tang(n - 1), r0 = rings[n - 1], L = Math.min(r0[2], r0[3]) * capB;
      for (let j = 1; j <= 3; j++) {
        const a = (j / 3) * Math.PI * 0.5, sc = Math.max(Math.cos(a), 0.04);
        R.push({ y: r0[0] + ty * L * Math.sin(a), z: r0[1] + tz * L * Math.sin(a), rx: r0[2] * sc, rd: r0[3] * sc, ty, tz, s: 1 });
      }
    }
    let rAvg = 0;
    for (const r of R) rAvg += (r.rx + r.rd) * 0.5;
    rAvg /= R.length;
    const uRep = Math.max(1, Math.round((2 * Math.PI * rAvg) / tile));
    const hide = o.hide, belly = o.belly || o.hide, glowK = o.glow === undefined ? 1 : o.glow;
    const p = [], u = [], c = [], idx = [];
    let arc = 0;
    for (let k = 0; k < R.length; k++) {
      const r = R[k];
      if (k > 0) arc += Math.hypot(r.y - R[k - 1].y, r.z - R[k - 1].z);
      const n2y = -r.tz, n2z = r.ty;
      for (let j = 0; j <= seg; j++) {
        const th = ((j % seg) / seg) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
        const v = ventral * sn;
        let d = 1 + amp * (BW.fbm2(cs * 1.9 + seed * 7.3 + 40, sn * 1.9 + arc * 0.11 + seed * 3.1 + 40, 3) - 0.47) * 2;
        if (o.ridge) d += o.ridge * smooth(0.72, 1.0, -v);
        if (o.bulge) d *= o.bulge(r.s, th, v);
        const off = r.rd * sn * d;
        p.push(r.rx * cs * d, r.y + n2y * off, r.z + n2z * off);
        u.push((j / seg) * uRep, arc / tile);
        const f = smooth(0.10, 0.85, v);
        const nz = 0.72 + 0.56 * BW.fbm2(cs * 2.3 + arc * 0.07 + seed, sn * 2.3 - arc * 0.05 + seed * 1.7, 2);
        const dark = 1 - 0.35 * smooth(0.5, 1.0, -v);            // darker along the spine
        const mo = o.mouth ? smooth(0.30, 0.55, o.mouth * v) * smooth(o.mouthS || 0, (o.mouthS || 0) + 0.12, r.s) : 0;   // wet flesh inside the jaws
        c.push(lerp(lerp(hide[0], belly[0], f) * nz * dark, 0.085, mo), lerp(lerp(hide[1], belly[1], f) * nz * dark, 0.018, mo), lerp(lerp(hide[2], belly[2], f) * nz * dark, 0.022, mo));
        let g = o.glowFn ? o.glowFn(r.s, v, cs) : (0.12 + 0.88 * Math.pow(1 - Math.abs(v), 2.0)) * (1 - 0.9 * smooth(0.1, 0.8, -v));
        c.push(lerp(g * glowK, 0.75, mo));
      }
    }
    const W = seg + 1;
    for (let k = 0; k < R.length - 1; k++) for (let j = 0; j < seg; j++) {
      const a = k * W + j, b = a + 1, d2 = a + W, e = d2 + 1;
      idx.push(a, d2, b, b, d2, e);
    }
    let nrm = computeNormals(p, idx);
    // make sure the winding faces outward (test a mid-body vertex against its radial direction)
    const mk = Math.floor(R.length / 2) * W + Math.floor(seg / 4);
    const mr = R[Math.floor(R.length / 2)];
    const rad = [p[mk * 3], p[mk * 3 + 1] - mr.y, p[mk * 3 + 2] - mr.z];
    if (rad[0] * nrm[mk * 3] + rad[1] * nrm[mk * 3 + 1] + rad[2] * nrm[mk * 3 + 2] < 0) {
      for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
      nrm = computeNormals(p, idx);
    }
    for (let k = 0; k < R.length; k++) {              // weld the UV seam
      const a = (k * W) * 3, b = (k * W + seg) * 3;
      for (let q = 0; q < 3; q++) { const m = nrm[a + q] + nrm[b + q]; nrm[a + q] = nrm[b + q] = m; }
      const l = Math.hypot(nrm[a], nrm[a + 1], nrm[a + 2]) || 1;
      for (let q = 0; q < 3; q++) { nrm[a + q] /= l; nrm[b + q] /= l; }
    }
    return { p, n: Array.from(nrm), u, c, i: idx };
  }

  /* Horn / tooth / claw / blade: tapered spike along +Y with elliptical section (rx along X, rz along Z).
   * o: len, rx, rz, seg, curve (bends toward +Z), colA (base rgb), colB (tip rgb), glowA (alpha at base) */
  function spike(o) {
    const seg = o.seg || 5, len = o.len, rx = o.rx, rz = o.rz === undefined ? o.rx : o.rz, curve = o.curve || 0;
    const rows = o.rows || 4, p = [], u = [], c = [], idx = [];
    const A = o.colA, B = o.colB || o.colA, ga = o.glowA || 0;
    for (let k = 0; k <= rows; k++) {
      const t = k / rows, rr = Math.max(Math.pow(1 - t, o.pow || 0.85), 0.02), bz = curve * len * t * t;
      for (let j = 0; j <= seg; j++) {
        const th = ((j % seg) / seg) * Math.PI * 2;
        p.push(Math.cos(th) * rx * rr, t * len, Math.sin(th) * rz * rr + bz);
        u.push(j / seg, (t * len) / 22);
        c.push(lerp(A[0], B[0], t), lerp(A[1], B[1], t), lerp(A[2], B[2], t), ga * (1 - t) * (1 - t));
      }
    }
    const W = seg + 1;
    for (let k = 0; k < rows; k++) for (let j = 0; j < seg; j++) {
      const a = k * W + j, b = a + 1, d = a + W, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
    let nrm = computeNormals(p, idx);
    if (nrm[0] * p[0] + nrm[2] * p[2] < 0) {
      for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
      nrm = computeNormals(p, idx);
    }
    for (let k = 0; k <= rows; k++) {
      const a = (k * W) * 3, b = (k * W + seg) * 3;
      for (let q = 0; q < 3; q++) { const m = nrm[a + q] + nrm[b + q]; nrm[a + q] = nrm[b + q] = m; }
      const l = Math.hypot(nrm[a], nrm[a + 1], nrm[a + 2]) || 1;
      for (let q = 0; q < 3; q++) { nrm[a + q] /= l; nrm[b + q] /= l; }
    }
    return { p, n: Array.from(nrm), u, c, i: idx };
  }

  // Ellipsoid blob (scutes, eyes, sacs, knuckles). rgba constant or fn(nx,ny,nz)->[r,g,b,a]
  function blob(rx, ry, rz, col, ws, hs) {
    ws = ws || 8; hs = hs || 6;
    const p = [], n = [], u = [], c = [], idx = [];
    for (let k = 0; k <= hs; k++) {
      const ph = (k / hs) * Math.PI, sp = Math.sin(ph), cp = Math.cos(ph);
      for (let j = 0; j <= ws; j++) {
        const th = ((j % ws) / ws) * Math.PI * 2, x = Math.cos(th) * sp, z = Math.sin(th) * sp, y = cp;
        p.push(x * rx, y * ry, z * rz);
        const nx = x / rx, ny = y / ry, nz = z / rz, l = Math.hypot(nx, ny, nz) || 1;
        n.push(nx / l, ny / l, nz / l);
        u.push((j / ws) * 1, (k / hs) * 0.5);
        const cc = typeof col === 'function' ? col(x, y, z) : col;
        c.push(cc[0], cc[1], cc[2], cc[3]);
      }
    }
    const W = ws + 1;
    for (let k = 0; k < hs; k++) for (let j = 0; j < ws; j++) {
      const a = k * W + j, b = a + 1, d = a + W, e = d + 1;
      idx.push(a, b, d, b, e, d);
    }
    return { p, n, u, c, i: idx };
  }

  const M4 = () => new T.Matrix4();
  const _q = new T.Quaternion(), _v = new T.Vector3(), _s = new T.Vector3(1, 1, 1), _up = new T.Vector3(0, 1, 0);
  // matrix placing a +Y primitive at pos, pointing along dir
  function aim(pos, dir, sx, sy, sz) {
    _v.set(dir[0], dir[1], dir[2]).normalize();
    _q.setFromUnitVectors(_up, _v);
    return M4().compose(new T.Vector3(pos[0], pos[1], pos[2]), _q, _s.set(sx || 1, sy || 1, sz || 1));
  }
  // matrix placing a +Y blade (thin in X) in the sagittal plane, rotated about X by ang
  function sag(y, z, ang) { return M4().makeRotationX(ang).setPosition(0, y, z); }

  // interpolate a ring table at path coordinate (index 0 = y, 1 = z selects the axis)
  function ringAt(rings, axis, val) {
    for (let i = 0; i < rings.length - 1; i++) {
      const a = rings[i], b = rings[i + 1];
      if ((val >= a[axis] && val <= b[axis]) || (val <= a[axis] && val >= b[axis])) {
        const t = (val - a[axis]) / ((b[axis] - a[axis]) || 1);
        return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
      }
    }
    return val < rings[0][axis] === rings[0][axis] < rings[rings.length - 1][axis] ? rings[0] : rings[rings.length - 1];
  }

  // ------------------------------------------------------------------ pose vector
  const NAMES = ['rootX', 'rootY', 'rootZ', 'roll', 'yaw', 'pitch', 's1p', 's2p', 's1y', 's2y', 'neckP', 'neckY', 'headP', 'headY', 'headR', 'jaw',
    'aFL', 'aAL', 'eL', 'wL', 'aFR', 'aAR', 'eR', 'wR', 'tL', 'kL', 'tR', 'kR', 'tailP', 'tailCurl', 'tailAmp', 'tailYaw', 'frill', 'sac', 'glow'];
  const P = {};
  NAMES.forEach((n, i) => (P[n] = i));
  const NP = NAMES.length;
  const SWAP = [['aFL', 'aFR'], ['aAL', 'aAR'], ['eL', 'eR'], ['wL', 'wR'], ['tL', 'tR'], ['kL', 'kR']];
  const NEG = ['rootX', 'roll', 'yaw', 's1y', 's2y', 'neckY', 'headY', 'headR', 'tailYaw'];
  function mirror(d) {
    const o = new Float32Array(d);
    for (const [a, b] of SWAP) { o[P[a]] = d[P[b]]; o[P[b]] = d[P[a]]; }
    for (const k of NEG) o[P[k]] = -d[P[k]];
    return o;
  }
  function buildKeys(sp) {
    const ak = sp.armK, rear = sp.rear;
    const D = (o, rearK) => {
      const f = new Float32Array(NP);
      for (const k in o) f[P[k]] = /^(aF|aA|e|w)[LR]$/.test(k) ? o[k] * ak : o[k];
      if (rearK) f[P.pitch] -= rear * rearK;
      return f;
    };
    const K = { W: {}, S: {} };
    K.W.swipeL = D({ s1y: 0.25, s2y: 0.42, aFL: 2.35, aAL: 0.95, eL: 1.15, wL: 0.3, aFR: 0.7, eR: 1.2, pitch: -0.12, jaw: 0.3, headR: 0.1, rootZ: -2 }, 1);
    K.S.swipeL = D({ s1y: -0.32, s2y: -0.58, aFL: 1.15, aAL: -0.62, eL: 0.12, wL: 0.35, aFR: -0.3, eR: 0.6, pitch: 0.24, rootZ: 6, jaw: 0.5, roll: -0.08 }, 0.5);
    K.W.swipeR = mirror(K.W.swipeL); K.S.swipeR = mirror(K.S.swipeL);
    K.W.bite = D({ neckP: -0.42, headP: -0.48, jaw: 0.85, pitch: -0.16, aFL: -0.3, aFR: -0.3, aAL: 0.4, aAR: 0.4, rootZ: -3, tailP: -0.1 });
    K.S.bite = D({ neckP: 0.38, headP: 0.30, jaw: 0.85, pitch: 0.36, rootZ: 10, aFL: 0.3, aFR: 0.3, tailP: 0.25, rootY: -2 });
    K.W.lunge = D({ rootY: -6, pitch: 0.24, aFL: -0.7, aFR: -0.7, eL: 1.2, eR: 1.2, aAL: 0.4, aAR: 0.4, kL: 0.35, kR: 0.35, tailP: 0.3, jaw: 0.3, rootZ: -5 });
    K.S.lunge = D({ rootY: -2, pitch: 0.42, rootZ: 16, aFL: 1.2, aFR: 1.2, eL: 0.2, eR: 0.2, aAL: 0.12, aAR: 0.12, jaw: 0.75, headP: -0.15, tailP: 0.1, tL: -0.4, tR: 0.3 });
    K.W.spit = D({ pitch: -0.26, neckP: -0.42, headP: -0.60, jaw: 0.12, sac: 1, frill: 1, glow: 1.3, aAL: 0.5, aAR: 0.5, eL: 0.5, eR: 0.5, rootZ: -2 });
    K.S.spit = D({ pitch: 0.20, neckP: 0.34, headP: 0.10, jaw: 1.0, sac: 0.1, frill: 1, glow: 2.2, rootZ: 4, aFL: -0.4, aFR: -0.4, aAL: 0.6, aAR: 0.6 });
    K.stagger = D({ pitch: -0.34, rootZ: -7, neckP: -0.3, headP: -0.5, aAL: 0.9, aAR: 0.9, aFL: 0.5, aFR: 0.3, jaw: 0.7, roll: 0.10, s2y: 0.25, rootY: -2, tailP: 0.2 }, 0.5);
    K.roar = D({ pitch: 0.12, neckP: 0.12, headP: -0.28, jaw: 1.0, aFL: -0.5, aFR: -0.5, aAL: 0.8, aAR: 0.8, eL: 0.7, eR: 0.7, glow: 1.5, frill: 1, sac: 0.6, tailAmp: 0.25, rootY: -2 }, 0.4);
    K.W.smash = D({ aFL: 2.9, aFR: 2.9, aAL: 0.28, aAR: 0.28, eL: 0.5, eR: 0.5, pitch: -0.30, neckP: -0.2, headP: -0.2, jaw: 0.55 }, 1.2);
    K.S.smash = D({ aFL: 0.75, aFR: 0.75, aAL: 0.10, aAR: 0.10, eL: 0.25, eR: 0.25, pitch: 0.45, rootY: -3, jaw: 0.2, headP: 0.2, rootZ: 4 }, 0);
    return K;
  }
  const add = (out, d, k) => { for (let i = 0; i < NP; i++) out[i] += d[i] * k; };
  const LAMBDA = { swim: 6, emerge: 9, idle: 6, walk: 7, windup: 13, swipeL: 24, swipeR: 24, bite: 24, lunge: 20, spit: 20, stagger: 20, roar: 9, smash: 18, death: 8 };

  function restPose(sp, t, o) {
    const R = sp.rest;
    o.fill(0);
    const br = Math.sin(t * 1.25);
    o[P.pitch] = R.pitch + 0.012 * br; o[P.s2p] = R.s2p + 0.02 * br; o[P.rootY] = 0.5 * br;
    o[P.neckP] = R.neckP; o[P.headP] = R.headP; o[P.headY] = 0.07 * Math.sin(t * 0.47); o[P.jaw] = R.jaw + 0.03 * Math.sin(t * 1.25 + 1);
    o[P.aFL] = R.aF + 0.03 * br; o[P.aFR] = R.aF - 0.02 * br; o[P.aAL] = o[P.aAR] = R.aA; o[P.eL] = o[P.eR] = R.e; o[P.wL] = o[P.wR] = R.w;
    o[P.tL] = o[P.tR] = R.th; o[P.kL] = o[P.kR] = R.kn;
    o[P.tailP] = R.tailP; o[P.tailCurl] = R.tailCurl; o[P.tailAmp] = 0.10; o[P.glow] = 1;
  }
  function swimPose(sp, t, o) {
    const R = sp.rest, d = sp.dim, w = t * 4.2;
    o.fill(0);
    o[P.pitch] = 1.50 + 0.03 * Math.sin(w * 0.5);
    o[P.rootY] = (WATER + 2.5 - d.s1D) - d.hipH + 1.1 * Math.sin(w * 0.5 + 1);
    o[P.yaw] = 0.07 * Math.sin(w); o[P.s2y] = -0.10 * Math.sin(w - 0.9); o[P.roll] = 0.04 * Math.sin(w * 0.5);
    o[P.s2p] = 0.02; o[P.neckP] = 0.0; o[P.headP] = 0.16; o[P.jaw] = 0.04;
    o[P.aFL] = o[P.aFR] = sp.armK < 1 ? -1.1 : -1.25; o[P.aAL] = o[P.aAR] = 0.12; o[P.eL] = o[P.eR] = 0.25; o[P.wL] = o[P.wR] = 0.1;
    o[P.tL] = -1.25 + 0.15 * Math.sin(w); o[P.tR] = -1.25 - 0.15 * Math.sin(w); o[P.kL] = o[P.kR] = 0.25;
    o[P.tailP] = 0.0; o[P.tailCurl] = 0.0; o[P.tailAmp] = 0.30; o[P.glow] = 1.15;
  }
  const _a = new Float32Array(NP), _b = new Float32Array(NP);

  function computeTarget(sp, K, a, o) {
    const st = a.state || 'idle', t = Math.max(0, a.t || 0), R = sp.rest, d = sp.dim;
    restPose(sp, t, o);
    switch (st) {
      case 'swim': swimPose(sp, t, o); break;
      case 'emerge': {
        const e = sat(t / DUR.emerge), k = smooth(0.0, 0.8, e);
        swimPose(sp, t, _a); restPose(sp, t, _b);
        for (let i = 0; i < NP; i++) o[i] = lerp(_a[i], _b[i], k);
        const burst = Math.sin(Math.PI * smooth(0.1, 1.0, e));        // surge up out of the water, then settle
        o[P.rootY] += 5 * burst; o[P.pitch] -= 0.22 * burst + sp.rear * 0.5 * burst;
        o[P.aAL] += 0.7 * burst * sp.armK; o[P.aAR] += 0.7 * burst * sp.armK; o[P.aFL] += 0.3 * burst * sp.armK; o[P.aFR] += 0.3 * burst * sp.armK;
        const hb = smooth(0.55, 0.95, e);
        o[P.headP] -= 0.75 * hb; o[P.neckP] -= 0.25 * hb; o[P.jaw] += 0.7 * hb; o[P.glow] += 0.9 * hb; o[P.frill] = hb; o[P.tailAmp] = 0.28;
        break;
      }
      case 'walk': {
        const sk = a.speed === undefined ? 1 : sat(a.speed), ph = t * sp.gait, s = Math.sin(ph), c2 = Math.cos(2 * ph);
        o[P.tL] = R.th + 0.42 * sk * s; o[P.tR] = R.th - 0.42 * sk * s;
        o[P.kL] = R.kn + 0.45 * sk * Math.max(0, Math.cos(ph)); o[P.kR] = R.kn + 0.45 * sk * Math.max(0, -Math.cos(ph));
        o[P.rootY] = (-1.4 + 1.4 * c2) * sk; o[P.rootX] = 2.4 * sk * s; o[P.roll] = 0.055 * sk * s;
        o[P.yaw] = 0.10 * sk * s; o[P.s2y] = -0.19 * sk * s; o[P.pitch] += 0.035 * sk * Math.sin(2 * ph + 0.6) + 0.05 * sk;
        if (sp.armK < 1) {                                       // quadruped: front limbs step with the opposite hind limb
          o[P.aFL] = R.aF - 0.40 * sk * s; o[P.aFR] = R.aF + 0.40 * sk * s;
          o[P.eL] = R.e + 0.5 * sk * Math.max(0, -Math.cos(ph)); o[P.eR] = R.e + 0.5 * sk * Math.max(0, Math.cos(ph));
        } else {
          o[P.aFL] = R.aF - 0.30 * sk * s; o[P.aFR] = R.aF + 0.30 * sk * s;
          o[P.eL] = R.e + 0.12 * sk * (1 - s); o[P.eR] = R.e + 0.12 * sk * (1 + s);
        }
        o[P.headY] = 0; o[P.headR] = -0.03 * sk * s; o[P.tailAmp] = 0.20; o[P.tailYaw] = -0.5 * sk * s;
        break;
      }
      case 'windup': {
        const k = smooth(0, DUR.windup, t), W = K.W[a.next] || K.W.swipeL;
        add(o, W, k);
        const tr = 0.012 * k * Math.sin(t * 34);                  // tension tremor
        o[P.headR] += tr; o[P.s2y] += tr;
        break;
      }
      case 'swipeL': case 'swipeR': case 'bite': case 'lunge': case 'spit': {
        const D = DUR[st], W = K.W[st], S = K.S[st];
        const s = smooth(0, D.hit, t), r = smooth(D.hit + (D.dur - D.hit) * 0.22, D.dur, t);
        for (let i = 0; i < NP; i++) o[i] += lerp(W[i], S[i], s) * (1 - r);
        if (st === 'bite') o[P.jaw] = lerp(R.jaw, 0.9, 1 - r) * (t > D.hit * 0.82 ? 0.04 : 1) + R.jaw * (t > D.hit * 0.82 ? 1 : 0);
        if (st === 'spit') o[P.jaw] = lerp(R.jaw, 1.0, smooth(D.hit * 0.5, D.hit, t) * (1 - smooth(D.hit + 0.25, D.dur, t)));
        break;
      }
      case 'stagger': {
        const env = smooth(0, 0.10, t) * (1 - smooth(0.35, DUR.stagger, t));
        add(o, K.stagger, env);
        o[P.roll] += 0.05 * env * Math.sin(t * 15); o[P.headR] += 0.12 * env * Math.sin(t * 19);
        break;
      }
      case 'roar': {
        const k = smooth(0, 0.35, t) * (1 - smooth(DUR.roar - 0.45, DUR.roar, t));
        add(o, K.roar, k);
        o[P.headR] += 0.045 * k * Math.sin(t * 41); o[P.jaw] -= 0.06 * k * (0.5 + 0.5 * Math.sin(t * 33)); o[P.headY] += 0.10 * k * Math.sin(t * 2.6);
        o[P.s2p] += 0.02 * k * Math.sin(t * 37);
        break;
      }
      case 'smash': {
        const D = DUR.smash, up = smooth(0, D.hit * 0.62, t), dn = smooth(D.hit * 0.66, D.hit, t), r = smooth(D.hit + 0.25, D.dur, t);
        for (let i = 0; i < NP; i++) o[i] += lerp(K.W.smash[i] * up, K.S.smash[i], dn) * (1 - r);
        break;
      }
      case 'death': {
        const reel = smooth(0, 0.25, t) * (1 - smooth(0.9, 1.35, t));
        const f = smooth(1.0, 2.5, t), sink = smooth(2.3, DUR.death, t);
        o[P.pitch] = lerp(R.pitch - 0.30 * reel, 1.52, f); o[P.s2p] = lerp(R.s2p, 0.02, f);
        o[P.neckP] = lerp(R.neckP - 0.2 * reel, 0.05, f); o[P.headP] = lerp(R.headP - 0.6 * reel, 0.30, f); o[P.headR] = 0.25 * f; o[P.headY] = 0.2 * f;
        o[P.jaw] = lerp(R.jaw, 0.75, Math.max(reel, f * 0.7));
        const yTop = (WATER - 3) - d.hipH, yEnd = (WATER - 6 - d.s1D - 9) - d.hipH;
        o[P.rootY] = lerp(lerp(0, yTop, f), yEnd, sink); o[P.rootZ] = 12 * f; o[P.roll] = 0.28 * f + 0.06 * reel * Math.sin(t * 9);
        const ak = sp.armK;
        o[P.aFL] = lerp(R.aF + 0.5 * reel, 1.35, f) * (ak < 1 ? 0.6 : 1); o[P.aFR] = lerp(R.aF + 0.3 * reel, 1.0, f) * (ak < 1 ? 0.6 : 1);
        o[P.aAL] = R.aA + 0.9 * reel * ak + 0.3 * f; o[P.aAR] = R.aA + 0.9 * reel * ak + 0.5 * f; o[P.eL] = lerp(R.e, 0.3, f); o[P.eR] = lerp(R.e, 0.6, f);
        o[P.tL] = lerp(R.th, -1.15, f); o[P.tR] = lerp(R.th, -0.9, f); o[P.kL] = lerp(R.kn, 0.3, f); o[P.kR] = lerp(R.kn, 0.5, f);
        o[P.tailP] = lerp(R.tailP, 0.0, f); o[P.tailCurl] = lerp(R.tailCurl, 0.0, f); o[P.tailAmp] = 0.10 * (1 - f); o[P.tailYaw] = 0.9 * f;
        o[P.glow] = 1 - smooth(0.4, 3.4, t); o[P.frill] = 0; o[P.sac] = 0;
        break;
      }
      default: break; // idle
    }
  }

  // ------------------------------------------------------------------ creature construction
  function create(key, seed) {
    const sp = SPECIES[key] || SPECIES.bruiser, d = sp.dim, R = sp.rest;
    seed = seed || 1;
    const rnd = BW.rng(seed * 7919 + key.length * 131);
    const sd = (seed % 97) * 0.37;
    const mat = makeMaterial(sp);
    const matShow = key === 'spitter' ? makeMaterial(sp) : null;   // sac + frill: their glow follows the display, not the body
    const K = sp._K || (sp._K = buildKeys(sp));
    const group = new T.Group();
    group.name = 'kaiju:' + sp.key;
    const meshes = [];
    const node = (parent, x, y, z) => { const o = new T.Object3D(); o.position.set(x || 0, y || 0, z || 0); parent.add(o); return o; };
    const skin = (bone, b, mt) => { const m = new T.Mesh(b.build(), mt || mat); m.frustumCulled = false; bone.add(m); meshes.push(m); return m; };
    const TO = (o) => Object.assign({ hide: sp.hide, belly: sp.belly, seed: sd + rnd() * 9 }, o);
    const HORN = sp.horn, HORN2 = [sp.horn[0] * 2.6, sp.horn[1] * 2.5, sp.horn[2] * 2.3];
    const TOOTH = sp.tooth, TOOTH0 = [sp.tooth[0] * 0.35, sp.tooth[1] * 0.3, sp.tooth[2] * 0.25];

    const root = node(group, 0, d.hipH, 0);
    const pelvis = node(root);
    const s1 = node(pelvis);
    const s2 = node(s1, 0, d.s1L, 0);
    const necks = [];
    for (let i = 0; i < d.neckN; i++) necks.push(node(i ? necks[i - 1] : s2, 0, i ? d.neckL : d.s2L, 0));
    const head = node(necks[d.neckN - 1], 0, d.neckL, 0);

    // Vertex-glow profile for torso tubes: faint veins on the flanks plus a row of solid-glow slits (like gill
    // openings) low on each side between s = s0..s1. Returns alpha (see material: >1 adds solid glow).
    function slits(count, s0, s1) {
      return (s, v, cs) => {
        const base = (0.12 + 0.88 * Math.pow(1 - Math.abs(v), 2.0)) * (1 - 0.9 * smooth(0.1, 0.8, -v));
        if (s < s0 || s > s1) return base;
        const u = ((s - s0) / (s1 - s0)) * count, fr = u - Math.floor(u);
        const along = smooth(0.30, 0.42, fr) * (1 - smooth(0.58, 0.70, fr));
        const band = smooth(0.02, 0.16, v) * (1 - smooth(0.42, 0.58, v)) * smooth(0.55, 0.8, Math.abs(cs));
        const k = along * band;
        return base * (1 - k) + 1.75 * k;
      };
    }

    // ---- torso
    const a1 = d.s1W, b1 = d.s1D, L1 = d.s1L, a2 = d.s2W, b2 = d.s2D, L2 = d.s2L;
    const isQuad = sp.armK < 1, isSpit = key === 'spitter', isBru = key === 'bruiser';
    {
      const B = new Builder();
      const rings = [[-0.34 * L1, -0.06 * b1, a1 * 0.70, b1 * 0.80], [-0.05 * L1, 0, a1 * 0.98, b1 * 1.0], [0.42 * L1, b1 * 0.10, a1 * 0.90, b1 * 1.0],
        [0.85 * L1, b1 * 0.06, a1 * 0.97, b1 * 1.02], [1.14 * L1, 0, a1 * 0.95, b1 * 0.96]];
      B.add(tube(rings, TO({ seg: 22, ventral: 1, ridge: 0.10, capA: 0.8, capB: 0.5, amp: 0.08, glowFn: slits(isQuad ? 5 : 3, 0.15, 0.95),
        bulge: (s, th, v) => 1 + 0.05 * Math.sin(s * 9) * smooth(0, 0.7, v) })));
      dorsal(B, rings, 0, L1, isQuad ? 4 : 3, 1.0);
      if (isQuad) scutes(B, rings, 0.0, L1, 4);
      skin(s1, B);
    }
    {
      const B = new Builder();
      const hump = isBru ? 0.22 : isQuad ? 0.10 : 0.05;
      const rings = [[-0.22 * L2, 0, a2 * 0.80, b2 * 0.86], [0.20 * L2, b2 * 0.04, a2 * 0.98, b2 * 1.0], [0.62 * L2, -b2 * hump, a2 * 1.0, b2 * (1.0 + hump * 0.6)],
        [0.90 * L2, -b2 * hump * 0.6, a2 * 0.74, b2 * 0.86], [1.10 * L2, 0, Math.max(a2 * 0.46, d.neckR * 1.05), Math.max(b2 * 0.56, d.neckR * 1.05)]];
      B.add(tube(rings, TO({ seg: 22, ventral: 1, ridge: 0.12, capA: 0.7, capB: 0.5, amp: 0.08, glowFn: slits(isQuad ? 4 : 3, 0.10, 0.62),
        bulge: (s, th, v) => 1 + 0.06 * smooth(0.2, 0.9, v) * Math.sin(s * 7 + 1) + 0.05 * Math.abs(Math.cos(th)) * smooth(0.3, 0.7, s) })));
      dorsal(B, rings, 0.0, L2 * 0.92, isQuad ? 4 : 3, isBru ? 1.25 : 1.0);
      if (isQuad) scutes(B, rings, 0.0, L2 * 0.9, 4);
      // shoulder masses
      for (const sx of [-1, 1]) {
        const shCol = (x, y, z) => { const k = 0.8 + 0.4 * y; return [sp.hide[0] * k, sp.hide[1] * k, sp.hide[2] * k, 0.5 * (1 - y)]; };
        B.add(blob(d.uaR * 1.35, d.uaR * 1.25, d.uaR * 1.45, shCol, 10, 6), M4().makeTranslation(sx * d.shW * 0.93, d.shY * L2 + d.uaR * 0.15, -b2 * 0.12));
        if (isBru) for (let k = 0; k < 3; k++) {                   // bony shoulder studs
          B.add(spike({ len: 4.2 - k * 0.7, rx: 1.5, rz: 1.5, seg: 5, colA: HORN, colB: HORN2, curve: 0.1 }),
            aim([sx * (d.shW + 1.5 - k * 2.4), d.shY * L2 + d.uaR * 1.1 + k * 0.6, -b2 * 0.15 - k * 2.6], [sx * (0.8 - k * 0.25), 1, -0.3 - k * 0.2]));
        }
      }
      skin(s2, B);
    }
    const chestAnchor = node(s2, 0, L2 * 0.45, b2 * 0.5);

    // dorsal blades along a +Y spine tube (dorsal side is -Z)
    function dorsal(B, rings, y0, y1, count, scale) {
      const pl = sp.key === 'crawler' ? { len: 8.5, wid: 2.6, th: 0.75, tilt: 0.55 } : sp.key === 'spitter' ? { len: 8.5, wid: 1.5, th: 0.4, tilt: 0.35 } : { len: 4.2, wid: 3.6, th: 1.7, tilt: 0.95 };
      for (let i = 0; i < count; i++) {
        const y = lerp(y0, y1, (i + 0.5) / count), r = ringAt(rings, 0, y);
        const len = pl.len * scale * (0.8 + 0.4 * rnd());
        B.add(spike({ len, rx: pl.th, rz: pl.wid, seg: 4, rows: 3, colA: HORN, colB: HORN2, curve: -0.12, pow: 0.7 }),
          sag(y, r[1] - r[3] * 0.92, -(Math.PI / 2 - pl.tilt)));
        if (sp.key !== 'spitter') for (const sx of [-1, 1]) {      // flanking row of smaller knobs
          const m = M4().makeRotationX(-(Math.PI / 2 - pl.tilt)).premultiply(M4().makeRotationY(sx * -0.55)).setPosition(sx * r[2] * 0.52, y + 1.5, r[1] - r[3] * 0.80);
          B.add(spike({ len: len * 0.5, rx: pl.th * 1.1, rz: pl.wid * 0.6, seg: 4, rows: 2, colA: HORN, colB: HORN2 }), m);
        }
      }
    }
    // overlapping armour shells on the back (crawler)
    function scutes(B, rings, y0, y1, count) {
      for (let i = 0; i < count; i++) {
        const y = lerp(y0, y1, (i + 0.5) / count), r = ringAt(rings, 0, y);
        for (const sx of [-1, 1]) {
          const col = (x, yy, z) => { const k = 0.7 + 0.9 * Math.max(yy, 0); return [HORN[0] * k, HORN[1] * k, HORN[2] * k, 0.9 * smooth(0.5, 0.0, yy)]; };
          const m = M4().makeRotationX(-Math.PI / 2 + 0.18).premultiply(M4().makeRotationY(sx * -0.75)).setPosition(sx * r[2] * 0.60, y, r[1] - r[3] * 0.62);
          B.add(blob(r[2] * 0.42, 3.4, (y1 - y0) / count * 0.80, col, 8, 5), m);
        }
      }
    }

    // ---- neck
    for (let i = 0; i < d.neckN; i++) {
      const B = new Builder(), r = d.neckR * (1 - 0.06 * i), ln = d.neckL;
      const rings = [[-0.25 * ln, 0, r * 1.12, r * 1.12], [0.4 * ln, r * 0.05, r, r], [1.15 * ln, 0, r * 0.94, r * 0.98]];
      B.add(tube(rings, TO({ seg: 14, ventral: 1, ridge: 0.10, capA: 0.6, capB: 0.6, glow: isSpit ? 1.0 : 0.8 })));
      if (isSpit) B.add(spike({ len: 4.5, rx: 0.35, rz: 1.1, seg: 4, rows: 2, colA: HORN, colB: HORN2 }), sag(ln * 0.5, -r * 0.9, -(Math.PI / 2 - 0.3)));
      skin(necks[i], B);
    }

    // ---- head + jaw
    const H = d.head, hl = H.l, hw = H.w, hh = H.h;
    const prof = isQuad
      ? [[0.10, -0.22, 0.66, 0.80], [0.16, 0.02, 1.00, 1.00], [0.14, 0.26, 0.98, 0.84], [0.04, 0.52, 0.80, 0.58], [-0.04, 0.80, 0.66, 0.42], [-0.08, 1.0, 0.50, 0.30]]
      : isSpit
        ? [[0.05, -0.20, 0.60, 0.72], [0.16, 0.04, 0.96, 1.00], [0.20, 0.30, 1.00, 0.92], [0.06, 0.56, 0.66, 0.62], [-0.02, 0.82, 0.48, 0.46], [-0.06, 1.0, 0.34, 0.32]]
        : [[0.08, -0.20, 0.64, 0.76], [0.18, 0.04, 0.98, 1.00], [0.22, 0.30, 1.00, 0.94], [0.10, 0.55, 0.84, 0.70], [0.02, 0.80, 0.70, 0.54], [-0.04, 1.0, 0.52, 0.40]];
    const skull = prof.map((p) => [p[0] * hh, p[1] * hl, p[2] * hw, p[3] * hh]);
    const hingeY = -hh * 0.30, hingeZ = hl * 0.06;
    const jaw = node(head, 0, hingeY, hingeZ);
    const jl = hl * (isBru ? 1.0 : 0.94);
    const jawR = [[-hh * 0.02, -hl * 0.08, hw * 0.74, hh * 0.40], [-hh * 0.16, jl * 0.28, hw * 0.86, hh * 0.46], [-hh * 0.14, jl * 0.60, hw * (isBru ? 0.74 : 0.62), hh * 0.38],
      [-hh * 0.04, jl * 0.90, hw * (isBru ? 0.56 : 0.42), hh * 0.30]];
    {
      const B = new Builder();
      B.add(tube(skull, TO({ seg: 18, ventral: 1, ridge: 0.16, capA: 0.9, capB: 0.7, amp: 0.06, glow: 0.45, tile: 14, mouth: 1, mouthS: 0.22,
        // flatten the palate so the mouth reads as a mouth
        bulge: (s, th, v) => 1 - 0.38 * smooth(0.35, 1.0, v) * smooth(0.2, 0.5, s) })));
      // gullet glow, seen when the jaws open
      B.add(blob(hw * 0.42, hh * 0.30, hl * 0.20, [0.01, 0.01, 0.01, 1.35], 8, 5), M4().makeTranslation(0, -hh * 0.16, hl * 0.16));
      // upper teeth
      const nT = isQuad ? 9 : isSpit ? 7 : 6;
      for (let k = 0; k < nT; k++) {
        const f = 0.36 + 0.62 * (k / (nT - 1)), r = ringAt(skull, 1, f * hl);
        const len = hh * (isSpit ? 0.50 : 0.36) * (0.7 + 0.6 * rnd()) * (k === nT - 2 ? 1.5 : 1);
        for (const sx of [-1, 1]) B.add(spike({ len, rx: len * 0.20, seg: 5, rows: 3, colA: TOOTH0, colB: TOOTH, curve: -0.15 }),
          aim([sx * r[2] * (k === nT - 1 ? 0.35 : 0.80), r[0] - r[3] * 0.50, r[1]], [sx * 0.12, -1, 0.10]));
      }
      // eyes: two pairs (three on the spitter)
      const eyes = isSpit ? [[0.30, 1.0], [0.42, 0.75], [0.53, 0.6]] : [[0.33, 1.0], [0.46, 0.62]];
      for (const [f, k] of eyes) {
        const r = ringAt(skull, 1, f * hl), er = hh * 0.105 * k;
        for (const sx of [-1, 1]) {
          B.add(blob(er * 1.9, er * 1.5, er * 2.2, [HORN[0] * 0.6, HORN[1] * 0.6, HORN[2] * 0.6, 0], 7, 5), M4().makeTranslation(sx * r[2] * 0.84, r[0] + r[3] * 0.46, r[1]));
          B.add(blob(er * 0.85, er * 0.85, er * 0.85, [0, 0, 0, 1.75], 6, 4), M4().makeTranslation(sx * r[2] * 0.93, r[0] + r[3] * 0.44, r[1] + er * 0.4));
        }
      }
      // ornament
      if (isBru) {
        for (let k = 0; k < 4; k++) for (const sx of [-1, 1])     // swept-back brow crest
          B.add(spike({ len: 5.5 - k * 0.7, rx: 1.3, rz: 1.6, seg: 5, colA: HORN, colB: HORN2, curve: -0.25 }),
            aim([sx * hw * (0.45 + k * 0.14), hh * (0.92 - k * 0.12), hl * (0.22 - k * 0.12)], [sx * (0.25 + k * 0.2), 0.8, -0.9]));
        B.add(spike({ len: 4.5, rx: 2.2, rz: 2.0, seg: 5, colA: HORN, colB: HORN2 }), aim([0, hh * 0.45, hl * 0.86], [0, 1, 0.5]));
      } else if (isQuad) {
        // bony shield sweeping back over the neck
        const col = (x, y, z) => { const k = 0.8 + 0.8 * Math.max(y, 0); return [HORN[0] * k, HORN[1] * k, HORN[2] * k, 0.5 * smooth(0.3, -0.2, y)]; };
        B.add(blob(hw * 1.05, hh * 0.55, hl * 0.42, col, 10, 6), M4().makeRotationX(-0.28).setPosition(0, hh * 0.60, -hl * 0.10));
        for (let k = 0; k < 5; k++) {
          const an = (k - 2) * 0.42;
          B.add(spike({ len: 7 - Math.abs(k - 2) * 1.2, rx: 1.0, rz: 1.5, seg: 4, colA: HORN, colB: HORN2 }),
            aim([Math.sin(an) * hw * 0.95, hh * 0.80, -hl * 0.36 + Math.cos(an) * -hl * 0.06], [Math.sin(an) * 0.8, 0.55, -1]));
        }
        for (const sx of [-1, 1]) B.add(spike({ len: 5, rx: 1.0, rz: 1.2, seg: 4, colA: HORN, colB: HORN2 }), aim([sx * hw * 0.42, hh * 0.25, hl * 0.90], [sx * 0.3, 1, 0.4]));
      } else {
        for (let k = 0; k < 3; k++) B.add(spike({ len: 6 - k, rx: 0.4, rz: 1.5, seg: 4, rows: 2, colA: HORN, colB: HORN2 }), sag(hh * 0.95, hl * (0.10 - k * 0.12), -0.9 - k * 0.2));
        for (const sx of [-1, 1]) B.add(spike({ len: 8, rx: 0.7, rz: 0.7, seg: 5, colA: HORN, colB: HORN2, curve: 0.3 }), aim([sx * hw * 0.8, -hh * 0.1, hl * 0.30], [sx * 0.9, -0.5, 0.5]));
      }
      skin(head, B);
    }
    {
      const B = new Builder();
      B.add(tube(jawR, TO({ seg: 14, ventral: 1, capA: 0.8, capB: 0.8, amp: 0.05, glow: 0.5, tile: 14, mouth: -1,
        bulge: (s, th, v) => 1 - 0.45 * smooth(0.2, 1.0, -v) })));     // flat tongue-side
      const nT = isQuad ? 8 : isSpit ? 6 : 5;
      for (let k = 0; k < nT; k++) {
        const f = 0.30 + 0.62 * (k / (nT - 1)), r = ringAt(jawR, 1, f * jl);
        const tusk = isBru && k === nT - 2;
        const len = hh * (tusk ? 0.85 : isSpit ? 0.42 : 0.30) * (0.75 + 0.5 * rnd());
        for (const sx of [-1, 1]) B.add(spike({ len, rx: len * (tusk ? 0.16 : 0.2), seg: 5, rows: 3, colA: TOOTH0, colB: TOOTH, curve: 0.12 }),
          aim([sx * r[2] * (tusk ? 0.98 : 0.80), r[0] + r[3] * 0.30, r[1]], [sx * (tusk ? 0.3 : 0.1), 1, tusk ? 0.2 : -0.05]));
      }
      if (isBru) B.add(blob(hw * 0.5, hh * 0.3, hl * 0.2, [sp.hide[0], sp.hide[1], sp.hide[2], 0.3], 7, 5), M4().makeTranslation(0, -hh * 0.42, jl * 0.72));
      skin(jaw, B);
    }
    const headAnchor = node(head, 0, hh * 0.3, hl * 0.4);
    const mouthAnchor = node(head, 0, -hh * 0.35, hl * 0.92);

    // ---- spitter: bile sac + neck frill
    let sac = null, frillL = null, frillR = null;
    if (isSpit) {
      sac = node(necks[1], 0, d.neckL * 0.9, d.neckR * 0.42);
      const B = new Builder();
      const sc = (x, y, z) => { const k = 0.6 + 0.4 * z; return [sp.belly[0] * k, sp.belly[1] * k, sp.belly[2] * k, 1.0 + 0.09 * smooth(0.0, 0.9, z) * smooth(0.95, 0.3, Math.abs(y))]; };
      B.add(blob(3.3, 6.0, 2.7, sc, 10, 7), M4().makeTranslation(0, 0, 0));          // throat pouch
      B.add(blob(2.4, 3.6, 2.1, sc, 8, 5), M4().makeTranslation(0, 6.5, 0.6));
      skin(sac, B, matShow);
      const mkFrill = (sx) => {
        const fb = node(head, sx * hw * 0.22, hh * 0.05, -hl * 0.12);
        const B = new Builder(), nS = 7, pts = [];
        for (let k = 0; k < nS; k++) {
          const an = -1.32 + (k / (nS - 1)) * 2.72, len = 14 + 6 * Math.sin((k / (nS - 1)) * Math.PI) + rnd() * 2;
          const dir = [Math.cos(an) * 0.94, Math.sin(an) * 0.94, -0.30];
          pts.push([dir[0] * len * sx, dir[1] * len, dir[2] * len]);
          B.add(spike({ len: len * 1.08, rx: 0.42, rz: 0.42, seg: 4, rows: 3, colA: HORN, colB: HORN2 }), aim([0, 0, 0], [dir[0] * sx, dir[1], dir[2]]));
        }
        // membrane (both windings so it is visible from either side)
        const p = [0, 0, 0], u = [0, 0], c = [sp.belly[0], sp.belly[1], sp.belly[2], 1.0], idx = [];
        for (let k = 0; k < nS; k++) {
          const q = pts[k], m = [q[0] * 0.55, q[1] * 0.55, q[2] * 0.55];
          p.push(m[0], m[1], m[2], q[0] * 0.93, q[1] * 0.93, q[2] * 0.93);
          u.push(m[0] / 9, m[1] / 9, q[0] / 9, q[1] / 9);
          c.push(sp.belly[0] * 0.8, sp.belly[1] * 0.7, sp.belly[2] * 0.9, 1.04, sp.hide[0] * 2, sp.hide[1] * 2, sp.hide[2] * 2.4, 0.85);
        }
        for (let k = 0; k < nS - 1; k++) {
          const m0 = 1 + k * 2, e0 = m0 + 1, m1 = m0 + 2, e1 = m0 + 3;
          idx.push(0, m0, m1, m0, e0, m1, e0, e1, m1);
        }
        const nA = computeNormals(p, idx);
        const front = { p, n: Array.from(nA), u, c, i: idx };
        const back = { p, n: Array.from(nA).map((v) => -v), u, c, i: idx.map((v, k) => (k % 3 === 1 ? idx[k + 1] : k % 3 === 2 ? idx[k - 1] : v)) };
        B.add(front).add(back);
        skin(fb, B, matShow);
        return fb;
      };
      frillL = mkFrill(1); frillR = mkFrill(-1);
    }

    // ---- arms
    function mkArm(sx) {
      const sh = node(s2, sx * d.shW, d.shY * L2, 0);
      const el = node(sh, 0, -d.uaL, 0);
      const hd = node(el, 0, -d.faL, 0);
      const ru = d.uaR, rf = d.faR, Lu = d.uaL, Lf = d.faL;
      {
        const B = new Builder();
        B.add(tube([[0.10 * Lu, 0, ru * 1.10, ru * 1.15], [-0.12 * Lu, 0, ru * 1.22, ru * 1.28], [-0.45 * Lu, -ru * 0.08, ru * 1.02, ru * 1.12],
          [-0.80 * Lu, 0, ru * 0.80, ru * 0.84], [-1.04 * Lu, 0, ru * 0.84, ru * 0.86]], TO({ seg: 14, ventral: -1, capA: 0.7, capB: 0.7, amp: 0.09 })));
        skin(sh, B);
      }
      {
        const B = new Builder();
        const fr = [[0.08 * Lf, 0, rf * 0.92, rf * 0.92], [-0.28 * Lf, -rf * 0.10, rf * 1.14, rf * 1.20], [-0.70 * Lf, 0, rf * 0.92, rf * 0.96], [-1.02 * Lf, 0, rf * 0.84, rf * 0.78]];
        B.add(tube(fr, TO({ seg: 14, ventral: -1, capA: 0.7, capB: 0.6, amp: 0.09 })));
        // elbow spur + forearm barbs (dorsal side of a hanging limb is +Z... the tube's n2 is -Z; spikes go on the outer/back face)
        B.add(spike({ len: rf * 1.5, rx: rf * 0.32, rz: rf * 0.4, seg: 5, colA: HORN, colB: HORN2 }), aim([0, 0, -rf * 0.8], [0, 0.5, -1]));
        if (!isSpit) for (let k = 0; k < 3; k++) B.add(spike({ len: rf * (0.9 - k * 0.15), rx: rf * 0.22, rz: rf * 0.3, seg: 4, colA: HORN, colB: HORN2 }),
          aim([sx * rf * 0.5, -Lf * (0.25 + k * 0.2), -rf * 0.85], [sx * 0.5, 0.2, -1]));
        skin(el, B);
      }
      {
        const B = new Builder(), hL = d.handL, hr = rf * 0.95;
        B.add(tube([[0.05 * hL, 0, hr * 0.9, hr * 0.7], [-0.5 * hL, hr * 0.1, hr * 1.15, hr * 0.62], [-1.0 * hL, hr * 0.15, hr * 0.95, hr * 0.5]], TO({ seg: 10, ventral: -1, capA: 0.6, capB: 0.5, glow: 0.6 })));
        const nC = isSpit ? 3 : 3;
        for (let k = 0; k < nC; k++) {
          const fx = (k - (nC - 1) / 2) * hr * 0.72;
          // knuckle + finger + claw
          B.add(blob(hr * 0.36, hr * 0.36, hr * 0.36, [sp.hide[0], sp.hide[1], sp.hide[2], 0.3], 6, 4), M4().makeTranslation(fx, -hL * 1.02, hr * 0.2));
          B.add(spike({ len: d.claw * (k === 1 ? 1.1 : 0.95), rx: hr * 0.30, rz: hr * 0.34, seg: 5, rows: 4, colA: HORN, colB: HORN2, curve: 0.32, pow: 0.75 }),
            aim([fx, -hL * 0.98, hr * 0.2], [fx * 0.03, -1, 0.22]));
        }
        B.add(spike({ len: d.claw * 0.7, rx: hr * 0.26, rz: hr * 0.3, seg: 5, rows: 3, colA: HORN, colB: HORN2, curve: 0.3 }), aim([-sx * hr * 0.9, -hL * 0.45, hr * 0.3], [-sx * 0.7, -0.7, 0.5]));
        skin(hd, B);
      }
      return { sh, el, hd };
    }
    const armL = mkArm(1), armR = mkArm(-1);

    // ---- legs
    function mkLeg(sx) {
      const th = node(root, sx * d.hipW, 0, 0);
      const kn = node(th, 0, -d.thL, 0);
      const ft = node(kn, 0, -d.shL, 0);
      const rt = d.thR, rs = d.shR;
      {
        const B = new Builder();
        B.add(tube([[0.18 * d.thL, 0, rt * 1.05, rt * 1.2], [-0.15 * d.thL, 0, rt * 1.18, rt * 1.38], [-0.6 * d.thL, 0, rt * 0.95, rt * 1.05], [-1.03 * d.thL, 0, rt * 0.78, rt * 0.80]],
          TO({ seg: 14, ventral: -1, capA: 0.7, capB: 0.7, amp: 0.08 })));
        skin(th, B);
      }
      {
        const B = new Builder();
        B.add(tube([[0.06 * d.shL, 0, rs * 1.15, rs * 1.15], [-0.3 * d.shL, -rs * 0.15, rs * 1.1, rs * 1.25], [-0.75 * d.shL, 0, rs * 0.72, rs * 0.75], [-1.02 * d.shL, 0, rs * 0.7, rs * 0.7]],
          TO({ seg: 12, ventral: -1, capA: 0.7, capB: 0.6, amp: 0.08, glow: 0.6 })));
        skin(kn, B);
      }
      {
        const B = new Builder(), fl = d.footL;
        B.add(tube([[1.0, -fl * 0.25, rs * 0.8, rs * 0.7], [0.6, fl * 0.3, rs * 1.25, rs * 0.75], [0.0, fl * 0.85, rs * 1.3, rs * 0.5]], TO({ seg: 10, ventral: 1, capA: 0.7, capB: 0.5, glow: 0.2 })));
        for (let k = -1; k <= 1; k++) B.add(spike({ len: 5, rx: rs * 0.3, rz: rs * 0.34, seg: 4, colA: HORN, colB: HORN2, curve: -0.2 }), aim([k * rs * 0.8, 0.2, fl * 0.85], [k * 0.3, 0.05, 1]));
        skin(ft, B);
      }
      return { th, kn, ft };
    }
    const legL = mkLeg(1), legR = mkLeg(-1);

    // ---- tail (segments run along -Z; dorsal is +Y)
    const tail = [];
    {
      const N = d.tailN, total = d.tailL;
      let acc = 0;
      const lens = [];
      for (let i = 0; i < N; i++) { lens.push(1.25 - 0.5 * (i / (N - 1))); acc += lens[i]; }
      let parent = pelvis, z = -b1 * 0.55, y = -L1 * 0.10;
      for (let i = 0; i < N; i++) {
        const len = (lens[i] / acc) * total;
        const bone = node(parent, 0, i ? 0 : y, i ? z : -b1 * 0.45);
        const r0 = d.tailR * Math.pow(1 - i / N, 0.85) + 0.5, r1 = d.tailR * Math.pow(1 - (i + 1) / N, 0.85) + 0.5;
        const B = new Builder();
        B.add(tube([[0, len * 0.14, r0 * 1.02, r0 * 1.05], [0, -len * 0.5, (r0 + r1) * 0.5, (r0 + r1) * 0.52], [0, -len * 1.06, r1, r1 * 1.02]],
          TO({ seg: i < 3 ? 14 : 10, ventral: -1, ridge: 0.12, capA: 0.6, capB: i === N - 1 ? 2.2 : 0.6, amp: 0.07, glow: 0.9 })));
        // blades on top
        const pl = sp.key === 'crawler' ? [7.0, 2.2, 0.6] : sp.key === 'spitter' ? [6.0, 1.2, 0.35] : [3.2, 2.6, 1.3];
        const kf = Math.pow(1 - i / N, 0.7);
        if (i < N - 1) for (const f of [0.25, 0.75]) B.add(spike({ len: pl[0] * kf * (0.8 + 0.4 * rnd()), rx: pl[2], rz: pl[1] * (0.5 + 0.5 * kf), seg: 4, rows: 3, colA: HORN, colB: HORN2, curve: -0.15, pow: 0.7 }),
          sag(lerp(r0, r1, f) * 0.92, -len * f, -0.5));
        if (i === N - 1 && isQuad) for (const sx of [-1, 1]) for (let k = 0; k < 2; k++)       // tail-tip rake
          B.add(spike({ len: 9 - k * 2, rx: 0.9, rz: 0.9, seg: 5, colA: HORN, colB: HORN2, curve: 0.2 }), aim([sx * 0.8, 0, -len * (0.5 + k * 0.35)], [sx, 0.25, -0.5]));
        skin(bone, B);
        tail.push(bone);
        parent = bone; z = -len;
      }
    }

    // ------------------------------------------------------------------ animation
    const cur = new Float32Array(NP), tgt = new Float32Array(NP);
    let first = true, clock = rnd() * 10, tailPhase = rnd() * 6, flashV = 0, lookCur = 0;
    const qa = new T.Quaternion(), qb = new T.Quaternion(), qc = new T.Quaternion(), qd = new T.Quaternion();
    const X = new T.Vector3(1, 0, 0), Y = new T.Vector3(0, 1, 0), Z = new T.Vector3(0, 0, 1);
    // local = Rx(-acc) * Ry(yaw) * Rx(acc + pitch): yaw about the world-up axis for a bone whose parents are pitched by acc
    const worldYaw = (bone, acc, yaw, pitch) => {
      qa.setFromAxisAngle(X, -acc); qb.setFromAxisAngle(Y, yaw); qc.setFromAxisAngle(X, acc + pitch);
      bone.quaternion.copy(qa).multiply(qb).multiply(qc);
    };

    function animate(dt, a) {
      a = a || {};
      const st = a.state || 'idle';
      dt = Math.min(Math.max(dt || 0, 0), 0.1);
      clock += dt;
      computeTarget(sp, K, a, tgt);
      if (first) { cur.set(tgt); first = false; }
      else { const k = 1 - Math.exp(-(LAMBDA[st] || 8) * dt); for (let i = 0; i < NP; i++) cur[i] += (tgt[i] - cur[i]) * k; }
      const c = cur;
      const noLook = st === 'swim' || st === 'death' || st === 'emerge' || st === 'stagger';
      const lk = noLook ? 0 : Math.max(-1, Math.min(1, a.look || 0));
      lookCur += (lk - lookCur) * (1 - Math.exp(-4 * dt));
      tailPhase += dt * (st === 'swim' ? 4.2 : st === 'walk' ? sp.gait : st === 'roar' ? 5 : 1.5);

      root.position.set(c[P.rootX], d.hipH + c[P.rootY], c[P.rootZ] + sp.zOff);   // zOff puts the group origin under the body's centre, not the hips
      root.rotation.set(0, c[P.yaw], c[P.roll]);
      const pitch = c[P.pitch];
      pelvis.rotation.x = pitch;
      worldYaw(s1, pitch, c[P.s1y], c[P.s1p]);
      let acc = pitch + c[P.s1p];
      worldYaw(s2, acc, c[P.s2y] + lookCur * 0.18, c[P.s2p]);
      acc += c[P.s2p];
      const accChest = acc;
      const nN = d.neckN;
      for (let i = 0; i < nN; i++) {
        // the spitter's long neck keeps an S-curve: lower segments lean back, the top one forward
        const sCurve = nN > 1 ? (i === 0 ? -0.22 : i === nN - 1 ? 0.22 : 0) : 0;
        const np = c[P.neckP] / nN + sCurve;
        worldYaw(necks[i], acc, (c[P.neckY] + lookCur * 0.30) / nN, np);
        acc += np;
      }
      qa.setFromAxisAngle(X, -acc); qb.setFromAxisAngle(Y, c[P.headY] + lookCur * 0.52); qc.setFromAxisAngle(X, c[P.headP]); qd.setFromAxisAngle(Z, c[P.headR]);
      head.quaternion.copy(qa).multiply(qb).multiply(qc).multiply(qd);
      jaw.rotation.x = c[P.jaw] * sp.jawMax;

      armL.sh.rotation.set(-(accChest + c[P.aFL]), 0, c[P.aAL]);
      armR.sh.rotation.set(-(accChest + c[P.aFR]), 0, -c[P.aAR]);
      armL.el.rotation.x = -c[P.eL]; armR.el.rotation.x = -c[P.eR];
      armL.hd.rotation.x = -c[P.wL]; armR.hd.rotation.x = -c[P.wR];

      legL.th.rotation.set(-c[P.tL], 0, sp.splay); legR.th.rotation.set(-c[P.tR], 0, -sp.splay);
      legL.kn.rotation.x = c[P.kL]; legR.kn.rotation.x = c[P.kR];
      legL.ft.rotation.x = c[P.tL] - c[P.kL]; legR.ft.rotation.x = c[P.tR] - c[P.kR];

      const N = tail.length;
      for (let i = 0; i < N; i++) {
        const w = c[P.tailYaw] / N + c[P.tailAmp] * Math.sin(tailPhase - i * 0.62) * (0.35 + 0.65 * (i / N));
        if (i === 0) { qa.setFromAxisAngle(X, -pitch); qb.setFromAxisAngle(Y, w); qc.setFromAxisAngle(X, c[P.tailP]); tail[0].quaternion.copy(qa).multiply(qb).multiply(qc); }
        else tail[i].rotation.set(c[P.tailCurl] * (1 + i * 0.12), w, 0);
      }
      if (sac) { const s = 1 + 0.55 * c[P.sac] + 0.04 * Math.sin(clock * 2.1); sac.scale.set(s, s, s); }
      if (frillL) {
        const f = sat(c[P.frill]) , fold = (1 - f) * 1.15 + 0.12 + 0.03 * Math.sin(clock * 23) * f;
        frillL.rotation.y = fold; frillR.rotation.y = -fold;
        const fy = 0.30 + 0.70 * f, fs = 0.72 + 0.28 * f;            // the fan collapses as it folds against the neck
        frillL.scale.set(fs, fy, fs); frillR.scale.set(fs, fy, fs);
        frillL.rotation.x = frillR.rotation.x = -(1 - f) * 0.35;
      }
      const pulse = 0.80 + 0.20 * Math.sin(clock * 1.9 + sd) + 0.06 * Math.sin(clock * 7.3);
      mat.emissiveIntensity = 1.1 * Math.max(0, c[P.glow]) * pulse;
      flashV *= Math.exp(-9 * dt);
      mat.userData.uFlash.value = flashV * 0.9;
      if (matShow) {
        const show = Math.max(sat(c[P.sac]), sat(c[P.frill]) * 0.7);
        matShow.emissiveIntensity = 1.6 * Math.max(0, c[P.glow]) * pulse * (0.22 + 0.72 * show);
        matShow.userData.uFlash.value = flashV * 0.9;
      }
    }

    animate(0, { state: 'idle', t: 0 });

    let tris = 0;
    for (const m of meshes) tris += m.geometry.index.count / 3;
    return {
      group, species: sp,
      anchors: { head: headAnchor, mouth: mouthAnchor, chest: chestAnchor },
      animate,
      flash(k) { flashV = Math.max(flashV, k === undefined ? 1 : k); },
      dispose() { for (const m of meshes) m.geometry.dispose(); mat.dispose(); if (matShow) matShow.dispose(); if (group.parent) group.parent.remove(group); },
      stats: { tris, draws: meshes.length },
    };
  }

  BW.Kaiju = { SPECIES, STATES, DUR, create };
})();
