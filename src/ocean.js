/* BREAKWATER — ocean: a camera-centred polar grid with Gerstner swell, sky reflection,
 * shore wash from the terrain height texture, and foam where giants disturb the water. */
(function () {
  'use strict';
  const T = THREE, BW = window.BW;
  const O = (BW.Ocean = {});
  const MAXD = 8;

  // dir.x, dir.z, wavelength, amplitude
  const WAVES = [[0.96, 0.28, 150, 0.60], [0.80, -0.60, 86, 0.38], [0.55, 0.83, 47, 0.25], [0.99, -0.10, 27, 0.14], [0.30, -0.95, 15, 0.08], [0.70, 0.70, 8.5, 0.045]];
  const waveGLSL = WAVES.map((w, i) => {
    const l = Math.hypot(w[0], w[1]), k = (2 * Math.PI) / w[2], c = Math.sqrt(9.81 / k);
    return `{ vec2 d = vec2(${(w[0] / l).toFixed(4)}, ${(w[1] / l).toFixed(4)}); float k = ${k.toFixed(5)}; float ph = k * (dot(d, p) - ${c.toFixed(3)} * t);
      float a = ${w[3].toFixed(3)} * amp${i < 2 ? '' : ' * hi'}; h += a * sin(ph); dh += a * k * cos(ph) * d; }`;
  }).join('\n');

  O.create = function (scene) {
    const rings = BW.Q.oceanRings, segs = 160;
    const pos = [], idx = [];
    pos.push(0, 0, 0);
    const g = Math.pow(26000 / 5, 1 / (rings - 1));
    for (let i = 0; i < rings; i++) {
      const r = 5 * Math.pow(g, i);
      for (let j = 0; j < segs; j++) { const a = (j / segs) * Math.PI * 2; pos.push(Math.cos(a) * r, 0, Math.sin(a) * r); }
    }
    for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
    for (let i = 0; i < rings - 1; i++)
      for (let j = 0; j < segs; j++) {
        const a = 1 + i * segs + j, b = 1 + i * segs + ((j + 1) % segs), c = a + segs, d = b + segs;
        idx.push(a, b, c, b, d, c);
      }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
    geo.setIndex(idx);
    const disturb = [];
    for (let i = 0; i < MAXD; i++) disturb.push(new T.Vector4(0, 0, 1, 0));
    const spots = [new T.Vector4(0, 0, 1, 0), new T.Vector4(0, 0, 1, 0)];
    const mat = new T.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 }, uSkyTime: BW.U.uSkyTime, uFlash: BW.U.uFlash, uFlashDir: BW.U.uFlashDir, uNoise: BW.U.uNoise, uEye: BW.U.uEye,
        uHeight: { value: BW.World.heightTex }, uRect: { value: BW.World.heightRect },
        uDisturb: { value: disturb }, uSpots: { value: spots }, uGlow: { value: new T.Vector4(0, 0, 0, 0) }, uGlowCol: { value: new T.Color(0, 0, 0) },
      },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uEye;
        varying vec3 vWorld; varying float vH;
        void waves(vec2 p, float t, float amp, float hi, out float h, out vec2 dh) {
          h = 0.0; dh = vec2(0.0);
          ${waveGLSL}
        }
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          float dist = length(wp.xz - uEye.xz);
          float amp = 1.0 - smoothstep(900.0, 5000.0, dist);
          float hi = 1.0 - smoothstep(150.0, 900.0, dist);
          float h; vec2 dh;
          waves(wp.xz, uTime, amp, hi, h, dh);
          wp.y += h; vH = h;
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uTime; uniform vec3 uEye;
        uniform sampler2D uHeight; uniform vec4 uRect;
        uniform vec4 uDisturb[${MAXD}]; uniform vec4 uSpots[2]; uniform vec4 uGlow; uniform vec3 uGlowCol;
        varying vec3 vWorld; varying float vH;
        ${BW.GLSL.sky}
        ${BW.GLSL.light}
        void waves(vec2 p, float t, float amp, float hi, out float h, out vec2 dh) {
          h = 0.0; dh = vec2(0.0);
          ${waveGLSL}
        }
        void main() {
          vec2 p = vWorld.xz;
          vec3 toEye = uEye - vWorld;
          float dist = length(toEye);
          vec3 V = toEye / dist;
          float h; vec2 dh;
          waves(p, uTime, 1.0, 1.0 - smoothstep(300.0, 1500.0, dist), h, dh);
          // fine chop from the noise texture, three scales drifting against each other
          float nf = 1.0 / (1.0 + dist / 500.0);
          vec2 n1 = texture2D(uNoise, p / 41.0 + vec2(uTime * 0.021, uTime * 0.013)).ba - 0.5;
          vec2 n2 = texture2D(uNoise, p / 13.0 - vec2(uTime * 0.034, -uTime * 0.027)).ba - 0.5;
          vec2 n3 = texture2D(uNoise, p / 190.0 + vec2(-uTime * 0.006, uTime * 0.004)).ba - 0.5;
          dh += n1 * 0.55 * nf + n2 * 0.40 * nf * nf + n3 * 0.5;
          vec3 N = normalize(vec3(-dh.x, 1.0, -dh.y));
          N = normalize(mix(N, vec3(0.0, 1.0, 0.0), smoothstep(400.0, 9000.0, dist) * 0.7));
          float ndv = max(dot(N, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.015; R = normalize(R);
          vec3 refl = skyFull(R);

          // water depth from the terrain
          vec2 huv = (p - uRect.xy) / uRect.zw;
          float inside = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
          float th = mix(${BW.SEA_FLOOR.toFixed(1)}, 10.0, texture2D(uHeight, huv).r);
          float depth = mix(22.0, -th, inside);
          vec3 deep = vec3(0.0030, 0.0105, 0.0150), shallow = vec3(0.016, 0.042, 0.038);
          vec3 body = mix(shallow, deep, smoothstep(0.0, 14.0, depth));
          body += vec3(0.006, 0.022, 0.020) * max(vH, 0.0) * max(dot(V.xz, -normalize(SUN_DIR.xz)), 0.0);   // light through the crests

          vec3 col = mix(body, refl, fres);

          // foam
          float nz = texture2D(uNoise, p / 23.0 + vec2(uTime * 0.012, 0.0)).r;
          float nz2 = texture2D(uNoise, p / 7.0 - vec2(0.0, uTime * 0.02)).g;
          float foam = 0.0;
          float wash = sin(depth * 1.3 - uTime * 1.1 + nz * 6.0) * 0.5 + 0.5;
          foam += inside * smoothstep(2.6, 0.2, depth - nz * 1.4) * (0.45 + 0.55 * wash);
                // whitecaps
          float lightPool = 0.0;
          for (int i = 0; i < ${MAXD}; i++) {
            vec4 D = uDisturb[i];
            float d = length(p - D.xy);
            float ring = smoothstep(D.z * 1.5, D.z * 0.55, d) * D.w;
            foam += ring * smoothstep(0.30, 0.62, nz * 0.6 + nz2 * 0.4 + ring * 0.35);
          }
          for (int i = 0; i < 2; i++) {
            float d = length(p - uSpots[i].xy);
            lightPool += smoothstep(uSpots[i].z, uSpots[i].z * 0.55, d) * uSpots[i].w;
          }
          foam = clamp(foam, 0.0, 1.0) * (0.55 + 0.45 * nz2);
          vec3 foamCol = vec3(0.74, 0.78, 0.80) * (litDiffuse(N) * 1.5 + vec3(0.75, 0.86, 1.0) * lightPool * 0.22);
          col = mix(col, foamCol, foam);
          col += vec3(0.75, 0.86, 1.0) * lightPool * (0.006 + 0.014 * nz2);                           // searchlight on the surface
          // coloured glow on the water (plasma, bioluminescence)
          float gd = length(p - uGlow.xy);
          col += uGlowCol * uGlow.w * exp(-gd * gd / (uGlow.z * uGlow.z)) * (0.25 + 0.75 * fres + foam);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    O.mesh = mesh; O.mat = mat; O.disturb = disturb; O.spots = spots;
    O.update = function (t, camera) {
      mat.uniforms.uTime.value = t;
      mesh.position.set(camera.position.x, 0, camera.position.z);
      mesh.updateMatrixWorld();
    };
    // slot i: foam of radius r (m) and strength s (0..1.5) at (x, z)
    O.setDisturb = function (i, x, z, r, s) { if (i < MAXD) disturb[i].set(x, z, Math.max(r, 1), s); };
    O.clearDisturb = function (from) { for (let i = from || 0; i < MAXD; i++) disturb[i].w = 0; };
    O.setGlow = function (x, z, r, power, color) { mat.uniforms.uGlow.value.set(x, z, r, power); if (color) mat.uniforms.uGlowCol.value.copy(color); };
    return O;
  };
  O.MAXD = MAXD;
})();
