/* BREAKWATER — audio: everything is synthesized with WebAudio. No samples, no downloads.
 *
 *   BW.Audio.init()            call from a user gesture; idempotent. Before init every call is a silent no-op.
 *   BW.Audio.resume()          after a tab switch / pause
 *   BW.Audio.setMuted(b)       BW.Audio.muted
 *   BW.Audio.update(dt, s)     every frame; s = { speed, hull, charge, rain, threat, paused }
 *   BW.Audio.play(name, o)     one-shots; o = { pan:-1..1, gain:0..1, pitch:mult, size:0..1 }
 *
 * The synthesis lives in Engine, which runs on any BaseAudioContext, so dev/audio.html can render
 * every sound through the real master chain in an OfflineAudioContext and measure it.
 *
 * Master chain: sfx/bed/music -> sum -> duck -> compressor -> soft-clip ceiling -> master -> mute -> out.
 * The ceiling is a waveshaper whose output never exceeds CEIL, so nothing can clip however many
 * one-shots overlap.
 */
(function () {
  'use strict';
  const BW = (window.BW = window.BW || {});

  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const lerp = (a, b, t) => a + (b - a) * t;
  const MAX_VOICES = 24;
  const CEIL = 0.862;       // waveshaper ceiling (see makeCeiling)
  const MASTER = 0.9;       // => absolute output ceiling ~0.78

  // Per-sound output level into the sfx bus, and priority for voice stealing (0 = droppable).
  const LEVEL = {
    step: 0.30, punch: 0.42, impact: 1.25, slam: 0.95, block: 0.68, hurt: 0.78, roar: 0.85, growl: 0.32,
    emerge: 0.42, splash: 0.50, spit: 0.42, acidHit: 0.38, cannon: 1.0, plasmaHit: 0.80, klaxon: 0.38,
    kill: 0.80, sync: 0.42, ui: 0.16, dash: 0.22, cityHit: 0.20, thunder: 0.20, victory: 0.42, defeat: 0.40,
  };

  const PRIO = { ui: 0, step: 0, splash: 0, growl: 1, punch: 1, spit: 1, acidHit: 1, dash: 1, cityHit: 1, thunder: 1 };
  // Nominal lengths in seconds (offline render length; live voices use each builder's return value).
  const DUR = {
    step: 1.25, punch: 0.65, impact: 0.95, slam: 1.6, block: 1.4, hurt: 1.05, roar: 2.6, growl: 0.75,
    emerge: 2.2, splash: 0.85, spit: 0.5, acidHit: 1.1, cannon: 1.5, plasmaHit: 1.3, klaxon: 1.45,
    kill: 3.7, sync: 1.2, ui: 0.09, dash: 0.9, cityHit: 2.5, thunder: 4.4, victory: 2.1, defeat: 2.5,
  };

  // ------------------------------------------------------------------ noise buffers
  function makeNoise(ctx, kind, seconds) {
    const sr = ctx.sampleRate, n = Math.floor(sr * seconds), fade = Math.floor(sr * 0.05);
    const raw = new Float32Array(n + fade);
    let seed = kind === 'white' ? 1234567 : kind === 'pink' ? 7654321 : 2468135;
    const rnd = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1;
    };
    if (kind === 'white') {
      for (let i = 0; i < raw.length; i++) raw[i] = rnd();
    } else if (kind === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;       // Paul Kellet's filter
      for (let i = 0; i < raw.length; i++) {
        const w = rnd();
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
        b6 = w * 0.115926;
      }
    } else {
      let last = 0;                                                      // brown: leaky integrator
      for (let i = 0; i < raw.length; i++) { last = (last + 0.02 * rnd()) / 1.02; raw[i] = last; }
    }
    // Cross-fade the tail into the head so the loop is seamless, then normalise to RMS 0.3.
    const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = raw[i];
    for (let i = 0; i < fade; i++) { const k = i / fade; d[i] = raw[i] * k + raw[n + i] * (1 - k); }
    let s = 0, mean = 0;
    for (let i = 0; i < n; i++) mean += d[i];
    mean /= n;
    for (let i = 0; i < n; i++) { d[i] -= mean; s += d[i] * d[i]; }
    const g = 0.3 / Math.sqrt(s / n || 1);
    for (let i = 0; i < n; i++) d[i] *= g;
    return buf;
  }

  // Linear below 0.5, soft above, flat at CEIL for |x| >= 1 (the WaveShaper clamps its input).
  function makeCeiling() {
    const n = 4097, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
      const y = a <= 0.5 ? a : 0.5 + 0.45 * Math.tanh((a - 0.5) / 0.45);
      c[i] = x < 0 ? -y : y;
    }
    return c;
  }
  function makeDrive(k) {
    const n = 2049, c = new Float32Array(n), norm = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
    return c;
  }

  // Envelope helper: value v0 at t0, then cumulative segments [dt, value, 'e'?].
  function env(param, t0, v0, segs) {
    param.setValueAtTime(v0, t0);
    let t = t0;
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      t += Math.max(sg[0], 0.001);
      if (sg[2] === 'e') param.exponentialRampToValueAtTime(Math.max(sg[1], 1e-4), t);
      else param.linearRampToValueAtTime(sg[1], t);
    }
  }

  // ------------------------------------------------------------------ voice
  function Voice(eng, o, level) {
    const ctx = eng.ctx;
    this.eng = eng; this.ctx = ctx;
    this.t = ctx.currentTime + 0.012;
    this.p = clamp(o.pitch || 1, 0.25, 4);
    this.size = o.size == null ? 0.6 : clamp(o.size, 0, 1);
    this.out = ctx.createGain();
    this.out.gain.value = level * (o.gain == null ? 1 : clamp(o.gain, 0, 1.5));
    this.tail = this.out;
    if (ctx.createStereoPanner && o.pan) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = clamp(o.pan, -1, 1);
      this.out.connect(pan);
      this.tail = pan;
    }
    this.tail.connect(eng.sfx);
  }
  Voice.prototype.gain = function (v, dest) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    g.connect(dest || this.out);
    return g;
  };
  Voice.prototype.filt = function (type, f, q, dest) {
    const b = this.ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = q == null ? 0.7 : q;
    b.connect(dest || this.out);
    return b;
  };
  Voice.prototype.osc = function (type, f, t0, t1, dest) {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    o.connect(dest || this.out);
    o.start(t0); o.stop(t1);
    return o;
  };
  Voice.prototype.noise = function (kind, t0, t1, dest, rate) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.eng.noiseBuf[kind];
    s.loop = true;
    if (rate) s.playbackRate.value = rate;
    s.connect(dest || this.out);
    s.start(t0, Math.random() * 1.6);
    s.stop(t1);
    return s;
  };
  Voice.prototype.drive = function (k, dest) {
    const w = this.ctx.createWaveShaper();
    w.curve = this.eng.driveCurve(k);
    w.connect(dest || this.out);
    return w;
  };

  // Filtered noise burst. o = { dur, peak, type, f0, f1, q, a, rate, dest, hold }
  function burst(v, kind, t, o) {
    const f = v.filt(o.type || 'lowpass', o.f0, o.q, o.dest);
    if (o.f1) env(f.frequency, t, o.f0, [[o.fdur || o.dur, o.f1, 'e']]);
    const g = v.gain(0, f), a = o.a || 0.005, hold = o.hold || 0;
    env(g.gain, t, 1e-4, [[a, o.peak, 'e'], [hold, o.peak], [Math.max(o.dur - a - hold, 0.01), 1e-4, 'e']]);
    v.noise(kind, t, t + o.dur + 0.05, g, o.rate);
    return f;
  }
  // Enveloped oscillator with optional glide. o = { f0, f1, fdur, dur, peak, a, dest, hold }
  function tone(v, type, t, o) {
    const g = v.gain(0, o.dest), a = o.a || 0.005, hold = o.hold || 0;
    env(g.gain, t, 1e-4, [[a, o.peak, 'e'], [hold, o.peak], [Math.max(o.dur - a - hold, 0.01), 1e-4, 'e']]);
    const os = v.osc(type, o.f0, t, t + o.dur + 0.05, g);
    if (o.f1) env(os.frequency, t, o.f0, [[o.fdur || o.dur, o.f1, 'e']]);
    return os;
  }

  // ------------------------------------------------------------------ the monster voice
  // Detuned saws + sub, random FM and rough AM, driven into three moving formant band-passes,
  // with a noise breath on top. c = { f0, dur, contour:[[frac,mult]..], F:[[start,mid,end] x3], breath, gain, attack }
  function monster(v, t, c) {
    const dur = c.dur, f0 = c.f0, att = c.attack || 0.1, end = t + dur + 0.08;
    const amp = v.gain(0);
    env(amp.gain, t, 1e-4, [[att, c.gain, 'e'], [dur * 0.5, c.gain * 0.9], [dur * 0.3, c.gain * 0.3],
      [Math.max(dur * 0.2 - att, 0.05), 1e-4, 'e']]);

    const Fg = [1.0, 0.75, 0.42], Fq = [4, 6, 8];
    const drive = v.ctx.createWaveShaper();
    drive.curve = v.eng.driveCurve(3);
    for (let i = 0; i < 3; i++) {
      const fg = v.gain(Fg[i] * 1.6, amp);
      const bp = v.filt('bandpass', c.F[i][0], Fq[i], fg);
      env(bp.frequency, t, c.F[i][0], [[dur * 0.3, c.F[i][1], 'e'], [dur * 0.7, c.F[i][2], 'e']]);
      drive.connect(bp);
    }
    const body = v.filt('lowpass', 260, 0.7, v.gain(0.55, amp));   // chest resonance, un-formanted
    drive.connect(body);

    // rough amplitude modulation in front of the drive (vocal-fold flap), slowing as the roar dies
    const pre = v.gain(0.55, drive);
    const am = v.osc('sawtooth', 44, t, end, v.gain(0.42, pre.gain));
    env(am.frequency, t, 46, [[dur, 22, 'e']]);

    // shared pitch modulation: slow wobble + band-limited random jitter
    const fm = v.gain(1);
    fm.disconnect();
    v.osc('sine', 5.3, t, end, v.gain(f0 * 0.035, fm));
    v.noise('white', t, end, v.gain(f0 * 0.5, fm), 0.004);
    const voices = [['sawtooth', 1, 0.5], ['sawtooth', 1.013, 0.42], ['sawtooth', 0.503, 0.5], ['square', 0.752, 0.16]];
    const contour = (param, base) => {
      param.setValueAtTime(base * c.contour[0][1], t);
      for (let i = 1; i < c.contour.length; i++)
        param.exponentialRampToValueAtTime(base * c.contour[i][1], t + c.contour[i][0] * dur);
    };
    for (let i = 0; i < voices.length; i++) {
      const o = v.osc(voices[i][0], f0 * voices[i][1], t, end, v.gain(voices[i][2], pre));
      contour(o.frequency, f0 * voices[i][1]);
      fm.connect(o.frequency);
    }
    const sub = v.osc('sine', f0 * 0.5, t, end, v.gain(0.5, amp));
    contour(sub.frequency, f0 * 0.5);

    // breath: raspy noise through the formants + airy hiss straight out
    const br = c.breath == null ? 0.4 : c.breath;
    v.noise('pink', t, end, v.gain(br * 0.8, pre), 1.3);
    const hiss = v.filt('bandpass', 2400, 0.7, v.gain(br * 0.5, amp));
    env(hiss.frequency, t, 3200, [[dur, 1300, 'e']]);
    v.noise('white', t, end, hiss);
    return dur;
  }

  function impactAt(v, t, k) {
    const p = v.p;
    tone(v, 'sine', t, { f0: 95 * p, f1: 30 * p, fdur: 0.22, dur: 0.6, peak: 1.0 * k, a: 0.004 });      // boom
    burst(v, 'white', t, { type: 'highpass', f0: 1800, dur: 0.06, peak: 0.9 * k, a: 0.001 });            // crack
    burst(v, 'brown', t, { type: 'lowpass', f0: 520, f1: 140, dur: 0.5, peak: 2.0 * k, a: 0.004 });      // body
    const wet = burst(v, 'pink', t + 0.015, { type: 'bandpass', f0: 950, f1: 420, q: 1.6, dur: 0.3, peak: 0.9 * k, a: 0.01 }); // wet tear
    void wet;
    const part = [317, 541, 893];                                                                         // armour ring
    for (let i = 0; i < part.length; i++)
      tone(v, 'sine', t, { f0: part[i] * p, dur: 0.35 - i * 0.07, peak: 0.1 * k, a: 0.002 });
  }
  function waterAt(v, t, k, len) {
    burst(v, 'pink', t, { type: 'bandpass', f0: 700, f1: 2400, q: 0.6, fdur: len * 0.35, dur: len, peak: 1.2 * k, a: 0.03 });
    burst(v, 'brown', t, { type: 'lowpass', f0: 300, f1: 90, dur: len * 0.8, peak: 1.6 * k, a: 0.02 });
    burst(v, 'white', t + len * 0.12, { type: 'highpass', f0: 3200, dur: len * 0.9, peak: 0.4 * k, a: len * 0.15 });
  }

  // ------------------------------------------------------------------ one-shots (each returns its length)
  const S = {};

  S.step = function (v) {
    const t = v.t, p = v.p;
    tone(v, 'sine', t, { f0: 60 * p, f1: 26 * p, fdur: 0.38, dur: 0.55, peak: 1.0, a: 0.012 });
    burst(v, 'pink', t, { type: 'lowpass', f0: 1900, f1: 330, dur: 1.1, peak: 1.5, a: 0.04 });
    burst(v, 'white', t + 0.06, { type: 'highpass', f0: 2800, dur: 0.8, peak: 0.35, a: 0.07 });
    return 1.25;
  };

  S.punch = function (v) {
    const t = v.t, p = v.p;
    const f = v.filt('bandpass', 220, 1.1);
    env(f.frequency, t, 180 * p, [[0.24, 1300 * p, 'e'], [0.3, 260 * p, 'e']]);
    const g = v.gain(0, f);
    env(g.gain, t, 1e-4, [[0.2, 3.2, 'e'], [0.08, 2.4], [0.3, 1e-4, 'e']]);
    v.noise('pink', t, t + 0.65, g);
    const lp = v.filt('lowpass', 1500, 2);                                   // servo
    const sg = v.gain(0, lp);
    env(sg.gain, t, 1e-4, [[0.05, 0.3, 'e'], [0.22, 0.22], [0.15, 1e-4, 'e']]);
    const o = v.osc('sawtooth', 80 * p, t, t + 0.5, sg);
    env(o.frequency, t, 80 * p, [[0.28, 290 * p, 'e'], [0.14, 160 * p, 'e']]);
    burst(v, 'white', t, { type: 'bandpass', f0: 4200, q: 2, dur: 0.3, peak: 0.25, a: 0.03 });  // hydraulic hiss
    return 0.65;
  };

  S.impact = function (v) { impactAt(v, v.t, 1); return 0.95; };

  S.slam = function (v) {
    const t = v.t;
    impactAt(v, t, 0.85);
    impactAt(v, t + 0.11, 1.0);
    tone(v, 'sine', t + 0.1, { f0: 44 * v.p, f1: 24 * v.p, dur: 1.35, peak: 1.0, a: 0.02 });
    burst(v, 'brown', t + 0.1, { type: 'lowpass', f0: 200, f1: 60, dur: 1.3, peak: 1.5, a: 0.03 });
    return 1.6;
  };

  S.block = function (v) {
    const t = v.t, base = 176 * v.p;
    const ratios = [1, 2.76, 5.4, 8.93, 11.34], dec = [1.3, 0.9, 0.6, 0.4, 0.25], lv = [0.5, 0.42, 0.3, 0.2, 0.12];
    for (let i = 0; i < ratios.length; i++) {
      tone(v, 'sine', t, { f0: base * ratios[i], dur: dec[i], peak: lv[i], a: 0.002 });
      tone(v, 'sine', t, { f0: base * ratios[i] * 1.011, dur: dec[i] * 0.8, peak: lv[i] * 0.5, a: 0.002 });
    }
    burst(v, 'white', t, { type: 'bandpass', f0: 3000, q: 0.8, dur: 0.09, peak: 1.4, a: 0.001 });
    tone(v, 'sine', t, { f0: 80 * v.p, f1: 38 * v.p, dur: 0.4, peak: 0.9, a: 0.004 });
    return 1.4;
  };

  S.hurt = function (v) {
    const t = v.t, p = v.p;
    tone(v, 'sine', t, { f0: 85 * p, f1: 34 * p, dur: 0.45, peak: 1.0, a: 0.004 });
    burst(v, 'brown', t, { type: 'lowpass', f0: 600, f1: 150, dur: 0.4, peak: 1.6, a: 0.004 });
    // metal groan: FM saw through a resonant sweep
    const bp = v.filt('bandpass', 420, 5, v.gain(2.2));
    env(bp.frequency, t, 520, [[0.5, 260, 'e'], [0.4, 340, 'e']]);
    const g = v.gain(0, bp);
    env(g.gain, t + 0.04, 1e-4, [[0.1, 0.7, 'e'], [0.45, 0.5], [0.4, 1e-4, 'e']]);
    const o = v.osc('sawtooth', 72 * p, t, t + 1.05, g);
    env(o.frequency, t, 76 * p, [[0.9, 47 * p, 'e']]);
    v.osc('sine', 7, t, t + 1.05, v.gain(5, o.frequency));
    // alarm chirp
    for (let i = 0; i < 3; i++)
      tone(v, 'square', t + 0.12 + i * 0.13, { f0: i % 2 ? 1050 : 1400, dur: 0.09, peak: 0.07, a: 0.004, hold: 0.06, dest: v.filt('lowpass', 3500, 0.7) });
    return 1.05;
  };

  S.roar = function (v) {
    const s = v.size;
    return monster(v, v.t, {
      f0: lerp(108, 62, s) * v.p, dur: lerp(1.5, 2.5, s), gain: 1.0, attack: 0.1, breath: 0.45,
      contour: [[0, 0.72], [0.12, 1.3], [0.45, 1.0], [1, 0.42]],
      F: [[420, 800, 330], [1150, 1800, 820], [2500, 3000, 2050]],
    }) + 0.1;
  };

  S.growl = function (v) {
    return monster(v, v.t, {
      f0: lerp(70, 48, v.size) * v.p, dur: 0.68, gain: 0.9, attack: 0.07, breath: 0.16,
      contour: [[0, 0.9], [0.3, 1.06], [1, 0.7]],
      F: [[280, 390, 240], [720, 900, 600], [1800, 2000, 1500]],
    }) + 0.07;
  };

  S.kill = function (v) {
    const t = v.t;
    monster(v, t, {
      f0: lerp(100, 74, v.size) * v.p, dur: 2.5, gain: 1.0, attack: 0.08, breath: 0.5,
      contour: [[0, 1.2], [0.1, 1.36], [0.5, 0.8], [1, 0.27]],
      F: [[520, 760, 240], [1500, 1700, 620], [2900, 2700, 1600]],
    });
    waterAt(v, t + 1.9, 0.9, 1.7);                                           // the body goes into the bay
    tone(v, 'sine', t + 1.9, { f0: 50, f1: 24, dur: 1.2, peak: 0.9, a: 0.03 });
    return 3.7;
  };

  S.emerge = function (v) {
    const t = v.t;
    const lp = v.filt('lowpass', 200, 0.6);
    env(lp.frequency, t, 180, [[0.55, 2600, 'e'], [1.5, 500, 'e']]);
    const g = v.gain(0, lp);
    env(g.gain, t, 1e-4, [[0.5, 2.2, 'e'], [0.3, 1.5], [1.3, 1e-4, 'e']]);
    v.noise('pink', t, t + 2.2, g);
    v.noise('brown', t, t + 2.2, g, 1.4);
    burst(v, 'white', t + 0.35, { type: 'highpass', f0: 3000, dur: 1.75, peak: 0.5, a: 0.3 });
    tone(v, 'sine', t, { f0: 34, f1: 52, fdur: 0.6, dur: 1.6, peak: 0.9, a: 0.45 });
    return 2.2;
  };

  S.splash = function (v) { waterAt(v, v.t, 0.8, 0.8); return 0.85; };

  S.spit = function (v) {
    const t = v.t, p = v.p;
    burst(v, 'white', t, { type: 'bandpass', f0: 2800 * p, f1: 850 * p, q: 1.4, dur: 0.38, peak: 2.6, a: 0.015 });
    const g = v.gain(0);
    env(g.gain, t, 1e-4, [[0.02, 0.6, 'e'], [0.3, 1e-4, 'e']]);
    const o = v.osc('sine', 320 * p, t, t + 0.4, g);                         // gurgle
    env(o.frequency, t, 330 * p, [[0.3, 110 * p, 'e']]);
    v.osc('sine', 31, t, t + 0.4, v.gain(60, o.frequency));
    burst(v, 'pink', t, { type: 'lowpass', f0: 500, dur: 0.2, peak: 1.2, a: 0.01 });
    return 0.5;
  };

  S.acidHit = function (v) {
    const t = v.t;
    const hp = v.filt('highpass', 3600, 0.7);
    const g = v.gain(0, hp);
    env(g.gain, t, 1e-4, [[0.02, 1.4, 'e'], [0.25, 0.8], [0.8, 1e-4, 'e']]);
    const crackle = v.gain(0.35, g);                                         // random gating = sizzle
    v.noise('white', t, t + 1.1, v.gain(2.2, crackle.gain), 0.006);
    v.noise('white', t, t + 1.1, crackle);
    burst(v, 'pink', t, { type: 'lowpass', f0: 700, f1: 200, dur: 0.22, peak: 1.6, a: 0.005 });
    return 1.1;
  };

  S.cannon = function (v) {
    const t = v.t, p = v.p;
    burst(v, 'white', t, { type: 'highpass', f0: 1800, dur: 0.05, peak: 2.4, a: 0.001 });           // crack
    const bp = v.filt('bandpass', 1500, 1.2, v.gain(1.4));
    env(bp.frequency, t, 3200 * p, [[0.3, 200 * p, 'e']]);
    tone(v, 'sawtooth', t, { f0: 2600 * p, f1: 110 * p, fdur: 0.26, dur: 0.4, peak: 0.8, a: 0.003, dest: bp }); // zap
    tone(v, 'sine', t, { f0: 170 * p, f1: 29 * p, fdur: 0.5, dur: 0.95, peak: 1.1, a: 0.004 });       // sub drop
    burst(v, 'pink', t, { type: 'lowpass', f0: 4200, f1: 180, dur: 1.4, peak: 2.0, a: 0.004 });      // tail
    // ring-mod shimmer: carrier amplitude driven by a second oscillator
    const rg = v.gain(0, v.filt('highpass', 500, 0.7));
    const rm = v.gain(0, rg);
    env(rg.gain, t, 1e-4, [[0.01, 0.22, 'e'], [0.6, 1e-4, 'e']]);
    v.osc('sine', 930 * p, t, t + 0.7, rm);
    v.osc('sine', 137, t, t + 0.7, rm.gain);
    return 1.5;
  };

  S.plasmaHit = function (v) {
    const t = v.t, p = v.p;
    tone(v, 'sine', t, { f0: 78 * p, f1: 24 * p, fdur: 0.4, dur: 0.9, peak: 1.1, a: 0.004 });
    burst(v, 'pink', t, { type: 'lowpass', f0: 3000, f1: 140, dur: 1.2, peak: 2.4, a: 0.004 });
    burst(v, 'white', t, { type: 'highpass', f0: 2500, dur: 0.07, peak: 1.4, a: 0.001 });
    // electric sizzle: band-passed noise chopped at mains-ish rate
    const bp = v.filt('bandpass', 4200, 1.5);
    const g = v.gain(0, bp);
    env(g.gain, t + 0.03, 1e-4, [[0.02, 0.5, 'e'], [0.5, 1e-4, 'e']]);
    const chop = v.gain(0.5, g);
    v.osc('square', 61, t, t + 0.6, v.gain(0.5, chop.gain));
    v.noise('white', t, t + 0.6, chop);
    return 1.3;
  };

  S.klaxon = function (v) {
    const p = v.p;
    for (let i = 0; i < 2; i++) {
      const t = v.t + i * 0.72;
      const lp = v.filt('lowpass', 2300, 1.2);
      const g = v.gain(0, lp);
      env(g.gain, t, 1e-4, [[0.03, 0.42, 'e'], [0.44, 0.38], [0.11, 1e-4, 'e']]);
      const fr = [233.08, 311.13, 466.16];
      for (let k = 0; k < fr.length; k++) {
        const o = v.osc('sawtooth', fr[k] * p, t, t + 0.62, g);
        env(o.frequency, t, fr[k] * p * 0.86, [[0.09, fr[k] * p, 'e']]);
      }
      v.osc('square', 29, t, t + 0.62, v.gain(0.12, g.gain));                 // horn rasp
    }
    return 1.45;
  };

  S.sync = function (v) {
    const notes = [587.33, 880.0], ratios = [1, 2.0, 3.01, 4.2], lv = [1, 0.4, 0.2, 0.1], dec = [1.0, 0.65, 0.4, 0.25];
    for (let n = 0; n < 2; n++) {
      const t = v.t + n * 0.13;
      for (let i = 0; i < ratios.length; i++)
        tone(v, i ? 'sine' : 'triangle', t, { f0: notes[n] * v.p * ratios[i], dur: dec[i], peak: lv[i] * 0.5, a: 0.004 });
    }
    return 1.2;
  };

  S.ui = function (v) {
    tone(v, 'sine', v.t, { f0: 1250 * v.p, f1: 820 * v.p, dur: 0.05, peak: 1.0, a: 0.002 });
    burst(v, 'white', v.t, { type: 'highpass', f0: 5000, dur: 0.012, peak: 0.5, a: 0.001 });
    return 0.09;
  };

  S.dash = function (v) {
    const t = v.t;
    const bp = v.filt('bandpass', 500, 0.8);
    env(bp.frequency, t, 420, [[0.12, 1900, 'e'], [0.7, 380, 'e']]);
    const g = v.gain(0, bp);
    env(g.gain, t, 1e-4, [[0.05, 3.0, 'e'], [0.3, 2.2], [0.5, 1e-4, 'e']]);
    v.noise('pink', t, t + 0.9, g);
    burst(v, 'brown', t, { type: 'lowpass', f0: 240, dur: 0.8, peak: 1.8, a: 0.04, hold: 0.25 });
    tone(v, 'sine', t, { f0: 46, f1: 62, fdur: 0.3, dur: 0.75, peak: 0.6, a: 0.04, hold: 0.2 });
    return 0.9;
  };

  S.cityHit = function (v) {
    const t = v.t;
    burst(v, 'brown', t, { type: 'lowpass', f0: 280, f1: 90, dur: 2.3, peak: 2.6, a: 0.12, hold: 0.3 });
    tone(v, 'sine', t, { f0: 40, f1: 30, dur: 1.6, peak: 0.6, a: 0.15 });
    for (let i = 0; i < 6; i++)                                                 // crumbling masonry
      burst(v, 'pink', t + 0.08 + Math.random() * 1.5, {
        type: 'lowpass', f0: 500 + Math.random() * 500, dur: 0.14 + Math.random() * 0.2, peak: 0.7 + Math.random() * 0.9, a: 0.008 });
    return 2.5;
  };

  S.thunder = function (v) {
    const t = v.t;
    const lp = v.filt('lowpass', 500, 0.5);
    env(lp.frequency, t, 520, [[0.3, 230, 'e'], [3.6, 70, 'e']]);
    const g = v.gain(0, lp), r = () => 0.75 + Math.random() * 0.5;
    env(g.gain, t, 1e-4, [[0.06, 3.0 * r(), 'e'], [0.25, 1.1], [0.2, 3.2 * r()], [0.5, 1.2], [0.3, 2.4 * r()],
      [0.8, 0.8], [0.4, 1.4 * r()], [1.8, 1e-4, 'e']]);
    v.noise('brown', t, t + 4.4, g, 0.8);
    return 4.4;
  };

  S.victory = function (v) {
    const t = v.t, notes = [146.83, 220.0, 293.66, 369.99, 440.0];             // D A D F# A — the minor bed turns major
    const lp = v.filt('lowpass', 500, 0.8);
    env(lp.frequency, t, 450, [[0.7, 3400, 'e'], [1.3, 900, 'e']]);
    for (let i = 0; i < notes.length; i++) {
      const t0 = t + i * 0.09, g = v.gain(0, lp);
      env(g.gain, t0, 1e-4, [[0.06, 0.22, 'e'], [1.25 - i * 0.09, 0.18], [0.6, 1e-4, 'e']]);
      v.osc('sawtooth', notes[i] * 1.003, t0, t + 2.1, g);
      v.osc('sawtooth', notes[i] * 0.997, t0, t + 2.1, g);
      v.osc('triangle', notes[i] * 2, t0, t + 2.1, v.gain(0.4, g));
    }
    return 2.1;
  };

  S.defeat = function (v) {
    const t = v.t, notes = [73.42, 103.83, 174.61];                             // D, A-flat, F: a tritone sinking
    const lp = v.filt('lowpass', 1800, 0.8);
    env(lp.frequency, t, 1900, [[2.2, 190, 'e']]);
    for (let i = 0; i < notes.length; i++) {
      const g = v.gain(0, lp);
      env(g.gain, t, 1e-4, [[0.05, 0.3, 'e'], [1.3, 0.24], [1.1, 1e-4, 'e']]);
      for (let d = 0; d < 2; d++) {
        const o = v.osc('sawtooth', notes[i] * (d ? 1.005 : 0.995), t, t + 2.5, g);
        env(o.frequency, t, notes[i] * (d ? 1.005 : 0.995), [[0.4, notes[i]], [2.0, notes[i] * 0.8, 'e']]);
      }
    }
    tone(v, 'sine', t, { f0: 55, f1: 27, dur: 1.8, peak: 0.9, a: 0.01 });
    return 2.5;
  };

  // ------------------------------------------------------------------ engine
  // Harmony for the bed: i – VI – iv – Vsus over a D pedal, one chord per bar.
  const CHORDS = [
    { pad: [73.42, 110.0, 146.83, 174.61, 329.63], root: 36.71, air: 587.33 },   // Dm(add9)
    { pad: [73.42, 116.54, 146.83, 174.61, 220.0], root: 58.27, air: 698.46 },   // Bbmaj7/D
    { pad: [73.42, 98.0, 146.83, 164.81, 233.08], root: 49.0, air: 587.33 },     // Gm6/D
    { pad: [73.42, 110.0, 146.83, 196.0, 329.63], root: 55.0, air: 659.26 },     // Asus/D
  ];
  const STEP = 0.3125;                                         // eighth note at 96 bpm; 32 steps per chord (10 s)
  const KICK = [1, 0, 0, 0.6, 0, 0, 0.8, 0, 1, 0, 0, 0.6, 0, 0, 0.7, 0.4];
  const BASS = [1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0];

  function Engine(ctx) {
    this.ctx = ctx;
    this.voices = [];
    this._drive = {};
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    this.sum = g(1); this.duck = g(1); this.master = g(MASTER); this.mute = g(1);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12; this.comp.knee.value = 6; this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004; this.comp.release.value = 0.22;
    this.ceil = ctx.createWaveShaper();
    this.ceil.curve = makeCeiling();
    this.sum.connect(this.duck); this.duck.connect(this.comp); this.comp.connect(this.ceil);
    this.ceil.connect(this.master); this.master.connect(this.mute); this.mute.connect(ctx.destination);
    this.sfx = g(0.55); this.bed = g(1.25); this.music = g(1.25);
    this.sfx.connect(this.sum); this.bed.connect(this.sum); this.music.connect(this.sum);
    this.noiseBuf = { white: makeNoise(ctx, 'white', 2), pink: makeNoise(ctx, 'pink', 2), brown: makeNoise(ctx, 'brown', 2) };
    this.B = null;
    this._last = -1;
  }
  Engine.prototype.driveCurve = function (k) { return this._drive[k] || (this._drive[k] = makeDrive(k)); };
  Engine.prototype.setMuted = function (b) { this.mute.gain.setTargetAtTime(b ? 0 : 1, this.ctx.currentTime, 0.02); };

  Engine.prototype.play = function (name, o) {
    const fn = S[name];
    if (!fn) return;
    const ctx = this.ctx, now = ctx.currentTime, vs = this.voices;
    for (let i = vs.length - 1; i >= 0; i--) if (vs[i].end <= now) vs.splice(i, 1);
    const prio = PRIO[name] == null ? 2 : PRIO[name];
    if (vs.length >= MAX_VOICES) {
      if (prio === 0) return;
      let k = 0;                                               // steal the oldest of the lowest priority
      for (let i = 1; i < vs.length; i++) if (vs[i].prio < vs[k].prio) k = i;
      if (vs[k].prio > prio) return;
      const old = vs.splice(k, 1)[0];
      old.out.gain.cancelScheduledValues(now);
      old.out.gain.setTargetAtTime(0, now, 0.015);
    }
    const v = new Voice(this, o, LEVEL[name] || 0.4);
    let dur;
    try { dur = fn(v) || 1; } catch (e) { try { v.tail.disconnect(); } catch (_) {} return; }
    const rec = { out: v.out, end: v.t + dur + 0.1, prio };
    vs.push(rec);
    if (typeof OfflineAudioContext === 'undefined' || !(ctx instanceof OfflineAudioContext))
      setTimeout(() => { try { v.tail.disconnect(); } catch (_) {} }, (dur + 0.4) * 1000);
  };

  // Continuous layers. Everything is created once and steered with setTargetAtTime from update().
  Engine.prototype.startBeds = function () {
    if (this.B) return;
    const ctx = this.ctx, t = ctx.currentTime, eng = this, B = (this.B = {});
    const g = (v, dest) => { const n = ctx.createGain(); n.gain.value = v; n.connect(dest); return n; };
    const f = (type, fr, q, dest) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = fr; b.Q.value = q; b.connect(dest); return b; };
    const osc = (type, fr, dest) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = fr; o.connect(dest); o.start(t); return o; };
    const noise = (kind, dest, rate, off) => {
      const s = ctx.createBufferSource(); s.buffer = eng.noiseBuf[kind]; s.loop = true;
      if (rate) s.playbackRate.value = rate; s.connect(dest); s.start(t, off || 0); return s;
    };

    // wind across the canopy
    B.gWind = g(0, this.bed);
    const wbp = f('bandpass', 430, 0.7, B.gWind);
    noise('pink', wbp, 1, 0.3);
    osc('sine', 0.07, g(170, wbp.frequency));
    B.windLfo = g(0, B.gWind.gain);
    osc('sine', 0.113, B.windLfo);
    // rain: bright hiss + lower patter on the glass
    B.gRain = g(0, this.bed);
    noise('white', f('highpass', 3200, 0.5, f('lowpass', 9000, 0.5, B.gRain)), 1, 0.9);
    B.gPat = g(0, this.bed);
    const pat = g(0.6, f('bandpass', 1500, 0.9, B.gPat));
    noise('white', pat, 0.55, 0.2);
    noise('white', g(1.2, pat.gain), 0.0025, 0.7);             // slow random gusting of the patter
    // ocean
    B.gOcean = g(0, this.bed);
    const og = g(0.75, f('lowpass', 150, 0.6, B.gOcean));
    noise('brown', og, 0.9, 1.1);
    osc('sine', 0.09, g(0.25, og.gain));
    // reactor hum
    B.gHum = g(0, this.bed);
    osc('sine', 55, g(1, B.gHum));
    osc('sine', 110.35, g(0.45, B.gHum));
    osc('triangle', 82.6, g(0.2, B.gHum));
    osc('sawtooth', 27.5, f('lowpass', 180, 0.7, g(0.5, B.gHum)));
    // servos / hydraulics
    B.gServo = g(0, this.bed);
    B.servoBP = f('bandpass', 300, 5, B.gServo);
    B.servo = osc('sawtooth', 120, B.servoBP);
    B.servo2 = osc('sawtooth', 181, g(0.5, B.servoBP));
    B.gHyd = g(0, this.bed);
    noise('white', f('bandpass', 2300, 2, B.gHyd), 1, 1.4);
    // cannon charge
    B.gCharge = g(0, this.bed);
    const trem = g(0.7, B.gCharge);
    B.charge = osc('sine', 220, trem);
    B.charge2 = osc('sawtooth', 110, f('lowpass', 2600, 1, g(0.25, trem)));
    B.chargeLfo = osc('sine', 9, g(0.3, trem.gain));
    // low-hull alarm: two-tone, gated
    B.gAlarm = g(0, this.bed);
    const gate = g(0.5, f('lowpass', 2800, 0.7, B.gAlarm));
    const al = osc('square', 760, gate);
    osc('square', 2.4, g(0.5, gate.gain));
    osc('square', 1.2, g(95, al.frequency));

    // ---- music: detuned pad over a D pedal
    B.gPad = g(0, this.music);
    B.padLP = f('lowpass', 560, 0.8, B.gPad);
    osc('sine', 0.045, g(230, B.padLP.frequency));
    B.pad = [];
    for (let i = 0; i < 5; i++) {
      const vg = g(i === 4 ? 0.1 : i === 0 ? 0.3 : 0.22, B.padLP), fr = CHORDS[0].pad[i];
      const a = osc('sawtooth', fr, vg), b = osc('sawtooth', fr, vg);
      a.detune.value = -6 - i; b.detune.value = 6 + i;
      B.pad.push([a, b]);
    }
    osc('sine', 36.71, g(0.5, B.gPad));
    const airG = g(0, B.gPad);                                 // a thin high voice breathing in and out
    B.air = osc('sine', CHORDS[0].air, airG);
    osc('sine', 0.06, g(0.035, airG.gain));
    airG.gain.value = 0.035;
    B.gPulse = g(0, this.music);
    B.pulseLP = f('lowpass', 1400, 0.7, B.gPulse);
    B.t0 = t + 0.1;
    B.nextStep = 0;                                            // index of the next eighth to schedule
    B.threat = 0;
    B.chord = -1;
  };

  Engine.prototype._pulse = function (t, step, threat) {
    const ctx = this.ctx, B = this.B, i = step % 16, ch = CHORDS[Math.floor(step / 32) % CHORDS.length];
    const mk = (type, f0, t1, g0, segs, dest) => {
      const g = ctx.createGain(); g.gain.value = 0; g.connect(dest || B.pulseLP);
      env(g.gain, t, 1e-4, segs);
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f0; o.connect(g); o.start(t); o.stop(t1);
      return o;
    };
    if (KICK[i]) {                                             // low drum
      const o = mk('sine', 82, t + 0.4, 0, [[0.005, 0.9 * KICK[i], 'e'], [0.32, 1e-4, 'e']], B.gPulse);
      env(o.frequency, t, 84, [[0.14, 38, 'e']]);
    }
    if (BASS[i]) {                                             // muted bass ostinato on the chord root
      const f0 = ch.root * (i === 10 || i === 3 ? 2 : 1) * 2;
      mk('sawtooth', f0, t + 0.3, 0, [[0.008, 0.35, 'e'], [0.24, 1e-4, 'e']]);
      mk('square', f0 * 0.5, t + 0.3, 0, [[0.008, 0.18, 'e'], [0.24, 1e-4, 'e']]);
    }
    if (threat > 0.6 && i % 2 === 1) {                         // tension tick only when it gets hot
      const s = ctx.createBufferSource(); s.buffer = this.noiseBuf.white; s.loop = true;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500;
      const g = ctx.createGain(); g.gain.value = 0;
      env(g.gain, t, 1e-4, [[0.002, 0.3 * (threat - 0.6) / 0.4, 'e'], [0.035, 1e-4, 'e']]);
      s.connect(hp); hp.connect(g); g.connect(B.gPulse); s.start(t, (step * 0.137) % 1.5); s.stop(t + 0.06);
    }
  };

  Engine.prototype.update = function (dt, s) {
    const B = this.B;
    if (!B) return;
    const ctx = this.ctx, now = ctx.currentTime;
    if (this._last >= 0 && now - this._last < 0.045) return;   // steer at ~20 Hz, not every frame
    this._last = now;
    const speed = clamp(s.speed || 0, 0, 1), hull = s.hull == null ? 1 : clamp(s.hull, 0, 1);
    const charge = clamp(s.charge || 0, 0, 1), rain = s.rain == null ? 0.6 : clamp(s.rain, 0, 1);
    const threat = clamp(s.threat || 0, 0, 1);
    const set = (p, v, tc) => p.setTargetAtTime(v, now, tc || 0.15);

    set(this.duck.gain, s.paused ? 0.12 : 1, 0.12);
    set(B.gWind.gain, 0.020 + rain * 0.016, 0.8);
    set(B.windLfo.gain, 0.008 + rain * 0.006, 0.8);
    set(B.gRain.gain, rain * 0.024, 0.6);
    set(B.gPat.gain, rain * 0.028, 0.6);
    set(B.gOcean.gain, 0.07, 1.0);
    set(B.gHum.gain, 0.008 + speed * 0.004, 0.4);

    set(B.gServo.gain, speed * 0.045, 0.12);
    const sf = 105 + speed * 250;
    set(B.servo.frequency, sf, 0.18); set(B.servo2.frequency, sf * 1.507, 0.18); set(B.servoBP.frequency, sf * 2.5, 0.18);
    set(B.gHyd.gain, speed * 0.012, 0.15);

    set(B.gCharge.gain, charge > 0.001 ? 0.014 + charge * 0.032 : 0, charge > 0.001 ? 0.06 : 0.03);
    const cf = 200 * Math.pow(8, charge);                      // three octaves over the charge
    set(B.charge.frequency, cf, 0.05); set(B.charge2.frequency, cf * 0.5, 0.05);
    set(B.chargeLfo.frequency, 8 + charge * 22, 0.1);

    set(B.gAlarm.gain, hull < 0.25 && hull > 0 ? 0.018 : 0, 0.1);

    // music
    set(B.gPad.gain, 0.042, 1.5);
    set(B.padLP.frequency, 520 + threat * 520, 1.2);
    B.threat = threat;
    set(B.gPulse.gain, threat < 0.04 ? 0 : 0.03 + threat * 0.075, 0.9);
    // look-ahead scheduler for chord changes and the pulse layer
    const horizon = now + 0.3;
    if (now > B.t0 + (B.nextStep + 4) * STEP) B.nextStep = Math.ceil((now - B.t0) / STEP);   // skipped (tab asleep)
    while (B.t0 + B.nextStep * STEP < horizon) {
      const st = B.t0 + B.nextStep * STEP, step = B.nextStep++;
      if (st < now) continue;
      const ci = Math.floor(step / 32) % CHORDS.length;
      if (ci !== B.chord) {
        B.chord = ci;
        const ch = CHORDS[ci];
        for (let i = 0; i < 5; i++) {
          B.pad[i][0].frequency.setTargetAtTime(ch.pad[i], st, 0.9);
          B.pad[i][1].frequency.setTargetAtTime(ch.pad[i], st, 0.9);
        }
        B.air.frequency.setTargetAtTime(ch.air, st, 1.6);
      }
      if (threat >= 0.04) this._pulse(st, step, threat);
    }
  };

  // ------------------------------------------------------------------ public API
  const A = (BW.Audio = {
    muted: false,
    _eng: null,
    NAMES: Object.keys(S),
    DUR,

    init() {
      if (this._eng) { this.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      let ctx;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return; } }
      try {
        this._eng = new Engine(ctx);
        this._eng.startBeds();
        this._eng.setMuted(this.muted);
      } catch (e) { this._eng = null; return; }
      document.addEventListener('visibilitychange', () => { if (!document.hidden) A.resume(); });
      this.resume();
    },
    resume() {
      const e = this._eng;
      if (e && e.ctx.state !== 'running' && e.ctx.resume) { try { const p = e.ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
    },
    setMuted(b) {
      this.muted = !!b;
      if (this._eng) this._eng.setMuted(this.muted);
    },
    update(dt, s) {
      const e = this._eng;
      if (e && e.ctx.state === 'running') e.update(dt, s || {});
    },
    play(name, o) {
      const e = this._eng;
      // A suspended context has a frozen clock: anything scheduled now would all fire at once on resume.
      if (e && e.ctx.state === 'running' && !this.muted) e.play(name, o || {});
    },

    // ---- dev/test hooks (used by dev/audio.html) ----
    _Engine: Engine,
    _renderOffline(name, seconds, o) {
      const sr = 44100, len = seconds || (DUR[name] || 1) + 0.4;
      const ctx = new OfflineAudioContext(2, Math.ceil(sr * len), sr);
      const eng = new Engine(ctx);
      eng.play(name, o || {});
      return ctx.startRendering();
    },
    // fn(t) -> state object for update(); steered every 0.1 s of rendered time.
    _renderBedsOffline(seconds, fn) {
      const sr = 44100, step = 0.1;
      const ctx = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr);
      const eng = new Engine(ctx);
      eng.startBeds();
      for (let k = 1; k * step < seconds; k++) {
        const tt = k * step;
        ctx.suspend(tt).then(() => { eng.update(step, fn(tt)); ctx.resume(); });
      }
      eng.update(step, fn(0));
      return ctx.startRendering();
    },
  });
})();
