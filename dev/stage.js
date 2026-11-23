/* Dev harness stage: a small lit scene with the game's real sky, lights and environment,
 * so a single model can be looked at in isolation. Used by dev/*.html pages.
 *
 *   const stage = BW.devStage({ update(dt, t) {...} });
 *   stage.scene.add(model);
 * URL params (all optional): az, el (degrees), dist, ty (look-at height), fov, w (water 0/1)
 * window.__ready is set true after the first rendered frame (the screenshot tool waits for it).
 */
(function () {
  'use strict';
  const T = THREE, BW = window.BW;
  BW.devStage = function (opts) {
    opts = opts || {};
    const q = new URLSearchParams(location.search);
    const num = (k, d) => (q.has(k) ? parseFloat(q.get(k)) : d);
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = num('exp', 1.6);
    document.body.style.margin = '0';
    document.body.style.background = '#000';
    document.body.appendChild(renderer.domElement);

    const scene = new T.Scene();
    scene.add(BW.makeSkyDome(20000));
    scene.fog = new T.FogExp2(0x11161d, 0.00035);
    BW.addLights(scene);
    BW.buildEnvironment(renderer, scene);

    if (num('w', 1)) {
      const water = new T.Mesh(
        new T.PlaneGeometry(40000, 40000),
        new T.MeshStandardMaterial({ color: 0x06141a, roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.86 })
      );
      water.rotation.x = -Math.PI / 2;
      scene.add(water);
      const floor = new T.Mesh(new T.PlaneGeometry(40000, 40000), new T.MeshStandardMaterial({ color: 0x1a1c1a, roughness: 1 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = BW.SEA_FLOOR;
      scene.add(floor);
    }

    const camera = new T.PerspectiveCamera(num('fov', 40), innerWidth / innerHeight, 0.5, 40000);
    const az = (num('az', 30) * Math.PI) / 180, el = (num('el', 8) * Math.PI) / 180;
    const dist = num('dist', 260), ty = num('ty', 25);
    camera.position.set(Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(0, ty, 0);

    const stage = { renderer, scene, camera, q, num, t: 0 };
    let last = performance.now();
    const fixedT = q.has('t') ? parseFloat(q.get('t')) : null;
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      stage.t = fixedT !== null ? fixedT : stage.t + dt;
      BW.U.uSkyTime.value = stage.t;
      if (opts.update) opts.update(fixedT !== null ? 1 / 60 : dt, stage.t);
      renderer.render(scene, camera);
      window.__frames = (window.__frames || 0) + 1;
      if (window.__frames > 3) window.__ready = true;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    addEventListener('resize', () => {
      renderer.setSize(innerWidth, innerHeight);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    });
    return stage;
  };
})();
