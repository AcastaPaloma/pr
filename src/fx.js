/* BREAKWATER — fx: HDR post pipeline (depth fog, bloom, visor rain, grade), sprite particles, rain, fog banks.
 *
 * Frame: main scene -> rtScene (HDR + depth)  ->  fog pass -> rtA  ->  FX scene drawn onto rtA
 * (FX materials test against the scene depth texture themselves)  ->  bloom chain  ->  final grade to screen.
 */
(function () {
  'use strict';
  const T = THREE, BW = window.BW;
  const { clamp, lerp } = BW;

  // ================================================================== POST
  const P = (BW.Post = {});
  const FS_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
  P.create = function (renderer) {
    const tri = new T.BufferGeometry();
    tri.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    tri.setAttribute('uv', new T.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    const quad = new T.Mesh(tri, null);
    quad.frustumCulled = false;
    const qScene = new T.Scene(); qScene.add(quad);
    const qCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mk = (frag, uniforms, extra) => new T.ShaderMaterial(Object.assign({ vertexShader: FS_VERT, fragmentShader: 'precision highp float; varying vec2 vUv;\n' + frag, uniforms, depthTest: false, depthWrite: false }, extra || {}));

    const fogMat = mk(/* glsl */ `
      uniform sampler2D tColor, tDepth; uniform mat4 uInvViewProj;
      ${BW.GLSL.sky} ${BW.GLSL.fog}
      void main() {
        vec4 c = texture2D(tColor, vUv);
        float d = texture2D(tDepth, vUv).x;
        if (d >= 0.999999) { gl_FragColor = vec4(c.rgb, 1.0); return; }
        vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        wp /= wp.w;
        float f = fogAmount(wp.xyz);
        gl_FragColor = vec4(mix(c.rgb, fogColor(normalize(wp.xyz - uEye)), f), 1.0);
      }`, {
      tColor: { value: null }, tDepth: { value: null }, uInvViewProj: { value: new T.Matrix4() },
      uSkyTime: BW.U.uSkyTime, uFlash: BW.U.uFlash, uFlashDir: BW.U.uFlashDir, uNoise: BW.U.uNoise, uFogDensity: BW.U.uFogDensity, uEye: BW.U.uEye,
    });
    const brightMat = mk(/* glsl */ `
      uniform sampler2D tColor; uniform vec2 uTexel; uniform float uThreshold;
      void main() {
        vec3 c = texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb
               + texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        c *= 0.25;
        c = min(c, vec3(60.0));
        float l = max(c.r, max(c.g, c.b));
        gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold * 2.2, l), 1.0);
      }`, { tColor: { value: null }, uTexel: { value: new T.Vector2() }, uThreshold: { value: 0.9 } });
    const downMat = mk(/* glsl */ `
      uniform sampler2D tColor; uniform vec2 uTexel;
      void main() {
        vec3 c = texture2D(tColor, vUv).rgb * 4.0;
        c += texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb
           + texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c / 8.0, 1.0);
      }`, { tColor: { value: null }, uTexel: { value: new T.Vector2() } });
    const upMat = mk(/* glsl */ `
      uniform sampler2D tColor; uniform vec2 uTexel; uniform float uGain;
      void main() {
        vec3 c = texture2D(tColor, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, 0.0)).rgb
               + texture2D(tColor, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(0.0, 1.0)).rgb;
        c += (texture2D(tColor, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, -1.0)).rgb
            + texture2D(tColor, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tColor, vUv + uTexel * vec2(1.0, 1.0)).rgb) * 0.5;
        gl_FragColor = vec4(c / 6.0 * uGain, 1.0);
      }`, { tColor: { value: null }, uTexel: { value: new T.Vector2() }, uGain: { value: 1 } }, { blending: T.AdditiveBlending, transparent: true });
    const finalMat = mk(/* glsl */ `
      uniform sampler2D tColor, tBloom;
      uniform vec2 uRes; uniform float uTime, uExposure, uBloom, uVisor, uHit, uAberr, uFade, uDesat, uGlitch;
      float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      // rain beading on the canopy: each cell may hold a drop that lives, slides and dies
      vec2 drops(vec2 uv, float scale, float t) {
        vec2 g = uv * vec2(uRes.x / uRes.y, 1.0) * scale;
        vec2 id = floor(g);
        float h = hash21(id), h2 = hash21(id + 17.3);
        if (h < 0.80) return vec2(0.0);
        float life = fract(t * 0.06 * (0.5 + h2) + h * 9.0);
        vec2 c = (vec2(h2, fract(h * 13.7)) - 0.5) * 0.5;
        c.y -= life * life * 0.35 * step(0.8, h);                 // the heavy ones run
        float r = 0.05 + 0.11 * fract(h * 7.1);
        vec2 d = fract(g) - 0.5 - c;
        float m = smoothstep(r, r * 0.25, length(d)) * smoothstep(0.0, 0.08, life) * smoothstep(1.0, 0.75, life);
        return -d * m / scale * 1.1;
      }
      vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      void main() {
        vec2 uv = vUv;
        if (uGlitch > 0.0) { float band = step(0.94, hash21(vec2(floor(uv.y * 40.0), floor(uTime * 30.0)))); uv.x += band * uGlitch * 0.05 * (hash21(vec2(uTime, uv.y)) - 0.5); }
        vec2 off = vec2(0.0);
        if (uVisor > 0.0) off = (drops(uv, 9.0, uTime) + drops(uv + 3.7, 21.0, uTime * 1.3) * 0.7) * uVisor;
        uv += off;
        vec2 d = uv - 0.5;
        float ca = (uAberr + uHit * 0.012) * dot(d, d);
        vec3 col;
        col.r = texture2D(tColor, uv + d * ca).r;
        col.g = texture2D(tColor, uv).g;
        col.b = texture2D(tColor, uv - d * ca).b;
        vec3 bloom = texture2D(tBloom, uv).rgb;
        col += bloom * uBloom;
        col += length(off) * 14.0 * bloom;                                  // drops catch the light
        col *= uExposure;
        float vig = smoothstep(1.15, 0.30, length(d * vec2(1.0, 0.92)) * 1.35);
        col *= mix(1.0, vig, 0.62);
        col = mix(col, col * vec3(1.7, 0.45, 0.35), clamp(uHit, 0.0, 1.0) * (0.35 + 0.65 * dot(d, d) * 3.0));
        col = aces(col);
        float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, vec3(l), uDesat);
        col = mix(col, col * col * (3.0 - 2.0 * col), 0.18);               // a touch of contrast
        col = pow(col, vec3(1.0 / 2.2));
        col += (hash21(vUv * uRes + fract(uTime) * 91.0) - 0.5) * 0.022;
        gl_FragColor = vec4(col * uFade, 1.0);
      }`, {
      tColor: { value: null }, tBloom: { value: null }, uRes: { value: new T.Vector2(1, 1) }, uTime: { value: 0 },
      uExposure: { value: 1.35 }, uBloom: { value: 0.8 }, uVisor: { value: 1 }, uHit: { value: 0 }, uAberr: { value: 0.006 }, uFade: { value: 1 }, uDesat: { value: 0 }, uGlitch: { value: 0 },
    });

    // HDR targets need a float colour-buffer extension; fall back to 8-bit where a device has neither
    const gl = renderer.getContext();
    const HDR = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float') ? T.HalfFloatType : T.UnsignedByteType;
    const levels = BW.Q.bloomLevels;
    let rtScene = null, rtA = null, mips = [];
    const post = { finalMat, fogMat, w: 1, h: 1 };
    function alloc(w, h) {
      if (rtScene) { rtScene.dispose(); rtA.dispose(); mips.forEach((m) => m.dispose()); }
      const depth = new T.DepthTexture(w, h, T.UnsignedIntType);
      rtScene = new T.WebGLRenderTarget(w, h, { type: HDR, samples: BW.Q.msaa, depthTexture: depth, minFilter: T.LinearFilter, magFilter: T.LinearFilter });
      rtA = new T.WebGLRenderTarget(w, h, { type: HDR, depthBuffer: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter });
      mips = [];
      let mw = w, mh = h;
      for (let i = 0; i < levels; i++) {
        mw = Math.max(2, mw >> 1); mh = Math.max(2, mh >> 1);
        mips.push(new T.WebGLRenderTarget(mw, mh, { type: HDR, depthBuffer: false, minFilter: T.LinearFilter, magFilter: T.LinearFilter }));
      }
      post.w = w; post.h = h;
      BW.U.uDepthTex.value = depth;
      BW.U.uResolution.value.set(w, h);
      finalMat.uniforms.uRes.value.set(w, h);
    }
    post.setSize = function (w, h) { w = Math.max(8, Math.floor(w)); h = Math.max(8, Math.floor(h)); if (w !== post.w || h !== post.h) alloc(w, h); };
    function pass(mat, target) {
      quad.material = mat;
      renderer.setRenderTarget(target);
      renderer.render(qScene, qCam);
    }
    const vp = new T.Matrix4();
    post.render = function (scene, fxScene, camera, time) {
      renderer.autoClear = true;
      camera.updateMatrixWorld();
      BW.U.uEye.value.setFromMatrixPosition(camera.matrixWorld);
      BW.U.uNearFar.value.set(camera.near, camera.far);
      // 1. main scene
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);
      // 2. atmosphere
      vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      fogMat.uniforms.uInvViewProj.value.copy(vp).invert();
      fogMat.uniforms.tColor.value = rtScene.texture;
      fogMat.uniforms.tDepth.value = rtScene.depthTexture;
      pass(fogMat, rtA);
      // 3. lights, particles, beams
      renderer.autoClear = false;
      renderer.setRenderTarget(rtA);
      renderer.render(fxScene, camera);
      // 4. bloom
      brightMat.uniforms.tColor.value = rtA.texture;
      brightMat.uniforms.uTexel.value.set(0.5 / post.w, 0.5 / post.h);
      renderer.autoClear = true;
      pass(brightMat, mips[0]);
      for (let i = 1; i < levels; i++) {
        downMat.uniforms.tColor.value = mips[i - 1].texture;
        downMat.uniforms.uTexel.value.set(1 / mips[i - 1].width, 1 / mips[i - 1].height);
        pass(downMat, mips[i]);
      }
      renderer.autoClear = false;
      for (let i = levels - 1; i > 0; i--) {
        upMat.uniforms.tColor.value = mips[i].texture;
        upMat.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
        upMat.uniforms.uGain.value = 1.0;
        pass(upMat, mips[i - 1]);
      }
      // 5. grade
      renderer.autoClear = true;
      finalMat.uniforms.tColor.value = rtA.texture;
      finalMat.uniforms.tBloom.value = mips[0].texture;
      finalMat.uniforms.uTime.value = time;
      pass(finalMat, null);
    };
    alloc(8, 8);
    return post;
  };

  // ================================================================== SPRITES
  const FXU = () => ({
    uSkyTime: BW.U.uSkyTime, uFlash: BW.U.uFlash, uFlashDir: BW.U.uFlashDir, uNoise: BW.U.uNoise, uFogDensity: BW.U.uFogDensity, uEye: BW.U.uEye,
    uDepthTex: BW.U.uDepthTex, uResolution: BW.U.uResolution, uNearFar: BW.U.uNearFar,
  });
  function Batch(max, additive, fx) {
    this.max = max; this.n = 0; this.additive = additive;
    const f = (k) => new Float32Array(max * k);
    this.p = f(3); this.v = f(3); this.age = f(1); this.life = f(1); this.s0 = f(1); this.s1 = f(1);
    this.rot = f(1); this.vrot = f(1); this.col = f(4); this.grav = f(1); this.drag = f(1); this.soft = f(1); this.seed = f(1); this.floor = f(1);
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iPos = new T.InstancedBufferAttribute(f(3), 3); this.iSR = new T.InstancedBufferAttribute(f(4), 4); this.iCol = new T.InstancedBufferAttribute(f(4), 4);
    [this.iPos, this.iSR, this.iCol].forEach((a) => a.setUsage(T.DynamicDrawUsage));
    g.setAttribute('iPos', this.iPos); g.setAttribute('iSR', this.iSR); g.setAttribute('iCol', this.iCol);
    g.instanceCount = 0;
    const mat = new T.ShaderMaterial({
      uniforms: FXU(),
      vertexShader: /* glsl */ `
        attribute vec3 iPos; attribute vec4 iSR; attribute vec4 iCol;
        varying vec2 vUv; varying vec4 vCol; varying float vZ; varying vec2 vMisc;
        ${BW.GLSL.sky} ${BW.GLSL.fog}
        void main() {
          vec4 mv = viewMatrix * vec4(iPos, 1.0);
          float c = cos(iSR.y), s = sin(iSR.y);
          vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSR.x;
          mv.xy += q;
          vZ = -mv.z;
          gl_Position = projectionMatrix * mv;
          vUv = position.xy * 2.0;
          vMisc = vec2(iSR.z, iSR.w);
          float f = fogAmount(iPos);
          ${additive ? 'vCol = vec4(iCol.rgb * (1.0 - f), iCol.a);' : 'vCol = vec4(mix(iCol.rgb * (1.0 + uFlash * 4.0), fogColor(normalize(iPos - uEye)), f), iCol.a);'}
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uNoise;
        varying vec2 vUv; varying vec4 vCol; varying float vZ; varying vec2 vMisc;
        ${BW.GLSL.fxDepth}
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float n = texture2D(uNoise, vUv * 0.21 + vMisc.x).r;
          float a = 1.0 - r2;
          ${additive ? 'a = a * a * (0.55 + 0.9 * n);' : 'a = a * smoothstep(0.18, 0.72, n * 0.9 + a * 0.55);'}
          a *= vCol.a * fxDepthFade(vZ, vMisc.y);
          if (vZ < 5.0) a *= clamp((vZ - 2.5) / 2.5, 0.0, 1.0);
          gl_FragColor = vec4(vCol.rgb${additive ? ' * a, 1.0' : ', a'});
        }`,
      blending: additive ? T.AdditiveBlending : T.NormalBlending, transparent: true, depthTest: false, depthWrite: false,
    });
    this.mesh = new T.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 10;
    fx.add(this.mesh);
  }
  // o: {x,y,z, vx,vy,vz, life, s0, s1, r,g,b, a, grav, drag, soft, rot, vrot, floor}
  Batch.prototype.add = function (o) {
    let i = this.n;
    if (i >= this.max) { i = (Math.random() * this.max) | 0; } else this.n++;
    this.p[i * 3] = o.x; this.p[i * 3 + 1] = o.y; this.p[i * 3 + 2] = o.z;
    this.v[i * 3] = o.vx || 0; this.v[i * 3 + 1] = o.vy || 0; this.v[i * 3 + 2] = o.vz || 0;
    this.age[i] = 0; this.life[i] = o.life || 1; this.s0[i] = o.s0 || 1; this.s1[i] = o.s1 === undefined ? this.s0[i] : o.s1;
    this.rot[i] = o.rot === undefined ? Math.random() * 6.28 : o.rot; this.vrot[i] = o.vrot || 0;
    this.col[i * 4] = o.r; this.col[i * 4 + 1] = o.g; this.col[i * 4 + 2] = o.b; this.col[i * 4 + 3] = o.a === undefined ? 1 : o.a;
    this.grav[i] = o.grav || 0; this.drag[i] = o.drag || 0; this.soft[i] = o.soft || 6; this.seed[i] = Math.random(); this.floor[i] = o.floor === undefined ? -1e9 : o.floor;
  };
  Batch.prototype.update = function (dt) {
    let n = this.n;
    const { p, v, age, life, s0, s1, rot, vrot, col, grav, drag, soft, seed, floor } = this;
    const ip = this.iPos.array, isr = this.iSR.array, ic = this.iCol.array;
    for (let i = 0; i < n; i++) {
      age[i] += dt;
      if (age[i] >= life[i] || p[i * 3 + 1] < floor[i]) {       // remove: swap with last
        n--;
        if (i !== n) {
          for (let k = 0; k < 3; k++) { p[i * 3 + k] = p[n * 3 + k]; v[i * 3 + k] = v[n * 3 + k]; }
          for (let k = 0; k < 4; k++) col[i * 4 + k] = col[n * 4 + k];
          age[i] = age[n]; life[i] = life[n]; s0[i] = s0[n]; s1[i] = s1[n]; rot[i] = rot[n]; vrot[i] = vrot[n];
          grav[i] = grav[n]; drag[i] = drag[n]; soft[i] = soft[n]; seed[i] = seed[n]; floor[i] = floor[n];
        }
        i--; continue;
      }
      const dk = Math.max(0, 1 - drag[i] * dt);
      v[i * 3] *= dk; v[i * 3 + 1] = v[i * 3 + 1] * dk - grav[i] * dt; v[i * 3 + 2] *= dk;
      p[i * 3] += v[i * 3] * dt; p[i * 3 + 1] += v[i * 3 + 1] * dt; p[i * 3 + 2] += v[i * 3 + 2] * dt;
      rot[i] += vrot[i] * dt;
      const t = age[i] / life[i];
      ip[i * 3] = p[i * 3]; ip[i * 3 + 1] = p[i * 3 + 1]; ip[i * 3 + 2] = p[i * 3 + 2];
      isr[i * 4] = s0[i] + (s1[i] - s0[i]) * t; isr[i * 4 + 1] = rot[i]; isr[i * 4 + 2] = seed[i]; isr[i * 4 + 3] = soft[i];
      const fade = Math.min(1, t * 12) * (1 - t) * (1 - t * t);
      ic[i * 4] = col[i * 4]; ic[i * 4 + 1] = col[i * 4 + 1]; ic[i * 4 + 2] = col[i * 4 + 2]; ic[i * 4 + 3] = col[i * 4 + 3] * fade * 1.6;
    }
    this.n = n;
    this.mesh.geometry.instanceCount = n;
    this.iPos.needsUpdate = this.iSR.needsUpdate = this.iCol.needsUpdate = true;
  };

  const F = (BW.FX = {});
  const R = Math.random;
  const rs = (a) => (R() - 0.5) * 2 * a;
  F.create = function (fxScene) {
    const add = new Batch(BW.Q.mobile ? 900 : 1800, true, fxScene);
    const alp = new Batch(BW.Q.mobile ? 900 : 1800, false, fxScene);
    const fx = { add, alp, banks: [], fires: [] };
    const SPRAY = [0.085, 0.10, 0.125];

    // -------- water
    fx.splash = function (x, z, scale, n) {
      n = n || 26; scale = scale || 1;
      for (let i = 0; i < n; i++) {
        const a = R() * 6.283, sp = (6 + R() * 16) * scale, up = (16 + R() * 26) * scale;
        alp.add({ x: x + Math.cos(a) * 5 * scale, y: 1 + R() * 3, z: z + Math.sin(a) * 5 * scale, vx: Math.cos(a) * sp, vy: up, vz: Math.sin(a) * sp,
          life: 1.6 + R() * 1.6, s0: (5 + R() * 6) * scale, s1: (14 + R() * 12) * scale, r: SPRAY[0] * 1.3, g: SPRAY[1] * 1.3, b: SPRAY[2] * 1.3, a: 0.55, grav: 22, drag: 0.5, soft: 8, vrot: rs(1.5), floor: -2 });
      }
      for (let i = 0; i < n / 3; i++) {
        const a = R() * 6.283, d = R() * 14 * scale;
        alp.add({ x: x + Math.cos(a) * d, y: 3 + R() * 5, z: z + Math.sin(a) * d, vx: Math.cos(a) * 5 * scale, vy: 3 + R() * 5, vz: Math.sin(a) * 5 * scale,
          life: 3 + R() * 2.5, s0: 14 * scale, s1: (40 + R() * 30) * scale, r: SPRAY[0], g: SPRAY[1], b: SPRAY[2], a: 0.28, drag: 0.4, soft: 20, vrot: rs(0.4) });
      }
    };
    // water sheeting off something that just surfaced
    fx.shed = function (x, y, z, radius, n) {
      for (let i = 0; i < n; i++) {
        const a = R() * 6.283, d = radius * (0.5 + R() * 0.6);
        alp.add({ x: x + Math.cos(a) * d, y: y * (0.3 + R() * 0.7), z: z + Math.sin(a) * d, vx: Math.cos(a) * 4, vy: -2 - R() * 6, vz: Math.sin(a) * 4,
          life: 1.2 + R() * 1.4, s0: 5 + R() * 4, s1: 12 + R() * 8, r: SPRAY[0] * 1.2, g: SPRAY[1] * 1.2, b: SPRAY[2] * 1.2, a: 0.42, grav: 16, drag: 0.2, soft: 8, floor: -1 });
      }
    };
    fx.mist = function (x, y, z, size, alpha) {
      alp.add({ x, y, z, vx: rs(3), vy: 1 + R() * 2, vz: rs(3), life: 3 + R() * 2, s0: size, s1: size * 2.2, r: SPRAY[0], g: SPRAY[1], b: SPRAY[2], a: alpha || 0.22, drag: 0.3, soft: size * 0.5, vrot: rs(0.3) });
    };
    // -------- combat
    fx.sparks = function (x, y, z, dx, dy, dz, n, power, size) {
      power = power || 1; size = size || 1;
      for (let i = 0; i < n; i++) {
        const sp = (25 + R() * 70) * power;
        add.add({ x, y, z, vx: dx * sp + rs(30) * power, vy: dy * sp + rs(30) * power + 12, vz: dz * sp + rs(30) * power, life: 0.35 + R() * 0.9,
          s0: (0.55 + R() * 0.8) * size, s1: 0.15 * size, r: 5.0, g: 2.2 + R() * 1.5, b: 0.5, a: 1, grav: 40, drag: 0.8, soft: 2 });
      }
    };
    fx.flash = function (x, y, z, size, r, g, b, life) {
      add.add({ x, y, z, life: life || 0.22, s0: size, s1: size * 1.8, r, g, b, a: 1, soft: size * 0.3, rot: 0 });
    };
    // glowing ichor; col is THREE.Color (linear)
    fx.ichor = function (x, y, z, dx, dy, dz, col, n, power) {
      power = power || 1;
      for (let i = 0; i < n; i++) {
        const sp = (14 + R() * 42) * power;
        add.add({ x: x + rs(4), y: y + rs(4), z: z + rs(4), vx: dx * sp + rs(22), vy: dy * sp + rs(22) + 14, vz: dz * sp + rs(22), life: 0.9 + R() * 1.5,
          s0: 1.4 + R() * 2.2, s1: 0.5, r: col.r * 3.2, g: col.g * 3.2, b: col.b * 3.2, a: 1, grav: 30, drag: 0.4, soft: 4, floor: -1 });
      }
      for (let i = 0; i < n / 4; i++)
        alp.add({ x: x + rs(5), y: y + rs(5), z: z + rs(5), vx: dx * 12 + rs(8), vy: 4 + rs(6), vz: dz * 12 + rs(8), life: 1.4 + R(), s0: 9, s1: 26,
          r: col.r * 0.12 + 0.03, g: col.g * 0.12 + 0.035, b: col.b * 0.12 + 0.04, a: 0.4, drag: 0.8, soft: 10 });
    };
    fx.smoke = function (x, y, z, size, n, dark) {
      const c = dark === undefined ? 0.022 : dark;
      for (let i = 0; i < n; i++)
        alp.add({ x: x + rs(size * 0.4), y: y + rs(size * 0.3), z: z + rs(size * 0.4), vx: 4 + rs(3), vy: 7 + R() * 9, vz: rs(3), life: 4 + R() * 4,
          s0: size * (0.6 + R() * 0.5), s1: size * (2.2 + R()), r: c, g: c * 1.05, b: c * 1.15, a: 0.5, drag: 0.15, soft: size * 0.5, vrot: rs(0.3) });
    };
    fx.fireball = function (x, y, z, size) {
      for (let i = 0; i < 7; i++)
        add.add({ x: x + rs(size * 0.3), y: y + rs(size * 0.3), z: z + rs(size * 0.3), vx: rs(10), vy: 8 + R() * 14, vz: rs(10), life: 0.5 + R() * 0.7,
          s0: size * (0.5 + R() * 0.5), s1: size * 1.5, r: 4.5, g: 1.5 + R(), b: 0.25, a: 0.9, drag: 1.0, soft: size * 0.4, vrot: rs(1) });
      fx.smoke(x, y + size * 0.4, z, size, 4);
    };
    // plasma bolt body and wake; called every frame while the bolt flies
    fx.bolt = function (x, y, z, col, size) {
      add.add({ x, y, z, life: 0.07, s0: size * 2.4, s1: size * 2.4, r: col.r * 9, g: col.g * 9, b: col.b * 9, a: 1, soft: 6, rot: 0 });
      add.add({ x: x + rs(1.5), y: y + rs(1.5), z: z + rs(1.5), life: 0.5 + R() * 0.3, s0: size * 1.2, s1: size * 0.2, r: col.r * 3, g: col.g * 3, b: col.b * 3, a: 0.8, soft: 4 });
    };
    fx.burst = function (x, y, z, col, size, n) {
      fx.flash(x, y, z, size * 3.2, col.r * 9, col.g * 9, col.b * 9, 0.3);
      for (let i = 0; i < (n || 18); i++) {
        const a = R() * 6.283, e = rs(1.2), sp = 30 + R() * 80;
        add.add({ x, y, z, vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(e) * sp + 10, vz: Math.sin(a) * Math.cos(e) * sp, life: 0.5 + R() * 0.8,
          s0: size * (0.25 + R() * 0.3), s1: 0.5, r: col.r * 5, g: col.g * 5, b: col.b * 5, a: 1, grav: 18, drag: 1.2, soft: 4 });
      }
    };
    fx.thruster = function (x, y, z, dx, dz) {
      for (let i = 0; i < 3; i++)
        add.add({ x: x + rs(3), y: y + rs(3), z: z + rs(3), vx: dx * 60 + rs(10), vy: -6 + rs(8), vz: dz * 60 + rs(10), life: 0.35 + R() * 0.3, s0: 7, s1: 16, r: 1.4, g: 2.6, b: 5.0, a: 0.8, drag: 1.5, soft: 6 });
    };
    // burning buildings keep smoking
    fx.addFire = function (x, y, z) { if (fx.fires.length < 40) fx.fires.push({ x, y, z, t: R() }); };
    fx.clearFires = function () { fx.fires.length = 0; };

    // -------- fog banks pouring through the Gate, and low mist on the bay
    const NB = BW.Q.mobile ? 34 : 60;
    for (let i = 0; i < NB; i++) {
      const gate = i < NB * 0.62;
      fx.banks.push({ gate, x: gate ? -3200 + R() * 2700 : -1500 + R() * 4200, y: gate ? 15 + R() * 190 : 6 + R() * 26, z: gate ? rs(950) : -1900 + R() * 2700,
        s: gate ? 380 + R() * 420 : 300 + R() * 300, a: gate ? 0.20 + R() * 0.16 : 0.025 + R() * 0.03, v: 5 + R() * 6, rot: R() * 6.28, seed: R() });
    }
    const bankGeo = new T.InstancedBufferGeometry();
    bankGeo.setAttribute('position', new T.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    bankGeo.setIndex([0, 1, 2, 0, 2, 3]);
    const bPos = new T.InstancedBufferAttribute(new Float32Array(NB * 3), 3), bSR = new T.InstancedBufferAttribute(new Float32Array(NB * 4), 4), bCol = new T.InstancedBufferAttribute(new Float32Array(NB * 4), 4);
    bPos.setUsage(T.DynamicDrawUsage);
    bankGeo.setAttribute('iPos', bPos); bankGeo.setAttribute('iSR', bSR); bankGeo.setAttribute('iCol', bCol);
    bankGeo.instanceCount = NB;
    const bankMesh = new T.Mesh(bankGeo, alp.mesh.material);
    bankMesh.frustumCulled = false; bankMesh.renderOrder = 5;
    fxScene.add(bankMesh);
    fx.updateBanks = function (dt) {
      for (let i = 0; i < NB; i++) {
        const b = fx.banks[i];
        b.x += b.v * dt;
        if (b.gate && b.x > -400) { b.x = -3300; b.z = rs(950); }
        if (!b.gate && b.x > 2900) b.x = -1500;
        const edge = b.gate ? BW.smooth(-3300, -2700, b.x) * BW.smooth(-400, -1100, b.x) : BW.smooth(-1500, -1000, b.x) * BW.smooth(2900, 2300, b.x);
        bPos.array[i * 3] = b.x; bPos.array[i * 3 + 1] = b.y; bPos.array[i * 3 + 2] = b.z;
        bSR.array[i * 4] = b.s; bSR.array[i * 4 + 1] = b.rot; bSR.array[i * 4 + 2] = b.seed; bSR.array[i * 4 + 3] = b.s * 0.35;
        bCol.array[i * 4] = 0.075; bCol.array[i * 4 + 1] = 0.092; bCol.array[i * 4 + 2] = 0.12; bCol.array[i * 4 + 3] = b.a * edge;
      }
      bPos.needsUpdate = bSR.needsUpdate = bCol.needsUpdate = true;
    };

    // -------- rain
    const NR = BW.Q.rain, rb = new Float32Array(NR * 2 * 3), re = new Float32Array(NR * 2);
    for (let i = 0; i < NR; i++) {
      const x = R(), y = R(), z = R();
      for (let k = 0; k < 2; k++) { rb[(i * 2 + k) * 3] = x; rb[(i * 2 + k) * 3 + 1] = y; rb[(i * 2 + k) * 3 + 2] = z; re[i * 2 + k] = k; }
    }
    const rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.BufferAttribute(rb, 3));
    rg.setAttribute('aEnd', new T.BufferAttribute(re, 1));
    const rainMat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uVel: { value: new T.Vector3(7, -26, 2) }, uAmount: { value: 1 }, uEye: BW.U.uEye, uFlash: BW.U.uFlash,
        uDepthTex: BW.U.uDepthTex, uResolution: BW.U.uResolution, uNearFar: BW.U.uNearFar },
      vertexShader: /* glsl */ `
        attribute float aEnd; uniform float uTime, uAmount; uniform vec3 uVel, uEye; varying float vA; varying float vZ;
        void main() {
          const vec3 BOX = vec3(90.0, 70.0, 90.0);
          vec3 p = position * BOX + uVel * uTime;
          p = mod(p - uEye + BOX * 0.5, BOX) - BOX * 0.5 + uEye;
          p -= uVel * 0.028 * aEnd;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          vZ = -mv.z;
          vA = (1.0 - aEnd * 0.7) * smoothstep(7.0, 16.0, vZ) * smoothstep(48.0, 24.0, vZ) * uAmount * step(fract(position.x * 91.7), uAmount);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `precision highp float; uniform float uFlash; varying float vA; varying float vZ; ${BW.GLSL.fxDepth}
        void main() { gl_FragColor = vec4(vec3(0.30, 0.36, 0.44) * (1.0 + uFlash * 5.0) * vA * 0.15 * fxDepthFade(vZ, 1.0), 1.0); }`,
      blending: T.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false,
    });
    const rain = new T.LineSegments(rg, rainMat);
    rain.frustumCulled = false; rain.renderOrder = 30;
    fxScene.add(rain);
    fx.rainMat = rainMat;

    let fireAcc = 0;
    fx.update = function (dt, t, camVel) {
      rainMat.uniforms.uTime.value = t;
      if (camVel) rainMat.uniforms.uVel.value.set(7 - camVel.x * 0.9, -26, 2 - camVel.z * 0.9);
      fx.updateBanks(dt);
      fireAcc += dt;
      if (fireAcc > 0.12) {
        fireAcc = 0;
        for (const f of fx.fires) {
          if (R() < 0.35) add.add({ x: f.x + rs(8), y: f.y + R() * 6, z: f.z + rs(8), vx: 3 + rs(3), vy: 9 + R() * 10, vz: rs(3), life: 0.7 + R() * 0.7, s0: 9 + R() * 8, s1: 4, r: 4.2, g: 1.3 + R() * 0.8, b: 0.2, a: 0.8, drag: 0.6, soft: 6, vrot: rs(1) });
          if (R() < 0.16) fx.smoke(f.x, f.y + 12, f.z, 16, 1, 0.014);
        }
      }
      add.update(dt); alp.update(dt);
    };
    return fx;
  };
})();
