"""San Francisco Bay, built from numbers.

Terrain heightfield, the city (boxes with procedurally lit windows), street lamps, the Golden Gate
Bridge, Alcatraz, and the water. Geography is compressed about 1 : 2.5 but laid out like the real
bay: the Gate to the west (-X), the city to the south (-Y), Marin to the north, Alcatraz mid-bay.

`height(x, y)` is plain NumPy and is also used by post-processing for the shore wash.
`build()` creates the Blender objects.
"""
import numpy as np
from . import SEA_FLOOR, ORANGE
from .noise import fbm, vnoise

# ------------------------------------------------------------------ geography (x east, y north)
POLY = {
    'sf': [(-2150, -980), (-1800, -900), (-1500, -950), (-1000, -1000), (-300, -950), (200, -880), (800, -840), (1350, -880),
           (1750, -1100), (1950, -1700), (2050, -2600), (2200, -4500), (2200, -7000), (-2600, -7000), (-2600, -2500), (-2500, -1400), (-2350, -1050)],
    'marin': [(-7000, 700), (-2600, 760), (-1800, 700), (-1500, 820), (-1250, 1150), (-1000, 1700), (-800, 2300),
              (-600, 3000), (-200, 3600), (-200, 7000), (-7000, 7000)],
}
HILLS = {
    'sf': [(1500, -1250, 80, 220), (850, -1380, 95, 300), (1100, -1780, 100, 320), (-100, -1680, 115, 450), (-1500, -1500, 115, 500),
           (-2300, -1500, 90, 400), (0, -4300, 270, 700), (-600, -3900, 265, 480), (100, -3200, 170, 300), (1700, -3800, 90, 400)],
    'marin': [(-2900, 1200, 280, 700), (-1900, 1500, 290, 600), (-1300, 2100, 250, 700), (-2500, 2600, 330, 900), (-3500, 5200, 780, 1800), (-4500, 1500, 300, 1200)],
}
ISLES = [dict(x=550, y=450, a=265, b=105, rot=0.5, peak=41, plateau=True),          # Alcatraz
         dict(x=1350, y=1950, a=650, b=500, rot=-0.3, peak=238, plateau=False)]     # Angel Island
BX, TOWER_Y, ANCH_Y, TOWER_TOP, DECK_W = -1800.0, 640.0, 983.0, 227.0, 27.0
GRID_A = -0.155                                                                     # street grid rotation


def _smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _sd_poly(P, x, y):
    """Signed distance to a polygon (negative inside), vectorised."""
    P = np.asarray(P, float)
    d = np.full(np.shape(x), np.inf); s = np.ones(np.shape(x))
    n = len(P)
    for i in range(n):
        j = (i - 1) % n
        ex, ey = P[j, 0] - P[i, 0], P[j, 1] - P[i, 1]
        wx, wy = x - P[i, 0], y - P[i, 1]
        t = np.clip((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1)
        bx, by = wx - ex * t, wy - ey * t
        d = np.minimum(d, bx * bx + by * by)
        c1 = y >= P[i, 1]; c2 = y < P[j, 1]; c3 = ex * wy > ey * wx
        flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
        s = np.where(flip, -s, s)
    return s * np.sqrt(d)


def _hills(lst, x, y):
    h = 0.0
    for hx, hy, hh, r in lst: h = h + hh * np.exp(-((x - hx) ** 2 + (y - hy) ** 2) / (r * r))
    return h


def height(x, y):
    """Terrain height in metres (sea floor where there is no land)."""
    x = np.asarray(x, float); y = np.asarray(y, float)
    h = np.full(x.shape, SEA_FLOOR)
    for key, ramp, base, namp in (('sf', 400.0, 0.0, 14.0), ('marin', 240.0, 40.0, 90.0)):
        t = -_sd_poly(POLY[key], x, y)                       # metres inland
        n = fbm(x * 0.004, y * 0.004, 4, seed=3)
        hl = base + _hills(HILLS[key], x, y) + n * namp
        under = SEA_FLOOR * (1 - _smooth(-90, 4, t))
        land = under + 2.5 * _smooth(0, 30, t) + hl * _smooth(5, ramp, t)
        h = np.maximum(h, np.where(t < -90, SEA_FLOOR, np.where(t <= 0, under, land)))
    for I in ISLES:
        dx, dy = x - I['x'], y - I['y']
        c, s = np.cos(I['rot']), np.sin(I['rot'])
        u = (dx * c + dy * s) / I['a']; v = (-dx * s + dy * c) / I['b']
        rho = np.sqrt(u * u + v * v) + (vnoise(x * 0.011, y * 0.011, 5) - 0.5) * 0.30 + (vnoise(x * 0.04, y * 0.04, 6) - 0.5) * 0.08
        n = fbm(x * 0.012, y * 0.012, 3, seed=9)
        if I['plateau']: hh = I['peak'] * _smooth(1.0, 0.74, rho) * (0.72 + 0.28 * _smooth(0.75, 0.3, rho)) + (n - 0.4) * 12 * _smooth(1, 0.6, rho)
        else: hh = 6 * _smooth(1.0, 0.9, rho) + I['peak'] * np.maximum(0, 1 - rho * rho) ** 1.4 + n * 22 * _smooth(1, 0.5, rho)
        hh = np.where(rho >= 1, SEA_FLOOR * _smooth(1.0, 1.35, rho), hh)
        h = np.maximum(h, np.where(rho > 1.35, SEA_FLOOR, hh))
    return h


def deck_z(y):
    a = np.abs(y)
    return 67 - 9 * np.minimum((a / TOWER_Y) ** 2, 1) - np.maximum(a - TOWER_Y, 0) * 0.028


def cable_z(y):
    a = np.abs(y)
    main = 71 + (TOWER_TOP - 6 - 71) * (a / TOWER_Y) ** 2
    t = np.clip((a - TOWER_Y) / (ANCH_Y - TOWER_Y), 0, 1)
    side = (TOWER_TOP - 6) + (deck_z(ANCH_Y) + 3 - (TOWER_TOP - 6)) * t - 13 * np.sin(np.pi * t)
    return np.where(a <= TOWER_Y, main, side)


# ------------------------------------------------------------------ box soup builder
_CUBE = np.array([[-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5]])
_FACES = np.array([[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]])


class Soup:
    """Accumulates boxes and beams into one mesh with a per-vertex colour."""

    def __init__(self): self.v = []; self.f = []; self.c = []; self.n = 0

    def _add(self, verts, col):
        self.v.append(verts); self.f.append(_FACES + self.n); self.c.append(np.tile(np.asarray(col, float), (8, 1))); self.n += 8

    def box(self, cx, cy, cz, sx, sy, sz, col, rz=0.0):
        v = _CUBE * (sx, sy, sz)
        if rz:
            c, s = np.cos(rz), np.sin(rz); v = np.stack([v[:, 0] * c - v[:, 1] * s, v[:, 0] * s + v[:, 1] * c, v[:, 2]], 1)
        self._add(v + (cx, cy, cz), col)

    def beam(self, a, b, w, col, d=None):
        a = np.asarray(a, float); b = np.asarray(b, float)
        ax = b - a; L = np.linalg.norm(ax); ax = ax / L
        ref = np.array([0.0, 0.0, 1.0]) if abs(ax[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
        s = np.cross(ax, ref); s /= np.linalg.norm(s); u = np.cross(s, ax)
        loc = _CUBE * (w, L, d or w)
        self._add((a + b) / 2 + loc[:, [0]] * s + loc[:, [1]] * ax + loc[:, [2]] * u, col)

    def arrays(self):
        return np.concatenate(self.v), np.concatenate(self.f), np.concatenate(self.c)


# ------------------------------------------------------------------ data builders (pure NumPy)
def terrain_mesh(n=260):
    x0, x1, y0, y1 = -4400.0, 5200.0, -4800.0, 4800.0
    xs = np.linspace(x0, x1, n + 1); ys = np.linspace(y0, y1, n + 1)
    X, Y = np.meshgrid(xs, ys)
    H = height(X, Y)
    gy, gx = np.gradient(H, ys, xs)
    slope = np.hypot(gx, gy)
    nz = fbm(X * 0.01, Y * 0.01, 3, seed=11)
    in_sf = (Y < -700) & (X > -2700) & (X < 2300)
    presidio = in_sf & (((X + 1500) / 780) ** 2 + ((Y + 1560) / 540) ** 2 < 1)
    col = np.stack([0.10 + nz * 0.07, 0.105 + nz * 0.06, 0.05 + nz * 0.02], -1)                    # coastal scrub
    col = np.where(presidio[..., None], np.stack([0.02 + nz * 0.02, 0.05 + nz * 0.03, np.full(nz.shape, 0.025)], -1), col)
    col = np.where((slope > 0.55)[..., None], np.stack([0.16 + nz * 0.06, 0.145 + nz * 0.05, 0.12 + nz * 0.04], -1), col)
    col = np.where((in_sf & ~presidio & (H < 190))[..., None], np.stack([0.045 + nz * 0.02] * 3, -1), col)   # asphalt, roofs
    col = np.where((H < 1.6)[..., None], np.array([0.20, 0.18, 0.14]), col)                       # wet sand, riprap
    V = np.stack([X, Y, H], -1).reshape(-1, 3)
    i = np.arange(n * n); r = i // n; c = i % n
    a = r * (n + 1) + c
    quads = np.stack([a, a + 1, a + n + 2, a + n + 1], 1)
    keep = np.max(H.reshape(-1)[quads], 1) > -7
    return V, quads[keep], col.reshape(-1, 3), (xs, ys, H)


def city_data(seed=4242):
    """Buildings as (cx, cy, base_z, w, d, h) plus lamp positions/colours."""
    rng = np.random.default_rng(seed)
    ca, sa, LOT = np.cos(GRID_A), np.sin(GRID_A), 36.0
    I, J = np.meshgrid(np.arange(-10, 150), np.arange(-20, 125), indexing='ij')
    I = I.ravel(); J = J.ravel()
    u, v = I * LOT, J * LOT
    x = -2500 + u * ca + v * sa; y = -880 + u * sa - v * ca
    ok = (y < -860) & (x > -2450) & (x < 2180) & (y > -4700)
    ok &= ~((((x + 1500) / 780) ** 2 + ((y + 1560) / 540) ** 2) < 1)                               # Presidio
    ok &= ~((x > -2500) & (x < -500) & (y < -3300) & (y > -3560))                                  # the park
    x, y, I, J = x[ok], y[ok], I[ok], J[ok]
    h0 = height(x, y)
    ok = (h0 > 2.2) & (h0 < 195)
    x, y, I, J, h0 = x[ok], y[ok], I[ok], J[ok], h0[ok]
    street = (I % 4 == 0) | (J % 3 == 0)
    r = rng.random((len(x), 5))
    lm = street & (r[:, 0] < 0.62)
    sod = r[lm, 1] < 0.8
    lamps = np.stack([x[lm] + (r[lm, 2] - .5) * 8, y[lm] + (r[lm, 3] - .5) * 8, h0[lm] + 9], 1)
    lamp_col = np.where(sod[:, None], np.array([1.0, 0.56, 0.22]), np.array([0.80, 0.90, 1.0]))
    b = ~street & (r[:, 0] > 0.06)
    x, y, h0, r = x[b], y[b], h0[b], r[b]
    D = np.exp(-((x - 1500) ** 2 + (y + 1950) ** 2) / (2 * 430 ** 2)) + 0.55 * np.exp(-((x - 1780) ** 2) / (2 * 300 ** 2) - ((y + 2600) ** 2) / (2 * 480 ** 2))
    vn = 0.5 * np.exp(-((x - 420) / 90) ** 2)
    h = 9 + 9 * r[:, 1] ** 2 + vn * 40 * r[:, 2] + np.where(D > 0.08, D * (40 + 210 * r[:, 2] ** 1.5), 0)
    w = np.where(D > 0.08, 30 + r[:, 3] * 5, 26 + r[:, 3] * 6); d = np.where(D > 0.08, 30 + r[:, 4] * 5, 26 + r[:, 4] * 6)
    bld = np.stack([x, y, h0 - 2, w, d, h + 2], 1)
    # landmarks: the pyramid (as a stack of shrinking boxes) and the tall round-ish tower
    extra = []
    px, py = 1400, -1580; pz = float(height(px, py))
    for k in range(13): s = 56 * (1 - k / 13); extra.append((px, py, pz + k * 20 - 2, s, s, 22))
    tx, ty = 1660, -2230; tz = float(height(tx, ty))
    for k, s in enumerate([62, 60, 58, 56, 52, 46, 36]): extra.append((tx, ty, tz + k * 46 - 2, s, s, 48))
    bld = np.concatenate([bld, np.array(extra, float)])
    # piers along the waterfront
    shore = [(820, -835), (1350, -872), (1750, -1092), (1950, -1700), (2040, -2500)]
    piers = []
    for a, b2 in zip(shore[:-1], shore[1:]):
        L = np.hypot(b2[0] - a[0], b2[1] - a[1]); nx, ny = -(b2[1] - a[1]) / L, (b2[0] - a[0]) / L
        if ny < 0 and abs(nx) < 0.5: nx, ny = -nx, -ny
        cnt = int(L // 95)
        for k in range(cnt):
            t = (k + .5) / cnt; qx = a[0] + (b2[0] - a[0]) * t; qy = a[1] + (b2[1] - a[1]) * t
            PL = 130 + rng.random() * 60
            piers.append((qx + nx * (PL / 2 - 15), qy + ny * (PL / 2 - 15), 5.0, 34.0, PL, 12.0, np.arctan2(-nx, ny)))
    return bld, lamps, lamp_col, np.array(piers)


def city_mesh(bld):
    """One mesh for every building, with wall-aligned UVs in metres so windows can be shaded procedurally."""
    N = len(bld)
    c, s = np.cos(GRID_A), np.sin(GRID_A)
    base = _CUBE + (0, 0, 0.5)
    v = base[None] * np.stack([bld[:, 3], bld[:, 4], bld[:, 5]], 1)[:, None, :]
    v = np.stack([v[..., 0] * c - v[..., 1] * s, v[..., 0] * s + v[..., 1] * c, v[..., 2]], -1) + np.stack([bld[:, 0], bld[:, 1], bld[:, 2]], 1)[:, None, :]
    F = (_FACES[None] + (np.arange(N) * 8)[:, None, None]).reshape(-1, 4)
    w, d, h = bld[:, 3], bld[:, 4], bld[:, 5]
    z = np.zeros(N)
    quad = lambda uu, vv: np.stack([np.stack([z, z], 1), np.stack([uu, z], 1), np.stack([uu, vv], 1), np.stack([z, vv], 1)], 1)   # (N, 4, 2)
    uv = np.stack([np.zeros((N, 4, 2)), np.zeros((N, 4, 2)), quad(w, h), quad(d, h), quad(w, h), quad(d, h)], 1)                  # roofs get no windows
    return v.reshape(-1, 3), F, uv.reshape(-1, 2)


def lamp_mesh(pos, col, size=1.1):
    """Each lamp is a tiny octahedron; colour rides on a vertex attribute."""
    o = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], float) * size
    f = np.array([[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]])
    N = len(pos)
    sizes = size if np.isscalar(size) else None
    V = (o[None] + pos[:, None, :]).reshape(-1, 3)
    F = (f[None] + (np.arange(N) * 6)[:, None, None]).reshape(-1, 3)
    C = np.repeat(col, 6, axis=0)
    return V, F, C


def bridge_soup():
    """The Golden Gate: towers, deck truss, cables, suspenders, piers. Returns (steel Soup, concrete Soup, lamp positions)."""
    st, cn, lamps, beacons = Soup(), Soup(), [], []
    O = ORANGE; Od = tuple(v * 0.8 for v in O)
    for ty in (-TOWER_Y, TOWER_Y):
        for sx in (-1, 1):
            x = BX + sx * (DECK_W / 2 + 3.5)
            for z0, z1, wx, wy in ((-4, 58, 11, 17), (58, 104, 9.6, 15), (104, 146, 8.4, 13), (146, 186, 7.2, 11.2), (186, TOWER_TOP, 6.2, 9.6)):
                st.box(x, ty, (z0 + z1) / 2, wx, wy, z1 - z0, O)
                st.box(x, ty, z1 - 1.0, wx + 1.2, wy + 1.2, 2.0, O)                      # stepped cornice
            st.box(x, ty, TOWER_TOP + 2.5, 8, 12, 5, O)
            beacons.append((x, ty, TOWER_TOP + 7))
        for z, hh in ((100, 9), (142, 8), (182, 7), (221, 6)):
            st.box(BX, ty, z, DECK_W + 7, 7, hh, O)
            st.box(BX, ty, z, DECK_W - 4, 7.6, hh * 0.45, Od)                             # recessed panel
        xl, xr = BX - DECK_W / 2 - 3.5, BX + DECK_W / 2 + 3.5
        for z0, z1 in ((2, 28), (28, 54)):
            st.beam((xl, ty, z0), (xr, ty, z1), 3.2, O, 5); st.beam((xr, ty, z0), (xl, ty, z1), 3.2, O, 5)
        st.box(BX, ty, 28, DECK_W + 7, 6, 4, O)
        cn.box(BX, ty, -9, 64, 40, 30, (0.36, 0.35, 0.33))
        if ty < 0: cn.box(BX, ty, -2, 104, 164, 14, (0.33, 0.32, 0.30))                   # the south tower's fender
    SEG = 56; ya, yb = -ANCH_Y - 300, ANCH_Y + 300
    for i in range(SEG):
        y0 = ya + (yb - ya) * i / SEG; y1 = ya + (yb - ya) * (i + 1) / SEG
        z0 = float(deck_z(np.clip(y0, -ANCH_Y, ANCH_Y))); z1 = float(deck_z(np.clip(y1, -ANCH_Y, ANCH_Y)))
        st.beam((BX, y0, z0 - 0.8), (BX, y1, z1 - 0.8), DECK_W, (0.05, 0.05, 0.055), 1.6)
        for sx in (-1, 1):
            x = BX + sx * (DECK_W / 2 - 0.5); ym, zm = (y0 + y1) / 2, (z0 + z1) / 2
            st.beam((x, y0, z0 - 0.2), (x, y1, z1 - 0.2), 1.2, O, 2.6)
            st.beam((x, y0, z0 - 8.2), (x, y1, z1 - 8.2), 1.2, Od, 1.4)
            st.beam((x, y0, z0 - 8.2), (x, ym, zm - 0.8), 0.9, Od); st.beam((x, ym, zm - 0.8), (x, y1, z1 - 8.2), 0.9, Od)
        st.box(BX, y0, z0 - 8.2, DECK_W, 1.2, 1.2, Od)
    for y in (-ANCH_Y, ANCH_Y): cn.box(BX, y, float(deck_z(ANCH_Y)) - 22, 46, 60, 34, (0.36, 0.35, 0.33))
    for sx in (-1, 1):
        x = BX + sx * (DECK_W / 2 + 3.5)
        ys = np.linspace(-ANCH_Y, ANCH_Y, 81); zs = cable_z(ys)
        for i in range(80): st.beam((x, ys[i], zs[i]), (x, ys[i + 1], zs[i + 1]), 1.5, O)
        for y in np.arange(-ANCH_Y + 15, ANCH_Y, 15.2):
            if abs(abs(y) - TOWER_Y) < 9: continue
            zc, zd = float(cable_z(y)), float(deck_z(y))
            if zc - zd > 2: st.beam((x, y, zd), (x, y, zc), 0.42, O)
    for y in np.arange(-ANCH_Y - 280, ANCH_Y + 281, 46.0):
        z = float(deck_z(np.clip(y, -ANCH_Y, ANCH_Y))) + 9
        lamps.append((BX - DECK_W / 2, y, z)); lamps.append((BX + DECK_W / 2, y + 23, z))
    return st, cn, np.array(lamps), np.array(beacons)


# ------------------------------------------------------------------ Blender scene
def build():
    """Create every world object in the current Blender scene. Returns handles used per frame."""
    import bpy
    from . import bl
    out = {}

    # --- terrain
    V, F, C, grid = terrain_mesh()
    ter = bl.mesh_object('terrain', V, F, smooth=True, attrs={'col': C})
    mat, n = bl.material('terrain')
    col = n.new('ShaderNodeAttribute', attribute_name='col')
    p = bl.principled(n, Base_Color=col.outputs['Color'], Roughness=0.95)
    n.output(p.outputs[0]); ter.data.materials.append(mat)
    out['height_grid'] = grid

    # --- water: a glossy sheet whose normal is driven by drifting 4D noise at three scales
    q = np.array([[-40000, -40000, 0], [40000, -40000, 0], [40000, 40000, 0], [-40000, 40000, 0]], float)
    water = bl.mesh_object('water', q, [[0, 1, 2, 3]])
    mat, n = bl.material('water')
    geo = n.new('ShaderNodeNewGeometry')
    tval = n.new('ShaderNodeValue'); tval.label = 'time'
    drift = n.new('ShaderNodeCombineXYZ', inputs={0: n.math('MULTIPLY', tval.outputs[0], 2.2), 1: n.math('MULTIPLY', tval.outputs[0], 0.6), 2: 0.0})
    pos = n.vmath('SUBTRACT', geo.outputs['Position'], drift.outputs[0])
    hsum = None
    for scale, amp, speed, detail in ((0.016, 1.00, 0.20, 2.0), (0.060, 0.45, 0.45, 3.0), (0.26, 0.16, 0.9, 3.0)):
        nz = n.new('ShaderNodeTexNoise', noise_dimensions='4D', inputs={'Vector': pos, 'W': n.math('MULTIPLY', tval.outputs[0], speed), 'Scale': scale, 'Detail': detail, 'Roughness': 0.55})
        term = n.math('MULTIPLY', nz.outputs[0], amp)
        hsum = term if hsum is None else n.math('ADD', hsum, term)
    cam = n.new('ShaderNodeCameraData')
    near = n.math('DIVIDE', 1.0, n.math('ADD', 1.0, n.math('MULTIPLY', cam.outputs['View Distance'], 1 / 900.0)))   # calm the far field
    bump = n.new('ShaderNodeBump', inputs={'Strength': n.math('ADD', 0.10, n.math('MULTIPLY', near, 0.5)), 'Distance': 3.0, 'Height': hsum})
    p = bl.principled(n, Base_Color=(0.0030, 0.0100, 0.0140, 1), Roughness=0.035, IOR=1.33, Normal=bump.outputs[0])
    n.output(p.outputs[0]); water.data.materials.append(mat)
    out['water_time'] = tval.outputs[0]

    # --- city
    bld, lamps, lamp_col, piers = city_data()
    Vc, Fc, UVc = city_mesh(bld)
    city = bl.mesh_object('city', Vc, Fc, uvs=UVc)
    mat, n = bl.material('city')
    geo = n.new('ShaderNodeNewGeometry'); rnd = geo.outputs['Random Per Island']
    uv = n.new('ShaderNodeUVMap', uv_map='UVMap')
    sep = n.new('ShaderNodeSeparateXYZ', inputs={0: uv.outputs[0]})
    gx = n.math('DIVIDE', sep.outputs[0], n.math('ADD', 2.8, n.math('MULTIPLY', rnd, 1.6))); gy = n.math('DIVIDE', sep.outputs[1], 3.6)
    fx = n.math('FRACT', gx); fy = n.math('FRACT', gy)
    win = n.math('MULTIPLY', n.math('MULTIPLY', n.math('GREATER_THAN', fx, 0.16), n.math('LESS_THAN', fx, 0.84)),
                 n.math('MULTIPLY', n.math('GREATER_THAN', fy, 0.26), n.math('LESS_THAN', fy, 0.80)))
    cell = n.new('ShaderNodeCombineXYZ', inputs={0: n.math('FLOOR', gx), 1: n.math('FLOOR', gy), 2: n.math('MULTIPLY', rnd, 517.0)})
    wn = n.new('ShaderNodeTexWhiteNoise', noise_dimensions='3D', inputs={'Vector': cell.outputs[0]})
    rowv = n.new('ShaderNodeCombineXYZ', inputs={0: n.math('FLOOR', gy), 1: n.math('MULTIPLY', rnd, 91.0), 2: 0.0})
    rown = n.new('ShaderNodeTexWhiteNoise', noise_dimensions='3D', inputs={'Vector': rowv.outputs[0]})
    occ = n.math('ADD', 0.05, n.math('MULTIPLY', n.math('FRACT', n.math('MULTIPLY', rnd, 7.31)), 0.32))
    lit = n.math('MAXIMUM', n.math('GREATER_THAN', wn.outputs['Value'], n.math('SUBTRACT', 1.0, occ)),
                 n.math('MULTIPLY', n.math('LESS_THAN', rown.outputs['Value'], 0.07), n.math('GREATER_THAN', wn.outputs['Value'], 0.25)))
    hasuv = n.math('GREATER_THAN', n.math('ADD', sep.outputs[0], sep.outputs[1]), 0.001)
    bright = n.math('MULTIPLY', n.math('MULTIPLY', n.math('MULTIPLY', lit, win), hasuv), n.math('ADD', 0.5, n.math('MULTIPLY', wn.outputs['Color'], 0.9)))
    wcol = n.mix(n.math('GREATER_THAN', n.math('FRACT', n.math('MULTIPLY', rnd, 3.7)), 0.70), (1.0, 0.66, 0.36, 1), (0.70, 0.84, 1.0, 1))
    facade = n.mix(n.math('FRACT', n.math('MULTIPLY', rnd, 91.7)), (0.030, 0.033, 0.038, 1), (0.11, 0.10, 0.09, 1))
    lp = n.new('ShaderNodeLightPath')
    seen = n.math('MAXIMUM', lp.outputs['Is Camera Ray'], lp.outputs['Is Glossy Ray'])
    p = bl.principled(n, Base_Color=facade, Roughness=0.55, Emission_Color=wcol, Emission_Strength=n.math('MULTIPLY', n.math('MULTIPLY', bright, seen), 2.1))
    n.output(p.outputs[0]); city.data.materials.append(mat)

    # --- piers, Alcatraz buildings: plain painted concrete
    so = Soup()
    for px, py, pz, w, L, h, rz in piers: so.box(px, py, pz, w, L, h, (0.10, 0.10, 0.10), rz)
    A = ISLES[0]; c, s = np.cos(A['rot']), np.sin(A['rot'])
    onA = lambda u, v: (A['x'] + u * c - v * s, A['y'] + u * s + v * c)
    for (u, v, z, w, d, h, k) in ((-10, 0, 49, 150, 44, 17, 0.42), (-10, 0, 59, 120, 30, 4, 0.34), (70, -30, 46, 50, 18, 12, 0.42), (-70, 32, 30, 60, 14, 9, 0.38), (150, -25, 12, 46, 20, 10, 0.42), (105, 8, 54, 5, 5, 27, 0.6), (-120, -20, 60, 13, 13, 22, 0.3)):
        x, y = onA(u, v); so.box(x, y, z, w, d, h, (k, k * 0.96, k * 0.88), A['rot'])
    Vs, Fs, Cs = so.arrays()
    props = bl.mesh_object('props', Vs, Fs, attrs={'col': Cs})
    mat, n = bl.material('concrete'); col = n.new('ShaderNodeAttribute', attribute_name='col')
    p = bl.principled(n, Base_Color=col.outputs['Color'], Roughness=0.9); n.output(p.outputs[0]); props.data.materials.append(mat)
    out['lighthouse'] = np.array([*onA(105, 8), 69.0])

    # --- the bridge
    st, cn, blamps, beacons = bridge_soup()
    Vb, Fb, Cb = st.arrays()
    bridge = bl.mesh_object('bridge', Vb, Fb, attrs={'col': Cb})
    mat, n = bl.material('bridge_steel')
    col = n.new('ShaderNodeAttribute', attribute_name='col'); geo = n.new('ShaderNodeNewGeometry')
    z = n.new('ShaderNodeSeparateXYZ', inputs={0: geo.outputs['Position']}).outputs[2]
    flood = n.math('MULTIPLY', n.math('POWER', 2.718, n.math('MULTIPLY', n.math('MAXIMUM', n.math('SUBTRACT', z, 62.0), 0.0), -1 / 60.0)), 0.16)   # floodlit from the roadway
    flood = n.math('ADD', flood, 0.03)
    wear = n.new('ShaderNodeTexNoise', inputs={'Scale': 0.08, 'Detail': 4.0})
    base = n.mix(n.math('MULTIPLY', wear.outputs[0], 0.35), col.outputs['Color'], (0.20, 0.03, 0.02, 1))
    p = bl.principled(n, Base_Color=base, Roughness=0.6, Metallic=0.2, Emission_Color=n.mix(0.5, col.outputs['Color'], (0.9, 0.22, 0.08, 1)), Emission_Strength=flood)
    n.output(p.outputs[0]); bridge.data.materials.append(mat)
    Vn, Fn, Cn = cn.arrays()
    conc = bl.mesh_object('bridge_concrete', Vn, Fn, attrs={'col': Cn}); conc.data.materials.append(bpy.data.materials['concrete'])

    # --- every lamp in the bay as one mesh of tiny emitters, seen by the camera and by reflections only
    rng = np.random.default_rng(5)
    extra, ecol = [], []
    def scatter(nn, x0, x1, y0, y1, cond=None, lift=6):
        k = 0; tries = 0
        while k < nn and tries < nn * 12:
            tries += 1
            x = rng.uniform(x0, x1); y = rng.uniform(y0, y1); h = float(height(x, y))
            if h < 2 or (cond and not cond(h)): continue
            extra.append((x, y, h + lift)); ecol.append((1.0, 0.74, 0.46) if rng.random() < 0.7 else (1.0, 0.56, 0.22)); k += 1
    scatter(420, -1500, -650, 1100, 2900, lambda h: h < 140)                    # the town on the north shore
    scatter(26, 350, 760, 380, 520)                                             # Alcatraz
    scatter(500, -2500, 2150, -7000, -4700, None, 8)                            # city beyond the building grid
    eb = np.stack([5700 + rng.random(1800) ** 1.7 * 3400, rng.uniform(-9000, 9000, 1800), 8 + rng.random(1800) ** 3 * 300], 1)   # far shore
    pos = np.concatenate([lamps, blamps, np.array(extra), eb])
    col = np.concatenate([lamp_col, np.tile([1.0, 0.56, 0.22], (len(blamps), 1)), np.array(ecol), np.tile([1.0, 0.62, 0.3], (len(eb), 1))])
    dist = np.hypot(pos[:, 0] + 300, pos[:, 1])
    Vl, Fl, Cl = lamp_mesh(pos, col, 1.0)
    Vl = (Vl.reshape(-1, 6, 3) - pos[:, None, :]) * (0.8 + dist / 3200.0)[:, None, None] + pos[:, None, :]      # far lamps are drawn larger so they survive sampling
    lm = bl.mesh_object('lamps', Vl.reshape(-1, 3), Fl, attrs={'col': Cl})
    mat, n = bl.material('lamps'); col_n = n.new('ShaderNodeAttribute', attribute_name='col'); lp = n.new('ShaderNodeLightPath')
    em = n.new('ShaderNodeEmission', inputs={'Color': col_n.outputs['Color'], 'Strength': 14.0})
    tr = n.new('ShaderNodeBsdfTransparent')
    mix = n.new('ShaderNodeMixShader', inputs={0: n.math('MAXIMUM', lp.outputs['Is Camera Ray'], lp.outputs['Is Glossy Ray']), 1: tr.outputs[0], 2: em.outputs[0]})
    n.output(mix.outputs[0]); lm.data.materials.append(mat)
    Vr, Fr, Cr = lamp_mesh(np.concatenate([beacons, [out['lighthouse']]]), np.array([[1, 0.05, 0.03]] * len(beacons) + [[1, 0.95, 0.8]]), 2.2)
    bc = bl.mesh_object('beacons', Vr, Fr, attrs={'col': Cr})
    mat2 = mat.copy(); mat2.name = 'beacons'
    for nd in mat2.node_tree.nodes:
        if nd.bl_idname == 'ShaderNodeEmission': nd.inputs['Strength'].default_value = 40.0; out['beacon_strength'] = nd.inputs['Strength']
    bc.data.materials.append(mat2)

    # --- a low warm key from the west so wet surfaces catch a rim
    sun = bpy.data.lights.new('dusk', 'SUN'); sun.energy = 1.1; sun.color = (1.0, 0.42, 0.16); sun.angle = np.radians(6)
    so_ = bpy.data.objects.new('dusk', sun); bpy.context.scene.collection.objects.link(so_)
    from mathutils import Vector
    so_.rotation_euler = Vector((1.0, 0.10, -0.10)).to_track_quat('-Z', 'Y').to_euler()       # light travels east, slightly down
    so_.visible_glossy = False                                                                # the sun itself is below the horizon
    out['sun'] = sun
    return out
