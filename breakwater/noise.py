"""Value noise in NumPy: lattice hashing, fbm, and tileable fields for textures."""
import numpy as np


def hash2(ix, iy, seed=0):
    """Integer lattice hash -> float in [0, 1). Vectorised over arrays."""
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263 + seed * 1442695041) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(1 << 24)


def vnoise(x, y, seed=0):
    x = np.asarray(x, dtype=np.float64); y = np.asarray(y, dtype=np.float64)
    xi = np.floor(x); yi = np.floor(y)
    u = x - xi; v = y - yi
    u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v)
    a = hash2(xi, yi, seed); b = hash2(xi + 1, yi, seed); c = hash2(xi, yi + 1, seed); d = hash2(xi + 1, yi + 1, seed)
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v


def fbm(x, y, octaves=4, seed=0, lacunarity=2.03, gain=0.5):
    s = 0.0; a = 0.5; f = 1.0; norm = 0.0
    for i in range(octaves):
        s = s + a * vnoise(x * f + i * 17.3, y * f - i * 9.1, seed + i)
        norm += a; a *= gain; f *= lacunarity
    return s / norm


def tile_fbm(size=256, periods=(4, 8, 16, 32, 64), seed=1):
    """Tileable fbm field in [0, 1], shape (size, size)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    out = np.zeros((size, size)); a = 0.5; norm = 0.0
    for p in periods:
        lat = rng.random((p, p))
        fx = xx / size * p; fy = yy / size * p
        xi = np.floor(fx).astype(int); yi = np.floor(fy).astype(int)
        u = fx - xi; v = fy - yi
        u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v)
        x0 = xi % p; x1 = (xi + 1) % p; y0 = yi % p; y1 = (yi + 1) % p
        n = lat[y0, x0] * (1 - u) * (1 - v) + lat[y0, x1] * u * (1 - v) + lat[y1, x0] * (1 - u) * v + lat[y1, x1] * u * v
        out += a * n; norm += a; a *= 0.5
    return out / norm


def sample_tile(tex, u, v):
    """Bilinear, wrapping lookup of a tileable field at float coords (in tile units)."""
    h, w = tex.shape
    x = (u % 1.0) * w; y = (v % 1.0) * h
    x0 = np.floor(x).astype(int) % w; y0 = np.floor(y).astype(int) % h
    x1 = (x0 + 1) % w; y1 = (y0 + 1) % h
    fx = x - np.floor(x); fy = y - np.floor(y)
    return tex[y0, x0] * (1 - fx) * (1 - fy) + tex[y0, x1] * fx * (1 - fy) + tex[y1, x0] * (1 - fx) * fy + tex[y1, x1] * fx * fy
