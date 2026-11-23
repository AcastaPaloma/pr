/* BREAKWATER — core: namespace, math, noise, shared GLSL (sky / fog), lights, environment.
 *
 * Conventions used by every module:
 *   - Units are metres. Y is up. Sea level is y = 0. The bay floor in the arena is y = BW.SEA_FLOOR.
 *   - Models face +Z. forward(yaw) = (sin yaw, 0, cos yaw), and Object3D.rotation.y = yaw.
 *   - West (the Golden Gate, the dusk glow) is -X. South (the city) is +Z.
 */
(function () {
  'use strict';
  const BW = (window.BW = window.BW || {});
  const T = THREE;

  // ---------------------------------------------------------------- math
  BW.clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  BW.lerp = (a, b, t) => a + (b - a) * t;
  BW.sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  BW.smooth = (a, b, x) => {
    const t = BW.sat((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  BW.damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
  BW.angDiff = (a, b) => {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  BW.dampAng = (a, b, lambda, dt) => a + BW.angDiff(a, b) * (1 - Math.exp(-lambda * dt));
  BW.fwdX = (yaw) => Math.sin(yaw);
  BW.fwdZ = (yaw) => Math.cos(yaw);
  BW.yawTo = (x0, z0, x1, z1) => Math.atan2(x1 - x0, z1 - z0);

  BW.rng = function (seed) {
    let a = seed >>> 0 || 1;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  BW.hash2 = function (x, y) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  BW.vnoise2 = function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = BW.hash2(xi, yi), b = BW.hash2(xi + 1, yi);
    const c = BW.hash2(xi, yi + 1), d = BW.hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  BW.fbm2 = function (x, y, oct) {
    let s = 0, a = 0.5, f = 1;
    for (let i = 0; i < (oct || 4); i++) {
      s += a * BW.vnoise2(x * f + i * 17.3, y * f - i * 9.1);
      a *= 0.5; f *= 2.03;
    }
    return s;
  };

  // ---------------------------------------------------------------- constants
  BW.SEA_FLOOR = -22;
  // Direction TOWARD the dusk glow (sun just under the western horizon).
  BW.SUN_DIR = new T.Vector3(-1, 0.02, 0.1).normalize();
  // International Orange, the bridge paint. Also the HUD accent.
  BW.ORANGE = new T.Color(0xc0362c);

  // ---------------------------------------------------------------- quality
  const ua = navigator.userAgent || '';
  const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Mac/i.test(ua));
  BW.isMobile = mobile;
  BW.Q = {
    mobile,
    maxPixelRatio: mobile ? 1.6 : 1.5,
    msaa: mobile ? 0 : 4,
    rain: mobile ? 1800 : 4200,
    oceanRings: mobile ? 70 : 110,
    bloomLevels: mobile ? 4 : 5,
  };

  // ---------------------------------------------------------------- noise texture
  // Tileable RGBA8: R = fbm A, G = fbm B, BA = normal.xy of A (0.5-centred). Used by sky, water, sprites.
  BW.makeNoiseTex = function (size) {
    size = size || 256;
    const rnd = BW.rng(1337);
    function layer(period) {
      const lat = new Float32Array(period * period);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      return (x, y) => {
        const fx = (x / size) * period, fy = (y / size) * period;
        const xi = Math.floor(fx), yi = Math.floor(fy);
        let u = fx - xi, v = fy - yi;
        u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
        const x0 = xi % period, x1 = (xi + 1) % period, y0 = yi % period, y1 = (yi + 1) % period;
        const a = lat[y0 * period + x0], b = lat[y0 * period + x1];
        const c = lat[y1 * period + x0], d = lat[y1 * period + x1];
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
      };
    }
    function field() {
      const periods = [4, 8, 16, 32, 64];
      const layers = periods.map(layer);
      const out = new Float32Array(size * size);
      let k = 0;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          let s = 0, a = 0.5;
          for (let i = 0; i < layers.length; i++) { s += a * layers[i](x, y); a *= 0.5; }
          out[k++] = s / 0.96875;
        }
      return out;
    }
    const A = field(), B = field();
    const data = new Uint8Array(size * size * 4);
    const at = (F, x, y) => F[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        const dx = (at(A, x + 1, y) - at(A, x - 1, y)) * 6.0;
        const dy = (at(A, x, y + 1) - at(A, x, y - 1)) * 6.0;
        data[i] = Math.round(BW.sat(A[y * size + x]) * 255);
        data[i + 1] = Math.round(BW.sat(B[y * size + x]) * 255);
        data[i + 2] = Math.round(BW.sat(0.5 + dx) * 255);
        data[i + 3] = Math.round(BW.sat(0.5 + dy) * 255);
      }
    const tex = new T.DataTexture(data, size, size, T.RGBAFormat, T.UnsignedByteType);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.minFilter = T.LinearMipmapLinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = T.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  };
  BW.noiseTex = BW.makeNoiseTex(256);

  // ---------------------------------------------------------------- shared uniforms
  // One object per uniform, shared by reference across every material that uses the chunk.
  BW.U = {
    uSkyTime: { value: 0 },
    uFlash: { value: 0 },                              // lightning brightness 0..1
    uFlashDir: { value: new T.Vector3(0, 0.3, -1).normalize() },
    uNoise: { value: BW.noiseTex },
    uFogDensity: { value: 0.00020 },
    uEye: { value: new T.Vector3() },                  // camera world position (set each frame)
    // FX scene depth test against the main scene:
    uDepthTex: { value: null },
    uResolution: { value: new T.Vector2(1, 1) },       // drawing buffer size of the scene target
    uNearFar: { value: new T.Vector2(0.5, 40000) },
  };

  // ---------------------------------------------------------------- GLSL chunks
  BW.GLSL = {};
  const s = BW.SUN_DIR;
  BW.GLSL.sky = /* glsl */ `
    uniform float uSkyTime;
    uniform float uFlash;
    uniform vec3 uFlashDir;
    uniform sampler2D uNoise;
    const vec3 SUN_DIR = vec3(${s.x.toFixed(5)}, ${s.y.toFixed(5)}, ${s.z.toFixed(5)});
    const vec2 CITY_DIR = vec2(0.33, 0.944);

    // Sky without cloud detail: used for fog colour and water reflection.
    vec3 skyBase(vec3 d) {
      float y = d.y;
      float h = clamp(y, 0.0, 1.0);
      vec3 zen = vec3(0.010, 0.019, 0.040);
      vec3 hor = vec3(0.042, 0.062, 0.098);
      vec3 c = mix(hor, zen, pow(h, 0.42));
      vec2 dh = normalize(d.xz + vec2(1e-5));
      float w = max(dot(dh, normalize(SUN_DIR.xz)), 0.0);
      float band = exp(-abs(y - 0.012) * 15.0);
      c += vec3(1.35, 0.40, 0.10) * pow(w, 6.0) * band * 0.95;          // ember strip under the cloud deck
      c += vec3(0.50, 0.19, 0.20) * pow(w, 2.6) * exp(-max(y, 0.0) * 4.5) * 0.13; // wide rose wash
      float cg = max(dot(dh, CITY_DIR), 0.0);
      c += vec3(0.60, 0.34, 0.15) * pow(cg, 2.0) * exp(-max(y, 0.0) * 6.0) * 0.20; // sodium glow over the city
      c = mix(c, vec3(0.008, 0.012, 0.018), clamp(-y * 5.0, 0.0, 1.0));
      return c;
    }

    // Full sky with a marine cloud deck lit from below.
    vec3 skyFull(vec3 d) {
      vec3 base = skyBase(d);
      if (d.y < 0.0) return base;
      vec2 uv = d.xz / (d.y + 0.11);
      vec2 wind = vec2(uSkyTime * 0.0035, uSkyTime * 0.0011);
      float n  = texture2D(uNoise, uv * 0.050 + wind).r * 0.55;
      n += texture2D(uNoise, uv * 0.130 - wind * 1.7).g * 0.30;
      n += texture2D(uNoise, uv * 0.410 + wind * 3.1).r * 0.15;
      float cov = smoothstep(0.34, 0.58, n);
      float thick = smoothstep(0.45, 0.80, n);
      vec2 dh = normalize(d.xz + vec2(1e-5));
      float w = max(dot(dh, normalize(SUN_DIR.xz)), 0.0);
      float cg = max(dot(dh, CITY_DIR), 0.0);
      vec3 cl = vec3(0.020, 0.027, 0.040);                               // cloud body, blue hour
      cl += vec3(0.95, 0.30, 0.12) * pow(w, 4.0) * exp(-d.y * 6.0) * (1.0 - thick * 0.75) * 0.7; // under-lit by dusk
      cl += vec3(0.42, 0.25, 0.12) * pow(cg, 1.5) * exp(-d.y * 3.0) * 0.30;               // under-lit by the city
      cl += vec3(0.75, 0.85, 1.0) * uFlash * pow(max(dot(d, uFlashDir), 0.0), 6.0) * 3.0 * (0.3 + n);
      vec3 gap = base * 1.6 + vec3(0.006, 0.010, 0.020);
      vec3 c = mix(gap, cl, cov);
      float haze = exp(-d.y * 9.0);
      return mix(c, base, haze * 0.8);
    }
  `;

  BW.GLSL.fog = /* glsl */ `
    uniform float uFogDensity;
    uniform vec3 uEye;
    float fogAmount(vec3 p) {
      vec3 v = p - uEye;
      float dist = length(v);
      const float H = 230.0;
      float a = uFogDensity * exp(-max(uEye.y, 0.0) / H);
      float k = v.y / H;
      float integ = abs(k) > 1e-3 ? (1.0 - exp(-k)) / k : 1.0;
      return 1.0 - exp(-dist * a * min(integ, 3.0));
    }
    vec3 fogColor(vec3 dir) {
      vec3 d = normalize(vec3(dir.x, max(dir.y, 0.0) * 0.5 + 0.11, dir.z));
      return skyBase(d) * 1.0 + vec3(0.003, 0.005, 0.008) + vec3(0.6, 0.7, 1.0) * uFlash * 0.05;
    }
  `;

  // For FX-scene materials (drawn after the fog pass, without a depth buffer):
  // call fxDepthFade(viewZ) in the fragment shader; returns 0 when hidden behind scene geometry,
  // ramps to 1 over softness metres (soft particles).
  BW.GLSL.fxDepth = /* glsl */ `
    uniform sampler2D uDepthTex;
    uniform vec2 uResolution;
    uniform vec2 uNearFar;
    float sceneViewZ() {
      float dz = texture2D(uDepthTex, gl_FragCoord.xy / uResolution).x;
      float n = uNearFar.x, f = uNearFar.y;
      float ndc = dz * 2.0 - 1.0;
      return (2.0 * n * f) / (f + n - ndc * (f - n));       // positive distance along view axis
    }
    float fxDepthFade(float fragViewZ, float softness) {
      float sz = sceneViewZ();
      return clamp((sz - fragViewZ) / max(softness, 0.001) + (0.012 * fragViewZ) / max(softness, 0.001), 0.0, 1.0);
    }
  `;

  // ---------------------------------------------------------------- sky dome
  BW.makeSkyDome = function (radius) {
    const mat = new T.ShaderMaterial({
      uniforms: { uSkyTime: BW.U.uSkyTime, uFlash: BW.U.uFlash, uFlashDir: BW.U.uFlashDir, uNoise: BW.U.uNoise },
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = modelViewMatrix * vec4(position, 0.0); p.w = 1.0;
        gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
      fragmentShader: `precision highp float; varying vec3 vDir; ${BW.GLSL.sky}
        void main(){ gl_FragColor = vec4(skyFull(normalize(vDir)), 1.0); }`,
      side: T.BackSide, depthWrite: false, depthTest: true,
    });
    const m = new T.Mesh(new T.SphereGeometry(radius || 1000, 48, 24), mat);
    m.frustumCulled = false;
    m.renderOrder = -1000;
    return m;
  };

  // PMREM environment from the sky so PBR surfaces (wet hide, steel) reflect the dusk.
  BW.buildEnvironment = function (renderer, scene) {
    const tmp = new T.Scene();
    const dome = BW.makeSkyDome(500);
    // In the env pass the dome is an ordinary far sphere.
    dome.material = new T.ShaderMaterial({
      uniforms: dome.material.uniforms,
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `precision highp float; varying vec3 vDir; ${BW.GLSL.sky}
        void main(){ vec3 d = normalize(vDir); vec3 c = skyFull(d);
          // sea below the horizon: dark teal with a hint of the glow so undersides are not pure black
          if (d.y < 0.0) c = mix(skyBase(vec3(d.x, 0.02, d.z)) * 0.35, vec3(0.006, 0.014, 0.018), clamp(-d.y * 3.0, 0.0, 1.0));
          gl_FragColor = vec4(c, 1.0); }`,
      side: T.BackSide,
    });
    tmp.add(dome);
    const pm = new T.PMREMGenerator(renderer);
    const rt = pm.fromScene(tmp, 0.0, 1, 2000);
    pm.dispose();
    dome.geometry.dispose();
    if (scene) scene.environment = rt.texture;
    BW.envMap = rt.texture;
    return rt.texture;
  };

  // The lighting rig every scene uses (game and dev harnesses), so models are tuned once.
  BW.addLights = function (scene) {
    const hemi = new T.HemisphereLight(0x5b7396, 0x0b0d10, 0.55);
    const dusk = new T.DirectionalLight(0xff8a4a, 1.5);          // low, from the west
    dusk.position.copy(BW.SUN_DIR).multiplyScalar(1000).add(new T.Vector3(0, 120, 0));
    const fill = new T.DirectionalLight(0x7f9bd0, 0.38);         // cool sky fill from above/east
    fill.position.set(500, 900, -300);
    scene.add(hemi, dusk, fill, dusk.target, fill.target);
    return { hemi, dusk, fill };
  };

  // ---------------------------------------------------------------- procedural texture helper
  // Paint into a canvas with a callback and get a repeat-wrapped texture back.
  BW.canvasTex = function (size, paint, opts) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    paint(ctx, size);
    const tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = 4;
    tex.colorSpace = opts && opts.srgb ? T.SRGBColorSpace : T.NoColorSpace;
    return tex;
  };

  // Height field (Float32Array size*size, tileable) -> tangent-space normal map texture.
  BW.normalMapFromHeight = function (H, size, strength) {
    const data = new Uint8Array(size * size * 4);
    const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
        const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
        const l = 1 / Math.hypot(dx, dy, 1);
        const i = (y * size + x) * 4;
        data[i] = Math.round((-dx * l * 0.5 + 0.5) * 255);
        data[i + 1] = Math.round((-dy * l * 0.5 + 0.5) * 255);
        data[i + 2] = Math.round((l * 0.5 + 0.5) * 255);
        data[i + 3] = 255;
      }
    const tex = new T.DataTexture(data, size, size, T.RGBAFormat, T.UnsignedByteType);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.minFilter = T.LinearMipmapLinearFilter;
    tex.magFilter = T.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };
})();
