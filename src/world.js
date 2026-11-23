/* BREAKWATER — world: San Francisco Bay at dusk.
 * Terrain heightfield, the city (instanced, procedurally lit windows), the Golden Gate Bridge,
 * the Bay Bridge, Alcatraz, ships, helicopters, and every light point in the scene.
 * Geography is compressed (about 1 : 2.5) but laid out like the real bay:
 *   -X = west (Golden Gate, Pacific, dusk).   +Z = south (the city).   -Z = north (Marin, Angel Island).
 */
(function () {
  'use strict';
  const T = THREE, BW = window.BW;
  const { clamp, lerp, smooth, sat } = BW;
  const FLOOR = BW.SEA_FLOOR;
  const W = (BW.World = {});

  // ------------------------------------------------------------------ lighting chunk for custom shaders
  // Matches BW.addLights() as three's standard material would shade a rough dielectric.
  const sd = BW.SUN_DIR;
  BW.GLSL.light = /* glsl */ `
    const vec3 L_DIR = vec3(${sd.x.toFixed(5)}, 0.12, ${sd.z.toFixed(5)});
    const vec3 L_DUSK = vec3(0.477, 0.150, 0.045);
    const vec3 L_SKY = vec3(0.034, 0.052, 0.090);
    const vec3 L_GND = vec3(0.007, 0.008, 0.009);
    vec3 litDiffuse(vec3 n) {
      float ndl = max(dot(n, normalize(L_DIR)), 0.0);
      float nf = max(dot(n, normalize(vec3(0.45, 0.82, -0.28))), 0.0);
      return mix(L_GND, L_SKY, n.y * 0.5 + 0.5) + L_DUSK * ndl + vec3(0.026, 0.039, 0.076) * nf;
    }
  `;

  // ------------------------------------------------------------------ geography
  const POLY = {
    sf: [[-2150, 980], [-1800, 900], [-1500, 950], [-1000, 1000], [-300, 950], [200, 880], [800, 840], [1350, 880],
      [1750, 1100], [1950, 1700], [2050, 2600], [2200, 4500], [2200, 7000], [-2600, 7000], [-2600, 2500], [-2500, 1400], [-2350, 1050]],
    marin: [[-7000, -700], [-2600, -760], [-1800, -700], [-1500, -820], [-1250, -1150], [-1000, -1700], [-800, -2300],
      [-600, -3000], [-200, -3600], [-200, -7000], [-7000, -7000]],
    tib: [[300, -7000], [500, -3500], [900, -2950], [1500, -3050], [2200, -3700], [3500, -7000]],
  };
  const HILLS = {
    sf: [[1500, 1250, 80, 220], [850, 1380, 95, 300], [1100, 1780, 100, 320], [-100, 1680, 115, 450], [-1500, 1500, 115, 500],
      [-2300, 1500, 90, 400], [0, 4300, 270, 700], [-600, 3900, 265, 480], [100, 3200, 170, 300], [1700, 3800, 90, 400]],
    marin: [[-2900, -1200, 280, 700], [-1900, -1500, 290, 600], [-1300, -2100, 250, 700], [-2500, -2600, 330, 900], [-3500, -5200, 780, 1800], [-4500, -1500, 300, 1200]],
    tib: [[1200, -3800, 200, 800], [700, -3200, 120, 400], [2400, -5000, 180, 900]],
  };
  const ISLES = [ // cx, cz, a, b, rot, peak, plateau
    { name: 'alcatraz', x: 550, z: -450, a: 265, b: 105, rot: -0.5, peak: 41, plateau: true },
    { name: 'angel', x: 1350, z: -1950, a: 650, b: 500, rot: 0.3, peak: 238 },
    { name: 'yerba', x: 3300, z: -150, a: 420, b: 330, rot: 0.2, peak: 104 },
    { name: 'treasure', x: 3350, z: -950, a: 520, b: 420, rot: 0, peak: 4, plateau: true },
  ];
  W.ALCATRAZ = ISLES[0];
  function bbox(P) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of P) { a = Math.min(a, p[0]); b = Math.min(b, p[1]); c = Math.max(c, p[0]); d = Math.max(d, p[1]); } return [a - 120, b - 120, c + 120, d + 120]; }
  const BB = { sf: bbox(POLY.sf), marin: bbox(POLY.marin), tib: bbox(POLY.tib) };

  function sdPoly(P, x, z) {
    let d = Infinity, s = 1;
    for (let i = 0, j = P.length - 1; i < P.length; j = i, i++) {
      const ex = P[j][0] - P[i][0], ez = P[j][1] - P[i][1];
      const wx = x - P[i][0], wz = z - P[i][1];
      const t = clamp((wx * ex + wz * ez) / (ex * ex + ez * ez), 0, 1);
      const bx = wx - ex * t, bz = wz - ez * t;
      d = Math.min(d, bx * bx + bz * bz);
      const c1 = z >= P[i][1], c2 = z < P[j][1], c3 = ex * wz > ez * wx;
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
    }
    return s * Math.sqrt(d);
  }
  function hillSum(list, x, z) {
    let h = 0;
    for (const k of list) { const dx = x - k[0], dz = z - k[1]; h += k[2] * Math.exp(-(dx * dx + dz * dz) / (k[3] * k[3])); }
    return h;
  }
  function profile(t, hills, ramp) {
    if (t < -90) return FLOOR;
    const under = FLOOR * (1 - smooth(-90, 4, t));
    if (t <= 0) return under;
    return under + 2.5 * smooth(0, 30, t) + hills * smooth(5, ramp, t);
  }
  // Exact (slow) height; the runtime uses the baked grid below.
  function heightExact(x, z) {
    let h = FLOOR;
    for (const key of ['sf', 'marin', 'tib']) {
      const b = BB[key];
      if (x < b[0] || z < b[1] || x > b[2] || z > b[3]) continue;
      const t = -sdPoly(POLY[key], x, z);
      if (t < -90) continue;
      const n = BW.fbm2(x * 0.004, z * 0.004, 4);
      let hills, ramp;
      if (key === 'sf') { hills = hillSum(HILLS.sf, x, z) + n * 14; ramp = 400; }
      else if (key === 'marin') { hills = 40 + hillSum(HILLS.marin, x, z) + n * 90; ramp = 240; }
      else { hills = 15 + hillSum(HILLS.tib, x, z) + n * 40; ramp = 300; }
      h = Math.max(h, profile(t, hills, ramp));
    }
    for (const I of ISLES) {
      const dx = x - I.x, dz = z - I.z;
      if (Math.abs(dx) > I.a + 200 || Math.abs(dz) > I.a + 200) continue;
      const c = Math.cos(I.rot), s = Math.sin(I.rot);
      const u = (dx * c + dz * s) / I.a, v = (-dx * s + dz * c) / I.b;
      const rho = Math.sqrt(u * u + v * v) + (BW.vnoise2(x * 0.011, z * 0.011) - 0.5) * 0.30 + (BW.vnoise2(x * 0.04, z * 0.04) - 0.5) * 0.08;
      if (rho > 1.35) continue;
      const n = BW.fbm2(x * 0.012, z * 0.012, 3);
      let hh;
      if (rho >= 1) hh = FLOOR * smooth(1.0, 1.35, rho);
      else if (I.plateau) hh = I.peak * smooth(1.0, 0.74, rho) * (0.72 + 0.28 * smooth(0.75, 0.3, rho)) + (n - 0.4) * 12 * smooth(1, 0.6, rho);
      else hh = 6 * smooth(1.0, 0.9, rho) + I.peak * Math.pow(Math.max(0, 1 - rho * rho), 1.4) + n * 22 * smooth(1, 0.5, rho);
      h = Math.max(h, hh);
    }
    return h;
  }

  // Baked height grid
  const TX0 = -4400, TX1 = 5200, TZ0 = -4800, TZ1 = 4800, GN = 320;
  const GS = (TX1 - TX0) / GN;
  let grid = null;
  function bake() {
    grid = new Float32Array((GN + 1) * (GN + 1));
    for (let j = 0; j <= GN; j++) for (let i = 0; i <= GN; i++) grid[j * (GN + 1) + i] = heightExact(TX0 + i * GS, TZ0 + j * GS);
  }
  W.terrainH = function (x, z) {
    const fx = (x - TX0) / GS, fz = (z - TZ0) / GS;
    if (fx < 0 || fz < 0 || fx >= GN || fz >= GN) return FLOOR;
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * (GN + 1) + i;
    return grid[k] * (1 - u) * (1 - v) + grid[k + 1] * u * (1 - v) + grid[k + GN + 1] * (1 - u) * v + grid[k + GN + 2] * u * v;
  };

  // ------------------------------------------------------------------ bridge constants
  const BX = -1800, TOWER_Z = 640, ANCH_Z = 983, TOWER_TOP = 227, DECK_W = 27;
  W.BRIDGE = { x: BX, towerZ: TOWER_Z, top: TOWER_TOP };
  function deckY(z) {
    const a = Math.abs(z);
    return 67 - 9 * Math.min((a / TOWER_Z) * (a / TOWER_Z), 1) - (a > TOWER_Z ? (a - TOWER_Z) * 0.028 : 0);
  }
  function cableY(z) {
    const a = Math.abs(z);
    if (a <= TOWER_Z) return 71 + (TOWER_TOP - 6 - 71) * (a / TOWER_Z) * (a / TOWER_Z);
    const t = (a - TOWER_Z) / (ANCH_Z - TOWER_Z);
    const end = deckY(ANCH_Z) + 3;
    return lerp(TOWER_TOP - 6, end, t) - 26 * Math.sin(Math.PI * t) * 0.5;
  }
  // Bay Bridge (western span) line
  const BB0 = [2050, 2500], BB1 = [3250, -50];
  const SHIPS = [{ x: 1950, z: 250, yaw: 0.5, len: 290 }, { x: 2350, z: -1000, yaw: -0.3, len: 240 }];

  // Can a 20 m-radius giant stand here?
  W.blocked = function (x, z, r) {
    r = r || 18;
    if (x < BX + 170 || x > 2500) return true;
    if (z < -3000) return true;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      if (W.terrainH(x + Math.cos(a) * r, z + Math.sin(a) * r) > -10) return true;
    }
    // Bay Bridge
    const ex = BB1[0] - BB0[0], ez = BB1[1] - BB0[1];
    const t = clamp(((x - BB0[0]) * ex + (z - BB0[1]) * ez) / (ex * ex + ez * ez), 0, 1);
    if (Math.hypot(x - BB0[0] - ex * t, z - BB0[1] - ez * t) < 55 + r) return true;
    for (const s of SHIPS) {
      const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), dx = x - s.x, dz = z - s.z;
      const u = dx * sn + dz * c, v = dx * c - dz * sn;
      if (Math.abs(u) < s.len / 2 + r && Math.abs(v) < 24 + r) return true;
    }
    return false;
  };

  // ------------------------------------------------------------------ geometry helpers
  function merge(list) {
    let n = 0;
    const parts = list.map((g) => { const q = g.index ? g.toNonIndexed() : g; n += q.attributes.position.count; return q; });
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), ext = new Float32Array(n);
    let o = 0;
    for (const q of parts) {
      const c = q.attributes.position.count;
      pos.set(q.attributes.position.array, o * 3);
      nor.set(q.attributes.normal.array, o * 3);
      if (q.attributes.color) col.set(q.attributes.color.array, o * 3); else col.fill(1, o * 3, (o + c) * 3);
      if (q.attributes.aFlood) ext.set(q.attributes.aFlood.array, o);
      o += c;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(nor, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setAttribute('aFlood', new T.BufferAttribute(ext, 1));
    return g;
  }
  W.merge = merge;
  const _m = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler(), _v = new T.Vector3(), _s = new T.Vector3();
  function place(g, x, y, z, ry, rx, rz) {
    _e.set(rx || 0, ry || 0, rz || 0, 'YXZ');
    _m.compose(_v.set(x, y, z), _q.setFromEuler(_e), _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    return g;
  }
  function tint(g, r, gg, b, flood) {
    const n = g.attributes.position.count, c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
    g.setAttribute('color', new T.BufferAttribute(c, 3));
    if (flood !== undefined) {
      const f = new Float32Array(n);
      const p = g.attributes.position.array;
      for (let i = 0; i < n; i++) f[i] = typeof flood === 'function' ? flood(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) : flood;
      g.setAttribute('aFlood', new T.BufferAttribute(f, 1));
    }
    return g;
  }
  const box = (w, h, d, x, y, z, ry, rx, rz) => place(new T.BoxGeometry(w, h, d), x, y, z, ry, rx, rz);
  // A box beam from point A to point B with square-ish section.
  function beam(ax, ay, az, bx, by, bz, w, d) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    const g = new T.BoxGeometry(w, len, d || w);
    _q.setFromUnitVectors(_v.set(0, 1, 0), _s.set(dx / len, dy / len, dz / len));
    _m.compose(_v.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    return g;
  }

  // ------------------------------------------------------------------ terrain mesh
  function buildTerrain(scene) {
    const N = GN + 1;
    const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3);
    const c = new T.Color();
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = j * N + i, x = TX0 + i * GS, z = TZ0 + j * GS, h = grid[k];
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        const hx = grid[j * N + Math.min(i + 1, GN)] - grid[j * N + Math.max(i - 1, 0)];
        const hz = grid[Math.min(j + 1, GN) * N + i] - grid[Math.max(j - 1, 0) * N + i];
        const slope = Math.hypot(hx, hz) / (2 * GS);
        const n = BW.fbm2(x * 0.01, z * 0.01, 3);
        const inSF = z > 700 && x > -2700 && x < 2300;
        const presidio = inSF && Math.pow((x + 1500) / 780, 2) + Math.pow((z - 1560) / 540, 2) < 1;
        if (h < 1.6) c.setRGB(0.20, 0.18, 0.14);                                   // wet sand / riprap
        else if (inSF && !presidio && h < 190) c.setRGB(0.045 + n * 0.02, 0.046 + n * 0.02, 0.05 + n * 0.02); // asphalt, roofs
        else if (slope > 0.55) c.setRGB(0.16 + n * 0.06, 0.145 + n * 0.05, 0.12 + n * 0.04);                 // rock
        else if (presidio) c.setRGB(0.02 + n * 0.02, 0.05 + n * 0.03, 0.025);                               // cypress, eucalyptus
        else c.setRGB(0.10 + n * 0.07, 0.105 + n * 0.06, 0.05 + n * 0.02);                                   // coastal scrub
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      }
    const idx = [];
    for (let j = 0; j < GN; j++)
      for (let i = 0; i < GN; i++) {
        const a = j * N + i, b = a + 1, d = a + N, e = d + 1;
        if (Math.max(grid[a], grid[b], grid[d], grid[e]) < -7) continue;
        idx.push(a, d, b, b, d, e);
      }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new T.Mesh(g, new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.6 }));
    mesh.frustumCulled = false;
    scene.add(mesh);
    // Height texture for the water shader (shore foam, shallows).
    const data = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) { const v = Math.round(sat((grid[k] - FLOOR) / (10 - FLOOR)) * 255); data[k * 4] = v; data[k * 4 + 3] = 255; }
    const tex = new T.DataTexture(data, N, N, T.RGBAFormat, T.UnsignedByteType);
    tex.magFilter = tex.minFilter = T.LinearFilter;
    tex.needsUpdate = true;
    W.heightTex = tex;
    W.heightRect = new T.Vector4(TX0, TZ0, TX1 - TX0, TZ1 - TZ0);
    // Far east-bay ridge, beyond the grid.
    const rp = [], ri = [];
    const RN = 90;
    for (let i = 0; i <= RN; i++) {
      const z = -9000 + (18000 * i) / RN;
      const hh = 180 + BW.fbm2(z * 0.0006, 3.3, 4) * 520;
      rp.push(6600, -5, z, 8200, hh * 0.55, z, 10500, hh, z);
      if (i < RN) { const a = i * 3; ri.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
    }
    const rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.BufferAttribute(new Float32Array(rp), 3));
    rg.setIndex(ri); rg.computeVertexNormals();
    const ridge = new T.Mesh(rg, new T.MeshStandardMaterial({ color: 0x1a1c18, roughness: 1, side: T.DoubleSide }));
    ridge.frustumCulled = false;
    scene.add(ridge);
  }

  // ------------------------------------------------------------------ light points (FX scene)
  // One Points cloud for every lamp in the bay. aKind: x = size (m), y = blink phase (0 = steady), z = twinkle
  const LP = { pos: [], col: [], kind: [] };
  function lamp(x, y, z, r, g, b, size, blink, tw) {
    LP.pos.push(x, y, z); LP.col.push(r, g, b); LP.kind.push(size || 3, blink || 0, tw === undefined ? 0.3 : tw);
  }
  const SODIUM = [1.0, 0.56, 0.22], LED = [0.80, 0.90, 1.0], WARM = [1.0, 0.74, 0.46];
  function buildLamps(fx) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(LP.pos), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(LP.col), 3));
    g.setAttribute('aKind', new T.BufferAttribute(new Float32Array(LP.kind), 3));
    const mat = new T.ShaderMaterial({
      uniforms: {
        uTime: BW.U.uSkyTime, uPx: { value: 800 }, uPower: { value: 1 },
        uSkyTime: BW.U.uSkyTime, uFlash: BW.U.uFlash, uFlashDir: BW.U.uFlashDir, uNoise: BW.U.uNoise,
        uFogDensity: BW.U.uFogDensity, uEye: BW.U.uEye, uDepthTex: BW.U.uDepthTex, uResolution: BW.U.uResolution, uNearFar: BW.U.uNearFar,
      },
      vertexShader: /* glsl */ `
        attribute vec3 color; attribute vec3 aKind;
        uniform float uTime, uPx, uPower;
        varying vec3 vCol; varying float vZ;
        ${BW.GLSL.sky} ${BW.GLSL.fog}
        void main() {
          vec4 mv = viewMatrix * vec4(position, 1.0);
          vZ = -mv.z;
          gl_Position = projectionMatrix * mv;
          float ideal = aKind.x * 5.5 * uPx / max(vZ, 1.0);
          float sz = clamp(ideal, 2.0, 46.0);
          gl_PointSize = sz;
          float I = min(1.0, (ideal * ideal) / (sz * sz)) ;
          I = mix(I, 1.0, 0.25);
          float fog = fogAmount(position);
          I *= (1.0 - fog) * (1.0 - fog);
          float h = fract(sin(dot(position.xz, vec2(12.9898, 78.233))) * 43758.5453);
          I *= 1.0 - aKind.z * (0.5 + 0.5 * sin(uTime * (2.0 + h * 5.0) + h * 40.0)) * smoothstep(300.0, 2500.0, vZ);
          if (aKind.y > 0.0) I *= step(0.72, fract(uTime * 0.7 + aKind.y));
          vCol = color * I * uPower;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        varying vec3 vCol; varying float vZ;
        ${BW.GLSL.fxDepth}
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(p, p);
          if (r2 > 1.0) discard;
          float a = exp(-r2 * 9.0) * 2.4 + exp(-r2 * 2.5) * 0.22;
          a *= fxDepthFade(vZ, 4.0);
          gl_FragColor = vec4(vCol * a, 1.0);
        }`,
      blending: T.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    });
    const pts = new T.Points(g, mat);
    pts.frustumCulled = false;
    fx.add(pts);
    W.lampMat = mat;
  }

  // ------------------------------------------------------------------ city
  const GRID_A = 0.155;                                  // street grid rotation
  const bld = { x: [], z: [], h: [], alive: [] };        // for damage lookups
  let cityMesh = null, cityInfo = null;
  function cityMaterial() {
    return new T.ShaderMaterial({
      uniforms: { uTime: BW.U.uSkyTime },
      vertexShader: /* glsl */ `
        attribute vec4 aInfo;
        varying vec3 vLocal; varying vec3 vN; varying vec4 vInfo; varying vec3 vScale;
        void main() {
          vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
          vec3 p = position;
          float dmg = aInfo.y;
          p.y *= 1.0 - 0.74 * dmg;
          p.x += dmg * 0.22 * p.y * sin(aInfo.x * 40.0);
          vLocal = p * sc; vScale = sc; vInfo = aInfo;
          vN = normalize(mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime;
        varying vec3 vLocal; varying vec3 vN; varying vec4 vInfo; varying vec3 vScale;
        ${BW.GLSL.light}
        float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
        float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        void main() {
          vec3 n = normalize(vN);
          float seed = vInfo.x, dmg = vInfo.y, style = vInfo.z;
          vec3 facade = mix(vec3(0.030, 0.033, 0.038), vec3(0.11, 0.10, 0.09), hash11(seed * 91.7));
          facade = mix(facade, vec3(0.02, 0.03, 0.04), step(0.5, style) * 0.7);          // glass towers
          float face = abs(n.x) > abs(n.z) ? 0.0 : 1.0;
          float u = face < 0.5 ? vLocal.z : vLocal.x;
          float v = vLocal.y;
          float cw = mix(2.8, 4.4, hash11(seed * 13.1)), ch = 3.6;
          vec2 g = vec2(u / cw, v / ch);
          vec2 cell = floor(g), f = fract(g);
          float fw = max(fwidth(g.x), fwidth(g.y));
          float win = smoothstep(0.12, 0.2, f.x) * smoothstep(0.88, 0.8, f.x) * smoothstep(0.2, 0.3, f.y) * smoothstep(0.86, 0.76, f.y);
          float occ = mix(0.04, 0.34, hash11(seed * 7.3));
          float r = hash21(cell + vec2(seed * 57.0 + face * 13.0, seed * 19.0));
          float row = step(hash21(vec2(cell.y, seed * 3.0)), 0.07);
          float lit = max(step(1.0 - occ, r), row * step(0.22, r));
          vec3 wc = mix(vec3(1.0, 0.66, 0.36), vec3(0.70, 0.84, 1.0), step(0.70, hash11(seed * 3.7)));
          float avg = (occ + 0.05) * 0.42;
          vec2 cell2 = floor(g / 3.0);
          float far = step(1.0 - occ * 0.75, hash21(cell2 + vec2(seed * 31.0 + face * 7.0, seed * 11.0))) * 0.42;   // clusters of lit floors
          float e = mix(lit * win * (0.5 + 0.9 * hash21(cell + 3.1)), far, smoothstep(0.3, 1.0, fw));
          e = mix(e, avg, smoothstep(2.5, 6.0, fw));
          float roof = step(0.7, n.y);
          e *= (1.0 - roof) * (1.0 - dmg);
          vec3 col = facade * litDiffuse(n) * 1.3;
          // crown light for the tall round tower (style 2)
          col += step(1.5, style) * vec3(0.5, 0.75, 1.0) * smoothstep(0.90, 0.97, v / vScale.y) * (0.6 + 0.4 * sin(uTime * 0.6 + u * 0.05)) * 1.5 * (1.0 - roof);
          // fires in wrecked buildings
          float fl = 0.55 + 0.45 * sin(uTime * 11.0 + seed * 50.0) * sin(uTime * 7.3 + seed * 20.0);
          col += vec3(1.6, 0.42, 0.08) * dmg * fl * smoothstep(vScale.y * 0.5, 0.0, v) * 2.2;
          gl_FragColor = vec4(col + wc * e * 2.1, 1.0);
        }`,
    });
  }
  function inSFUrban(x, z) {
    if (z < 860 || x < -2450 || x > 2180 || z > 4700) return false;
    if (Math.pow((x + 1500) / 780, 2) + Math.pow((z - 1560) / 540, 2) < 1) return false;      // Presidio
    if (x > -2500 && x < -500 && z > 3300 && z < 3560) return false;                           // Golden Gate Park
    return true;
  }
  function buildCity(scene) {
    const rnd = BW.rng(4242);
    const ca = Math.cos(GRID_A), sa = Math.sin(GRID_A), LOT = 36;
    const mats = [], infos = [];
    const dummy = new T.Object3D();
    function add(geoKey, x, y, z, w, h, d, ry, style, seed) {
      dummy.position.set(x, y, z); dummy.rotation.set(0, ry, 0); dummy.scale.set(w, h, d); dummy.updateMatrix();
      mats.push(dummy.matrix.clone()); infos.push(seed, 0, style, 0);
      bld.x.push(x); bld.z.push(z); bld.h.push(h); bld.alive.push(1);
    }
    for (let i = -10; i < 150; i++)
      for (let j = -20; j < 125; j++) {
        const street = i % 4 === 0 || j % 3 === 0;
        const u = i * LOT, v = j * LOT;
        const x = -2500 + u * ca - v * sa, z = 880 + u * sa + v * ca;
        if (!inSFUrban(x, z)) continue;
        const h0 = W.terrainH(x, z);
        if (h0 < 2.2 || h0 > 195) continue;
        if (street) {
          if (rnd() < 0.62) {
            const c = rnd() < 0.8 ? SODIUM : LED;
            lamp(x + (rnd() - 0.5) * 8, h0 + 9, z + (rnd() - 0.5) * 8, c[0], c[1], c[2], 2.6 + rnd() * 1.2, 0, 0.35);
          }
          continue;
        }
        if (rnd() < 0.06) continue;
        const D = Math.exp(-((x - 1500) * (x - 1500) + (z - 1950) * (z - 1950)) / (2 * 430 * 430)) +
          0.55 * Math.exp(-((x - 1780) * (x - 1780)) / (2 * 300 * 300) - ((z - 2600) * (z - 2600)) / (2 * 480 * 480));
        const vn = 0.5 * Math.exp(-Math.pow((x - 420) / 90, 2));                         // Van Ness corridor
        const r1 = rnd(), r2 = rnd();
        let h = 9 + 9 * r1 * r1 + vn * 40 * r2;
        let w = 26 + rnd() * 6, d = 26 + rnd() * 6, style = 0;
        if (D > 0.08) {
          h += D * (40 + 210 * Math.pow(r2, 1.5));
          w = 30 + rnd() * 5; d = 30 + rnd() * 5;
          if (h > 70 && rnd() < 0.55) style = 1;
        }
        add('box', x, h0 - 2, z, w, h + 2, d, -GRID_A, style, rnd());
      }
    // piers along the Embarcadero
    const shore = [[820, 835], [1350, 872], [1750, 1092], [1950, 1700], [2040, 2500]];
    for (let s = 0; s < shore.length - 1; s++) {
      const a = shore[s], b = shore[s + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const nx = (b[1] - a[1]) / len, nz = -(b[0] - a[0]) / len;       // outward (toward the bay)
      const count = Math.floor(len / 95);
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count, px = lerp(a[0], b[0], t), pz = lerp(a[1], b[1], t);
        const L = 130 + rnd() * 60;
        add('box', px + nx * (L / 2 - 15), -1, pz + nz * (L / 2 - 15), 34, 11 + rnd() * 3, L, Math.atan2(nx, nz), 0, rnd() * 0.3);
        lamp(px + nx * (L - 14), 13, pz + nz * (L - 14), WARM[0], WARM[1], WARM[2], 3.2, 0, 0.2);
      }
    }
    const boxG = new T.BoxGeometry(1, 1, 1); boxG.translate(0, 0.5, 0);
    cityMesh = new T.InstancedMesh(boxG, cityMaterial(), mats.length);
    for (let i = 0; i < mats.length; i++) cityMesh.setMatrixAt(i, mats[i]);
    cityInfo = new T.InstancedBufferAttribute(new Float32Array(infos), 4);
    cityInfo.setUsage(T.DynamicDrawUsage);
    boxG.setAttribute('aInfo', cityInfo);
    cityMesh.frustumCulled = false;
    scene.add(cityMesh);
    W.buildingCount = mats.length;

    // Hero silhouettes share the shader through single-instance meshes.
    function hero(geo, x, z, w, h, d, style, seed, ry) {
      const m = new T.InstancedMesh(geo, cityMesh.material, 1);
      dummy.position.set(x, W.terrainH(x, z) - 2, z); dummy.rotation.set(0, ry || -GRID_A, 0); dummy.scale.set(w, h, d); dummy.updateMatrix();
      m.setMatrixAt(0, dummy.matrix);
      geo.setAttribute('aInfo', new T.InstancedBufferAttribute(new Float32Array([seed, 0, style, 0]), 4));
      m.frustumCulled = false; scene.add(m);
      return m;
    }
    const pyr = new T.ConeGeometry(0.7071, 1, 4, 1); pyr.translate(0, 0.5, 0); pyr.rotateY(Math.PI / 4);
    hero(pyr, 1400, 1580, 56, 262, 56, 0, 0.31);                                              // the pyramid
    const round = new T.CylinderGeometry(0.36, 0.5, 1, 20, 8); round.translate(0, 0.5, 0);
    { // taper the crown
      const p = round.attributes.position;
      for (let i = 0; i < p.count; i++) { const y = p.getY(i); if (y > 0.8) { const k = 1 - 0.55 * Math.pow((y - 0.8) / 0.2, 2); p.setX(i, (p.getX(i) / 0.36) * 0.36 * k); p.setZ(i, (p.getZ(i) / 0.36) * 0.36 * k); } }
      round.computeVertexNormals();
    }
    hero(round, 1660, 2230, 62, 326, 62, 2, 0.77);                                            // the tall round tower
    lamp(1400, W.terrainH(1400, 1580) + 262, 1580, 1, 0.1, 0.05, 5, 0.3, 0);
    lamp(1660, W.terrainH(1660, 2230) + 328, 2230, 1, 0.1, 0.05, 5, 0.6, 0);

    // Standard-material landmarks
    const parts = [];
    const th = W.terrainH(1500, 1250);
    parts.push(tint(place(new T.CylinderGeometry(5.5, 6.5, 58, 14), 1500, th + 29, 1250), 0.75, 0.72, 0.66, 0.3));   // tower on Telegraph Hill
    parts.push(tint(box(11, 72, 11, 1962, 36, 1702, -GRID_A), 0.62, 0.6, 0.56, 0.35));                             // ferry terminal clock tower
    parts.push(tint(box(200, 14, 36, 1962, 7, 1702, -GRID_A + Math.PI / 2 + 0.1), 0.5, 0.5, 0.48, 0.12));
    lamp(1955, 58, 1702, 1.0, 0.9, 0.7, 5, 0, 0);
    parts.push(tint(place(new T.SphereGeometry(22, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), -700, 26, 1040), 0.7, 0.55, 0.4, 0.14)); // rotunda by the lagoon
    parts.push(tint(place(new T.CylinderGeometry(21, 21, 24, 16, 1, true), -700, 14, 1040), 0.7, 0.55, 0.4, 0.16));
    // the hilltop mast: three legs, three decks, red and white
    const sx = -600, sz = 3900, sy = W.terrainH(sx, sz);
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      const bx = sx + Math.cos(a) * 30, bz = sz + Math.sin(a) * 30, tx = sx + Math.cos(a) * 12, tz = sz + Math.sin(a) * 12;
      parts.push(tint(beam(bx, sy, bz, tx, sy + 190, tz, 4.5), 0.75, 0.2, 0.15, 0.1));
      parts.push(tint(beam(tx, sy + 190, tz, tx, sy + 298, tz, 2.6), 0.9, 0.9, 0.9, 0.1));
      lamp(tx, sy + 300, tz, 1, 0.08, 0.04, 6, 0.2 + k * 0.25, 0);
      lamp(tx, sy + 190, tz, 1, 0.08, 0.04, 4.5, 0, 0);
    }
    for (const yy of [120, 190, 240]) parts.push(tint(place(new T.CylinderGeometry(20 - yy * 0.03, 20 - yy * 0.03, 4, 3), sx, sy + yy, sz), 0.8, 0.8, 0.8, 0.1));
    const lm = new T.Mesh(merge(parts), floodMaterial(0xffffff, 0.8, 0.0));
    lm.frustumCulled = false; scene.add(lm);
  }
  // Mark buildings near (x, z) as destroyed. Returns the list of [x, z, h] newly lost.
  W.damageCity = function (x, z, radius, max) {
    const out = [];
    if (!cityInfo) return out;
    for (let i = 0; i < bld.x.length && out.length < (max || 8); i++) {
      if (!bld.alive[i]) continue;
      if (Math.hypot(bld.x[i] - x, bld.z[i] - z) < radius) {
        bld.alive[i] = 0; cityInfo.array[i * 4 + 1] = 1; out.push([bld.x[i], bld.z[i], bld.h[i]]);
      }
    }
    if (out.length) cityInfo.needsUpdate = true;
    return out;
  };
  W.resetCity = function () {
    if (!cityInfo) return;
    for (let i = 0; i < bld.x.length; i++) { bld.alive[i] = 1; cityInfo.array[i * 4 + 1] = 0; }
    cityInfo.needsUpdate = true;
  };

  // Standard material + a per-vertex "floodlit" emissive term (aFlood attribute).
  function floodMaterial(color, rough, metal) {
    const m = new T.MeshStandardMaterial({ color, roughness: rough, metalness: metal, vertexColors: true, envMapIntensity: 0.7 });
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float aFlood; varying float vFlood;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vFlood = aFlood;');
      sh.fragmentShader = 'varying float vFlood;\n' + sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vFlood;');
    };
    return m;
  }

  // ------------------------------------------------------------------ the Golden Gate Bridge
  function buildGoldenGate(scene, fx) {
    const O = [0.753, 0.212, 0.172];                    // International Orange (sRGB) -> linearised below
    const lin = (v) => Math.pow(v, 2.2);
    const or = lin(O[0]), og = lin(O[1]), ob = lin(O[2]);
    const steel = [], conc = [];
    const towerFlood = (x, y) => 0.10 + 0.55 * Math.exp(-Math.max(y - 62, 0) / 60);
    for (const tz of [-TOWER_Z, TOWER_Z]) {
      for (const sx of [-1, 1]) {
        const x = BX + sx * (DECK_W / 2 + 3.5);
        // stepped legs
        const steps = [[-4, 58, 11, 17], [58, 104, 9.6, 15], [104, 146, 8.4, 13], [146, 186, 7.2, 11.2], [186, TOWER_TOP, 6.2, 9.6]];
        for (const s of steps) steel.push(tint(box(s[2], s[1] - s[0], s[3], x, (s[0] + s[1]) / 2, tz), or, og, ob, towerFlood));
        steel.push(tint(box(8, 5, 12, x, TOWER_TOP + 2.5, tz), or, og, ob, 0.2));
        lamp(x, TOWER_TOP + 7, tz, 1, 0.08, 0.04, 6.5, sx > 0 ? 0.01 : 0.5, 0);
      }
      // portal struts above the roadway, cross-bracing below it
      for (const s of [[100, 9], [142, 8], [182, 7], [221, 6]])
        steel.push(tint(box(DECK_W + 7, s[1], 7, BX, s[0], tz), or, og, ob, towerFlood));
      const xl = BX - DECK_W / 2 - 3.5, xr = BX + DECK_W / 2 + 3.5;
      for (const y of [[2, 28], [28, 54]]) {
        steel.push(tint(beam(xl, y[0], tz, xr, y[1], tz, 3.2, 5), or, og, ob, 0.14));
        steel.push(tint(beam(xr, y[0], tz, xl, y[1], tz, 3.2, 5), or, og, ob, 0.14));
      }
      steel.push(tint(box(DECK_W + 7, 4, 6, BX, 28, tz), or, og, ob, 0.14));
      // pier and fender
      conc.push(tint(box(64, 30, 40, BX, -9, tz), 0.36, 0.35, 0.33, 0.05));
      if (tz > 0) {
        const ring = new T.CylinderGeometry(1, 1, 16, 28, 1, true); ring.scale(52, 1, 82);
        conc.push(tint(place(ring, BX, -2, tz), 0.33, 0.32, 0.30, 0.04));
      }
    }
    // deck: swept box following the camber, with a darker stiffening truss underneath
    const SEG = 48, z0 = -ANCH_Z - 300, z1 = ANCH_Z + 300;
    for (let i = 0; i < SEG; i++) {
      const za = lerp(z0, z1, i / SEG), zb = lerp(z0, z1, (i + 1) / SEG);
      const ya = deckY(clamp(za, -ANCH_Z, ANCH_Z)), yb = deckY(clamp(zb, -ANCH_Z, ANCH_Z));
      steel.push(tint(beam(BX, ya - 0.8, za, BX, yb - 0.8, zb, DECK_W, 1.6), 0.05, 0.05, 0.055, 0.02));       // roadway
      for (const sx of [-1, 1]) {
        const x = BX + sx * (DECK_W / 2 - 0.5);
        steel.push(tint(beam(x, ya - 0.2, za, x, yb - 0.2, zb, 1.2, 2.6), or, og, ob, 0.16));               // top chord / rail
        steel.push(tint(beam(x, ya - 8.2, za, x, yb - 8.2, zb, 1.2, 1.4), or * 0.8, og * 0.8, ob * 0.8, 0.06)); // bottom chord
        const zm = (za + zb) / 2, ym = (ya + yb) / 2;
        steel.push(tint(beam(x, ya - 8.2, za, x, ym - 0.8, zm, 0.9), or * 0.8, og * 0.8, ob * 0.8, 0.06));    // warren truss
        steel.push(tint(beam(x, ym - 0.8, zm, x, yb - 8.2, zb, 0.9), or * 0.8, og * 0.8, ob * 0.8, 0.06));
      }
      if (i % 2 === 0) steel.push(tint(box(DECK_W, 1.2, 1.2, BX, ya - 8.2, za), or * 0.7, og * 0.7, ob * 0.7, 0.04));
    }
    // approach viaduct piers
    for (const z of [-ANCH_Z - 150, ANCH_Z + 90, ANCH_Z + 200]) {
      const top = deckY(ANCH_Z) - 9, bot = Math.max(W.terrainH(BX, z) - 4, -22);
      if (top - bot > 6) conc.push(tint(box(20, top - bot, 8, BX, (top + bot) / 2, z), 0.36, 0.35, 0.33, 0.05));
    }
    for (const z of [-ANCH_Z, ANCH_Z]) conc.push(tint(box(46, 34, 60, BX, deckY(ANCH_Z) - 22, z), 0.36, 0.35, 0.33, 0.06));   // anchorages
    // main cables
    for (const sx of [-1, 1]) {
      const x = BX + sx * (DECK_W / 2 + 3.5);
      const CS = 64;
      for (let i = 0; i < CS; i++) {
        const za = lerp(-ANCH_Z, ANCH_Z, i / CS), zb = lerp(-ANCH_Z, ANCH_Z, (i + 1) / CS);
        steel.push(tint(beam(x, cableY(za), za, x, cableY(zb), zb, 1.7), or, og, ob, 0.10));
      }
    }
    const steelMesh = new T.Mesh(merge(steel), floodMaterial(0xffffff, 0.62, 0.25));
    const concMesh = new T.Mesh(merge(conc), floodMaterial(0xffffff, 0.95, 0));
    steelMesh.frustumCulled = concMesh.frustumCulled = false;
    scene.add(steelMesh, concMesh);
    // suspender ropes
    const lp = [];
    for (const sx of [-1, 1]) {
      const x = BX + sx * (DECK_W / 2 + 3.5);
      for (let z = -ANCH_Z + 15; z < ANCH_Z; z += 15.2) {
        if (Math.abs(Math.abs(z) - TOWER_Z) < 9) continue;
        const yc = cableY(z), yd = deckY(z);
        if (yc - yd > 2) lp.push(x, yc, z, x, yd, z);
      }
    }
    const lg = new T.BufferGeometry();
    lg.setAttribute('position', new T.BufferAttribute(new Float32Array(lp), 3));
    const ropes = new T.LineSegments(lg, new T.LineBasicMaterial({ color: new T.Color(or * 0.5, og * 0.5, ob * 0.5) }));
    ropes.frustumCulled = false;
    scene.add(ropes);
    // roadway lamps
    for (let z = -ANCH_Z - 280; z <= ANCH_Z + 280; z += 46) {
      const y = deckY(clamp(z, -ANCH_Z, ANCH_Z)) + 9;
      lamp(BX - DECK_W / 2, y, z, SODIUM[0], SODIUM[1], SODIUM[2], 3.3, 0, 0.1);
      lamp(BX + DECK_W / 2, y, z + 23, SODIUM[0], SODIUM[1], SODIUM[2], 3.3, 0, 0.1);
    }
    lamp(BX, cableY(0) + 2, 0, 1, 0.08, 0.04, 4, 0.8, 0);
    // traffic: headlights and tail lights streaming across, animated in the vertex shader
    const NCAR = 150, cp = new Float32Array(NCAR * 3), ck = new Float32Array(NCAR * 3);
    const rnd = BW.rng(77);
    for (let i = 0; i < NCAR; i++) {
      const lane = i % 4;
      cp[i * 3] = BX + (lane - 1.5) * 5.4; cp[i * 3 + 1] = 1.2; cp[i * 3 + 2] = 0;
      ck[i * 3] = rnd(); ck[i * 3 + 1] = lane < 2 ? 1 : -1; ck[i * 3 + 2] = 0.8 + rnd() * 0.4;
    }
    const cg = new T.BufferGeometry();
    cg.setAttribute('position', new T.BufferAttribute(cp, 3));
    cg.setAttribute('aCar', new T.BufferAttribute(ck, 3));
    const cars = new T.Points(cg, new T.ShaderMaterial({
      uniforms: { uTime: BW.U.uSkyTime, uPx: { value: 800 }, uFogDensity: BW.U.uFogDensity, uEye: BW.U.uEye, uSkyTime: BW.U.uSkyTime, uFlash: BW.U.uFlash,
        uFlashDir: BW.U.uFlashDir, uNoise: BW.U.uNoise, uDepthTex: BW.U.uDepthTex, uResolution: BW.U.uResolution, uNearFar: BW.U.uNearFar, uFlow: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aCar; uniform float uTime, uPx, uFlow; varying vec3 vCol; varying float vZ;
        ${BW.GLSL.sky} ${BW.GLSL.fog}
        float deckY(float z) { float a = abs(z); return 67.0 - 9.0 * min((a / ${TOWER_Z}.0) * (a / ${TOWER_Z}.0), 1.0) - max(a - ${TOWER_Z}.0, 0.0) * 0.028; }
        void main() {
          float span = ${(ANCH_Z + 280).toFixed(1)};
          float z = (fract(aCar.x + uTime * 0.0095 * aCar.z * aCar.y * uFlow) * 2.0 - 1.0) * span;
          vec3 p = vec3(position.x, deckY(clamp(z, -${ANCH_Z}.0, ${ANCH_Z}.0)) + 1.3, z);
          vec4 mv = viewMatrix * vec4(p, 1.0); vZ = -mv.z; gl_Position = projectionMatrix * mv;
          float toward = sign((uEye.z - z) * aCar.y);
          vec3 c = toward > 0.0 ? vec3(1.0, 0.95, 0.85) * 1.5 : vec3(1.0, 0.06, 0.03) * 0.7;
          float ideal = 2.4 * 5.5 * uPx / max(vZ, 1.0); float sz = clamp(ideal, 1.6, 24.0); gl_PointSize = sz;
          float fog = fogAmount(p);
          vCol = c * min(1.0, (ideal * ideal) / (sz * sz) + 0.2) * (1.0 - fog) * (1.0 - fog);
        }`,
      fragmentShader: /* glsl */ `precision highp float; varying vec3 vCol; varying float vZ; ${BW.GLSL.fxDepth}
        void main() { vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard;
          gl_FragColor = vec4(vCol * exp(-r2 * 7.0) * 2.2 * fxDepthFade(vZ, 3.0), 1.0); }`,
      blending: T.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
    }));
    cars.frustumCulled = false;
    fx.add(cars);
    W.carMat = cars.material;
  }

  // ------------------------------------------------------------------ the Bay Bridge (distant, simplified)
  function buildBayBridge(scene) {
    const parts = [];
    const ex = BB1[0] - BB0[0], ez = BB1[1] - BB0[1], len = Math.hypot(ex, ez), ry = Math.atan2(ex, ez);
    const at = (t) => [BB0[0] + ex * t, BB0[1] + ez * t];
    const G = [0.30, 0.32, 0.34];
    parts.push(tint(box(20, 10, len + 500, BB0[0] + ex * 0.45, 58, BB0[1] + ez * 0.45, ry), G[0], G[1], G[2], 0.04));
    const towers = [0.14, 0.38, 0.62, 0.86];
    for (const t of towers) {
      const p = at(t);
      for (const s of [-1, 1]) {
        const ox = Math.cos(ry) * s * 12, oz = -Math.sin(ry) * s * 12;
        parts.push(tint(box(6, 180, 7, p[0] + ox, 68, p[1] + oz, ry), G[0], G[1], G[2], 0.10));
        lamp(p[0] + ox, 160, p[1] + oz, 1, 0.08, 0.04, 5, 0.3 + t, 0);
      }
      for (const y of [85, 120, 150]) parts.push(tint(box(26, 5, 5, p[0], y, p[1], ry), G[0], G[1], G[2], 0.1));
    }
    const mid = at(0.5);
    parts.push(tint(box(34, 100, 60, mid[0], 28, mid[1], ry), 0.34, 0.34, 0.33, 0.05));
    const m = new T.Mesh(merge(parts), floodMaterial(0xffffff, 0.8, 0.2));
    m.frustumCulled = false; scene.add(m);
    // cables as strings of white LEDs, plus the deck lamps
    const segs = [[0.02, 0.14], [0.14, 0.38], [0.38, 0.5], [0.5, 0.62], [0.62, 0.86], [0.86, 0.98]];
    for (const s of segs) {
      const full = Math.abs(s[1] - s[0]) > 0.2;
      for (let k = 0; k <= 26; k++) {
        const u = k / 26, t = lerp(s[0], s[1], u), p = at(t);
        let y;
        if (full) y = 66 + (156 - 66) * Math.pow(Math.abs(u - 0.5) * 2, 2);
        else { const hi = s[0] === 0.02 || s[0] === 0.5 ? u : 1 - u; y = 62 + (156 - 62) * hi * hi; }
        for (const sgn of [-1, 1]) lamp(p[0] + Math.cos(ry) * sgn * 12, y, p[1] - Math.sin(ry) * sgn * 12, LED[0], LED[1], LED[2], 2.8, 0, 0.5);
      }
    }
    for (let k = 0; k < 60; k++) { const p = at(-0.05 + (k / 60) * 1.15); lamp(p[0], 66, p[1], WARM[0], WARM[1], WARM[2], 3, 0, 0.2); }
  }

  // ------------------------------------------------------------------ Alcatraz, ships, scattered shore lights
  function buildProps(scene, fx) {
    const A = ISLES[0], parts = [];
    const c = Math.cos(A.rot), s = Math.sin(A.rot);
    const onA = (u, v) => [A.x + u * c - v * s, A.z + u * s + v * c];
    const C = [0.42, 0.40, 0.36];
    let p = onA(-10, 0); parts.push(tint(box(150, 17, 44, p[0], 41 + 8, p[1], -A.rot), C[0], C[1], C[2], 0.07));           // cellhouse
    p = onA(-10, 0); parts.push(tint(box(120, 4, 30, p[0], 41 + 18, p[1], -A.rot), C[0] * 0.8, C[1] * 0.8, C[2] * 0.8, 0.03));
    p = onA(105, -8); parts.push(tint(place(new T.CylinderGeometry(2.4, 3.4, 27, 10), p[0], 41 + 13, p[1]), 0.6, 0.6, 0.58, 0.25)); // lighthouse
    W.lighthouse = new T.Vector3(p[0], 41 + 28, p[1]);
    lamp(p[0], 41 + 28, p[1], 1, 0.95, 0.8, 7, 0, 0);
    p = onA(-120, 20); parts.push(tint(place(new T.CylinderGeometry(7, 7, 9, 12), p[0], 41 + 26, p[1]), 0.3, 0.28, 0.26, 0.04));      // water tower
    for (const k of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) { const q = onA(-120 + k[0], 20 + k[1]); parts.push(tint(box(0.9, 24, 0.9, q[0], 41 + 11, q[1]), 0.25, 0.24, 0.22, 0.03)); }
    p = onA(70, 30); parts.push(tint(box(50, 12, 18, p[0], 41 + 5, p[1], -A.rot), C[0], C[1], C[2], 0.05));
    p = onA(-70, -32); parts.push(tint(box(60, 9, 14, p[0], 30, p[1], -A.rot + 0.1), C[0] * 0.9, C[1] * 0.9, C[2] * 0.9, 0.05));
    p = onA(150, 25); parts.push(tint(box(46, 10, 20, p[0], 12, p[1], -A.rot), C[0], C[1], C[2], 0.06));                    // dock building
    const rnd = BW.rng(9);
    for (let i = 0; i < 26; i++) { const q = onA((rnd() - 0.5) * 380, (rnd() - 0.5) * 120); const h = W.terrainH(q[0], q[1]); if (h > 3) lamp(q[0], h + 6 + rnd() * 10, q[1], WARM[0], WARM[1], WARM[2], 2.6, 0, 0.2); }

    // ships at anchor
    for (const sh of SHIPS) {
      const hull = [0.08, 0.02, 0.02];
      const L = sh.len;
      const local = (u, y, v, g) => { g.rotateY(sh.yaw); g.translate(sh.x + Math.sin(sh.yaw) * u + Math.cos(sh.yaw) * v, y, sh.z + Math.cos(sh.yaw) * u - Math.sin(sh.yaw) * v); return g; };
      parts.push(tint(local(0, 4, 0, new T.BoxGeometry(40, 20, L)), hull[0], hull[1], hull[2], 0.02));
      parts.push(tint(local(-L * 0.38, 30, 0, new T.BoxGeometry(36, 34, 20)), 0.6, 0.6, 0.58, 0.18));
      const cols = [[0.25, 0.06, 0.04], [0.04, 0.1, 0.22], [0.2, 0.2, 0.2], [0.05, 0.18, 0.1], [0.3, 0.16, 0.03]];
      for (let k = 0; k < 9; k++) {
        const cc = cols[k % cols.length], hh = 10 + ((k * 7) % 3) * 5;
        parts.push(tint(local(-L * 0.28 + k * (L * 0.075), 14 + hh / 2, 0, new T.BoxGeometry(36, hh, L * 0.068)), cc[0], cc[1], cc[2], 0.03));
      }
      const lp = (u, y, v, col, size, blink) => lamp(sh.x + Math.sin(sh.yaw) * u + Math.cos(sh.yaw) * v, y, sh.z + Math.cos(sh.yaw) * u - Math.sin(sh.yaw) * v, col[0], col[1], col[2], size, blink || 0, 0);
      lp(-L * 0.38, 52, 0, [1, 1, 0.9], 5); lp(L * 0.46, 22, 0, [1, 1, 0.9], 4);
      lp(-L * 0.38, 40, -19, [1, 0.05, 0.03], 3.5); lp(-L * 0.38, 40, 19, [0.05, 1, 0.2], 3.5);
      for (let k = 0; k < 6; k++) lp(-L * 0.3 + k * L * 0.13, 30, 0, WARM, 3.5);
    }
    const mesh = new T.Mesh(merge(parts), floodMaterial(0xffffff, 0.85, 0.05));
    mesh.frustumCulled = false; scene.add(mesh);

    // shore towns and the far side of the bay
    function scatter(n, x0, x1, z0, z1, seed, cond, y0, tw) {
      const r = BW.rng(seed);
      for (let i = 0, tries = 0; i < n && tries < n * 12; tries++) {
        const x = lerp(x0, x1, r()), z = lerp(z0, z1, r()), h = W.terrainH(x, z);
        if (h < 2 || (cond && !cond(x, z, h))) continue;
        const cl = r() < 0.7 ? WARM : r() < 0.5 ? SODIUM : LED;
        lamp(x, h + (y0 || 6), z, cl[0], cl[1], cl[2], 2.6 + r() * 1.4, 0, tw === undefined ? 0.5 : tw); i++;
      }
    }
    scatter(520, -1500, -650, -2900, -1100, 11, (x, z, h) => h < 140);        // Sausalito
    scatter(380, 400, 2300, -4400, -2950, 12, (x, z, h) => h < 150);          // Tiburon / Belvedere
    scatter(14, 800, 1900, -2400, -1500, 13, (x, z, h) => h < 40);            // Angel Island coves
    scatter(160, 2900, 3800, -1400, 200, 14, null);                           // Treasure Island / Yerba Buena
    scatter(90, -2450, -900, 1050, 2050, 15, null);                           // Presidio roads
    scatter(700, -2500, 2150, 4700, 7000, 16, null, 8, 0.6);                  // city beyond the building grid
    const r = BW.rng(17);
    for (let i = 0; i < 2600; i++) {                                          // East Bay shore and hills
      const z = -9000 + r() * 18000, t = Math.pow(r(), 1.7), x = 5700 + t * 3400;
      const cl = r() < 0.75 ? SODIUM : LED;
      lamp(x, 6 + t * t * 320 * r(), z, cl[0], cl[1], cl[2], 3.2 + r() * 2, 0, 0.8);
    }
  }

  // ------------------------------------------------------------------ helicopters with searchlights
  function buildHelos(scene, fx) {
    W.helos = [];
    const coneGeo = new T.CylinderGeometry(0.03, 1, 1, 20, 1, true); coneGeo.translate(0, -0.5, 0); coneGeo.rotateX(-Math.PI / 2);   // apex at origin, opens toward +Z
    const n = BW.Q.mobile ? 1 : 2;
    for (let i = 0; i < 2; i++) {
      const g = new T.Group();
      const body = new T.Mesh(merge([
        tint(place(new T.SphereGeometry(1, 12, 8).scale(1.5, 1.6, 3.0), 0, 0, 1), 0.5, 0.5, 0.5),
        tint(box(0.8, 0.9, 8, 0, 0.6, -7), 0.5, 0.5, 0.5), tint(box(0.3, 3, 1.6, 0, 1.8, -10.6), 0.6, 0.1, 0.08),
        tint(box(0.3, 0.3, 3.6, 1.6, -2.2, 0), 0.1, 0.1, 0.1), tint(box(0.3, 0.3, 3.6, -1.6, -2.2, 0), 0.1, 0.1, 0.1),
      ]), new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }));
      const rotor = new T.Mesh(new T.CircleGeometry(7.5, 20), new T.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.35, side: T.DoubleSide, depthWrite: false }));
      rotor.rotation.x = -Math.PI / 2; rotor.position.y = 2.4;
      g.add(body, rotor);
      scene.add(g);
      const spot = i < n ? new T.SpotLight(0xdfeaff, 0, 1400, 0.10, 0.6, 2.0) : null;
      if (spot) { scene.add(spot, spot.target); }
      const cone = new T.Mesh(coneGeo, new T.ShaderMaterial({
        uniforms: { uLen: { value: 300 }, uPower: { value: 1 }, uDepthTex: BW.U.uDepthTex, uResolution: BW.U.uResolution, uNearFar: BW.U.uNearFar },
        vertexShader: `varying float vT; varying vec3 vN; varying vec3 vV; varying float vZ;
          void main(){ vT = position.z; vN = normalMatrix * normal; vec4 mv = modelViewMatrix * vec4(position,1.0); vV = -mv.xyz; vZ = -mv.z; gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `precision highp float; uniform float uPower; varying float vT; varying vec3 vN; varying vec3 vV; varying float vZ; ${BW.GLSL.fxDepth}
          void main(){ float rim = abs(dot(normalize(vN), normalize(vV))); float a = pow(rim, 1.6) * (1.0 - vT * 0.85) * 0.10 * uPower;
            a *= fxDepthFade(vZ, 25.0); gl_FragColor = vec4(vec3(0.75, 0.86, 1.0) * a, 1.0); }`,
        blending: T.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, side: T.DoubleSide,
      }));
      cone.frustumCulled = false;
      fx.add(cone);
      W.helos.push({ g, rotor, spot, cone, phase: i * 3.1, r: 420 + i * 160, alt: 170 + i * 55, aim: new T.Vector3(), pos: new T.Vector3(), strobe: 0 });
    }
    // lighthouse beam
    const beam = new T.Mesh(coneGeo, W.helos[0].cone.material.clone());
    beam.material.uniforms.uDepthTex = BW.U.uDepthTex; beam.material.uniforms.uResolution = BW.U.uResolution; beam.material.uniforms.uNearFar = BW.U.uNearFar;
    beam.material.uniforms.uPower = { value: 0.8 };
    beam.frustumCulled = false; fx.add(beam);
    W.lhBeam = beam;
  }
  const _a = new T.Vector3(), _b = new T.Vector3();
  function updateHelos(dt, t, focus, targets) {
    for (let i = 0; i < W.helos.length; i++) {
      const h = W.helos[i];
      const a = t * (0.11 + i * 0.03) * (i ? -1 : 1) + h.phase;
      _a.set(focus.x + Math.cos(a) * h.r, h.alt + Math.sin(t * 0.4 + i) * 14, focus.z + Math.sin(a) * h.r);
      h.pos.lerp(_a, 1 - Math.exp(-dt * 0.9));
      if (h.pos.lengthSq() < 1) h.pos.copy(_a);
      h.g.position.copy(h.pos);
      h.g.rotation.y = -a + (i ? Math.PI : 0);
      h.g.rotation.z = (i ? -1 : 1) * 0.18;
      h.rotor.rotation.z = t * 40;
      const tgt = targets[i] || targets[0] || focus;
      h.aim.lerp(tgt, 1 - Math.exp(-dt * 1.6));
      const len = h.pos.distanceTo(h.aim);
      h.cone.position.copy(h.pos);
      h.cone.lookAt(h.aim);
      h.cone.scale.set(len * 0.11, len * 0.11, len);
      if (h.spot) { h.spot.position.copy(h.pos); h.spot.target.position.copy(h.aim); h.spot.intensity = 260000; h.spot.distance = len * 1.6; }
    }
    if (W.lhBeam && W.lighthouse) {
      const a = t * 0.9;
      W.lhBeam.position.copy(W.lighthouse);
      _b.set(W.lighthouse.x + Math.cos(a) * 100, W.lighthouse.y - 4, W.lighthouse.z + Math.sin(a) * 100);
      W.lhBeam.lookAt(_b);
      W.lhBeam.scale.set(70, 26, 1500);
    }
  }
  W.spotPools = function (out) {            // where the searchlights land on the water: [x, z, radius, power] * 2
    for (let i = 0; i < 2; i++) {
      const h = W.helos[i];
      out[i].set(h.aim.x, h.aim.z, h.pos.distanceTo(h.aim) * 0.11, 1);
    }
  };

  // ------------------------------------------------------------------ assembly
  W.create = function (scene, fx) {
    bake();
    buildTerrain(scene);
    buildCity(scene);
    buildGoldenGate(scene, fx);
    buildBayBridge(scene);
    buildProps(scene, fx);
    buildLamps(fx);
    buildHelos(scene, fx);
    // places on the waterfront a monster heads for when it goes for the city
    W.shoreTargets = [[-650, 880], [150, 800], [820, 760], [1300, 800], [1830, 1120]];
    W.update = function (dt, t, camera, focus, targets) {
      const px = (0.5 * BW.U.uResolution.value.y) / Math.tan((camera.fov * Math.PI) / 360) / 5.5;
      W.lampMat.uniforms.uPx.value = px;
      W.carMat.uniforms.uPx.value = px;
      updateHelos(dt, t, focus, targets || []);
    };
    return W;
  };
  W.deckY = deckY;
})();
