"""Everything between the path tracer and the encoder, in NumPy.

Per frame: denoise the 16-sample render with an edge-aware a-trous filter guided by the normal and
position passes, accumulate over time by reprojecting the previous frame through the position pass,
lay foam on the water, add distance haze from the same sky model that lights the scene, splat
spray / sparks / plasma as depth-tested sprites, bloom, upscale, then rain streaks, beads on the
canopy, lens falloff, tone curve, the head-up display in a hand-built stroke font, and grain.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from . import sky, EXPOSURE
from .noise import tile_fbm, sample_tile, hash2

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
_N1 = tile_fbm(256, seed=21).astype(np.float32)
_N2 = tile_fbm(256, seed=22).astype(np.float32)
PLASMA = np.array([0.35, 0.8, 1.0]); ICHOR = np.array([0.25, 1.0, 0.12])
SPRAY = np.array([0.085, 0.10, 0.125])


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


# ------------------------------------------------------------------ camera maths (from the per-frame sidecar)
class Cam:
    def __init__(self, meta, w, h):
        self.eye = np.array(meta['eye'], np.float64); self.r = np.array(meta['right']); self.u = np.array(meta['up']); self.f = np.array(meta['fwd'])
        self.th = meta['tan_half_fov']; self.w = w; self.h = h; self.aspect = w / h
        self.focal = (h / 2) / self.th                              # pixels per metre at 1 m

    def project(self, P):
        v = np.asarray(P, np.float64) - self.eye
        zc = v @ self.f
        zs = np.where(np.abs(zc) < 1e-6, 1e-6, zc)
        x = (v @ self.r) / zs * self.focal + self.w / 2
        y = self.h / 2 - (v @ self.u) / zs * self.focal
        return x, y, zc

    def rays(self):
        ys, xs = np.mgrid[0:self.h, 0:self.w].astype(np.float32)
        nx = (xs + 0.5 - self.w / 2) / self.focal; ny = (self.h / 2 - ys - 0.5) / self.focal
        d = self.f[None, None, :] + nx[..., None] * self.r + ny[..., None] * self.u
        return (d / np.linalg.norm(d, axis=-1, keepdims=True)).astype(np.float32)


# ------------------------------------------------------------------ small image ops
def _shift(a, dy, dx):
    """a shifted so out[y, x] = a[y + dy, x + dx], edges clamped."""
    h, w = a.shape[:2]
    ys = np.clip(np.arange(h) + dy, 0, h - 1); xs = np.clip(np.arange(w) + dx, 0, w - 1)
    return a[ys][:, xs]


def _box3(a):
    p = np.pad(a, ((1, 1), (1, 1)) + ((0, 0),) * (a.ndim - 2), mode='edge')
    h, w = a.shape[:2]
    return sum(p[i:i + h, j:j + w] for i in range(3) for j in range(3)) / 9.0


def _blur5(a):
    k = (1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16)
    h, w = a.shape[:2]
    p = np.pad(a, ((2, 2), (0, 0)) + ((0, 0),) * (a.ndim - 2), mode='edge'); a = sum(k[i] * p[i:i + h] for i in range(5))
    p = np.pad(a, ((0, 0), (2, 2)) + ((0, 0),) * (a.ndim - 2), mode='edge'); return sum(k[i] * p[:, i:i + w] for i in range(5))


def resize(a, w, h, mode=Image.BICUBIC):
    if a.ndim == 2: return np.asarray(Image.fromarray(a.astype(np.float32), 'F').resize((w, h), mode))
    return np.stack([np.asarray(Image.fromarray(np.ascontiguousarray(a[..., c]).astype(np.float32), 'F').resize((w, h), mode)) for c in range(a.shape[2])], -1)


# ------------------------------------------------------------------ denoise
def denoise(c, normal, pos, eye, sky_mask, iters=4):
    """Edge-avoiding a-trous wavelet filter (3x3 B-spline, holes doubling each pass)."""
    c = c.astype(np.float32)
    c = np.minimum(c, _box3(c) * 5.0 + 0.25)                                # fireflies
    lum = c @ LUMA
    m = _box3(lum); var = np.maximum(_box3(lum * lum) - m * m, 0)
    sig = 3.0 * np.sqrt(var) + 0.03 * m + 2e-3
    dist = np.linalg.norm(pos - eye.astype(np.float32), axis=-1)
    h, w = lum.shape
    out = c
    kern = [(-1, -1, 1), (-1, 0, 2), (-1, 1, 1), (0, -1, 2), (0, 1, 2), (1, -1, 1), (1, 0, 2), (1, 1, 1)]
    n0, n1, n2 = normal[..., 0], normal[..., 1], normal[..., 2]
    for i in range(iters):
        s = 1 << i
        pad = ((s, s), (s, s), (0, 0))
        pc = np.pad(out, pad, mode='edge'); pn = np.pad(normal, pad, mode='edge'); pp = np.pad(pos, pad, mode='edge')
        l0 = out @ LUMA; pl = np.pad(l0, pad[:2], mode='edge')
        inv_sig = 1.0 / sig; inv_plane = 1.0 / (0.012 * dist * s + 0.06)
        acc = out * 4.0; ws = np.full((h, w), 4.0, np.float32)
        for dy, dx, kw in kern:
            sl = (slice(s + dy * s, s + dy * s + h), slice(s + dx * s, s + dx * s + w))
            nn = pn[sl]; pq = pp[sl]
            wn = np.clip(n0 * nn[..., 0] + n1 * nn[..., 1] + n2 * nn[..., 2], 0, 1)
            wn = wn * wn; wn = wn * wn; wn = wn * wn; wn = wn * wn * wn                    # ^24
            dp = np.abs((pq[..., 0] - pos[..., 0]) * n0 + (pq[..., 1] - pos[..., 1]) * n1 + (pq[..., 2] - pos[..., 2]) * n2) * inv_plane
            wgt = (kw * wn * np.exp(-np.abs(pl[sl] - l0) * inv_sig - dp)).astype(np.float32)
            acc += pc[sl] * wgt[..., None]; ws += wgt
        out = acc / ws[..., None]
        sig = sig * 0.7
    out[sky_mask] = c[sky_mask]
    return out


def temporal(cur, pos, cam, prev, alpha=0.7):
    """Blend with the previous output where the same world point was visible there. prev = (image, pos, Cam)."""
    if prev is None: return cur
    pimg, ppos, pcam = prev
    x, y, zc = pcam.project(pos.astype(np.float64))
    h, w = cur.shape[:2]
    ok = (zc > 0.5) & (x >= 0) & (x < w - 1) & (y >= 0) & (y < h - 1)
    xi = np.clip(np.floor(x), 0, w - 2).astype(np.int32); yi = np.clip(np.floor(y), 0, h - 2).astype(np.int32)
    fx = (x - xi).astype(np.float32)[..., None]; fy = (y - yi).astype(np.float32)[..., None]
    samp = pimg[yi, xi] * (1 - fx) * (1 - fy) + pimg[yi, xi + 1] * fx * (1 - fy) + pimg[yi + 1, xi] * (1 - fx) * fy + pimg[yi + 1, xi + 1] * fx * fy
    pp = ppos[np.clip(np.round(y), 0, h - 1).astype(np.int32), np.clip(np.round(x), 0, w - 1).astype(np.int32)]
    dist = np.linalg.norm(pos - cam.eye.astype(np.float32), axis=-1)
    ok &= np.linalg.norm(pp - pos, axis=-1) < (0.004 * dist + 0.08)
    a = np.where(ok, alpha, 0.0).astype(np.float32)
    a = np.where(np.abs(pos[..., 2]) < 0.3, a * 0.75, a)                     # moving water keeps less history
    return cur * (1 - a[..., None]) + samp * a[..., None]


# ------------------------------------------------------------------ water dressing
def foam(col, pos, water, blobs, t, height_grid, glow=None):
    """blobs: list of (x, y, radius, strength). glow: (x, y, radius, rgb) coloured light on the water."""
    if not water.any(): return col
    x = pos[..., 0][water].astype(np.float64); y = pos[..., 1][water].astype(np.float64)
    n1 = sample_tile(_N1, x / 23.0 + t * 0.012, y / 23.0); n2 = sample_tile(_N2, x / 7.0, y / 7.0 - t * 0.02)
    f = np.zeros_like(x)
    xs, ys, H = height_grid
    gx = (x - xs[0]) / (xs[1] - xs[0]); gy = (y - ys[0]) / (ys[1] - ys[0])
    inside = (gx >= 0) & (gx < len(xs) - 1) & (gy >= 0) & (gy < len(ys) - 1)
    xi = np.clip(gx.astype(int), 0, len(xs) - 2); yi = np.clip(gy.astype(int), 0, len(ys) - 2); fx = gx - xi; fy = gy - yi
    hh = H[yi, xi] * (1 - fx) * (1 - fy) + H[yi, xi + 1] * fx * (1 - fy) + H[yi + 1, xi] * (1 - fx) * fy + H[yi + 1, xi + 1] * fx * fy
    depth = np.where(inside, -hh, 22.0)
    wash = np.sin(depth * 1.3 - t * 1.1 + n1 * 6.0) * 0.5 + 0.5
    f += inside * smooth(2.6, 0.2, depth - n1 * 1.4) * (0.45 + 0.55 * wash)
    for bx, by, br, bs in blobs:
        if bs <= 0: continue
        d = np.hypot(x - bx, y - by)
        ring = smooth(br * 1.5, br * 0.55, d) * bs
        f += ring * smooth(0.30, 0.62, n1 * 0.6 + n2 * 0.4 + ring * 0.35)
    f = np.clip(f, 0, 1) * (0.55 + 0.45 * n2)
    c = col[water]
    c = c * (1 - f[:, None]) + np.array([0.070, 0.085, 0.110], np.float32) * f[:, None]
    if glow is not None and glow[2] > 0:
        d2 = (x - glow[0]) ** 2 + (y - glow[1]) ** 2
        c = c + np.asarray(glow[3], np.float32) * (np.exp(-d2 / (glow[2] ** 2)) * (0.35 + 0.65 * f))[:, None]
    col = col.copy(); col[water] = c
    return col


# ------------------------------------------------------------------ sprites
def splat(img, dist, cam, sprites):
    """sprites: list of dicts(p, size, col, a, add, soft). Depth-tested against the scene distance map."""
    h, w = img.shape[:2]
    order = sorted(sprites, key=lambda s: -float(np.linalg.norm(np.asarray(s['p']) - cam.eye)))
    for s in order:
        x, y, zc = cam.project(np.asarray(s['p'], np.float64))
        if zc < 3.0: continue
        r = s['size'] * 0.5 * cam.focal / zc
        if r < 0.35 or r > 2.5 * w: continue
        x0 = int(max(0, np.floor(x - r))); x1 = int(min(w, np.ceil(x + r) + 1)); y0 = int(max(0, np.floor(y - r))); y1 = int(min(h, np.ceil(y + r) + 1))
        if x1 <= x0 or y1 <= y0: continue
        yy, xx = np.mgrid[y0:y1, x0:x1]
        r2 = ((xx - x) ** 2 + (yy - y) ** 2) / (r * r)
        a = np.clip(1 - r2, 0, 1) ** 2
        if s.get('noise', 0) and r > 3:
            a = a * smooth(0.18, 0.72, sample_tile(_N1, (xx - x) / (r * 4.8) + s['noise'], (yy - y) / (r * 4.8)) * 0.9 + a * 0.55)
        d = float(np.linalg.norm(np.asarray(s['p']) - cam.eye))
        a = a * np.clip((dist[y0:y1, x0:x1] - d) / s.get('soft', 6.0) + 0.15, 0, 1) * s.get('a', 1.0)
        if r < 1.0: a = a * r * r
        c = np.asarray(s['col'], np.float32)
        if s.get('add', True): img[y0:y1, x0:x1] += c * a[..., None].astype(np.float32)
        else: img[y0:y1, x0:x1] = img[y0:y1, x0:x1] * (1 - a[..., None]) + c * a[..., None]
    return img


def _burst(seed, n):
    r = np.random.default_rng(seed)
    az = r.uniform(0, 2 * np.pi, n); el = r.uniform(-0.3, 1.3, n)
    d = np.stack([np.cos(az) * np.cos(el), np.sin(az) * np.cos(el), np.sin(el)], 1)
    return d, r.random((n, 4))


def particles(sortie, st, meta, fog_eye):
    """All sprites alive at time st['t'], as closed-form functions of their age."""
    t = st['t']; out = []; p = sortie.p
    cx_at = lambda tt: sortie.creature(tt)
    def chest(tt):
        c = cx_at(tt); return np.array([c['x'] + 15.0, c['y'], 37.0])
    def ball(t0, origin, n, seed, speed, life, size, col, grav=30.0, drag=0.6, add=True, a=1.0, bias=(0, 0, 0), soft=5.0, grow=0.0, noise=False):
        age = t - t0
        if age < 0 or age > life * 1.6: return
        d, rr = _burst(seed, n)
        v = d * (speed * (0.35 + 0.65 * rr[:, [0]])) + np.asarray(bias, float)
        lf = life * (0.5 + rr[:, 1])
        k = (1 - np.exp(-drag * age)) / drag
        pos = np.asarray(origin, float) + v * k + np.array([0, 0, -0.5 * grav * age * age * np.exp(-drag * age * 0.5)])
        for i in range(n):
            u = age / lf[i]
            if u >= 1 or pos[i, 2] < -1: continue
            fade = min(1.0, u * 12) * (1 - u) * (1 - u * u) * 1.6
            out.append(dict(p=pos[i], size=size * (0.6 + 0.8 * rr[i, 2]) * (1 + grow * u), col=col, a=a * fade, add=add, soft=soft, noise=rr[i, 3] if noise else 0))
    # the wake while it swims in, and the water it sheds as it rises
    for k in range(int(max(0, (min(t, p['emerge']) - 0.0) / 0.12)) + 1):
        t0 = k * 0.12
        if t - t0 > 3.0 or t0 > t: continue
        c = cx_at(t0)
        ball(t0, (c['x'], c['y'], 2.0), 2, 1000 + k, 6.0, 2.6, 22.0, SPRAY, grav=2.0, drag=0.5, add=False, a=0.30, soft=14, grow=1.6, noise=True)
    e0 = p['emerge']; ce = cx_at(e0)
    ball(e0, (ce['x'], ce['y'], 2.0), 70, 11, 46.0, 2.6, 13.0, SPRAY * 1.3, grav=22, drag=0.5, add=False, a=0.6, soft=9, grow=1.3, noise=True, bias=(0, 0, 22))
    ball(e0, (ce['x'], ce['y'], 5.0), 22, 12, 12.0, 4.5, 46.0, SPRAY, grav=0.5, drag=0.4, add=False, a=0.30, soft=22, grow=1.4, noise=True)
    for k in range(22):
        t0 = e0 + 0.1 + k * 0.11
        ball(t0, (ce['x'], ce['y'], 8 + 34 * min(1, (t0 - e0) / 2.4)), 4, 300 + k, 13.0, 1.5, 8.0, SPRAY * 1.2, grav=16, drag=0.2, add=False, a=0.42, soft=8, grow=1.0, noise=True)
    # cannon: muzzle flash, the bolt, its impact
    mz = np.array(meta['muzzle'])
    if st['mech']['charge'] > 0.02:
        ch = st['mech']['charge']
        out.append(dict(p=mz, size=4 + ch * 13, col=PLASMA * 5 * ch, a=1.0, soft=3))
    b = st['bolt']
    if b is not None:
        tgt = chest(sortie.impact_t)
        for k, back in enumerate(np.linspace(0, 0.16, 9)):
            q = max(0.0, b - back)
            pos = mz + (tgt - mz) * q
            out.append(dict(p=pos, size=(15 if k == 0 else 9 * (1 - back * 4)), col=PLASMA * (9 if k == 0 else 3.5 * (1 - back * 5)), a=1.0, soft=5))
    ball(sortie.fire_t, mz, 1, 21, 0.0, 0.12, 60.0, PLASMA * 8, grav=0, soft=20)
    ti = sortie.impact_t; ci = chest(ti)
    ball(ti, ci, 1, 31, 0.0, 0.32, 150.0, PLASMA * 9, grav=0, soft=40)
    ball(ti, ci, 34, 32, 80.0, 0.9, 5.0, PLASMA * 5, grav=18, drag=1.2)
    ball(ti, ci, 26, 33, 46.0, 1.6, 4.0, ICHOR * 3.2, grav=30, drag=0.4, bias=(18, 0, 10))
    ball(ti, ci, 8, 34, 14.0, 3.0, 34.0, SPRAY * 0.9, grav=0, drag=0.6, add=False, a=0.4, soft=14, grow=1.6, noise=True)
    # the swipe across the canopy: sparks a few metres from the eye
    eye = np.array(meta['eye']); fw = np.array(meta['fwd']); rt = np.array(meta['right'])
    ball(sortie.swipe_hit, eye + fw * 11 + rt * 2 - np.array([0, 0, 1.5]), 34, 41, 30.0, 0.8, 0.22, np.array([5.0, 2.8, 0.6]), grav=30, drag=0.8, soft=1.5, bias=tuple(-fw * 10))
    ball(sortie.swipe_hit, eye + fw * 12, 1, 42, 0.0, 0.14, 12.0, np.array([4.0, 2.4, 1.0]), grav=0, soft=4)
    # fists and the hammer
    for th, seed, pw, off in ((sortie.hit_l, 51, 1.0, 5.0), (sortie.hit_r, 52, 1.0, -5.0), (sortie.slam_hit, 53, 2.4, 0.0)):
        c = chest(th) + np.array([0, off, 6.0 if pw < 2 else 2.0])
        ball(th, c, 1, seed, 0.0, 0.2, 34.0 * pw, ICHOR * 5 + 2.0, grav=0, soft=14)
        ball(th, c, int(22 * pw), seed + 100, 42.0 * (0.8 + 0.3 * pw), 1.5, 3.0, ICHOR * 3.2, grav=30, drag=0.4, bias=(26, 0, 12))
        ball(th, c, int(12 * pw), seed + 200, 70.0, 0.8, 0.9, np.array([5.0, 2.6, 0.5]), grav=40, drag=0.8, bias=(20, 0, 8))
        ball(th, c, int(5 * pw), seed + 300, 12.0, 2.2, 26.0, np.array([0.06, 0.16, 0.07]), grav=0, drag=0.8, add=False, a=0.4, soft=10, grow=1.5, noise=True)
    # the body going into the bay
    ts = sortie.splash_t; cs = cx_at(ts)
    ball(ts, (cs['x'] + 30, cs['y'], 2.0), 110, 61, 62.0, 3.2, 17.0, SPRAY * 1.3, grav=22, drag=0.45, add=False, a=0.62, soft=10, grow=1.4, noise=True, bias=(10, 0, 30))
    ball(ts, (cs['x'] + 30, cs['y'], 6.0), 34, 62, 20.0, 5.5, 70.0, SPRAY, grav=0.5, drag=0.35, add=False, a=0.32, soft=28, grow=1.5, noise=True)
    # haze swallows distant sprites like everything else
    for s in out:
        f = float(sky.fog_amount(fog_eye, np.asarray(s['p'], float)))
        if s.get('add', True): s['col'] = np.asarray(s['col']) * (1 - f)
        else:
            d = np.asarray(s['p'], float) - fog_eye
            s['col'] = np.asarray(s['col']) * (1 - f) + sky.fog_color(d / np.linalg.norm(d)) * f
    return out


def foam_blobs(sortie, st):
    t = st['t']; m = st['mech']; c = st['creature']; p = sortie.p; blobs = []
    blobs.append((m['x'], m['y'] + 11, 24.0, 0.6 + 0.6 * m['effort'])); blobs.append((m['x'], m['y'] - 11, 24.0, 0.6 + 0.6 * m['effort']))
    if c['action'] == 'death': s = 1.3 * (1 - smooth(3.0, 6.0, c['t']))
    else: s = {'swim': 1.25, 'emerge': 1.5}.get(c['action'], 0.95)
    blobs.append((c['x'], c['y'], 44.0 if c['action'] != 'swim' else 52.0, s))
    if c['action'] == 'swim':                                              # the wake it leaves
        for k in range(1, 9):
            cc = sortie.creature(t - k * 0.35); blobs.append((cc['x'], cc['y'], 40.0 + k * 3, max(0.0, 1.0 - k * 0.12)))
    for t0, r0 in ((p['emerge'], 110.0), (sortie.splash_t, 140.0), (sortie.slam_hit, 60.0)):
        age = t - t0
        if 0 <= age < 3.4:
            cc = sortie.creature(t0); blobs.append((cc['x'] + (30 if r0 > 120 else 0), cc['y'], r0 * (0.5 + age * 0.35), max(0.0, 1.4 - age * 0.45)))
    return blobs


# ------------------------------------------------------------------ lens
def bloom(img, threshold=0.9, strength=0.8, levels=5):
    l = img.max(axis=-1)
    src = np.minimum(img, 60.0) * smooth(threshold, threshold * 2.2, l)[..., None]
    pyr = []
    cur = src
    for _ in range(levels):
        h, w = cur.shape[:2]; h2, w2 = h // 2 * 2, w // 2 * 2
        cur = cur[:h2, :w2].reshape(h2 // 2, 2, w2 // 2, 2, 3).mean(axis=(1, 3))
        cur = _blur5(cur); pyr.append(cur)
    acc = pyr[-1]
    for lv in reversed(pyr[:-1]):
        up = np.repeat(np.repeat(acc, 2, axis=0), 2, axis=1)
        up = np.pad(up, ((0, max(0, lv.shape[0] - up.shape[0])), (0, max(0, lv.shape[1] - up.shape[1])), (0, 0)), mode='edge')[:lv.shape[0], :lv.shape[1]]
        acc = lv + _blur5(up)
    h, w = img.shape[:2]
    return resize(acc / levels, w, h, Image.BILINEAR) * strength


def canopy_drops(h, w, t):
    """Refraction offsets (dy, dx in pixels) from beads of rain on the glass."""
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    oy = np.zeros((h, w), np.float32); ox = np.zeros((h, w), np.float32)
    for scale, tm, amp in ((9.0, 1.0, 1.0), (21.0, 1.3, 0.7)):
        gx = xs / h * scale; gy = ys / h * scale
        ix = np.floor(gx); iy = np.floor(gy)
        hh = hash2(ix, iy, 5).astype(np.float32); h2 = hash2(ix + 17, iy + 3, 6).astype(np.float32)
        life = (t * tm * 0.06 * (0.5 + h2) + hh * 9.0) % 1.0
        cx = (h2 - 0.5) * 0.5; cy = (np.modf(hh * 13.7)[0] - 0.5) * 0.5 + life * life * 0.35 * (hh > 0.8)
        r = 0.05 + 0.11 * np.modf(hh * 7.1)[0]
        dx = gx - ix - 0.5 - cx; dy = gy - iy - 0.5 - cy
        m = smooth(r, r * 0.25, np.hypot(dx, dy)) * smooth(0.0, 0.08, life) * smooth(1.0, 0.75, life) * (hh > 0.80)
        ox -= dx * m / scale * 1.1 * h * amp; oy -= dy * m / scale * 1.1 * h * amp
    return oy, ox


# ------------------------------------------------------------------ head-up display
_G = {
    'A': [[(0, 0), (0, 4), (2, 6), (4, 4), (4, 0)], [(0, 2), (4, 2)]], 'B': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (0, 0)]],
    'C': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1)]], 'D': [[(0, 0), (0, 6), (2, 6), (4, 4), (4, 2), (2, 0), (0, 0)]],
    'E': [[(4, 6), (0, 6), (0, 0), (4, 0)], [(0, 3), (3, 3)]], 'F': [[(4, 6), (0, 6), (0, 0)], [(0, 3), (3, 3)]],
    'G': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 3), (2, 3)]], 'H': [[(0, 0), (0, 6)], [(4, 0), (4, 6)], [(0, 3), (4, 3)]],
    'I': [[(1, 0), (3, 0)], [(2, 0), (2, 6)], [(1, 6), (3, 6)]], 'J': [[(0, 1), (1, 0), (3, 0), (4, 1), (4, 6)]], 'K': [[(0, 0), (0, 6)], [(4, 6), (0, 3), (4, 0)]],
    'L': [[(0, 6), (0, 0), (4, 0)]], 'M': [[(0, 0), (0, 6), (2, 3), (4, 6), (4, 0)]], 'N': [[(0, 0), (0, 6), (4, 0), (4, 6)]],
    'O': [[(1, 0), (0, 1), (0, 5), (1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0)]], 'P': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)]],
    'Q': [[(1, 0), (0, 1), (0, 5), (1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0)], [(2, 2), (4, 0)]],
    'R': [[(0, 0), (0, 6), (3, 6), (4, 5), (4, 4), (3, 3), (0, 3)], [(2, 3), (4, 0)]],
    'S': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]], 'T': [[(0, 6), (4, 6)], [(2, 6), (2, 0)]],
    'U': [[(0, 6), (0, 1), (1, 0), (3, 0), (4, 1), (4, 6)]], 'V': [[(0, 6), (2, 0), (4, 6)]], 'W': [[(0, 6), (1, 0), (2, 3), (3, 0), (4, 6)]],
    'X': [[(0, 0), (4, 6)], [(0, 6), (4, 0)]], 'Y': [[(0, 6), (2, 3), (4, 6)], [(2, 3), (2, 0)]], 'Z': [[(0, 6), (4, 6), (0, 0), (4, 0)]],
    '0': [[(1, 0), (0, 1), (0, 5), (1, 6), (3, 6), (4, 5), (4, 1), (3, 0), (1, 0)], [(1, 1), (3, 5)]], '1': [[(1, 5), (2, 6), (2, 0)], [(1, 0), (3, 0)]],
    '2': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (0, 0), (4, 0)]], '3': [[(0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3)], [(3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '4': [[(3, 0), (3, 6), (0, 2), (4, 2)]], '5': [[(4, 6), (0, 6), (0, 3), (3, 3), (4, 2), (4, 1), (3, 0), (1, 0), (0, 1)]],
    '6': [[(4, 5), (3, 6), (1, 6), (0, 5), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2), (3, 3), (0, 3)]], '7': [[(0, 6), (4, 6), (1, 0)]],
    '8': [[(1, 3), (0, 4), (0, 5), (1, 6), (3, 6), (4, 5), (4, 4), (3, 3), (1, 3), (0, 2), (0, 1), (1, 0), (3, 0), (4, 1), (4, 2), (3, 3)]],
    '9': [[(0, 1), (1, 0), (3, 0), (4, 1), (4, 5), (3, 6), (1, 6), (0, 5), (0, 4), (1, 3), (4, 3)]],
    '-': [[(1, 3), (3, 3)]], '.': [[(2, 0), (2, 0.6)]], ':': [[(2, 1), (2, 1.6)], [(2, 4), (2, 4.6)]], '/': [[(0, 0), (4, 6)]],
    '%': [[(0, 0), (4, 6)], [(0, 5), (1, 6)], [(3, 0), (4, 1)]], ' ': [],
}


def text_width(s, size, track=1.0): return len(s) * size * (5.4 / 6.0) * track - size * (1.4 / 6.0)


def draw_text(d, x, y, s, size, col, width=2, track=1.0, align='l'):
    """Stroke text. (x, y) is the top-left of the cap height; size is the cap height in pixels."""
    if align == 'c': x -= text_width(s, size, track) / 2
    elif align == 'r': x -= text_width(s, size, track)
    u = size / 6.0
    for ch in s.upper():
        for poly in _G.get(ch, _G['-']):
            pts = [(x + px * u, y + (6 - py) * u) for px, py in poly]
            if len(pts) > 1: d.line(pts, fill=col, width=width, joint='curve')
        x += size * (5.4 / 6.0) * track


def hud(w, h, sortie, st, cam, meta):
    """The instrument layer as an RGB float image (premultiplied light, added over the picture)."""
    im = Image.new('RGB', (w, h), (0, 0, 0)); d = ImageDraw.Draw(im)
    u = h / 1080.0
    OR = (255, 90, 46); INK = (232, 238, 242); DIM = (120, 132, 142); CY = (127, 220, 240); AL = (255, 51, 39); YL = (255, 210, 60)
    m = st['mech']; c = st['creature']; hd = st['hud']; p = sortie.p; t = st['t']
    L = lambda v: int(round(v * u))
    # identity, crew
    draw_text(d, L(40), L(36), 'SF-07 WARDEN', L(22), OR, L(3))
    draw_text(d, L(40), L(72), 'WAVE 1' if t >= p['contact'] else 'STANDBY', L(40), INK, L(4))
    for i, (lab, col) in enumerate((('PORT - P1', OR), ('STBD - P2', CY))):
        x0 = L(40 + i * 178); d.rectangle([x0, L(128), x0 + L(164), L(156)], outline=col, width=L(2)); draw_text(d, x0 + L(12), L(136), lab, L(12), col, L(2))
    # compass
    yaw = np.arctan2(cam.f[0], cam.f[1]); brg = np.degrees(yaw) % 360
    cx = w / 2; cy = L(46); cw = L(520); span = 110.0
    for deg in range(int(np.ceil((brg - span / 2) / 5) * 5), int(brg + span / 2) + 1, 5):
        x = cx + (deg - brg) / span * cw; dd = deg % 360; major = dd % 15 == 0
        d.line([(x, cy - L(8 if major else 4)), (x, cy + L(8 if major else 4))], fill=DIM, width=L(2))
        if dd % 45 == 0: draw_text(d, x, cy + L(16), ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][dd // 45], L(13), INK, L(2), align='c')
    d.polygon([(cx, cy - L(12)), (cx - L(7), cy - L(22)), (cx + L(7), cy - L(22))], outline=OR)
    draw_text(d, cx, cy - L(44), '%03d' % int(round(brg)) , L(13), OR, L(2), align='c')
    # city
    draw_text(d, w - L(40), L(36), 'CITY 100%', L(22), INK, L(3), align='r')
    d.rectangle([w - L(300), L(70), w - L(40), L(78)], fill=INK)
    # hull, reactor
    for i, (lab, val, col) in enumerate((('HULL', m['hull'], OR if m['hull'] > 0.3 else AL), ('REACTOR', m['reactor'], CY))):
        y0 = h - L(150 - i * 62)
        draw_text(d, L(40), y0, lab, L(12), DIM, L(2)); draw_text(d, L(300), y0 - L(12), '%d' % round(val * 100), L(26), INK, L(3), align='r')
        d.rectangle([L(40), y0 + L(22), L(300), y0 + L(30)], outline=DIM, width=1)
        d.rectangle([L(40), y0 + L(22), L(40) + L(260 * np.clip(val, 0, 1)), y0 + L(30)], fill=col)
    # arm status
    for i, (lab, arm) in enumerate((('PORT', m['L'][0]), ('STBD', m['R'][0]))):
        x0 = w - L(40 + (2 - i) * 104) + L(8); act = arm in ('punch', 'slam', 'fire'); chg = arm in ('charge', 'block')
        col = OR if act else CY if chg else DIM
        if act or chg: d.rectangle([x0, h - L(110), x0 + L(92), h - L(76)], fill=col); draw_text(d, x0 + L(46), h - L(100), lab, L(13), (5, 8, 11), L(2), align='c')
        else: d.rectangle([x0, h - L(110), x0 + L(92), h - L(76)], outline=col, width=L(2)); draw_text(d, x0 + L(46), h - L(100), lab, L(13), col, L(2), align='c')
    draw_text(d, w - L(40), h - L(56), 'CREW SYNC %d%%' % round(100 * (0.42 + 0.3 * smooth(sortie.hit_l, sortie.slam_hit, t) + 0.28 * smooth(sortie.slam_hit, sortie.slam_hit + 0.3, t))), L(12), DIM, L(2), align='r')
    # reticle and cannon charge
    rx, ry = w / 2, h / 2
    for a, b in (((-22, 0), (-8, 0)), ((8, 0), (22, 0)), ((0, -22), (0, -8)), ((0, 8), (0, 22))):
        d.line([(rx + L(a[0]), ry + L(a[1])), (rx + L(b[0]), ry + L(b[1]))], fill=DIM, width=L(2))
    if m['charge'] > 0.01: d.arc([rx - L(36), ry - L(36), rx + L(36), ry + L(36)], -90, -90 + 360 * m['charge'], fill=CY, width=L(5))
    # target lock
    if hd['lock'] > 0.02 and c['hp'] >= 0:
        tgt = np.array(meta['chest']) if c['surfaced'] else np.array([c['x'], c['y'], 6.0])
        x, y, zc = cam.project(tgt)
        if zc > 1:
            s = float(np.clip(46.0 * cam.focal / max(c['dist'], 30.0) * 0.5, L(26), h * 0.36)); s *= 1.0 + 1.6 * (1 - hd['lock'])
            q = s * 0.3; col = tuple(int(v * hd['lock']) for v in OR)
            x = float(np.clip(x, s + 4, w - s - 4)); y = float(np.clip(y, s + L(60), h - s - L(60)))
            for ax, ay in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                d.line([(x + ax * s, y + ay * s - ay * q), (x + ax * s, y + ay * s), (x + ax * s - ax * q, y + ay * s)], fill=col, width=L(3))
            draw_text(d, x - s, y - s - L(26), '%s  %d M' % (p['callsign'] if c['surfaced'] else 'CONTACT', round(c['dist'])), L(14), col, L(2))
            d.rectangle([x - s, y + s + L(10), x + s, y + s + L(16)], fill=(50, 54, 58)); d.rectangle([x - s, y + s + L(10), x - s + 2 * s * c['hp'], y + s + L(16)], fill=col)
    # banners
    if hd['banner']:
        main, sub, a = hd['banner']
        draw_text(d, w / 2, L(215), main, L(58), tuple(int(v * a) for v in INK), L(7), track=1.0, align='c')
        draw_text(d, w / 2, L(298), sub, L(17), tuple(int(v * a) for v in OR), L(3), track=1.25, align='c')
    glow = im.filter(ImageFilter.GaussianBlur(L(7)))
    core = im.filter(ImageFilter.GaussianBlur(0.7 * u))
    out = (np.asarray(core, np.float32) + np.asarray(glow, np.float32) * 0.55) / 255.0
    out *= hd['boot'] * (0.86 + 0.14 * np.sin(t * 50.0) * hd['glitch'])
    if hd['glitch'] > 0.05:                                                       # torn scan lines after the hit
        rng = np.random.default_rng(int(t * 24) + 7)
        for _ in range(int(10 * hd['glitch'])):
            y0 = int(rng.integers(0, h - 12)); out[y0:y0 + int(rng.integers(3, 12))] = np.roll(out[y0:y0 + 12][:int(rng.integers(3, 12))], int(rng.integers(-60, 60) * u), axis=1)
    return out


# ------------------------------------------------------------------ the frame
def grade_frame(passes, meta, sortie, prev, height_grid, out_size=(1920, 1080)):
    """passes: dict from bl.read_exr. Returns (uint8 RGB image at out_size, state for the next frame)."""
    t = meta['t']; st = sortie.state(t)
    rgb = passes['rgb']; h, w = rgb.shape[:2]
    cam = Cam(meta, w, h)
    pos = passes['pos'].astype(np.float32); nrm = passes['normal'].astype(np.float32)
    emit = passes.get('emit'); emit = np.zeros_like(rgb) if emit is None else emit
    dist = np.linalg.norm(pos - cam.eye.astype(np.float32), axis=-1)
    skym = (passes['depth'] > 1e8) | ~np.isfinite(dist) | (dist > 5e4)
    dist = np.where(skym, 1e6, dist).astype(np.float32)
    # 1. clean up the path tracer's noise
    raw = np.maximum(rgb - emit, 0)
    water = (~skym) & (np.abs(pos[..., 2]) < 0.35) & (nrm[..., 2] > 0.5)
    c = denoise(raw, nrm, pos, cam.eye, skym)
    c[water] = c[water] * 0.2 + np.minimum(raw, _box3(raw) * 4.0 + 0.2)[water] * 0.8      # keep the ripples the filter cannot see in the normal pass
    c = temporal(c, pos, cam, prev, alpha=0.7 * (1 - min(1.0, st['flash'] * 4)))
    keep = (c.copy(), pos, cam)
    col = c + emit
    # 2. the water's surface
    cr = st['creature']
    glow = (cr['x'], cr['y'], 95.0, ICHOR * 0.020 * cr['glow']) if cr['glow'] > 0 else None
    col = foam(col, pos, water, foam_blobs(sortie, st), t, height_grid, glow)
    # 3. air
    rays = cam.rays()
    f = np.where(skym, 0.0, sky.fog_amount(cam.eye, pos.astype(np.float64))).astype(np.float32)
    fc = sky.fog_color(rays[::4, ::4].astype(np.float64), st['flash']).astype(np.float32)
    fc = resize(fc, w, h, Image.BILINEAR)
    col = col * (1 - f[..., None]) + fc * f[..., None]
    # 4. spray, sparks, plasma
    col = splat(col.astype(np.float32), dist, cam, particles(sortie, st, meta, cam.eye))
    # 5. glow of bright things
    col = col + bloom(col)
    # 6. up to delivery size; the rest is on the glass and in the lens
    W, H = out_size
    big = np.maximum(resize(col, W, H, Image.BICUBIC), 0)
    rain = Image.new('L', (W, H), 0); rd = ImageDraw.Draw(rain)
    rng = np.random.default_rng(99)
    n = 520; rx = rng.random(n); ry = rng.random(n); rs = 0.9 + rng.random(n) * 1.3; rl = 14 + rng.random(n) * 34; rb = rng.integers(40, 150, n)
    slant = 0.26 + 0.5 * st['mech']['effort']
    for i in range(n):
        y = ((ry[i] + t * rs[i]) % 1.0) * (H + 80) - 40; x = (rx[i] * 1.3 - 0.15 + (y / H) * slant * 0.2) * W
        rd.line([(x, y), (x - rl[i] * slant, y - rl[i])], fill=int(rb[i]), width=1)
    big += (np.asarray(rain.filter(ImageFilter.GaussianBlur(0.6)), np.float32) / 255.0)[..., None] * np.array([0.050, 0.060, 0.074], np.float32) * (1 + st['flash'] * 5)
    oy, ox = canopy_drops(H // 2, W // 2, t)                                       # beads are soft; half resolution is plenty
    oy = np.repeat(np.repeat(oy, 2, 0), 2, 1) * 2; ox = np.repeat(np.repeat(ox, 2, 0), 2, 1) * 2
    ys, xs = np.mgrid[0:H, 0:W]
    sy = np.clip(ys + oy, 0, H - 1).astype(np.int32); sx = np.clip(xs + ox, 0, W - 1).astype(np.int32)
    big = big[sy, sx]
    hit = st['hud']['hit']
    ca = 0.0016 + 0.004 * hit                                                      # lateral colour toward the corners
    r_ = resize(big[..., 0], int(W * (1 + ca)), int(H * (1 + ca))); b_ = big[..., 2]
    oyc = (r_.shape[0] - H) // 2; oxc = (r_.shape[1] - W) // 2
    big = np.stack([r_[oyc:oyc + H, oxc:oxc + W], big[..., 1], b_], -1)
    yy = (ys - H / 2) / (H / 2) * 0.92; xx = (xs - W / 2) / (H / 2) / (W / H)
    rr = np.sqrt(xx * xx + yy * yy)
    big *= (1 - 0.62 * (1 - smooth(1.15, 0.30, rr * 1.35)))[..., None]
    if hit > 0.01: big = big * (1 - hit * (0.35 + 0.65 * np.clip(rr * rr, 0, 1))[..., None]) + big * np.array([1.7, 0.45, 0.35], np.float32) * (hit * (0.35 + 0.65 * np.clip(rr * rr, 0, 1)))[..., None]
    x = big * EXPOSURE
    x = np.clip((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1)
    x = x * 0.82 + (x * x * (3 - 2 * x)) * 0.18
    x = x ** (1 / 2.2)
    x = x + hud(W, H, sortie, st, Cam(meta, W, H), meta) * 0.92
    x += (np.random.default_rng(int(t * 1000) + 3).random((H, W, 1), dtype=np.float32) - 0.5) * 0.030
    x *= st['fade']
    return (np.clip(x, 0, 1) * 255 + 0.5).astype(np.uint8), keep
