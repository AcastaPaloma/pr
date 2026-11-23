"""The dusk sky as plain math: used for the environment light, the fog colour and the grade.

`sky_base` has no cloud detail (fog, reflections); `sky_full` adds a marine cloud deck lit from
below by the last light in the west and by the city. Directions are (..., 3) arrays, Z up.
"""
import numpy as np
from . import SUN_DIR, CITY_DIR
from .noise import tile_fbm, sample_tile

_NA = tile_fbm(256, seed=1337)
_NB = tile_fbm(256, seed=4242)
_SUN_H = SUN_DIR[:2] / np.linalg.norm(SUN_DIR[:2])


def _smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def sky_base(d):
    d = np.asarray(d, dtype=np.float64)
    z = d[..., 2]
    h = np.clip(z, 0.0, 1.0)[..., None]
    zen = np.array([0.010, 0.019, 0.040]); hor = np.array([0.042, 0.062, 0.098])
    c = hor + (zen - hor) * h ** 0.42
    dh = d[..., :2] / (np.linalg.norm(d[..., :2], axis=-1, keepdims=True) + 1e-6)
    w = np.maximum(dh @ _SUN_H, 0.0)[..., None]
    zc = np.maximum(z, 0.0)[..., None]
    band = np.exp(-np.abs(z - 0.012) * 15.0)[..., None]
    c = c + np.array([1.35, 0.40, 0.10]) * w ** 6 * band * 0.95                 # ember strip under the cloud deck
    c = c + np.array([0.50, 0.19, 0.20]) * w ** 2.6 * np.exp(-zc * 4.5) * 0.13   # wide rose wash
    cg = np.maximum(dh @ CITY_DIR, 0.0)[..., None]
    c = c + np.array([0.60, 0.34, 0.15]) * cg ** 2 * np.exp(-zc * 6.0) * 0.20    # sodium glow over the city
    below = np.clip(-z * 5.0, 0.0, 1.0)[..., None]
    return c * (1 - below) + np.array([0.008, 0.012, 0.018]) * below


def sky_full(d, flash=0.0, flash_dir=(0.0, 1.0, 0.3)):
    d = np.asarray(d, dtype=np.float64)
    base = sky_base(d)
    z = d[..., 2]
    up = z > 0
    zz = np.maximum(z, 0.0)
    u = d[..., 0] / (zz + 0.11); v = -d[..., 1] / (zz + 0.11)
    n = sample_tile(_NA, u * 0.050, v * 0.050) * 0.55 + sample_tile(_NB, u * 0.130, v * 0.130) * 0.30 + sample_tile(_NA, u * 0.410 + 0.37, v * 0.410) * 0.15
    cov = _smooth(0.34, 0.58, n)[..., None]; thick = _smooth(0.45, 0.80, n)[..., None]
    dh = d[..., :2] / (np.linalg.norm(d[..., :2], axis=-1, keepdims=True) + 1e-6)
    w = np.maximum(dh @ _SUN_H, 0.0)[..., None]; cg = np.maximum(dh @ CITY_DIR, 0.0)[..., None]
    zc = zz[..., None]
    cl = np.array([0.020, 0.027, 0.040]) + np.array([0.95, 0.30, 0.12]) * w ** 4 * np.exp(-zc * 6.0) * (1 - thick * 0.75) * 0.7
    cl = cl + np.array([0.42, 0.25, 0.12]) * cg ** 1.5 * np.exp(-zc * 3.0) * 0.30
    if flash > 0:
        fd = np.asarray(flash_dir, dtype=np.float64); fd = fd / np.linalg.norm(fd)
        cl = cl + np.array([0.75, 0.85, 1.0]) * flash * (np.maximum(d @ fd, 0.0) ** 6)[..., None] * 3.0 * (0.3 + n[..., None])
    gap = base * 1.6 + np.array([0.006, 0.010, 0.020])
    c = gap * (1 - cov) + cl * cov
    haze = np.exp(-zc * 9.0) * 0.8
    c = c * (1 - haze) + base * haze
    return np.where(up[..., None], c, base)


def fog_amount(eye, p, density=0.00020, height=230.0):
    """Fraction of light replaced by haze between `eye` (3,) and points `p` (..., 3)."""
    v = p - eye
    dist = np.linalg.norm(v, axis=-1)
    a = density * np.exp(-max(eye[2], 0.0) / height)
    k = v[..., 2] / height
    integ = np.where(np.abs(k) > 1e-3, (1 - np.exp(-k)) / np.where(np.abs(k) > 1e-3, k, 1.0), 1.0)
    return 1 - np.exp(-dist * a * np.minimum(integ, 3.0))


def fog_color(d, flash=0.0):
    d = np.asarray(d, dtype=np.float64)
    dd = np.stack([d[..., 0], d[..., 1], np.maximum(d[..., 2], 0.0) * 0.5 + 0.11], axis=-1)
    dd = dd / np.linalg.norm(dd, axis=-1, keepdims=True)
    return sky_base(dd) + np.array([0.003, 0.005, 0.008]) + np.array([0.6, 0.7, 1.0]) * flash * 0.05


def equirect(width=2048, height=1024, flash=0.0):
    """Environment map in Blender's equirectangular convention, float32 RGBA, row 0 at the bottom.
    Below the horizon it is a dark sea so undersides are lit by a plausible bounce."""
    v, u = np.mgrid[0:height, 0:width].astype(np.float64)
    phi = (0.5 - (u + 0.5) / width) * 2 * np.pi          # Cycles: u = 0.5 - atan2(y, x) / 2pi, so the image centre faces +X
    th = ((v + 0.5) / height - 0.5) * np.pi
    c = np.cos(th)
    d = np.stack([np.cos(phi) * c, np.sin(phi) * c, np.sin(th)], axis=-1)
    col = sky_full(d, flash)
    low = d[..., 2] < 0
    flat = d.copy(); flat[..., 2] = 0.02
    sea = sky_base(flat / np.linalg.norm(flat, axis=-1, keepdims=True)) * 0.35
    k = np.clip(-d[..., 2] * 3.0, 0.0, 1.0)[..., None]
    sea = sea * (1 - k) + np.array([0.006, 0.014, 0.018]) * k
    col = np.where(low[..., None], sea, col)
    return np.concatenate([col, np.ones((height, width, 1))], axis=-1).astype(np.float32)
