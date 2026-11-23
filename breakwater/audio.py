"""The soundtrack, synthesised in NumPy from the same timeline that drives the picture.

No samples: every sound is oscillators and shaped noise. Continuous beds (rain on the canopy, the
bay, the reactor, the servo whine whose pitch follows the machine's walking effort, a slow D-minor
drone whose pulse rises with the threat) plus one-shots placed at the timeline's event times and
panned by where the thing is relative to the pilot's head.
"""
import wave
import numpy as np

SR = 44100


def _env(n, a=0.005, d=0.3, curve=1.0):
    """Attack / exponential-decay envelope, seconds."""
    t = np.arange(n) / SR
    return np.minimum(t / max(a, 1e-4), 1.0) * np.exp(-np.maximum(t - a, 0) / max(d, 1e-4)) ** curve


def _noise(n, seed):
    return np.random.default_rng(seed).standard_normal(n)


def _shape(x, gain_fn):
    """Filter by an arbitrary gain curve over frequency (zero phase, FFT domain)."""
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X * gain_fn(f), len(x))


def _band(f, lo, hi, soft=0.35):
    """Smooth band-pass gain between lo and hi Hz."""
    f = np.maximum(f, 1.0)
    return 1 / (1 + (lo / f) ** (2 / soft)) / (1 + (f / hi) ** (2 / soft))


def _tv_filter(x, gain_at, block=2048):
    """Time-varying filter: gain_at(t_seconds, freqs) -> gain, applied block by block with overlap-add."""
    hop = block // 2; win = np.hanning(block)
    pad = np.concatenate([np.zeros(hop), x, np.zeros(block)])
    out = np.zeros(len(pad)); f = np.fft.rfftfreq(block, 1 / SR)
    for i in range(0, len(pad) - block, hop):
        seg = pad[i:i + block] * win
        out[i:i + block] += np.fft.irfft(np.fft.rfft(seg) * gain_at((i - hop + block / 2) / SR, f), block)
    return out[hop:hop + len(x)]


def _osc(freq, kind='sine', phase0=0.0):
    """Oscillator from an instantaneous-frequency array."""
    ph = phase0 + 2 * np.pi * np.cumsum(freq) / SR
    if kind == 'sine': return np.sin(ph)
    if kind == 'saw': return 2 * ((ph / (2 * np.pi)) % 1.0) - 1
    if kind == 'square': return np.sign(np.sin(ph))
    raise ValueError(kind)


def _sweep(n, f0, f1, curve=1.0):
    return f0 * (f1 / f0) ** (np.linspace(0, 1, n) ** curve)


# ------------------------------------------------------------------ one-shots (mono arrays)
def step(seed):
    n = int(0.9 * SR)
    thud = _osc(_sweep(n, 62, 34), 'sine') * _env(n, 0.004, 0.16)
    crash = _shape(_noise(n, seed), lambda f: _band(f, 250, 3200)) * _env(n, 0.03, 0.22) * 0.16
    return thud * 0.8 + crash


def klaxon():
    n = int(1.5 * SR); t = np.arange(n) / SR
    gate = ((t % 0.72) < 0.5) * np.minimum(1, (t % 0.72) / 0.02) * np.minimum(1, (0.5 - (t % 0.72)).clip(0) / 0.03)
    x = _osc(np.full(n, 392.0), 'saw') * 0.5 + _osc(np.full(n, 466.0), 'saw') * 0.4 + _osc(np.full(n, 196.0), 'square') * 0.2
    return _shape(x, lambda f: _band(f, 250, 2600)) * gate * 0.55


def roar(dur=2.2, f_hi=96.0, f_lo=52.0, seed=1, breath=0.5):
    n = int(dur * SR); t = np.arange(n) / SR; r = np.random.default_rng(seed)
    jit = np.interp(t, np.linspace(0, dur, 60), r.standard_normal(60)) * 0.06
    f0 = _sweep(n, f_hi, f_lo, 0.7) * (1 + jit + 0.03 * np.sin(2 * np.pi * 11 * t))
    src = sum(_osc(f0 * k, 'saw', r.uniform(0, 6)) * w for k, w in ((1, 1.0), (1.007, 0.8), (0.5, 0.7), (1.5, 0.35), (2.01, 0.3)))
    src = src + _noise(n, seed + 1) * breath * 2.0
    def formants(tt, f):
        u = np.clip(tt / dur, 0, 1); open_ = np.sin(u * np.pi) ** 0.5
        f1 = 320 + 380 * open_; f2 = 900 + 700 * open_ - 300 * u; f3 = 2400 - 500 * u
        g = 0.05 + np.exp(-((f - f1) / 140) ** 2) * 1.6 + np.exp(-((f - f2) / 240) ** 2) * 1.1 + np.exp(-((f - f3) / 500) ** 2) * 0.5 + np.exp(-(f / 150) ** 2) * 1.2
        return g
    x = _tv_filter(src, formants)
    env = np.minimum(t / 0.12, 1) * np.minimum((dur - t) / (dur * 0.45), 1).clip(0) ** 1.4
    x = np.tanh(x * 0.6 * env * 2.2)
    return x * 0.8


def whoosh(dur=0.5, seed=3, lo=250.0, hi=1700.0):
    n = int(dur * SR)
    def g(tt, f):
        u = np.clip(tt / dur, 0, 1); fc = lo + (hi - lo) * np.sin(u * np.pi) ** 1.2
        return np.exp(-((np.log(np.maximum(f, 1)) - np.log(fc)) / 0.55) ** 2)
    x = _tv_filter(_noise(n, seed), g, 1024)
    servo = _osc(_sweep(n, 140, 420, 0.6), 'saw') * 0.05
    return (x * 0.5 + servo) * np.sin(np.linspace(0, np.pi, n)) ** 1.3


def impact(power=1.0, seed=5):
    n = int((0.9 + 0.5 * power) * SR)
    boom = _osc(_sweep(n, 70, 30), 'sine') * _env(n, 0.003, 0.22 + 0.1 * power)
    crack = _shape(_noise(n, seed), lambda f: _band(f, 900, 6500)) * _env(n, 0.001, 0.05) * 0.5
    wet = _shape(_noise(n, seed + 1), lambda f: _band(f, 180, 1400)) * _env(n, 0.02, 0.2) * 0.4
    return np.tanh((boom * 1.2 + crack + wet) * (0.9 + 0.4 * power))


def hull_hit(seed=7):
    n = int(1.4 * SR); t = np.arange(n) / SR
    clang = sum(np.sin(2 * np.pi * f * t + i) * np.exp(-t / d) * w for i, (f, d, w) in enumerate(((173, 0.5, 1.0), (437, 0.35, 0.7), (611, 0.3, 0.6), (893, 0.22, 0.5), (1380, 0.15, 0.4), (2210, 0.1, 0.25))))
    crunch = _shape(_noise(n, seed), lambda f: _band(f, 120, 2500)) * _env(n, 0.002, 0.12)
    beep = np.sin(2 * np.pi * 1320 * t) * (((t - 0.25) % 0.16) < 0.08) * (t > 0.25) * (t < 0.95) * 0.16
    return np.tanh(clang * 0.5 + crunch * 0.9) * 0.9 + beep


def charge(dur):
    n = int(dur * SR); u = np.linspace(0, 1, n)
    f = _sweep(n, 180, 1500, 1.4)
    x = _osc(f, 'sine') * 0.5 + _osc(f * 1.5, 'saw') * 0.12 + _osc(f * 0.5, 'sine') * 0.3
    return x * u ** 1.5 * 0.5 * (1 + 0.2 * np.sin(2 * np.pi * (8 + 30 * u) * u))


def cannon(seed=9):
    n = int(1.3 * SR)
    crack = _noise(n, seed) * _env(n, 0.0005, 0.035)
    drop = _osc(_sweep(n, 150, 30, 0.6), 'sine') * _env(n, 0.002, 0.3)
    zap = _shape(_osc(_sweep(n, 2600, 180, 0.5), 'saw'), lambda f: _band(f, 200, 5000)) * _env(n, 0.001, 0.12) * 0.5
    tail = _shape(_noise(n, seed + 1), lambda f: _band(f, 60, 900)) * _env(n, 0.05, 0.4) * 0.25
    return np.tanh(crack * 0.9 + drop * 1.2 + zap + tail)


def plasma_hit(seed=11):
    n = int(1.2 * SR)
    boom = _osc(_sweep(n, 90, 32), 'sine') * _env(n, 0.003, 0.3)
    sizzle = _shape(_noise(n, seed), lambda f: _band(f, 1800, 9000)) * _env(n, 0.01, 0.35) * 0.35
    return np.tanh(boom * 1.2 + sizzle + _shape(_noise(n, seed + 1), lambda f: _band(f, 150, 1500)) * _env(n, 0.002, 0.1) * 0.6)


def splash(dur=3.0, seed=13, sub=True):
    n = int(dur * SR); t = np.arange(n) / SR
    def g(tt, f): return _band(f, 120, 5200 * np.exp(-tt / (dur * 0.35)) + 500)
    x = _tv_filter(_noise(n, seed), g) * np.minimum(t / 0.06, 1) * np.exp(-t / (dur * 0.33))
    if sub: x = x + _osc(_sweep(n, 55, 28), 'sine') * _env(n, 0.01, 0.5) * 1.4
    return x * 0.6


def chime():
    n = int(1.1 * SR); t = np.arange(n) / SR
    a = np.sin(2 * np.pi * 587.3 * t) * np.exp(-t / 0.35); b = np.sin(2 * np.pi * 880.0 * t) * np.exp(-np.maximum(t - 0.11, 0) / 0.45) * (t > 0.11)
    return (a + b + 0.3 * np.sin(2 * np.pi * 1760 * t) * np.exp(-t / 0.2)) * 0.3


def thunder(seed=17):
    n = int(4.0 * SR); t = np.arange(n) / SR; r = np.random.default_rng(seed)
    amp = np.interp(t, np.linspace(0, 4, 40), np.abs(r.standard_normal(40))) * np.exp(-t / 1.4) * np.minimum(t / 0.05, 1)
    return _shape(_noise(n, seed), lambda f: _band(f, 25, 240)) * amp * 0.9


# ------------------------------------------------------------------ the mix
def render(sortie):
    """Return a (N, 2) float array in -1..1 and a list of (time, name) placements for the checker."""
    dur = sortie.duration; N = int(dur * SR) + SR // 2
    L = np.zeros(N); R = np.zeros(N); placed = []
    t = np.arange(N) / SR
    grid = np.linspace(0, dur, int(dur * 100) + 1)
    states = [sortie.state(g) for g in grid]
    curve = lambda fn: np.interp(t, grid, np.array([fn(s) for s in states]))

    def put(x, at, pan=0.0, gain=1.0, name=None):
        i = int(at * SR)
        if i >= N or i < 0: return
        x = x[:N - i] * gain
        l = np.cos((pan + 1) * np.pi / 4); r = np.sin((pan + 1) * np.pi / 4)
        L[i:i + len(x)] += x * l * 1.4142; R[i:i + len(x)] += x * r * 1.4142
        if name: placed.append((at, name))

    def pan_of(tt):
        """Where the creature sits in the stereo field, from the pilot's head yaw."""
        return float(np.clip(np.sin(sortie.camera(tt)['yaw']) * 1.2, -1, 1))

    # beds
    rain = _shape(_noise(N, 100), lambda f: _band(f, 1200, 9000, 0.6)) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.13 * t)) * 0.035
    rain_r = _shape(_noise(N, 101), lambda f: _band(f, 1200, 9000, 0.6)) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.11 * t + 1)) * 0.035
    rng = np.random.default_rng(102); patter = np.zeros(N)
    idx = rng.integers(0, N - 400, int(dur * 38))
    for i in idx: patter[i:i + 300] += _noise(300, int(i)) * np.exp(-np.arange(300) / 40.0) * rng.uniform(0.2, 1.0)
    patter = _shape(patter, lambda f: _band(f, 1500, 7000)) * 0.03
    ocean = _shape(_noise(N, 103), lambda f: _band(f, 20, 140)) * (0.6 + 0.4 * np.sin(2 * np.pi * 0.09 * t)) * 0.10
    charge_c = curve(lambda s: s['mech']['charge'])
    hum = (np.sin(2 * np.pi * 55 * t) + 0.5 * np.sin(2 * np.pi * 110.4 * t) + 0.25 * np.sin(2 * np.pi * 164.7 * t)) * (0.035 + 0.03 * charge_c)
    effort = curve(lambda s: s['mech']['effort'])
    servo = _shape(_osc(170 + 250 * effort, 'saw') * 0.5 + _osc(85 + 125 * effort, 'square') * 0.2, lambda f: _band(f, 150, 2400)) * effort ** 1.2 * 0.045
    threat = curve(lambda s: float(np.clip(1.2 - s['creature']['dist'] / 700.0, 0.0, 1.0)) * (1.0 if s['creature']['action'] != 'death' else max(0.0, 1 - s['creature']['t'] / 3.0)))
    threat = threat * (t > sortie.p['contact'])
    drone = np.zeros(N)
    for f0, w in ((73.42, 1.0), (110.0, 0.6), (146.83, 0.5), (174.61, 0.35), (220.0, 0.25)):          # D2 A2 D3 F3 A3
        for det in (-0.25, 0.0, 0.31): drone += _osc(np.full(N, f0 + det), 'saw', det * 9) * w
    drone = _shape(drone, lambda f: _band(f, 40, 520, 0.6)) * (0.5 + 0.5 * np.sin(2 * np.pi * 0.07 * t - 1.2)) * 0.012 * (0.7 + 0.8 * threat)
    beat = np.zeros(N); bpm = 104.0
    for k in range(int(dur * bpm / 60) + 1):
        tb = k * 60 / bpm; i = int(tb * SR)
        n = int(0.4 * SR)
        if i + n >= N: break
        hit = _osc(_sweep(n, 78 if k % 2 == 0 else 62, 40), 'sine') * _env(n, 0.004, 0.11)
        beat[i:i + n] += hit * (1.0 if k % 4 == 0 else 0.6)
    beat *= threat * 0.16
    bed = hum + servo + drone + beat + ocean + patter
    L += bed + rain; R += bed + rain_r

    # one-shots
    for at, kind, arg in sortie.events:
        c = sortie.creature(at); g = float(np.clip(1.15 - c['dist'] / 900.0, 0.25, 1.0)); pn = pan_of(at)
        if kind == 'step': put(step(int(at * 1000)), at, 0.3 * arg, 0.5, 'step')
        elif kind == 'klaxon': put(klaxon(), at, 0, 0.85, 'klaxon')
        elif kind == 'emerge': put(splash(2.6, 31), at, pn, 0.8 * g, 'emerge')
        elif kind == 'roar': put(roar(2.2, 98, 50, 41), at, pn, 0.95 * g, 'roar')
        elif kind == 'thunder': put(thunder(), at, -0.3, 0.6, 'thunder')
        elif kind == 'charge': put(charge(arg), at, 0.35, 0.5, 'charge')
        elif kind == 'cannon': put(cannon(), at, 0.3, 0.9, 'cannon')
        elif kind == 'plasma_hit': put(plasma_hit(), at, pn, 0.75 * g, 'plasma_hit'); put(roar(0.8, 120, 70, 43, 0.8), at + 0.05, pn, 0.5 * g)
        elif kind == 'growl': put(roar(0.75, 70, 48, 45, 0.3), at, pn, 0.7, 'growl')
        elif kind == 'whoosh_heavy': put(whoosh(0.5, 51, 120, 900), at, pn, 0.8, 'whoosh_heavy')
        elif kind == 'hull_hit': put(hull_hit(), at, 0, 1.0, 'hull_hit')
        elif kind == 'whoosh': put(whoosh(0.42, 53 + int(arg)), at, 0.45 * arg, 0.6, 'whoosh')
        elif kind == 'impact': put(impact(1.0, 61 + int(arg)), at, 0.3 * arg, 0.9, 'impact'); put(roar(0.5, 110, 80, 63, 0.9), at + 0.04, pn, 0.35)
        elif kind == 'slam': put(impact(2.0, 71), at, 0, 1.0, 'slam'); put(impact(1.2, 72), at + 0.07, 0, 0.6)
        elif kind == 'sync': put(chime(), at, 0, 0.5, 'sync')
        elif kind == 'death_bellow': put(roar(3.0, 84, 30, 81, 0.7), at, pn, 0.85, 'death_bellow')
        elif kind == 'big_splash': put(splash(3.6, 91), at, pn, 0.95, 'big_splash')
    mix = np.stack([L, R], 1)
    fade = np.clip(t / 0.6, 0, 1) * np.clip((dur - t) / 0.7, 0, 1)
    mix = np.tanh(mix * 1.15) / np.tanh(1.15) * fade[:, None]
    mix = mix / max(1e-9, np.abs(mix).max()) * 0.89
    return mix[:int(dur * SR)], placed


def write_wav(path, mix):
    pcm = (np.clip(mix, -1, 1) * 32767).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())


def read_wav(path):
    with wave.open(path, 'rb') as w:
        return np.frombuffer(w.readframes(w.getnframes()), '<i2').reshape(-1, w.getnchannels()).astype(np.float64) / 32767.0
