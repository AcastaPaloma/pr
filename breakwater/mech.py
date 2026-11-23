"""The harbour-defence machine, as its pilot sees it: the cockpit interior and the two arms.

The film is first-person only, so nothing else is built (no legs, no hull).

    mech = Mech()                                   # builds meshes, materials, lights under mech.root
    mech.root.location = (x, y, SEA_FLOOR); mech.root.rotation_euler.z = heading
    mech.pose(L=('idle', t), R=('punch', 0.24), twist=0.1, bob=(0, 0, 0.4))
    cam_pos = mech.eye()                            # camera goes exactly here, looking along +Y (after heading + twist)

Layout (torso frame = root frame after bob / twist / sway; metres, +Y forward, +X right, z from the feet):
the pilot's eye sits on the centre line at z = EYE_HEIGHT; the cockpit is a few metres across with the co-pilot
seated ahead and to the right; shoulders are 20 m to each side and 14 m below the eye. Arm poses are pure
functions of (state, seconds), solved with two-bone IK, so any frame can be rendered on its own.

Extras beyond the agreed interface (all optional): `aim()` (unit vector of the cannon barrel), `knuckles(side)`,
`basis()` (cockpit right / forward / up in world space, includes sway roll), `Mech.HOLD` (ease times of the hold
states) and a third tuple element on the hold states, e.g. ('block', t, r): r = seconds since release, which
eases the arm back to idle.

Rendering notes. The budget is 16-24 samples with no denoiser, so the shading is kept low-variance on purpose:
screens and glows are emissive for camera rays only and never light anything; the cabin is lit by a few soft area
lights that ride with it (plus one warm light kept on the world's west side); the arms get a light-linked work
light; a diffuse bounce ray that lands on the machine is terminated (it receives bounce light but passes none on).
"""
import numpy as np
import bpy
from mathutils import Matrix
from . import bl, ORANGE, SUN_DIR

# ------------------------------------------------------------------------------------------------ palette (linear)
C_FRAME = (0.150, 0.170, 0.185)      # naval grey, canopy frame
C_WALL = (0.085, 0.097, 0.105)
C_PANEL = (0.040, 0.043, 0.047)      # instrument panels
C_PLATE = (0.060, 0.065, 0.070)
C_DARK = (0.014, 0.015, 0.016)
C_STEEL = (0.46, 0.44, 0.42)
C_ARM = (0.270, 0.300, 0.320)        # naval grey, arm armour
C_ARM2 = (0.170, 0.192, 0.208)
C_ARM_D = (0.040, 0.043, 0.047)
C_SUIT = (0.115, 0.135, 0.092)
C_GLOVE = (0.22, 0.19, 0.14)
C_HELM = (0.50, 0.51, 0.48)
C_SEAT = (0.045, 0.047, 0.050)
C_WHITE = (0.55, 0.55, 0.52)
C_YEL = (0.60, 0.42, 0.03)
G_GREEN = (0.10, 1.00, 0.32); G_AMBER = (1.00, 0.50, 0.06); G_CYAN = (0.18, 0.85, 1.00); G_RED = (1.00, 0.06, 0.03); G_WHITE = (0.85, 0.92, 1.0)

M_PAINT, M_METAL, M_FABRIC, M_GLOSS, M_DECAL, M_DA, M_DB, M_DC, M_WARN, M_CORE, M_SEG, M_NAV = range(12)


# ------------------------------------------------------------------------------------------------ small math
def _n(v):
    v = np.asarray(v, dtype=float)
    return v / (np.linalg.norm(v) + 1e-12)


def _T(x, y=None, z=None):
    M = np.eye(4); M[:3, 3] = (x, y, z) if y is not None else x
    return M


def _RX(a):
    c, s = np.cos(a), np.sin(a); M = np.eye(4); M[1, 1] = c; M[1, 2] = -s; M[2, 1] = s; M[2, 2] = c
    return M


def _RY(a):
    c, s = np.cos(a), np.sin(a); M = np.eye(4); M[0, 0] = c; M[0, 2] = s; M[2, 0] = -s; M[2, 2] = c
    return M


def _RZ(a):
    c, s = np.cos(a), np.sin(a); M = np.eye(4); M[0, 0] = c; M[0, 1] = -s; M[1, 0] = s; M[1, 1] = c
    return M


def _frame(o, X, Y, Z):
    M = np.eye(4); M[:3, 0] = X; M[:3, 1] = Y; M[:3, 2] = Z; M[:3, 3] = o
    return M


def _aim(o, ydir, zhint):
    """Frame at o with +Y along ydir and +Z as close to zhint as possible."""
    Y = _n(ydir); Z = np.asarray(zhint, float); Z = Z - (Z @ Y) * Y
    if np.linalg.norm(Z) < 1e-6: Z = np.cross(Y, (1.0, 0.0, 0.0))
    Z = _n(Z)
    return _frame(o, np.cross(Y, Z), Y, Z)


def _pface(o, X, Y):
    """Panel frame: local X right, Y up the panel, Z out of it."""
    X = _n(X); Y = _n(Y)
    return _frame(o, X, Y, np.cross(X, Y))


ALONG_Y = _RX(-np.pi / 2)     # turns a +Z primitive (cyl, lathe, prism) to run along +Y
ALONG_X = _RY(np.pi / 2)


# ------------------------------------------------------------------------------------------------ bitmap font
_FONT_SRC = """
A 01110 10001 10001 11111 10001 10001 10001
B 11110 10001 10001 11110 10001 10001 11110
C 01110 10001 10000 10000 10000 10001 01110
D 11110 10001 10001 10001 10001 10001 11110
E 11111 10000 10000 11110 10000 10000 11111
F 11111 10000 10000 11110 10000 10000 10000
G 01110 10001 10000 10111 10001 10001 01111
H 10001 10001 10001 11111 10001 10001 10001
I 01110 00100 00100 00100 00100 00100 01110
J 00111 00010 00010 00010 00010 10010 01100
K 10001 10010 10100 11000 10100 10010 10001
L 10000 10000 10000 10000 10000 10000 11111
M 10001 11011 10101 10101 10001 10001 10001
N 10001 11001 10101 10011 10001 10001 10001
O 01110 10001 10001 10001 10001 10001 01110
P 11110 10001 10001 11110 10000 10000 10000
Q 01110 10001 10001 10001 10101 10010 01101
R 11110 10001 10001 11110 10100 10010 10001
S 01111 10000 10000 01110 00001 00001 11110
T 11111 00100 00100 00100 00100 00100 00100
U 10001 10001 10001 10001 10001 10001 01110
V 10001 10001 10001 10001 10001 01010 00100
W 10001 10001 10001 10101 10101 10101 01010
X 10001 10001 01010 00100 01010 10001 10001
Y 10001 10001 01010 00100 00100 00100 00100
Z 11111 00001 00010 00100 01000 10000 11111
0 01110 10001 10011 10101 11001 10001 01110
1 00100 01100 00100 00100 00100 00100 01110
2 01110 10001 00001 00010 00100 01000 11111
3 11111 00010 00100 00010 00001 10001 01110
4 00010 00110 01010 10010 11111 00010 00010
5 11111 10000 11110 00001 00001 10001 01110
6 00110 01000 10000 11110 10001 10001 01110
7 11111 00001 00010 00100 01000 01000 01000
8 01110 10001 10001 01110 10001 10001 01110
9 01110 10001 10001 01111 00001 00010 01100
- 00000 00000 00000 11111 00000 00000 00000
. 00000 00000 00000 00000 00000 01100 01100
/ 00001 00001 00010 00100 01000 10000 10000
: 00000 01100 01100 00000 01100 01100 00000
% 11001 11010 00010 00100 01000 01011 10011
+ 00000 00100 00100 11111 00100 00100 00000
> 01000 00100 00010 00001 00010 00100 01000
< 00010 00100 01000 10000 01000 00100 00010
"""
_FONT = {}
for _ln in _FONT_SRC.strip().splitlines():
    _p = _ln.split(); _FONT[_p[0]] = np.array([[c == '1' for c in r] for r in _p[1:]], bool)


def _text(s, scale=1):
    s = s.upper(); out = np.zeros((7, max(6 * len(s) - 1, 1)), bool)
    for i, ch in enumerate(s):
        g = _FONT.get(ch)
        if g is not None: out[:, 6 * i:6 * i + 5] = g
    return np.kron(out, np.ones((scale, scale), bool)) if scale > 1 else out


class _Canvas:
    """A little raster for drawing instrument faces; row 0 is the top."""

    def __init__(self, w, h, bg=(0.0, 0.0, 0.0)):
        self.a = np.zeros((h, w, 3), np.float32) + np.asarray(bg, np.float32); self.w = w; self.h = h

    def rect(self, x0, y0, x1, y1, c):
        self.a[max(int(y0), 0):int(y1), max(int(x0), 0):int(x1)] = c

    def box(self, x0, y0, x1, y1, c, t=1):
        self.rect(x0, y0, x1, y0 + t, c); self.rect(x0, y1 - t, x1, y1, c); self.rect(x0, y0, x0 + t, y1, c); self.rect(x1 - t, y0, x1, y1, c)

    def line(self, x0, y0, x1, y1, c, t=1):
        k = int(max(abs(x1 - x0), abs(y1 - y0))) * 2 + 2
        xs = np.linspace(x0, x1, k); ys = np.linspace(y0, y1, k)
        for dx in range(t):
            for dy in range(t):
                xi = np.clip(np.round(xs).astype(int) + dx, 0, self.w - 1); yi = np.clip(np.round(ys).astype(int) + dy, 0, self.h - 1)
                self.a[yi, xi] = c

    def circle(self, cx, cy, r, c, t=1.3, fill=False):
        yy, xx = np.mgrid[0:self.h, 0:self.w]
        d = np.hypot(xx - cx, yy - cy)
        m = d <= r if fill else np.abs(d - r) <= t * 0.5
        self.a[m] = c

    def text(self, x, y, s, c, scale=1):
        g = _text(s, scale); h, w = g.shape
        x = int(x); y = int(y); w = min(w, self.w - x); h = min(h, self.h - y)
        if w <= 0 or h <= 0: return
        self.a[y:y + h, x:x + w][g[:h, :w]] = c


class _Atlas:
    """Shelf-packed texture atlas. add() returns the uv rect (u0, v0, u1, v1) of the pasted image."""

    def __init__(self, size=1024, bg=(0.0, 0.0, 0.0)):
        self.size = size; self.a = np.zeros((size, size, 3), np.float32) + np.asarray(bg, np.float32)
        self.x = 2; self.y = 2; self.rowh = 0; self.cache = {}

    def add(self, img, key=None):
        if key is not None and key in self.cache: return self.cache[key]
        h, w = img.shape[:2]; s = self.size
        if self.x + w + 2 > s: self.x = 2; self.y += self.rowh + 4; self.rowh = 0
        if self.y + h + 2 > s: raise ValueError('atlas full')
        self.a[self.y - 1:self.y + h + 1, self.x - 1:self.x + w + 1] = img[0, 0]      # bleed guard
        self.a[self.y:self.y + h, self.x:self.x + w] = img
        r = ((self.x + 0.5) / s, 1 - (self.y + h - 0.5) / s, (self.x + w - 0.5) / s, 1 - (self.y + 0.5) / s)
        self.x += w + 4; self.rowh = max(self.rowh, h)
        if key is not None: self.cache[key] = r
        return r

    def image(self, name):
        return bl.image_from_array(name, self.a[::-1], 'Linear Rec.709')


def _draw_displays(rng):
    """All instrument faces. Returns ({name: uv rect}, atlas)."""
    at = _Atlas(1024); cells = {}
    G, A, Cy, Rd, W = (np.array(c, np.float32) for c in (G_GREEN, G_AMBER, G_CYAN, G_RED, G_WHITE))
    # tactical scope
    c = _Canvas(256, 256, G * 0.012)
    yy, xx = np.mgrid[0:256, 0:256]; ang = np.arctan2(yy - 128.0, xx - 128.0); rad = np.hypot(xx - 128.0, yy - 128.0)
    sweep = np.clip(1 - ((ang - 0.9) % (2 * np.pi)) / 1.4, 0, 1) * (rad < 118)
    c.a += G * 0.22 * sweep[..., None]
    for r in (30, 59, 88, 118): c.circle(128, 128, r, G * 0.55)
    c.line(128, 8, 128, 248, G * 0.3); c.line(8, 128, 248, 128, G * 0.3)
    for i in range(12):
        a = i * np.pi / 6; c.line(128 + 112 * np.cos(a), 128 + 112 * np.sin(a), 128 + 120 * np.cos(a), 128 + 120 * np.sin(a), G)
    for bx, by in ((60, 170), (190, 150), (175, 205), (88, 96)): c.rect(bx, by, bx + 4, by + 4, G)
    c.line(120, 52, 128, 38, Rd, 2); c.line(128, 38, 136, 52, Rd, 2); c.line(136, 52, 120, 52, Rd, 2); c.circle(128, 46, 14, Rd * 0.8)
    c.text(140, 30, 'HOSTILE', Rd); c.text(6, 6, 'TAC 600M', G); c.text(196, 6, 'BRG 004', G); c.text(6, 242, 'SONAR ACT', A)
    c.rect(125, 125, 131, 131, W)
    cells['tac'] = at.add(c.a)
    # attitude / heading
    c = _Canvas(256, 192, (0.0, 0.004, 0.008))
    c.a[:96] += Cy * 0.05; c.a[96:] += A * 0.035
    c.line(0, 100, 255, 90, W, 2)
    for i, off in enumerate((-60, -40, -20, 20, 40, 60)):
        wd = 26 if i % 2 else 40; c.line(128 - wd, 95 + off, 128 + wd, 94 + off, Cy * 0.8); c.text(128 + wd + 4, 91 + off, '%d' % abs(off // 2), Cy * 0.8)
    c.line(84, 96, 112, 96, A, 3); c.line(144, 96, 172, 96, A, 3); c.rect(125, 93, 131, 99, A)
    c.rect(0, 0, 256, 18, (0, 0, 0)); c.box(0, 0, 256, 18, Cy * 0.5)
    for i in range(13): c.line(8 + i * 20, 12, 8 + i * 20, 17, Cy); c.text(2 + i * 20, 3, '%02d' % ((34 + i) % 36), Cy * 0.9) if i % 2 == 0 else None
    c.rect(4, 30, 30, 170, (0, 0, 0)); c.box(4, 30, 30, 170, G * 0.6); c.rect(226, 30, 252, 170, (0, 0, 0)); c.box(226, 30, 252, 170, G * 0.6)
    for i in range(8): c.line(22, 38 + i * 17, 29, 38 + i * 17, G); c.line(227, 38 + i * 17, 234, 38 + i * 17, G)
    c.text(6, 96, '078', G); c.text(232, 96, '22', G); c.text(96, 176, 'HDG 004  TRIM', A)
    cells['att'] = at.add(c.a)
    # text page
    c = _Canvas(256, 192, G * 0.010)
    rows = ['REACTOR   94%', 'COOLANT   71C', 'HYD A    2980', 'HYD B    2940', 'GYRO       OK', 'BALLAST   38%', 'DEPTH     22M', 'TIDE     +1.2', 'CANNON   STBY', 'SEAL L3   CHK', 'COMMS   HARBR', 'WIND  270/14']
    c.text(6, 4, 'SYS STATUS', Cy); c.line(4, 15, 252, 15, Cy * 0.6)
    for i, r in enumerate(rows): c.text(8, 22 + i * 14, r, A if i in (5, 9) else G)
    c.rect(180, 20, 250, 30, G * 0.5); c.text(184, 21, 'PAGE 2/5', (0, 0, 0))
    cells['text'] = at.add(c.a)
    # sonar waterfall
    c = _Canvas(256, 160, (0, 0.003, 0.006))
    wf = rng.random((40, 64)) ** 3; wf[:, 20:23] += 0.8; wf[:, 44] += 0.5; wf = np.kron(wf, np.ones((3, 4)))
    c.a[30:150] = (np.clip(wf, 0, 1)[..., None] * Cy * 0.8).astype(np.float32)
    xs = np.arange(0, 255); ys = 16 + 9 * np.sin(xs * 0.11) * np.sin(xs * 0.023) + rng.normal(0, 1.2, len(xs))
    for i in range(len(xs) - 1): c.line(xs[i], ys[i], xs[i + 1], ys[i + 1], G)
    c.text(4, 151, 'PASSIVE 2-8KHZ', Cy)
    cells['wave'] = at.add(c.a)
    # machine status schematic (portrait)
    c = _Canvas(160, 256, G * 0.010)
    for (x0, y0, x1, y1, col) in ((66, 14, 94, 36, G), (48, 40, 112, 110, G), (14, 44, 42, 120, A), (118, 44, 146, 120, G), (16, 124, 40, 150, A), (120, 124, 144, 150, G),
                                  (52, 114, 76, 190, G), (84, 114, 108, 190, G), (48, 194, 78, 206, G), (82, 194, 112, 206, G)):
        c.box(x0, y0, x1, y1, col * 0.9, 2)
    c.rect(18, 48, 38, 116, A * 0.25); c.rect(70, 60, 90, 80, Cy * 0.5)
    c.text(6, 214, 'L ARM  HYD LOW', A); c.text(6, 226, 'R ARM  OK', G); c.text(6, 238, 'CORE   94%', G); c.text(4, 2, 'BW-02', Cy)
    cells['sys'] = at.add(c.a)
    # bar graphs
    c = _Canvas(256, 96, G * 0.010)
    for i in range(10):
        hgt = int(18 + 52 * rng.random()); col = A if hgt > 60 else G
        c.box(10 + i * 24, 8, 26 + i * 24, 78, G * 0.4); c.rect(12 + i * 24, 76 - hgt, 24 + i * 24, 76, col * 0.9)
        c.text(11 + i * 24, 84, 'H%d' % i, G * 0.8)
    cells['bars'] = at.add(c.a)
    # annunciator grid (quiet)
    c = _Canvas(192, 96, (0.004, 0.004, 0.004))
    names = ['HYD A', 'HYD B', 'COOL', 'SEAL', 'GYRO', 'FIRE', 'BILGE', 'BUS 1', 'BUS 2', 'CANN', 'TORS', 'COMM']
    for i, nm in enumerate(names):
        x0 = 4 + (i % 4) * 47; y0 = 4 + (i // 4) * 30; lit = i in (3, 9)
        c.rect(x0, y0, x0 + 43, y0 + 26, A * (0.75 if lit else 0.035)); c.text(x0 + 4, y0 + 10, nm, (0, 0, 0) if lit else A * 0.22)
    cells['ann'] = at.add(c.a)
    # annunciator grid, everything lit (master caution)
    c = _Canvas(192, 96, (0.004, 0.004, 0.004))
    for i, nm in enumerate(names):
        x0 = 4 + (i % 4) * 47; y0 = 4 + (i // 4) * 30
        c.rect(x0, y0, x0 + 43, y0 + 26, Rd if i % 3 != 1 else A); c.text(x0 + 4, y0 + 10, nm, (0, 0, 0))
    cells['ann_hot'] = at.add(c.a)
    c = _Canvas(128, 44, Rd)
    c.text(22, 5, 'MASTER', (0.02, 0, 0), 2); c.text(16, 25, 'CAUTION', (0.02, 0, 0), 2)
    cells['caution'] = at.add(c.a)
    for i, (s, col) in enumerate((('2980', A), ('118.5', G), ('0.87', Cy), ('004', A), ('22.0', G), ('71', A))):
        c = _Canvas(96, 32, col * 0.012); c.text(8, 6, s, col, 3); cells['num%d' % i] = at.add(c.a)
    # round gauge
    c = _Canvas(96, 96, (0.006, 0.006, 0.006))
    c.circle(48, 48, 44, W * 0.5)
    for i in range(21):
        a = np.pi * 0.75 + i * np.pi * 1.5 / 20; r0 = 34 if i % 5 == 0 else 39
        c.line(48 + r0 * np.cos(a), 48 + r0 * np.sin(a), 48 + 43 * np.cos(a), 48 + 43 * np.sin(a), W * (0.9 if i < 16 else 0) + Rd * (0 if i < 16 else 1))
    c.line(48, 48, 48 + 34 * np.cos(4.1), 48 + 34 * np.sin(4.1), A, 2); c.circle(48, 48, 4, W * 0.6, fill=True); c.text(34, 66, 'PSI', W * 0.5)
    cells['gauge'] = at.add(c.a)
    c = _Canvas(256, 28, (0, 0.002, 0.004))
    for i in range(26): c.line(6 + i * 10, 18 if i % 5 else 12, 6 + i * 10, 26, Cy)
    for i in range(6): c.text(i * 50 + 2, 2, '%03d' % ((340 + i * 10) % 360), Cy)
    c.line(128, 0, 128, 27, A, 2)
    cells['strip'] = at.add(c.a)
    for nm, col in (('led_g', G), ('led_a', A), ('led_r', Rd), ('led_c', Cy), ('led_w', W), ('led_off', W * 0.01)):
        cells[nm] = at.add(np.zeros((8, 8, 3), np.float32) + col)
    return cells, at


# ------------------------------------------------------------------------------------------------ mesh builder
_BOX = {}


def _box_topo(inset):
    if inset in _BOX: return _BOX[inset]
    S = (-1, 1); desc = []; idx = {}
    for a in range(3):
        for sx in S:
            for sy in S:
                for sz in S:
                    for ring in ((0, 1) if inset else (0,)):
                        idx[(a, sx, sy, sz, ring)] = len(desc); desc.append((a, sx, sy, sz, ring))
    faces = []; kinds = []
    loop = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for a in range(3):
        o = [i for i in range(3) if i != a]
        for s in S:
            def vid(u, v, ring):
                sg = [0, 0, 0]; sg[a] = s; sg[o[0]] = u; sg[o[1]] = v
                return idx[(a, sg[0], sg[1], sg[2], ring)]
            if inset:
                faces.append([vid(u, v, 1) for u, v in loop]); kinds.append([0, 0, 0, 0])
                for i in range(4):
                    (u0, v0), (u1, v1) = loop[i], loop[(i + 1) % 4]
                    faces.append([vid(u0, v0, 0), vid(u1, v1, 0), vid(u1, v1, 1), vid(u0, v0, 1)]); kinds.append([1, 1, 0, 0])
            else:
                faces.append([vid(u, v, 0) for u, v in loop]); kinds.append([3, 3, 3, 3])
    for e in range(3):
        o = [i for i in range(3) if i != e]
        for s0 in S:
            for s1 in S:
                def vid(a, se):
                    sg = [0, 0, 0]; sg[e] = se; sg[o[0]] = s0; sg[o[1]] = s1
                    return idx[(a, sg[0], sg[1], sg[2], 0)]
                faces.append([vid(o[0], -1), vid(o[0], 1), vid(o[1], 1), vid(o[1], -1)]); kinds.append([2, 2, 2, 2])
    for sx in S:
        for sy in S:
            for sz in S:
                faces.append([idx[(a, sx, sy, sz, 0)] for a in range(3)]); kinds.append([2, 2, 2])
    d = np.array(desc); A = d[:, 0]; SG = d[:, 1:4].astype(float); RING = d[:, 4].astype(float)
    mask = (np.arange(3)[None, :] != A[:, None]).astype(float)
    P = SG * np.array([1.0, 1.3, 1.7]) - SG * mask * (0.2 + RING * 0.25)[:, None]
    for f, k in zip(faces, kinds):
        c = P[f].mean(0); nrm = np.cross(P[f[1]] - P[f[0]], P[f[2]] - P[f[0]])
        if nrm @ c < 0: f.reverse(); k.reverse()
    _BOX[inset] = (SG, mask, RING, faces, kinds)
    return _BOX[inset]


_PLAIN_F = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
_PLAIN_V = np.array([[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], float)


class _MB:
    """Accumulates primitives into one mesh with per-corner colour / wear attributes and per-face materials."""

    def __init__(self, mirror=False):
        self.V = []; self.nv = 0; self.F = []; self.fmat = []; self.fsm = []; self.col = []; self.edge = []; self.uv = []
        self.mirror = mirror; self.stack = [np.eye(4)]

    class _Ctx:
        def __init__(self, mb, M): self.mb = mb; self.M = M
        def __enter__(self): self.mb.stack.append(self.mb.stack[-1] @ self.M)
        def __exit__(self, *a): self.mb.stack.pop()

    def at(self, M):
        return _MB._Ctx(self, M)

    def tris(self):
        return sum(len(f) - 2 for f in self.F)

    def add(self, v, faces, col=C_FRAME, mat=M_PAINT, smooth=False, edge=0.1, uv=None, M=None):
        T = self.stack[-1] if M is None else self.stack[-1] @ M
        v = np.asarray(v, float) @ T[:3, :3].T + T[:3, 3]
        b = self.nv; self.V.append(v); self.nv += len(v)
        c3 = tuple(col); sl = isinstance(smooth, (list, tuple)); el = isinstance(edge, (list, tuple))
        for i, f in enumerate(faces):
            k = len(f)
            self.F.append([b + j for j in f]); self.fmat.append(mat); self.fsm.append(smooth[i] if sl else smooth)
            e = edge[i] if el else edge
            if isinstance(e, (list, tuple)): self.edge.extend(e)
            else: self.edge.extend([e] * k)
            self.col.extend([c3] * k)
            if uv is not None: self.uv.extend(uv[i])
            else: self.uv.extend([(0.0, 0.0)] * k)

    # ---- primitives
    def box(self, size, M=None, bevel=0.0, inset=0.0, edge0=0.12, **kw):
        h = np.asarray(size, float) / 2
        if bevel <= 0:
            self.add(_PLAIN_V * h, _PLAIN_F, edge=edge0, M=M, **kw); return
        b = min(bevel, 0.45 * h.min()); w = min(inset, max(0.0, 0.8 * (np.sort(h)[1] - b)))
        SG, mask, RING, faces, kinds = _box_topo(bool(w > 0))
        P = SG * h - SG * mask * (b + RING * w)[:, None]
        ev = (0.0, 0.9, 1.0, edge0)
        self.add(P, faces, edge=[[ev[k] for k in ks] for ks in kinds], M=M, **kw)

    def beam(self, p0, p1, w, d, hint, bevel=0.012, **kw):
        p0 = np.asarray(p0, float); p1 = np.asarray(p1, float)
        M = _aim((p0 + p1) / 2, p1 - p0, hint)
        self.box((w, np.linalg.norm(p1 - p0), d), M, bevel=bevel, **kw)
        return M

    def loft(self, rings, M=None, smooth=True, edge=0.1, cap0=True, cap1=True, seg_smooth=None, seg_edge=None, **kw):
        n = len(rings[0]); m = len(rings)
        V = np.concatenate([np.asarray(r, float) for r in rings])
        F = []; SM = []; ED = []
        if cap0: F.append(list(range(n - 1, -1, -1))); SM.append(False); ED.append(edge)
        for i in range(m - 1):
            s = smooth if seg_smooth is None else seg_smooth[i]; e = edge if seg_edge is None else seg_edge[i]
            for j in range(n):
                j1 = (j + 1) % n
                F.append([i * n + j, i * n + j1, (i + 1) * n + j1, (i + 1) * n + j]); SM.append(s); ED.append(e)
        if cap1: F.append([(m - 1) * n + j for j in range(n)]); SM.append(False); ED.append(edge)
        self.add(V, F, smooth=SM, edge=ED, M=M, **kw)

    def lathe(self, prof, M=None, n=12, **kw):
        a = np.arange(n) * (2 * np.pi / n); c, s = np.cos(a), np.sin(a)
        self.loft([np.stack([max(r, 1e-4) * c, max(r, 1e-4) * s, np.full(n, float(z))], 1) for r, z in prof], M, **kw)

    def cyl(self, r, h, M=None, n=12, bevel=0.0, r2=None, smooth=True, edge0=0.1, **kw):
        """Cylinder along local +Z from 0 to h."""
        r2 = r if r2 is None else r2
        if bevel > 0:
            self.lathe([(r - bevel, 0), (r, bevel), (r2, h - bevel), (r2 - bevel, h)], M, n, seg_smooth=[False, smooth, False], seg_edge=[1.0, edge0, 1.0], edge=edge0, **kw)
        else:
            self.lathe([(r, 0), (r2, h)], M, n, smooth=smooth, edge=edge0, **kw)

    def ball(self, radii, M=None, n=14, m=8, lo=-90.0, hi=90.0, **kw):
        ph = np.radians(np.linspace(max(lo, -88.0), min(hi, 88.0), m))
        rx, ry, rz = radii
        a = np.arange(n) * (2 * np.pi / n)
        rings = [np.stack([rx * np.cos(p) * np.cos(a), ry * np.cos(p) * np.sin(a), np.full(n, rz * np.sin(p))], 1) for p in ph]
        self.loft(rings, M, **kw)

    def tube(self, pts, r, M=None, n=8, round_caps=False, **kw):
        P = np.asarray(pts, float); m = len(P)
        rr = np.full(m, float(r)) if np.isscalar(r) else np.asarray(r, float)
        T = np.zeros_like(P); T[1:-1] = P[2:] - P[:-2]; T[0] = P[1] - P[0]; T[-1] = P[-1] - P[-2]
        T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
        N = np.cross(T[0], (0.0, 0.0, 1.0))
        if np.linalg.norm(N) < 0.1: N = np.cross(T[0], (1.0, 0.0, 0.0))
        N = _n(N); a = np.arange(n) * (2 * np.pi / n); ca = np.cos(a)[:, None]; sa = np.sin(a)[:, None]
        rings = []; fr = []
        for i in range(m):
            N = _n(N - (N @ T[i]) * T[i]); B = np.cross(T[i], N); fr.append((N, B))
            rings.append(P[i] + rr[i] * (ca * N + sa * B))
        if round_caps:
            for end, sgn in ((0, -1.0), (m - 1, 1.0)):
                N, B = fr[end]; ex = []
                for off, k in ((0.5, 0.87), (0.87, 0.5)):
                    ex.append(P[end] + sgn * T[end] * rr[end] * off + rr[end] * k * (ca * N + sa * B))
                rings = (ex[::-1] + rings) if end == 0 else (rings + ex)
        self.loft(rings, M, **kw)

    def strap(self, pts, width, thick, hint, **kw):
        """Flat ribbon along a polyline; hint = rough surface normal."""
        P = np.asarray(pts, float); m = len(P)
        T = np.zeros_like(P); T[1:-1] = P[2:] - P[:-2]; T[0] = P[1] - P[0]; T[-1] = P[-1] - P[-2]
        hint = np.asarray(hint, float); rings = []
        for i in range(m):
            t = _n(T[i]); h = hint[i] if hint.ndim == 2 else hint
            nz = _n(h - (h @ t) * t); sx = np.cross(t, nz)
            rings.append(np.array([P[i] - sx * width / 2 - nz * thick / 2, P[i] + sx * width / 2 - nz * thick / 2, P[i] + sx * width / 2 + nz * thick / 2, P[i] - sx * width / 2 + nz * thick / 2]))
        self.loft(rings, smooth=False, **kw)

    def prism(self, poly, h, M=None, bevel=0.0, edge0=0.12, **kw):
        """Convex polygon (CCW in local XY) extruded along +Z from 0 to h, chamfered ends."""
        p = np.asarray(poly, float); c = p.mean(0)
        def ring(k, z): return np.concatenate([c + (p - c) * k, np.full((len(p), 1), z)], 1)
        if bevel > 0:
            k = 1 - bevel / (np.linalg.norm(p - c, axis=1).mean() + 1e-9)
            self.loft([ring(k, 0), ring(1, bevel), ring(1, h - bevel), ring(k, h)], M, smooth=False, seg_edge=[1.0, edge0, 1.0], edge=edge0, **kw)
        else:
            self.loft([ring(1, 0), ring(1, h)], M, smooth=False, edge=edge0, **kw)

    def ngon_prism(self, r, h, M=None, n=8, rot=None, **kw):
        a = (np.arange(n) + 0.5) * (2 * np.pi / n) if rot is None else np.arange(n) * (2 * np.pi / n) + rot
        self.prism(np.stack([r * np.cos(a), r * np.sin(a)], 1), h, M, **kw)

    def quad(self, w, h, uvr, M=None, mat=M_DECAL, z=0.0015, col=(1, 1, 1)):
        u0, v0, u1, v1 = uvr
        if self.mirror: u0, u1 = u1, u0
        v = [(-w / 2, -h / 2, z), (w / 2, -h / 2, z), (w / 2, h / 2, z), (-w / 2, h / 2, z)]
        self.add(v, [[0, 1, 2, 3]], col=col, mat=mat, edge=0.0, uv=[[(u0, v0), (u1, v0), (u1, v1), (u0, v1)]], M=M)

    def bolt(self, x, y, z=0.0, r=0.006, M=None, col=C_STEEL, mat=M_METAL):
        Mb = _T(x, y, z) if M is None else M @ _T(x, y, z)
        self.cyl(r, r * 0.7, Mb, n=6, smooth=False, col=col, mat=mat, cap0=False, edge0=0.6)

    # ---- output
    def finish(self, name, mats, collection, parent=None):
        V = np.concatenate(self.V) if self.V else np.zeros((0, 3))
        F = self.F; col = np.asarray(self.col, np.float32); edge = np.asarray(self.edge, np.float32); uv = np.asarray(self.uv, np.float32)
        if self.mirror:
            V = V * np.array([-1.0, 1.0, 1.0])
            perm = []; s = 0
            for f in F:
                k = len(f); perm.extend(range(s + k - 1, s - 1, -1)); s += k
            F = [f[::-1] for f in F]; col = col[perm]; edge = edge[perm]; uv = uv[perm]
        ob = bl.mesh_object(name, V, F, uvs=uv, collection=collection)
        me = ob.data
        me.polygons.foreach_set('material_index', np.asarray(self.fmat, np.int32))
        me.polygons.foreach_set('use_smooth', np.asarray(self.fsm, bool))
        at = me.attributes.new('edge', 'FLOAT', 'CORNER'); at.data.foreach_set('value', edge)
        at = me.attributes.new('col', 'FLOAT_COLOR', 'CORNER'); at.data.foreach_set('color', np.concatenate([col, np.ones((len(col), 1), np.float32)], 1).ravel())
        for m in mats: me.materials.append(m)
        me.update()
        if parent is not None: ob.parent = parent
        return ob


# ------------------------------------------------------------------------------------------------ materials
def _out(node, *names):
    for nm in names:
        if nm in node.outputs: return node.outputs[nm]
    return node.outputs[0]


def _finish(n, bsdf):
    """Output with a cut-off: a diffuse bounce ray that lands on the mech stops there. The machine still receives
    bounce light, it just does not pass any on, which halves the path length inside the closed cabin and removes
    the worst indirect noise at 16 samples."""
    dead = n.new('ShaderNodeBsdfDiffuse', inputs={'Color': (0.0, 0.0, 0.0, 1.0)})
    mix = n.new('ShaderNodeMixShader', inputs={0: n.new('ShaderNodeLightPath').outputs['Is Diffuse Ray'], 1: bsdf.outputs[0], 2: dead.outputs[0]})
    n.output(mix.outputs[0])


def _mat_paint(name, scale, img=None, rough=0.5, coat=0.0, wear=1.0, glow_at=None):
    mat, n = bl.material(name)
    P = n.new('ShaderNodeTexCoord').outputs['Object']
    edge = _out(n.new('ShaderNodeAttribute', attribute_name='edge'), 'Fac', 'Factor')
    base = _out(n.new('ShaderNodeAttribute', attribute_name='col'), 'Color') if img is None else n.new('ShaderNodeTexImage', image=img).outputs['Color']
    big = n.new('ShaderNodeTexNoise', inputs={'Vector': P, 'Scale': scale, 'Detail': 2.0, 'Roughness': 0.6}).outputs[0]
    fine = n.new('ShaderNodeTexNoise', inputs={'Vector': P, 'Scale': scale * 11.0, 'Detail': 1.0, 'Roughness': 0.6}).outputs[0]
    grime = n.ramp(big, [(0.36, 1.0), (0.72, 0.45)])
    mul = n.new('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={0: 1.0, 6: base, 7: grime}).outputs[2]
    m = n.math('ADD', n.math('MULTIPLY', edge, 0.80 * wear), n.math('MULTIPLY', fine, 0.55))
    w = n.ramp(m, [(0.97, 0.0), (1.06, 1.0)])
    col = n.mix(w, mul, (0.42, 0.40, 0.37, 1.0))
    rgh = n.mix(w, n.math('ADD', rough - 0.12, n.math('MULTIPLY', big, 0.28)), 0.42, 'FLOAT')
    p = bl.principled(n, Base_Color=col, Metallic=n.math('MULTIPLY', w, 0.9), Roughness=rgh, Coat_Weight=coat, Coat_Roughness=0.15)
    k = None
    if glow_at is not None:
        # the cannon's glow on its own forearm, painted in the shader (a point light this close to the surface is the
        # noisiest thing in the frame at 16 samples): lambert falloff from a point in object space, camera rays only
        k = n.new('ShaderNodeValue'); k.outputs[0].default_value = 0.0
        to = n.vmath('SUBTRACT', tuple(glow_at), P); d = n.vmath('LENGTH', to)
        ndl = n.math('MAXIMUM', n.vmath('DOT_PRODUCT', n.new('ShaderNodeTexCoord').outputs['Normal'], n.vmath('NORMALIZE', to)), 0.0)
        att = n.math('DIVIDE', 1.0, n.math('ADD', 1.0, n.math('MULTIPLY', n.math('MULTIPLY', d, d), 1.0 / 10.0)))
        cam = n.new('ShaderNodeLightPath').outputs['Is Camera Ray']
        n.set(p.inputs['Emission Color'], n.new('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={0: 1.0, 6: mul, 7: (0.30, 0.88, 1.0, 1.0)}).outputs[2])
        n.set(p.inputs['Emission Strength'], n.math('MULTIPLY', n.math('MULTIPLY', n.math('MULTIPLY', ndl, att), k.outputs[0]), cam))
        mat.cycles.emission_sampling = 'NONE'
    _finish(n, p)
    return (mat, k) if glow_at is not None else mat


def _mat_simple(name, scale, rough, metallic=0.0, coat=0.0):
    mat, n = bl.material(name)
    P = n.new('ShaderNodeTexCoord').outputs['Object']
    base = _out(n.new('ShaderNodeAttribute', attribute_name='col'), 'Color')
    big = n.new('ShaderNodeTexNoise', inputs={'Vector': P, 'Scale': scale, 'Detail': 1.0, 'Roughness': 0.6}).outputs[0]
    col = n.new('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', inputs={0: 1.0, 6: base, 7: n.ramp(big, [(0.3, 1.0), (0.75, 0.6)])}).outputs[2]
    p = bl.principled(n, Base_Color=col, Metallic=metallic, Roughness=n.math('ADD', rough - 0.08, n.math('MULTIPLY', big, 0.2)), Coat_Weight=coat, Coat_Roughness=0.1)
    _finish(n, p)
    return mat


def _mat_display(name, img, gain=1.6):
    """Emissive screen: seen by the camera only (never a light source). Returns (material, strength node, glitch node)."""
    mat, n = bl.material(name)
    uv = n.new('ShaderNodeTexCoord').outputs['UV']
    k = n.new('ShaderNodeValue'); k.outputs[0].default_value = 1.0
    g = n.new('ShaderNodeValue'); g.outputs[0].default_value = 0.0
    sep = n.new('ShaderNodeSeparateXYZ', inputs={0: uv})
    row = n.new('ShaderNodeTexNoise', noise_dimensions='2D', inputs={'Vector': n.new('ShaderNodeCombineXYZ', inputs={0: g.outputs[0], 1: n.math('MULTIPLY', sep.outputs[1], 900.0)}).outputs[0], 'Scale': 1.0, 'Detail': 0.0}).outputs[0]
    du = n.math('MULTIPLY', n.math('SUBTRACT', row, 0.5), n.math('MULTIPLY', g.outputs[0], 0.02))
    uv2 = n.new('ShaderNodeCombineXYZ', inputs={0: n.math('ADD', sep.outputs[0], du), 1: sep.outputs[1]}).outputs[0]
    tex = n.new('ShaderNodeTexImage', image=img, inputs={'Vector': uv2}).outputs['Color']
    cam = n.new('ShaderNodeLightPath').outputs['Is Camera Ray']
    p = bl.principled(n, Base_Color=(0.004, 0.004, 0.005, 1), Roughness=0.22, Emission_Color=tex, Emission_Strength=n.math('MULTIPLY', n.math('MULTIPLY', k.outputs[0], gain), cam))
    n.output(p.outputs[0]); mat.cycles.emission_sampling = 'NONE'
    return mat, k, g


def _mat_glow(name, color, seg=False, attr_color=False):
    """Camera-only glow. seg=True: lights up progressively along the 'edge' attribute as the level value rises."""
    mat, n = bl.material(name)
    k = n.new('ShaderNodeValue'); k.outputs[0].default_value = 0.0
    cam = n.new('ShaderNodeLightPath').outputs['Is Camera Ray']
    s = k.outputs[0]
    if seg:
        e = _out(n.new('ShaderNodeAttribute', attribute_name='edge'), 'Fac', 'Factor')
        s = n.math('ADD', n.math('MULTIPLY', n.math('MULTIPLY', n.math('SUBTRACT', k.outputs[0], e), 14.0, clamp=True), 1.5), 0.02)
    col = _out(n.new('ShaderNodeAttribute', attribute_name='col'), 'Color') if attr_color else tuple(color) + (1.0,)
    p = bl.principled(n, Base_Color=(0.01, 0.012, 0.014, 1), Roughness=0.3, Emission_Color=col, Emission_Strength=n.math('MULTIPLY', s, cam))
    n.output(p.outputs[0]); mat.cycles.emission_sampling = 'NONE'
    return mat, k


# ------------------------------------------------------------------------------------------------ cockpit
class _Cab(_MB):
    """Mesh builder with instrument-panel widgets. Widgets are placed in panel-local coords (x right, y up, z out)."""

    def __init__(self, cells, decals, rng, **kw):
        super().__init__(**kw); self.cells = cells; self.decals = decals; self.rng = rng; self.nscreen = 0

    def label_uv(self, text, fg=C_WHITE, bg=C_DARK, scale=2, pad=3):
        key = (text, tuple(fg), tuple(bg), scale)
        if key in self.decals.cache: return self.decals.cache[key]
        g = _text(text, scale); h, w = g.shape
        im = np.zeros((h + 2 * pad, w + 2 * pad, 3), np.float32) + np.asarray(bg, np.float32)
        im[pad:pad + h, pad:pad + w][g] = fg
        r = self.decals.add(im, key); self.decals.cache[key] = r; self.decals.cache[('asp',) + key] = im.shape[1] / im.shape[0]
        return r

    def label(self, x, y, text, h=0.012, fg=C_WHITE, bg=C_DARK, z=0.0012, scale=2, M=None):
        r = self.label_uv(text, fg, bg, scale); asp = self.decals.cache[('asp', text, tuple(fg), tuple(bg), scale)]
        Mq = _T(x, y, 0) if M is None else M @ _T(x, y, 0)
        self.quad(h * asp, h, r, Mq, z=z)

    def hazard(self, x, y, w, h, z=0.0012, M=None, key='haz'):
        r = self.decals.cache[key]; u0, v0, u1, v1 = r
        frac = min(1.0, (w / h) / 8.0)                       # the tile is 8:1; crop it to keep the stripes at 45 degrees
        Mq = _T(x, y, 0) if M is None else M @ _T(x, y, 0)
        self.quad(w, h, (u0, v0, u0 + (u1 - u0) * frac, v1), Mq, z=z)

    def screen(self, x, y, w, h, cell, keys=True, group=None):
        g = (M_DA, M_DB, M_DC)[self.nscreen % 3] if group is None else group; self.nscreen += 1
        self.box((w + 0.036, h + 0.036, 0.022), _T(x, y, 0.011), bevel=0.004, col=C_DARK)
        self.quad(w, h, self.cells[cell], _T(x, y, 0.022), mat=g, z=0.0006)
        if keys:
            nk = max(2, int(w / 0.045))
            for i in range(nk):
                kx = x - w / 2 + (i + 0.5) * w / nk
                self.box((0.016, 0.009, 0.006), _T(kx, y - h / 2 - 0.009, 0.024), bevel=0.0015, col=C_PLATE)
        for sx in (-1, 1):
            for sy in (-1, 1): self.bolt(x + sx * (w / 2 + 0.011), y + sy * (h / 2 + 0.011), 0.022, r=0.0035)

    def led(self, x, y, color='led_g', s=0.006, z=0.002, group=M_DA):
        self.quad(s, s, self.cells[color], _T(x, y, 0), mat=group, z=z)

    def toggle(self, x, y, up=None):
        up = self.rng.random() < 0.6 if up is None else up
        self.cyl(0.0075, 0.005, _T(x, y, 0), n=6, smooth=False, col=C_STEEL, mat=M_METAL, cap0=False, edge0=0.5)
        a = 0.42 if up else -0.42
        self.cyl(0.0032, 0.024, _T(x, y, 0.004) @ _RX(-a), n=6, r2=0.0042, col=C_STEEL, mat=M_METAL, cap0=False)

    def knob(self, x, y, r=0.011):
        self.cyl(r, 0.016, _T(x, y, 0), n=12, bevel=0.002, col=C_DARK, cap0=False)
        self.box((0.003, r * 1.1, 0.002), _T(x, y, 0.016) @ _RZ(self.rng.uniform(-2, 2)) @ _T(0, r * 0.45, 0.001), col=C_WHITE)

    def button(self, x, y, s=0.013, lit=None):
        self.box((s, s, 0.007), _T(x, y, 0.0035), bevel=0.0015, col=C_PLATE)
        if lit: self.led(x, y, lit, s * 0.55, z=0.0075)

    def plate(self, x, y, w, h, col=C_PANEL, t=0.006):
        self.box((w, h, t), _T(x, y, t / 2), bevel=0.0015, col=col, edge0=0.2)
        for sx in (-1, 1):
            for sy in (-1, 1): self.bolt(x + sx * (w / 2 - 0.012), y + sy * (h / 2 - 0.012), t, r=0.004)

    def switch_row(self, x0, x1, y, pitch=0.032, labels=True, z=0.0):
        with self.at(_T(0, 0, z)):
            for i, x in enumerate(np.arange(x0, x1 + 1e-6, pitch)):
                self.toggle(x, y)
                if labels and i % 2 == 0: self.label(x + pitch / 2, y + 0.021, self.rng.choice(_WORDS), h=0.0075, z=0.0008)

    def handle(self, M, length=0.24, stand=0.055, r=0.011, col=C_STEEL, mat=M_METAL):
        """Grab handle along local Y, standing off along +Z."""
        h = length / 2; s = stand
        self.tube([(0, -h, 0), (0, -h, s * 0.75), (0, -h + s * 0.3, s), (0, h - s * 0.3, s), (0, h, s * 0.75), (0, h, 0)], r, M, n=8, col=col, mat=mat)
        for sy in (-1, 1): self.cyl(r * 1.9, 0.006, M @ _T(0, sy * h, 0), n=8, col=col, mat=mat, cap0=False)


_WORDS = ['HYD', 'BUS', 'PUMP', 'GYRO', 'AUX', 'VENT', 'SEAL', 'XFER', 'ISOL', 'LAMP', 'COOL', 'BILGE', 'STAB', 'FEED', 'ARM', 'TRIM', 'SONR', 'COMM', 'NAV', 'PWR']


def _build_cockpit(mb):
    """Everything fixed in the cabin, in eye coordinates (origin at the pilot's eye)."""
    R = mb.rng
    nin = _n((0.0, -0.943, -0.333))                      # windshield plane normal, pointing into the cabin
    # ---- canopy frame: A pillars, header, sill, quarter windows
    for sx in (-1, 1):
        pb = np.array([sx * 2.15, 2.2, -1.0]); pt = np.array([sx * 1.25, 1.5, 0.98])
        M = mb.beam(pb + nin * 0.09, pt + nin * 0.09, 0.18, 0.26, nin, bevel=0.022, inset=0.035, col=C_FRAME)
        for y in np.arange(-1.0, 1.01, 0.16):
            for bx in (-0.058, 0.058): mb.bolt(bx, y, 0.13, r=0.009, M=M)
        mb.handle(M @ _T(0, 0.12, 0.13), 0.30, 0.06, 0.012)
        mb.tube([(-sx * 0.115, y, 0.02) for y in np.linspace(-1.08, 1.08, 6)], 0.017, M, n=8, col=C_DARK, mat=M_FABRIC)
        mb.tube([(-sx * 0.115, y, 0.058) for y in np.linspace(-1.08, 1.08, 6)], 0.010, M, n=6, col=(0.20, 0.05, 0.03), mat=M_FABRIC)
        for y in np.arange(-0.9, 0.95, 0.36): mb.box((0.05, 0.03, 0.085), M @ _T(-sx * 0.115, y, 0.04), bevel=0.004, col=C_STEEL, mat=M_METAL)
        mb.hazard(0, -0.62, 0.15, 0.075, z=0.1315, M=M)
        mb.label(0, -0.50, 'NO HANDHOLD', 0.022, z=0.1315, M=M)
        mb.label(0, 0.36, 'FRAME %d' % (4 if sx > 0 else 3), 0.02, bg=C_FRAME, fg=C_DARK, z=0.1315, M=M)
        if sx < 0:                                           # port pillar: fire bottle in its bracket, laminated checklist on a clip
            red = (0.42, 0.022, 0.016)
            mb.box((0.07, 0.30, 0.012), M @ _T(0, -0.27, 0.136), bevel=0.003, col=C_PLATE)
            mb.cyl(0.046, 0.23, M @ _T(0, -0.40, 0.19) @ ALONG_Y, n=14, bevel=0.008, col=red, mat=M_GLOSS)
            mb.ball((0.046, 0.046, 0.03), M @ _T(0, -0.17, 0.19) @ ALONG_Y, n=14, m=5, lo=0, col=red, mat=M_GLOSS, cap0=False)
            mb.cyl(0.017, 0.045, M @ _T(0, -0.145, 0.19) @ ALONG_Y, n=8, col=C_STEEL, mat=M_METAL)
            mb.box((0.02, 0.085, 0.012), M @ _T(0, -0.085, 0.215) @ _RX(0.25), bevel=0.003, col=C_DARK)
            mb.box((0.018, 0.06, 0.01), M @ _T(0, -0.095, 0.175), bevel=0.003, col=C_DARK)
            for by in (-0.36, -0.22): mb.cyl(0.049, 0.018, M @ _T(0, by, 0.19) @ ALONG_Y, n=14, col=C_STEEL, mat=M_METAL, cap0=False, cap1=False)
            mb.quad(0.125, 0.18, mb.decals.cache['card'], M @ _T(0, 0.56, 0) @ _RZ(0.05), z=0.134)
            mb.box((0.05, 0.022, 0.012), M @ _T(0.003, 0.652, 0.138), bevel=0.003, col=C_STEEL, mat=M_METAL)
        # quarter window: B pillar, header and sill
        bb = np.array([sx * 2.6, 1.0, -1.0]); bt = np.array([sx * 1.75, 0.75, 0.98]); qn = _n(np.cross(bb - pb, (0, 0, 1.0))) * sx
        Mb = mb.beam(bb + qn * 0.07, bt + qn * 0.07, 0.18, 0.2, qn, bevel=0.02, inset=0.03, col=C_FRAME)
        for y in np.arange(-0.9, 0.91, 0.2): mb.bolt(0, y, 0.10, r=0.009, M=Mb)
        mb.beam(pt + qn * 0.06, bt + qn * 0.06, 0.16, 0.2, qn, bevel=0.02, col=C_FRAME)
        mb.beam(pb + qn * 0.05, bb + qn * 0.05, 0.12, 0.16, qn, bevel=0.015, col=C_FRAME)
        # shell: upper side wall, lower walls
        mb.add([bb, (sx * 2.6, -1.3, -1.0), (sx * 1.75, -1.3, 1.04), bt + (0, 0, 0.06)], [[0, 1, 2, 3]], col=C_WALL, edge=0.0)
        mb.add([pb, bb, bb + (0, 0, -0.6), pb + (0, 0, -0.6)], [[0, 1, 2, 3]], col=C_WALL, edge=0.0)
        mb.add([bb, (sx * 2.6, -1.3, -1.0), (sx * 2.6, -1.3, -1.6), bb + (0, 0, -0.6)], [[0, 1, 2, 3]], col=C_WALL, edge=0.0)
        # side console along the wall (out of the forward view, there for sideways glances)
        mb.box((0.7, 1.9, 0.75), _T(sx * 2.22, 0.05, -0.98), bevel=0.02, col=C_PANEL)
        Ms = _pface((sx * 2.2, 0.1, -0.602), (0, sx, 0), (-sx, 0, 0))
        with mb.at(Ms):
            mb.screen(-0.45 * sx, 0.0, 0.26, 0.2, 'text' if sx < 0 else 'bars')
            mb.switch_row(-0.1, 0.5, 0.12); mb.switch_row(-0.1, 0.5, -0.02, labels=False)
            for i in range(5): mb.knob(-0.08 + i * 0.07, -0.14)
    Mh = mb.beam(np.array([-1.36, 1.5, 0.98]) + nin * 0.10, np.array([1.36, 1.5, 0.98]) + nin * 0.10, 0.24, 0.26, nin, bevel=0.022, inset=0.035, col=C_FRAME)
    Mh = Mh @ _RZ(np.pi / 2)                          # local x along the header (+X), y up the windshield, z into the cabin
    for x in np.arange(-1.1, 1.11, 0.14):
        for by in (-0.08, 0.08): mb.bolt(x, by, 0.13, r=0.009, M=Mh)
    mb.beam(np.array([-2.2, 2.2, -1.0]) + nin * 0.05, np.array([2.2, 2.2, -1.0]) + nin * 0.05, 0.12, 0.16, nin, bevel=0.015, col=C_FRAME)
    # roof, rear wall, floor, front lower wall
    mb.add([(-1.25, 1.5, 1.04), (1.25, 1.5, 1.04), (1.75, 0.75, 1.04), (1.75, -1.3, 1.04), (-1.75, -1.3, 1.04), (-1.75, 0.75, 1.04)], [[0, 5, 4, 3, 2, 1]], col=C_WALL, edge=0.0)
    mb.add([(-2.6, -1.3, -1.6), (2.6, -1.3, -1.6), (1.75, -1.3, 1.04), (-1.75, -1.3, 1.04)], [[0, 1, 2, 3]], col=C_WALL, edge=0.0)
    mb.add([(-2.6, -1.3, -1.6), (2.6, -1.3, -1.6), (2.6, 1.0, -1.6), (2.15, 2.2, -1.6), (-2.15, 2.2, -1.6), (-2.6, 1.0, -1.6)], [[0, 1, 2, 3, 4, 5]], col=C_DARK, edge=0.0)
    mb.add([(-2.15, 2.2, -1.0), (2.15, 2.2, -1.0), (2.15, 2.2, -1.6), (-2.15, 2.2, -1.6)], [[0, 1, 2, 3]], col=C_WALL, edge=0.0)
    # roof ribs and conduits (seen when looking up)
    for y in (0.0, -0.6): mb.beam((-1.75, y, 1.0), (1.75, y, 1.0), 0.08, 0.08, (0, 0, -1), bevel=0.01, col=C_FRAME)
    for sx in (-1, 1):
        mb.tube([(sx * 0.95, -1.2, 0.99), (sx * 0.95, 0.9, 0.99), (sx * 1.0, 1.25, 0.97), (sx * 1.05, 1.42, 0.9)], 0.022, n=8, col=C_DARK, mat=M_FABRIC)
        mb.tube([(sx * 1.02, -1.2, 0.99), (sx * 1.02, 0.85, 0.99), (sx * 1.1, 1.2, 0.97)], 0.012, n=6, col=C_STEEL, mat=M_METAL)
    # wipers parked outside along the sill
    for sx in (-1, 1):
        mb.tube([(sx * 1.1, 2.27, -0.99), (sx * 0.85, 2.262, -0.955), (sx * 0.2, 2.268, -0.925)], 0.009, n=6, col=C_DARK, mat=M_METAL)
        mb.beam((sx * 0.75, 2.262, -0.965), (sx * 0.02, 2.275, -0.93), 0.02, 0.032, nin, bevel=0.003, col=C_DARK, mat=M_FABRIC)
        mb.cyl(0.03, 0.05, _T(sx * 1.1, 2.27, -1.0), n=8, col=C_DARK, mat=M_METAL)

    # ---- main console (pilot): body, lip, rail
    prof = [(1.01, -0.535), (1.01, -0.56), (1.05, -0.56), (0.86, -1.05), (0.86, -1.6), (2.2, -1.6), (2.2, -1.0)]
    mb.loft([np.array([(x, y, z) for y, z in prof]) for x in (-2.3, 0.5)], smooth=False, col=C_PANEL, edge=0.05)
    mb.tube([(-2.2, 1.0, -0.537), (0.5, 1.0, -0.537)], 0.024, n=10, col=C_DARK, mat=M_FABRIC)
    mb.tube([(-1.25, 1.075, -0.535), (-1.25, 1.075, -0.497), (-1.22, 1.075, -0.487), (0.32, 1.075, -0.487), (0.35, 1.075, -0.497), (0.35, 1.075, -0.535)], 0.011, n=8, col=C_STEEL, mat=M_METAL)
    for x in (-0.72, -0.2): mb.cyl(0.009, 0.045, _T(x, 1.075, -0.535), n=6, col=C_STEEL, mat=M_METAL)
    for x in np.arange(-2.0, 0.45, 0.25): mb.bolt(x, 1.13, 0, r=0.008, M=_pface((0, 0, -0.5795), (1, 0, 0), _n((0, 1.19, -0.465))))
    # dash-top pods: heading repeater (left) and master caution (centre-left)
    Mp = _T(-0.86, 1.2, -0.59)
    mb.box((0.30, 0.2, 0.15), Mp @ _T(0, 0, 0.075), bevel=0.012, inset=0.02, col=C_PANEL)
    with mb.at(_pface((-0.86, 1.099, -0.515), (1, 0, 0), (0, 0, 1))):
        mb.quad(0.25, 0.034, mb.cells['strip'], _T(0, 0.012, 0), mat=M_DB, z=0.001)
        for i in range(4): mb.led(-0.09 + i * 0.06, -0.028, ('led_g', 'led_g', 'led_a', 'led_g')[i], 0.007)
    mb.box((0.15, 0.1, 0.075), _T(-0.3, 1.13, -0.53), bevel=0.008, col=C_PANEL)
    with mb.at(_pface((-0.3, 1.079, -0.525), (1, 0, 0), (0, 0, 1))):
        mb.quad(0.12, 0.044, mb.cells['caution'], mat=M_WARN, z=0.001)
    # instrument face
    Yp = _n((0.0, 0.19, 0.49)); P = _pface((0.0, 1.05, -0.56), (1, 0, 0), Yp)
    with mb.at(P):
        mb.screen(0.0, -0.145, 0.30, 0.215, 'att'); mb.screen(-0.345, -0.16, 0.25, 0.25, 'tac'); mb.screen(0.345, -0.17, 0.17, 0.27, 'sys')
        mb.screen(-0.715, -0.145, 0.30, 0.215, 'text'); mb.screen(-1.075, -0.09, 0.30, 0.11, 'bars'); mb.screen(-1.45, -0.135, 0.30, 0.19, 'wave')
        mb.screen(-1.82, -0.10, 0.26, 0.13, 'ann', keys=False)
        for i in range(3):
            mb.box((0.10, 0.042, 0.014), _T(-1.18 + i * 0.105, -0.205, 0.007), bevel=0.003, col=C_DARK)
            mb.quad(0.085, 0.028, mb.cells['num%d' % i], _T(-1.18 + i * 0.105, -0.205, 0.014), mat=M_DC, z=0.0005)
        for gx in (-1.92, -1.78, -1.64):
            mb.cyl(0.048, 0.016, _T(gx, -0.245, 0), n=20, bevel=0.003, col=C_DARK, cap0=False)
            mb.quad(0.082, 0.082, mb.cells['gauge'], _T(gx, -0.245, 0.016), mat=M_DA, z=0.0005)
        # lower modules: knobs, switches, keys
        xs = np.arange(-2.08, 0.4, 0.31)
        for i, x in enumerate(xs):
            xc = x + 0.155
            mb.plate(xc, -0.415, 0.30, 0.20, col=C_PLATE if i % 2 else C_PANEL)
            kind = i % 4
            with mb.at(_T(0, 0, 0.006)):
                if kind == 0:
                    mb.switch_row(xc - 0.11, xc + 0.11, -0.365); mb.switch_row(xc - 0.11, xc + 0.11, -0.455)
                elif kind == 1:
                    for j in range(4): mb.knob(xc - 0.10 + j * 0.066, -0.36, 0.013); mb.label(xc - 0.10 + j * 0.066, -0.385, R.choice(_WORDS), 0.007)
                    for j in range(7): mb.button(xc - 0.11 + j * 0.036, -0.455, lit=R.choice(['led_g', 'led_a', None, None]))
                elif kind == 2:
                    for a in range(4):
                        for b in range(3): mb.button(xc - 0.10 + a * 0.024, -0.375 - b * 0.024, 0.017)
                    mb.switch_row(xc + 0.02, xc + 0.12, -0.375, labels=True)
                    mb.box((0.085, 0.04, 0.012), _T(xc + 0.07, -0.455, 0.006), bevel=0.003, col=C_DARK)
                    mb.quad(0.075, 0.027, mb.cells['num%d' % (3 + i % 3)], _T(xc + 0.07, -0.455, 0.012), mat=M_DB, z=0.0005)
                else:
                    mb.box((0.05, 0.06, 0.03), _T(xc - 0.09, -0.37, 0.015), bevel=0.004, col=ORANGE)            # guarded switch
                    mb.hazard(xc - 0.09, -0.42, 0.075, 0.018); mb.label(xc - 0.09, -0.445, 'JETTISON', 0.008)
                    mb.switch_row(xc - 0.02, xc + 0.12, -0.365)
                    for j in range(5): mb.led(xc - 0.02 + j * 0.033, -0.43, R.choice(['led_g', 'led_g', 'led_a', 'led_off']), 0.008, group=M_DC)
                    mb.label(xc + 0.05, -0.465, 'BUS TIE', 0.008)
        mb.label(0.0, -0.022, 'ATT / HDG', 0.009); mb.label(-0.345, -0.022, 'TAC', 0.009); mb.label(-0.715, -0.022, 'SYS', 0.009)

    # ---- centre pedestal with levers
    mb.box((0.26, 1.72, 0.86), _T(0.63, 1.36, -1.17), bevel=0.018, inset=0.03, col=C_PANEL)
    with mb.at(_pface((0.63, 1.2, -0.74), (1, 0, 0), (0, 1, 0))):
        mb.plate(0, 0.0, 0.22, 0.34, col=C_PLATE)
        for i, (lx, la, lc) in enumerate(((-0.06, 0.35, ORANGE), (0.0, 0.1, C_WHITE), (0.06, -0.25, C_YEL))):
            mb.box((0.012, 0.22, 0.004), _T(lx, 0.0, 0.007), col=C_DARK)
            Ml = _T(lx, 0.0, 0.0) @ _RX(-la)
            mb.box((0.014, 0.02, 0.12), Ml @ _T(0, 0, 0.06), bevel=0.003, col=C_STEEL, mat=M_METAL)
            mb.box((0.042, 0.04, 0.034), Ml @ _T(0, 0, 0.125), bevel=0.008, col=lc)
        mb.plate(0, 0.34, 0.22, 0.26, col=C_PANEL)
        for a in range(4):
            for b in range(4): mb.button(-0.06 + a * 0.04, 0.26 + b * 0.04, 0.026)
        mb.screen(0, 0.47 + 0.07, 0.15, 0.05, 'num4', keys=False)
        mb.plate(0, -0.30, 0.22, 0.2, col=C_PANEL)
        mb.box((0.06, 0.07, 0.035), _T(-0.05, -0.29, 0.02), bevel=0.005, col=ORANGE); mb.hazard(-0.05, -0.345, 0.09, 0.02, z=0.007); mb.label(-0.05, -0.24, 'CANNON ARM', 0.009, z=0.007)
        for j in range(2): mb.knob(0.05, -0.26 - j * 0.07, 0.016)
        mb.hazard(0, 0.69, 0.22, 0.03, z=0.0015); mb.label(0, 0.73, 'KEEP CLEAR', 0.014, z=0.0015)
    # ---- co-pilot station: console under the right half of the windshield
    prof = [(1.84, -0.78), (1.86, -0.80), (1.76, -1.20), (1.76, -1.6), (2.2, -1.6), (2.2, -0.92)]
    mb.loft([np.array([(x, y, z) for y, z in prof]) for x in (0.76, 2.3)], smooth=False, col=C_PANEL, edge=0.05)
    mb.tube([(0.76, 1.835, -0.782), (2.2, 1.835, -0.782)], 0.02, n=8, col=C_DARK, mat=M_FABRIC)
    with mb.at(_pface((1.4, 1.86, -0.80), (1, 0, 0), _n((0, 0.10, 0.40)))):
        mb.screen(-0.50, -0.13, 0.20, 0.17, 'wave'); mb.screen(-0.22, -0.13, 0.26, 0.19, 'tac'); mb.screen(0.12, -0.12, 0.26, 0.17, 'text'); mb.screen(0.45, -0.12, 0.26, 0.17, 'sys')
        mb.switch_row(-0.6, 0.6, -0.28); mb.switch_row(-0.6, 0.6, -0.34, labels=False)
    # ---- overhead panel
    prof = [(0.25, 0.92), (1.32, 0.80), (1.32, 1.04), (0.25, 1.04)]
    mb.loft([np.array([(x, y, z) for y, z in prof]) for x in (-0.6, 0.6)], smooth=False, col=C_PANEL, edge=0.05)
    mb.beam((-0.62, 1.325, 0.805), (0.62, 1.325, 0.805), 0.04, 0.04, (0, -1, -1), bevel=0.008, col=C_FRAME)
    Yo = _n((0.0, -1.07, 0.12)); PO = _pface((0.0, 1.32, 0.80), (1, 0, 0), Yo)
    with mb.at(PO):
        for sx in (-1, 1):
            mb.handle(_T(sx * 0.635, 0.35, -0.01), 0.42, 0.05, 0.012)
            mb.beam((sx * 0.6, 0.0, 0.0), (sx * 0.6, 1.07, 0.0), 0.035, 0.03, (0, 0, 1), bevel=0.006, col=C_FRAME)
        for i in range(16):
            x = -0.525 + i * 0.07
            mb.box((0.055, 0.026, 0.008), _T(x, 0.05, 0.004), bevel=0.002, col=C_DARK)
            mb.quad(0.046, 0.018, mb.cells[('led_g', 'led_off', 'led_a', 'led_off', 'led_g', 'led_g', 'led_off', 'led_c')[i % 8]], _T(x, 0.05, 0.008), mat=M_DC, z=0.0005)
        mb.quad(0.16, 0.06, mb.cells['caution'], _T(0.0, 0.335, 0.0), mat=M_WARN, z=0.004)
        mb.box((0.18, 0.08, 0.006), _T(0.0, 0.335, 0.0), bevel=0.002, col=C_DARK)
        mb.switch_row(-0.53, 0.53, 0.115, pitch=0.045); mb.switch_row(-0.53, 0.53, 0.20, pitch=0.045, labels=False)
        mb.plate(-0.34, 0.34, 0.44, 0.14, col=C_PLATE); mb.plate(0.34, 0.34, 0.44, 0.14, col=C_PLATE)
        mb.screen(-0.36, 0.34, 0.20, 0.06, 'num1', keys=False); mb.screen(0.36, 0.34, 0.20, 0.06, 'num3', keys=False)
        for kx in (-0.16, 0.12, 0.17): mb.knob(kx, 0.34, 0.013)
        for row in range(4):
            y = 0.48 + row * 0.085
            if row % 2 == 0:
                mb.switch_row(-0.53, 0.53, y, pitch=0.05, labels=(row == 0))
            else:
                for i in range(24): mb.cyl(0.008, 0.012, _T(-0.52 + i * 0.045, y, 0), n=8, bevel=0.002, col=C_DARK if R.random() < 0.85 else C_WHITE, cap0=False)
        mb.plate(0, 0.90, 1.1, 0.22, col=C_PLATE)
        mb.screen(-0.3, 0.9, 0.3, 0.11, 'bars', keys=False); mb.screen(0.3, 0.9, 0.2, 0.13, 'ann', keys=False)
        mb.hazard(0.0, 1.035, 1.1, 0.03, z=0.002); mb.label(0.0, 0.995, 'EMERG BUS ISOLATION', 0.012, z=0.007)
    # header fittings: jettison handle (right), compass (left)
    with mb.at(Mh @ _T(0, 0, 0.13)):
        mb.box((0.16, 0.11, 0.05), _T(0.86, 0.0, 0.025), bevel=0.006, col=C_PLATE)
        mb.hazard(0.86, 0.0, 0.15, 0.09, z=0.051)
        mb.handle(_T(0.86, 0.0, 0.05) @ _RZ(np.pi / 2), 0.11, 0.04, 0.009, col=ORANGE, mat=M_PAINT)
        mb.label(0.86, -0.085, 'CANOPY JETT', 0.016, z=0.001)
        mb.cyl(0.055, 0.07, _T(-0.86, 0.0, 0.0), n=14, bevel=0.006, col=C_DARK)
        mb.quad(0.085, 0.085, mb.cells['gauge'], _T(-0.86, 0.0, 0.07), mat=M_DB, z=0.0006)
        mb.label(-0.86, -0.085, 'STBY HDG', 0.016, z=0.001)
    # ---- co-pilot seat and yoke
    Ms = _T(1.05, 1.06, -0.84) @ _RX(0.13)
    mb.box((0.50, 0.085, 0.62), Ms, bevel=0.02, inset=0.035, col=C_SEAT)
    for sx in (-1, 1):
        mb.box((0.035, 0.03, 0.66), Ms @ _T(sx * 0.2, -0.055, 0.0), bevel=0.006, col=C_FRAME)
        mb.box((0.07, 0.16, 0.5), Ms @ _T(sx * 0.27, 0.07, -0.04), bevel=0.02, col=C_SEAT, mat=M_FABRIC)
    mb.box((0.20, 0.05, 0.10), Ms @ _T(0, -0.062, 0.2), bevel=0.01, col=C_PLATE)                           # harness reel
    mb.hazard(0, 0.0, 0.18, 0.045, z=0.0, M=Ms @ _T(0, -0.0885, 0.2) @ _RX(np.pi / 2) @ _RZ(np.pi))
    mb.box((0.36, 0.05, 0.36), Ms @ _T(0, -0.05, -0.08), bevel=0.008, col=C_PLATE)
    mb.label(0, 0, 'SEAT 2', 0.03, bg=C_PLATE, z=0.0, M=Ms @ _T(0, -0.0765, -0.08) @ _RX(np.pi / 2) @ _RZ(np.pi))
    mb.box((0.19, 0.075, 0.15), Ms @ _T(0, -0.005, 0.385), bevel=0.02, col=C_SEAT, mat=M_FABRIC)             # headrest
    for sx in (-1, 1): mb.box((0.025, 0.03, 0.12), Ms @ _T(sx * 0.06, -0.03, 0.33), col=C_STEEL, mat=M_METAL)
    mb.box((0.5, 0.5, 0.10), _T(1.05, 1.3, -1.10), bevel=0.02, col=C_SEAT, mat=M_FABRIC)
    mb.box((0.36, 0.4, 0.42), _T(1.05, 1.25, -1.37), bevel=0.02, col=C_PLATE)
    mb.tube([(1.05, 1.95, -1.05), (1.05, 1.86, -0.80), (1.05, 1.80, -0.675)], 0.026, n=8, col=C_DARK)
    mb.box((0.09, 0.05, 0.06), _T(1.05, 1.79, -0.665), bevel=0.01, col=C_PLATE)
    for sx in (-1, 1):
        mb.tube([(1.05, 1.785, -0.665), (1.05 + sx * 0.11, 1.775, -0.67), (1.05 + sx * 0.158, 1.76, -0.645), (1.05 + sx * 0.162, 1.75, -0.60), (1.05 + sx * 0.162, 1.745, -0.52)],
                [0.016, 0.016, 0.018, 0.021, 0.021], n=8, col=C_DARK, mat=M_FABRIC)
        mb.box((0.02, 0.02, 0.012), _T(1.05 + sx * 0.162, 1.742, -0.512), bevel=0.003, col=ORANGE)


def _build_copilot(body, head):
    """The second pilot. `body` verts are relative to the hip pivot, `head` verts to the neck pivot (eye coords)."""
    hip = np.array([1.05, 1.22, -1.0]); neck = np.array([1.05, 1.255, -0.40])

    def ring(c, rx, ry, n=16, e=2.6):
        a = np.arange(n) * (2 * np.pi / n); ca, sa = np.cos(a), np.sin(a)
        return np.stack([c[0] + rx * np.sign(ca) * np.abs(ca) ** (2 / e), c[1] + ry * np.sign(sa) * np.abs(sa) ** (2 / e), np.full(n, c[2])], 1)

    with body.at(_T(-hip)):
        secs = [((1.05, 1.22, -1.04), .19, .125), ((1.05, 1.225, -0.88), .168, .112), ((1.05, 1.235, -0.72), .188, .12), ((1.05, 1.245, -0.60), .205, .122),
                ((1.05, 1.25, -0.53), .198, .108), ((1.05, 1.25, -0.485), .125, .088), ((1.05, 1.252, -0.455), .07, .07), ((1.05, 1.258, -0.36), .06, .062)]
        body.loft([ring(c, rx, ry) for c, rx, ry in secs], col=C_SUIT, mat=M_FABRIC)
        for sx in (-1, 1):
            body.ball((0.078, 0.072, 0.07), _T(1.05 + sx * 0.212, 1.252, -0.545), n=12, m=7, col=C_SUIT, mat=M_FABRIC)
            sh = np.array([1.05 + sx * 0.222, 1.26, -0.55]); el = np.array([1.05 + sx * 0.275, 1.46, -0.775]); wr = np.array([1.05 + sx * 0.168, 1.69, -0.615])
            pts = [sh, sh * 0.5 + el * 0.5, sh * 0.12 + el * 0.88, el * 0.86 + wr * 0.14, el * 0.5 + wr * 0.5, wr]
            body.tube(pts, [0.06, 0.056, 0.052, 0.05, 0.045, 0.038], n=10, round_caps=True, col=C_SUIT, mat=M_FABRIC)
            body.box((0.085, 0.07, 0.012), _aim(sh * 0.55 + el * 0.45 + (sx * 0.05, -0.02, 0.02), el - sh, (sx, -0.3, 0.3)), bevel=0.003, col=C_ARM2)          # sleeve pocket / patch
            body.tube([wr - (wr - el) * 0.25, wr], [0.043, 0.041], n=10, col=C_GLOVE, mat=M_FABRIC)                                                             # glove cuff
            body.ball((0.046, 0.058, 0.05), _T(1.05 + sx * 0.163, 1.737, -0.592), n=10, m=6, col=C_GLOVE, mat=M_FABRIC)                                       # glove on the grip
        # life-preserver collar (international orange) and harness
        half = [(0.965, 1.385, -0.74), (0.955, 1.385, -0.62), (0.945, 1.34, -0.515), (0.955, 1.26, -0.462), (0.99, 1.195, -0.452), (1.05, 1.172, -0.45)]
        full = half + [(2.1 - x, y, z) for x, y, z in half[-2::-1]]
        body.tube(full, 0.044, n=8, round_caps=True, col=tuple(c * 0.8 for c in ORANGE), mat=M_FABRIC)
        for sx in (-1, 1):
            pts = [(1.05 + sx * 0.075, 1.085, -0.60), (1.05 + sx * 0.10, 1.135, -0.505), (1.05 + sx * 0.15, 1.24, -0.478), (1.05 + sx * 0.16, 1.33, -0.52), (1.05 + sx * 0.13, 1.368, -0.64), (1.05 + sx * 0.08, 1.372, -0.8)]
            body.strap(pts, 0.046, 0.007, np.array([(0, -1, 0.4), (0, -0.6, 1), (0, 0, 1), (0, 0.6, 1), (0, 1, 0.2), (0, 1, 0)], float), col=C_DARK, mat=M_FABRIC)
            body.box((0.05, 0.02, 0.035), _T(1.05 + sx * 0.152, 1.262, -0.468), bevel=0.004, col=C_STEEL, mat=M_METAL)                                          # strap adjuster
        # legs (mostly hidden behind the pedestal)
        for sx in (-1, 1):
            body.tube([(1.05 + sx * 0.1, 1.24, -1.0), (1.05 + sx * 0.12, 1.5, -0.97), (1.05 + sx * 0.13, 1.68, -1.0), (1.05 + sx * 0.13, 1.8, -1.35)], [0.085, 0.075, 0.065, 0.05], n=10, round_caps=True, col=C_SUIT, mat=M_FABRIC)
    # ---- helmet
    hc = np.array([1.05, 1.272, -0.232])
    with head.at(_T(hc - neck) @ _RZ(0.30) @ _RX(-0.07)):
        a, b, c = 0.132, 0.152, 0.136
        head.ball((a, b, c), n=20, m=11, lo=-52, col=C_HELM, mat=M_GLOSS)
        def patch(az0, az1, el0, el1, k, na=12, ne=5, **kw):
            az = np.radians(np.linspace(az0, az1, na)); el = np.radians(np.linspace(el0, el1, ne)); V = []; F = []
            for e in el:
                for z in az: V.append((a * k * np.cos(e) * np.sin(z), b * k * np.cos(e) * np.cos(z), c * k * np.sin(e)))
            for i in range(ne - 1):
                for j in range(na - 1): F.append([i * na + j + 1, i * na + j, (i + 1) * na + j, (i + 1) * na + j + 1])
            head.add(V, F, smooth=True, **kw)
        patch(-78, 78, -24, 24, 1.03, col=(0.01, 0.012, 0.016), mat=M_GLOSS)                      # visor
        patch(-84, 84, 24, 60, 1.065, col=tuple(x * 0.8 for x in C_HELM), mat=M_GLOSS)             # visor housing
        patch(-84, 84, 20, 26, 1.075, ne=2, col=C_DARK, mat=M_FABRIC)
        th = np.radians(np.linspace(-40, 215, 22)); w = 0.02; k = np.sqrt(1 - (w / a) ** 2) * 1.012
        V = [(sx * w, b * k * np.cos(t), c * k * np.sin(t)) for t in th for sx in (-1, 1)]
        head.add(V, [[2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2] for i in range(len(th) - 1)], smooth=True, col=ORANGE, mat=M_GLOSS)       # centre stripe
        for sx in (-1, 1):
            head.cyl(0.056, 0.03, _T(sx * 0.118, -0.005, -0.045) @ _RY(sx * np.pi / 2), n=12, bevel=0.008, col=C_DARK, mat=M_GLOSS)       # ear cups
            head.box((0.02, 0.05, 0.03), _T(sx * 0.146, 0.02, -0.03), bevel=0.004, col=C_STEEL, mat=M_METAL)
        head.tube([(-0.105, -0.085, -0.108), (-0.06, -0.125, -0.115), (0, -0.14, -0.117), (0.06, -0.125, -0.115), (0.105, -0.085, -0.108)], 0.024, n=8, round_caps=True, col=C_DARK, mat=M_FABRIC)
        head.ball((0.062, 0.07, 0.065), _T(0, 0.118, -0.085), n=10, m=6, col=C_DARK, mat=M_FABRIC)                                       # mask
        head.tube([(0, 0.15, -0.12), (0.02, 0.17, -0.19), (0.05, 0.14, -0.28)], 0.022, n=8, col=C_DARK, mat=M_FABRIC)                   # hose
        head.tube([(-0.13, -0.02, -0.08), (-0.15, -0.06, -0.15), (-0.13, -0.09, -0.24)], 0.008, n=6, col=C_DARK, mat=M_FABRIC)          # comm lead
        head.ball((0.058, 0.06, 0.07), _T(0, 0.0, -0.13), n=10, m=5, col=C_DARK, mat=M_FABRIC)                                           # neck / balaclava
    return hip, neck


# ------------------------------------------------------------------------------------------------ arms
L1 = 24.0          # shoulder -> elbow
L2 = 28.0          # elbow -> centre of the fist
FIST_HALF = 4.3    # fist centre -> knuckle face
RAM_U = np.array([0.0, 10.0, -3.0])     # ram anchor on the upper arm (upper frame)
RAM_F = np.array([0.0, 5.0, -3.0])      # ram anchor on the forearm yoke (yoke frame)
RAM_X = 4.55
MUZZLE = np.array([0.0, 25.9, 5.5])     # in the forearm frame


def _plate(mb, size, M, col=C_ARM, bolts=True, r=0.14, **kw):
    """Armour plate lying in local XY (thickness along Z) with a bolt in each corner."""
    mb.box(size, M, bevel=min(0.22, size[2] * 0.3), inset=0.55, col=col, **kw)
    if bolts:
        hx, hy = size[0] / 2 - 0.5, size[1] / 2 - 0.5
        nx = max(1, int(round(2 * hx / 1.25))); ny = max(1, int(round(2 * hy / 1.25)))
        pts = [(-hx + 2 * hx * i / nx, sy * hy) for i in range(nx + 1) for sy in (-1, 1)] + [(sx * hx, -hy + 2 * hy * j / ny) for j in range(1, ny) for sx in (-1, 1)]
        for x, y in pts: mb.bolt(x, y, size[2] / 2, r=r, M=M)


def _railing(mb, p0, p1, up, height=1.1, pitch=1.5):
    p0 = np.asarray(p0, float); p1 = np.asarray(p1, float); up = _n(up); n = max(2, int(np.linalg.norm(p1 - p0) / pitch) + 1)
    for i in range(n):
        p = p0 + (p1 - p0) * i / (n - 1)
        mb.add(np.array([p + d for d in ((-.04, -.04, 0), (.04, -.04, 0), (.04, .04, 0), (-.04, .04, 0))] + [p + up * height + d for d in ((-.04, -.04, 0), (.04, -.04, 0), (.04, .04, 0), (-.04, .04, 0))]),
               _PLAIN_F, col=C_YEL, edge=0.3)
    for h in (height, height * 0.55): mb.tube([p0 + up * h, p1 + up * h], 0.045, n=5, col=C_YEL, cap0=False, cap1=False)


def _build_upper(mb):
    """Upper arm: origin at the shoulder, +Y to the elbow, X = elbow hinge axis, +Z = outside of the bend."""
    mb.ball((5.2, 5.2, 5.2), n=18, m=10, col=C_ARM_D)
    _plate(mb, (11.5, 10.0, 1.5), _T(0, 1.5, 5.6), col=C_ARM)
    for sx in (-1, 1): _plate(mb, (9.0, 9.0, 1.3), _T(sx * 5.5, 1.5, 0.5) @ _RY(sx * np.pi / 2), col=C_ARM2)
    mb.ngon_prism(3.0, 17.0, _T(0, 3.5, 0) @ ALONG_Y, n=8, bevel=0.3, col=C_ARM_D)
    _plate(mb, (5.8, 6.5, 1.0), _T(0, 8.3, 3.4)); _plate(mb, (5.8, 6.5, 1.0), _T(0, 15.3, 3.4), col=C_ARM2)
    for sx in (-1, 1):
        _plate(mb, (5.4, 6.3, 1.0), _T(sx * 3.5, 8.3, 0.3) @ _RY(sx * np.pi / 2))
        _plate(mb, (5.4, 6.3, 1.0), _T(sx * 3.5, 15.0, 0.3) @ _RY(sx * np.pi / 2), col=C_ARM2)
        mb.box((1.3, 7.0, 5.8), _T(sx * 3.4, 21.0, 0), bevel=0.25, inset=0.5, col=C_ARM)
        mb.cyl(3.5, 1.3, _T(sx * 3.4 - 0.65, L1, 0) @ ALONG_X, n=20, bevel=0.2, col=C_ARM)
        mb.cyl(1.7, 0.6, _T(sx * 4.05 - (0.6 if sx < 0 else 0), L1, 0) @ ALONG_X, n=12, bevel=0.12, col=C_ARM_D)
        for i in range(8):
            a = i * np.pi / 4; mb.bolt(0, 0, 0, r=0.2, M=_T(sx * 4.05, L1 + 2.6 * np.cos(a), 2.6 * np.sin(a)) @ _RY(sx * np.pi / 2))
        mb.box((1.2, 2.2, 2.4), _T(sx * RAM_X, RAM_U[1], RAM_U[2] + 0.5), bevel=0.2, col=C_ARM_D)
    mb.cyl(1.55, 8.6, _T(-4.3, L1, 0) @ ALONG_X, n=12, col=C_STEEL, mat=M_METAL)
    mb.box((2 * RAM_X + 1.2, 1.5, 1.5), _T(RAM_U[0], RAM_U[1], RAM_U[2] + 1.1), bevel=0.2, col=C_ARM_D)
    for x in (-1.3, 0, 1.3): mb.tube([(x, 4.0, -3.15), (x, 20.0, -3.15)], 0.3, n=6, col=C_DARK, mat=M_FABRIC)
    for y in (6, 13, 18.5): mb.box((4.6, 0.5, 0.8), _T(0, y, -3.1), bevel=0.1, col=C_ARM_D)


def _build_yoke(mb):
    """Forearm root: origin at the elbow, +Y to the fist, X = hinge axis. Carries the ram ends and the roll bearing."""
    mb.cyl(3.1, 5.3, _T(-2.65, 0, 0) @ ALONG_X, n=20, bevel=0.2, col=C_ARM_D)
    mb.ngon_prism(2.7, 4.0, _T(0, 1.4, 0) @ ALONG_Y, n=8, bevel=0.2, col=C_ARM_D)
    mb.cyl(3.45, 0.9, _T(0, 4.6, 0) @ ALONG_Y, n=24, bevel=0.15, col=C_ARM2)
    mb.box((2 * RAM_X + 1.2, 1.5, 1.5), _T(0, RAM_F[1], RAM_F[2] + 0.9), bevel=0.2, col=C_ARM_D)
    for sx in (-1, 1): mb.box((1.2, 2.2, 2.4), _T(sx * RAM_X, RAM_F[1], RAM_F[2] + 0.4), bevel=0.2, col=C_ARM_D)


def _build_ram(barrel, rod, blen):
    for sx in (-1, 1):
        barrel.cyl(0.85, blen, _T(sx * RAM_X, 0, 0) @ ALONG_Y, n=12, bevel=0.08, col=C_ARM2)
        barrel.cyl(1.0, 0.7, _T(sx * RAM_X, blen - 0.7, 0) @ ALONG_Y, n=12, bevel=0.08, col=C_ARM_D)
        barrel.cyl(1.0, 0.5, _T(sx * RAM_X, 0.6, 0) @ ALONG_Y, n=12, bevel=0.08, col=ORANGE)
        barrel.cyl(0.9, 1.5, _T(sx * RAM_X - 0.75, 0, 0) @ ALONG_X, n=10, bevel=0.1, col=C_ARM_D)
        barrel.tube([(sx * (RAM_X - 0.9), 0.8, 0.5), (sx * (RAM_X - 1.0), blen * 0.5, 0.7), (sx * (RAM_X - 0.9), blen - 1, 0.5)], 0.16, n=5, col=C_DARK, mat=M_FABRIC)
        rod.cyl(0.46, 1.0, _T(sx * RAM_X, 0, 0) @ ALONG_Y, n=10, col=(0.75, 0.75, 0.74), mat=M_METAL, cap0=False, cap1=False)
    return barrel, rod


def _build_fore(mb, right, glow=None):
    """Forearm + fist: origin at the elbow, +Y to the fist, +Z = back of the hand. `right` adds the cannon."""
    side = 'STBD' if right else 'PORT'
    mb.cyl(3.5, 1.0, _T(0, 5.5, 0) @ ALONG_Y, n=24, bevel=0.15, col=C_ARM)
    for i in range(12):
        a = i * np.pi / 6; mb.bolt(0, 0, 0, r=0.17, M=_T(3.0 * np.cos(a), 6.5, 3.0 * np.sin(a)) @ ALONG_Y)
    mb.ngon_prism(2.55, 15.6, _T(0, 6.4, 0) @ ALONG_Y, n=8, bevel=0.25, col=C_ARM_D)
    for sx in (-1, 1):
        Ma = _T(sx * 3.05, 10.5, 0.2) @ _RY(sx * np.pi / 2); Mb2 = _T(sx * 3.05, 17.9, 0.2) @ _RY(sx * np.pi / 2)
        _plate(mb, (4.9, 7.0, 0.9), Ma); _plate(mb, (4.5, 7.0, 0.9), Mb2, col=C_ARM2)
        Md = _frame((sx * 3.51, 0, 0.2), (0, sx, 0), (0, 0, 1), (sx, 0, 0))            # decal frame on the side face: x along the arm
        mb.label(sx * 10.6, 0.3, '%s 0%d' % (side, 2 if right else 1), 1.5, fg=C_WHITE, bg=C_ARM, z=0.01, M=Md, scale=4)
        mb.hazard(sx * 20.4, 0.0, 1.0, 4.0, z=0.012, M=Md, key='haz_v')
        mb.label(sx * 16.6, -1.4, 'NO STEP', 0.5, fg=C_DARK, bg=C_ARM2, z=0.012, M=Md)
        mb.label(sx * 16.9, 1.2, 'HYD 3000 PSI', 0.42, fg=C_DARK, bg=C_ARM2, z=0.012, M=Md)
    # underside: plates, service ladder, hydraulic runs
    _plate(mb, (4.6, 6.8, 0.8), _T(0, 10.4, -2.95) @ _RX(np.pi)); _plate(mb, (4.6, 6.6, 0.8), _T(0, 17.8, -2.95) @ _RX(np.pi), col=C_ARM2)
    for x in (-1.75, 1.75): mb.tube([(x, 6.6, -3.5), (x, 21.6, -3.5)], 0.28, n=6, col=C_DARK, mat=M_FABRIC)
    for x in (-0.45, 0.45): mb.tube([(x, 7.0, -3.5), (x, 21.2, -3.5)], 0.06, n=4, col=C_YEL, cap0=False, cap1=False)
    for y in np.arange(7.2, 21.2, 0.45): mb.add(_PLAIN_V * (0.45, 0.04, 0.04) + (0, y, -3.5), _PLAIN_F, col=C_YEL, edge=0.3)
    mb.label(0, -14.1, 'LIFT POINT', 0.5, fg=C_DARK, bg=C_ARM2, z=0.012, M=_frame((0, 0, -3.36), (1, 0, 0), (0, -1, 0), (0, 0, -1)))
    # wrist
    n = 24; a = np.arange(n) * 2 * np.pi / n
    for i in range(n):
        a0, a1 = a[i] - np.pi / n, a[i] + np.pi / n
        V = [(3.45 * np.cos(t), y, 3.45 * np.sin(t)) for y in (21.7, 22.9) for t in (a0, a1)]
        mb.add(V, [[0, 2, 3, 1]], col=ORANGE if i % 2 else C_DARK, edge=0.25)
    mb.cyl(3.4, 1.3, _T(0, 21.65, 0) @ ALONG_Y, n=24, col=C_ARM_D); mb.cyl(3.6, 0.35, _T(0, 21.4, 0) @ ALONG_Y, n=24, bevel=0.1, col=C_ARM); mb.cyl(3.6, 0.35, _T(0, 22.9, 0) @ ALONG_Y, n=24, bevel=0.1, col=C_ARM)
    mb.cyl(2.5, 1.3, _T(0, 23.2, 0) @ ALONG_Y, n=16, col=C_ARM_D)
    # navigation light (starboard green, port red)
    mb.box((0.7, 1.0, 0.7), _T(3.75, 20.6, 2.0), bevel=0.1, col=C_ARM_D)
    mb.ball((0.3, 0.3, 0.3), _T(4.15, 20.6, 2.0), n=8, m=5, col=G_GREEN if right else G_RED, mat=M_NAV)
    # ---- fist
    _plate(mb, (7.6, 4.6, 5.8), _T(0, 26.4, 0.2), col=C_ARM2, bolts=False)
    _plate(mb, (7.9, 4.3, 0.9), _T(0, 26.5, 3.45), col=C_ARM, r=0.2)
    mb.hazard(0, 26.5, 6.4, 0.8, z=3.91, key='haz')
    for sx in (-1, 1): _plate(mb, (4.6, 3.6, 0.7), _T(sx * 3.95, 26.5, 0.1) @ _RY(sx * np.pi / 2), col=C_ARM, r=0.16)
    for i, x in enumerate((-2.85, -0.95, 0.95, 2.85)):
        d = (0.0, 0.25, 0.15, -0.2)[i]
        mb.cyl(1.32, 1.74, _T(x - 0.87, 28.9, 2.0) @ ALONG_X, n=12, bevel=0.12, col=C_ARM_D)
        mb.box((1.72, 3.0, 2.3), _T(x, 30.2 + d, 1.85) @ _RX(-0.12), bevel=0.2, inset=0.3, col=C_ARM)
        mb.box((1.45, 2.0, 0.4), _T(x, 30.2 + d, 3.05) @ _RX(-0.12), bevel=0.1, col=C_ARM2)
        mb.cyl(1.08, 1.74, _T(x - 0.87, 31.55 + d, 1.35) @ ALONG_X, n=10, bevel=0.1, col=C_ARM_D)
        mb.box((1.72, 1.9, 2.8), _T(x, 31.4 + d, -0.35), bevel=0.2, inset=0.3, col=C_ARM)
        mb.cyl(0.95, 1.74, _T(x - 0.87, 31.2 + d, -1.95) @ ALONG_X, n=10, bevel=0.1, col=C_ARM_D)
        mb.box((1.72, 2.6, 1.7), _T(x, 29.9 + d, -2.55), bevel=0.2, inset=0.3, col=C_ARM)
    mb.box((1.9, 4.2, 2.1), _T(-4.0, 28.6, -1.9) @ _RZ(-0.25), bevel=0.25, inset=0.3, col=C_ARM)
    mb.cyl(1.1, 2.0, _T(-5.0, 27.0, -1.6), n=10, bevel=0.1, col=C_ARM_D)
    mb.box((3.6, 1.8, 1.7), _T(-2.3, 30.6, -4.0), bevel=0.25, inset=0.3, col=C_ARM)
    if not right:
        # port arm: bulwark plate along the back of the forearm, with a catwalk
        _plate(mb, (7.6, 15.6, 1.1), _T(0, 14.0, 3.55), col=C_ARM, r=0.2)
        for y in (8.5, 14.0, 19.5): mb.box((7.0, 0.6, 0.5), _T(0, y, 4.3), bevel=0.12, col=C_ARM2)
        for y in (6.6, 21.4): mb.hazard(0, y, 7.2, 0.9, z=4.12, key='haz')
        mb.label(0, 11.2, 'PORT 01', 1.4, fg=C_WHITE, bg=C_ARM, z=4.12, scale=4)
        _railing(mb, (-3.5, 6.6, 4.1), (-3.5, 21.4, 4.1), (0, 0, 1)); _railing(mb, (3.5, 6.6, 4.1), (3.5, 21.4, 4.1), (0, 0, 1))
        for y in (9.6, 16.6):
            mb.box((2.2, 2.6, 0.5), _T(-1.6, y + 1.6, 4.3), bevel=0.1, col=C_ARM_D)                  # hatches
            mb.handle(_T(-1.6, y + 1.6, 4.55), 1.0, 0.25, 0.06)
        return
    # ---- starboard arm: the cannon on the back of the forearm
    _plate(mb, (6.0, 14.6, 0.8), _T(0, 14.0, 3.0), col=C_ARM2, bolts=False)
    for y in (8.0, 14.6): mb.box((3.2, 2.4, 1.6), _T(0, y, 3.9), bevel=0.2, col=C_ARM_D)
    mb.box((4.8, 11.4, 3.4), _T(0, 11.2, 5.5), bevel=0.35, inset=0.6, col=C_ARM)
    for sx in (-1, 1):
        for y in np.arange(7.0, 15.6, 0.9): mb.box((0.25, 0.5, 2.0), _T(sx * 2.45, y, 5.5), bevel=0.06, col=C_ARM_D)         # side louvres
        mb.label(sx * 11.4, 6.9, 'DANGER  HV', 0.45, fg=ORANGE, bg=C_ARM, z=0.02, M=_frame((sx * 2.41, 0, 0), (0, sx, 0), (0, 0, 1), (sx, 0, 0)))
        mb.tube([(sx * 1.5, 5.6, 4.6), (sx * 1.6, 3.6, 4.2), (sx * 1.7, 2.6, 2.9)], 0.42, n=8, col=C_DARK, mat=M_FABRIC)                              # power trunks
        _railing(mb, (sx * 2.25, 6.0, 7.2), (sx * 2.25, 16.4, 7.2), (0, 0, 1))
    for y in np.arange(6.4, 9.6, 0.55): mb.box((3.4, 0.22, 0.6), _T(0, y, 7.45), bevel=0.05, col=C_ARM_D)                     # cooling fins
    mb.hazard(0, 15.9, 4.0, 0.7, z=7.215, key='haz'); mb.label(0, 12.0, 'CANNON 1', 0.8, fg=C_DARK, bg=C_ARM, z=7.215, scale=3)
    mb.box((1.6, 2.2, 0.4), _T(0.6, 13.6, 7.4), bevel=0.08, col=C_ARM_D); mb.handle(_T(0.6, 13.6, 7.6), 0.9, 0.22, 0.05)
    mb.ngon_prism(1.7, 4.2, _T(0, 16.9, MUZZLE[2]) @ ALONG_Y, n=8, bevel=0.2, col=C_ARM_D)
    for y in (17.4, 18.9, 20.4): mb.cyl(1.95, 0.5, _T(0, y, MUZZLE[2]) @ ALONG_Y, n=16, bevel=0.1, col=C_ARM)
    for i in range(4):
        a = np.pi / 4 + i * np.pi / 2; mb.box((0.5, 4.9, 0.7), _T(1.55 * np.cos(a), 23.4, MUZZLE[2] + 1.55 * np.sin(a)) @ _RY(-a + np.pi / 2), bevel=0.1, col=C_ARM)
    for y in (21.6, 22.6, 23.6, 24.6): glow.cyl(1.25, 0.28, _T(0, y, MUZZLE[2]) @ ALONG_Y, n=14, col=C_STEEL, mat=M_METAL)
    mb.lathe([(1.5, 0), (2.0, 0.15), (2.0, 0.7), (1.75, 0.9), (1.2, 0.9), (1.2, 0.3)], _T(0, 25.0, MUZZLE[2]) @ ALONG_Y, n=16, smooth=False, col=C_ARM, cap1=False, edge=0.5)
    # glowing parts go into their own object (it casts no shadow, so the light inside the cage gets out)
    glow.cyl(0.85, 4.3, _T(0, 20.9, MUZZLE[2]) @ ALONG_Y, n=12, col=G_CYAN, mat=M_CORE)
    glow.cyl(1.15, 0.05, _T(0, 25.35, MUZZLE[2]) @ ALONG_Y, n=14, col=G_CYAN, mat=M_CORE)
    for i in range(8):
        y = 7.3 + i * 1.08
        for (x, z, rot) in ((-1.7, 7.215, None), (-2.415, 6.55, 'side')):
            V = np.array([(-0.3, -0.42, 0), (0.3, -0.42, 0), (0.3, 0.42, 0), (-0.3, 0.42, 0)], float)
            Mq = _T(x, y, z) if rot is None else _frame((x, y, z), (0, -1, 0), (0, 0, 1), (-1, 0, 0)) @ _RZ(np.pi / 2)
            glow.add(V, [[0, 1, 2, 3]], col=G_CYAN, mat=M_SEG, edge=(i + 0.5) / 8.5, M=Mq)


# ------------------------------------------------------------------------------------------------ arm choreography
def _K(sh, fist, hint, up):
    return np.array([*sh, *fist, *hint, *up], float)


def _ease(kind, u):
    u = min(max(u, 0.0), 1.0)
    if kind == 'io': return u * u * (3 - 2 * u)
    if kind == 'in': return u ** 1.6
    if kind == 'out': return 1 - (1 - u) ** 2.2
    return u


def _track(keys, t):
    if t <= keys[0][0]: return keys[0][1]
    for (t0, k0, _), (t1, k1, e) in zip(keys, keys[1:]):
        if t <= t1: return k0 + (k1 - k0) * _ease(e, (t - t0) / (t1 - t0))
    return keys[-1][1]


SHOULDER = np.array([20.0, 0.0, 64.0])     # right shoulder in the torso frame (z from the feet); mirror x for the left
K_IDLE = _K((0, 0, 0), (14.5, 31.0, 61.0), (27, 2, 40), (0.5, -0.3, 1))


# ------------------------------------------------------------------------------------------------ the machine
class Mech:
    """The machine as seen from its own head. Build it after the scene exists (bl.reset / stage.make).

    root   Empty at the feet: set root.location = (x, y, SEA_FLOOR) and root.rotation_euler.z = heading (0 faces +Y).
    pose() sets everything else; eye(), fist(), knuckles(), muzzle(), aim(), basis() report world-space results of
    the last pose() with the root's current location / heading.
    """
    EYE_HEIGHT = 78.0      # pilot's eye above the feet
    REACH = 60.0           # ahead of the centre line: where the knuckles are when a punch lands
    # dur = length of a one-shot state, hit = seconds from its start to the impact.
    DUR = {'punch': {'dur': 0.62, 'hit': 0.24}, 'slam': {'dur': 0.95, 'hit': 0.42}, 'fire': {'dur': 0.5}}
    # block / charge are holds: 'in' = seconds to come up from idle, 'out' = seconds to go back once released.
    HOLD = {'block': {'in': 0.22, 'out': 0.30}, 'charge': {'in': 0.36, 'out': 0.40}}

    def __init__(self):
        rng = np.random.default_rng(7)
        sc = bpy.context.scene
        self.coll = bpy.data.collections.new('mech'); sc.collection.children.link(self.coll)
        self.coll_arms = bpy.data.collections.new('mech_arms'); self.coll.children.link(self.coll_arms)
        self.root = bpy.data.objects.new('mech_root', None); self.coll.objects.link(self.root)
        self.torso = bpy.data.objects.new('mech_torso', None); self.coll.objects.link(self.torso); self.torso.parent = self.root
        E = np.array([0.0, 0.0, self.EYE_HEIGHT])
        self._E = E; self._tm = np.eye(4)

        # ---- textures
        cells, datlas = _draw_displays(rng)
        decals = _Atlas(1024, C_DARK)
        hz = np.zeros((32, 256, 3), np.float32); yy, xx = np.mgrid[0:32, 0:256]
        hz[:] = np.where((((xx + yy) // 16) % 2 == 0)[..., None], np.asarray(ORANGE, np.float32), np.asarray(C_DARK, np.float32))
        decals.cache['haz'] = decals.add(hz)
        decals.cache['haz_v'] = decals.add(np.ascontiguousarray(hz[:, :128].transpose(1, 0, 2)))
        card = _Canvas(92, 132, (0.42, 0.42, 0.37))
        card.rect(0, 0, 92, 13, ORANGE); card.text(8, 3, 'WADE CHECK', (0.5, 0.5, 0.45))
        for i, ln in enumerate(('1 BALLAST SET', '2 GYRO ALIGN', '3 SEALS GRN', '4 HYD A/B ON', '5 ARMS FREE', '6 CANNON SAFE', '7 SONAR ACT', '8 HARBOR CTL', '9 CREW 2 RDY')):
            card.text(5, 20 + i * 12, ln, (0.02, 0.02, 0.025))
        decals.cache['card'] = decals.add(card.a)

        # ---- geometry
        cab = _Cab(cells, decals, rng); _build_cockpit(cab)
        body = _Cab(cells, decals, rng); head = _Cab(cells, decals, rng); hip, neck = _build_copilot(body, head)
        parts = {}
        for side, nm in ((1, 'R'), (-1, 'L')):
            mk = lambda: _Cab(cells, decals, rng, mirror=(side < 0))
            up, yo, fo, ba, ro, gl = mk(), mk(), mk(), mk(), mk(), mk()
            _build_upper(up); _build_yoke(yo); _build_fore(fo, side > 0, gl); _build_ram(ba, ro, self._BARREL)
            parts[nm] = dict(upper=up, yoke=yo, fore=fo, barrel=ba, rod=ro)
            if side > 0: parts[nm]['glow'] = gl
        self.tris = cab.tris() + body.tris() + head.tris() + sum(p.tris() for d in parts.values() for p in d.values())

        # ---- materials
        dimg = datlas.image('mech_displays'); kimg = decals.image('mech_decals')
        self._disp = [_mat_display('mech_disp%d' % i, dimg) for i in range(3)]
        warn = _mat_display('mech_warn', dimg, gain=3.0); self._warn = warn
        core = _mat_glow('mech_core', G_CYAN); seg = _mat_glow('mech_seg', (0.35, 0.9, 1.0), seg=True); nav = _mat_glow('mech_nav', (1, 1, 1), attr_color=True)
        nav[1].outputs[0].default_value = 6.0
        self._core = core; self._seg = seg
        metal_c = _mat_simple('mech_metal_cab', 6.0, 0.32, metallic=1.0); fabric = _mat_simple('mech_fabric', 9.0, 0.85); gloss = _mat_simple('mech_gloss', 5.0, 0.28, coat=0.6)
        cab_mats = [_mat_paint('mech_paint_cab', 5.0, rough=0.5), metal_c, fabric, gloss, _mat_paint('mech_decal_cab', 5.0, img=kimg, rough=0.55, wear=0.0),
                    self._disp[0][0], self._disp[1][0], self._disp[2][0], warn[0], core[0], seg[0], nav[0]]
        arm_mats = [_mat_paint('mech_paint_arm', 0.22, rough=0.42, coat=0.35), _mat_simple('mech_metal_arm', 0.3, 0.25, metallic=1.0), _mat_simple('mech_rubber_arm', 0.4, 0.7), gloss,
                    _mat_paint('mech_decal_arm', 0.22, img=kimg, rough=0.45, coat=0.35, wear=0.0), self._disp[0][0], self._disp[1][0], self._disp[2][0], warn[0], core[0], seg[0], nav[0]]

        gp = (0.0, 23.2, MUZZLE[2])
        fg = [_mat_paint('mech_paint_cannon', 0.22, rough=0.42, coat=0.35, glow_at=gp), _mat_paint('mech_decal_cannon', 0.22, img=kimg, rough=0.45, coat=0.35, wear=0.0, glow_at=gp)]
        self._fglow = [m[1] for m in fg]
        fore_mats = [fg[0][0]] + arm_mats[1:4] + [fg[1][0]] + arm_mats[5:]
        # ---- objects
        self.cab = cab.finish('mech_cockpit', cab_mats, self.coll, self.torso); self.cab.location = E
        self.body = body.finish('mech_copilot', cab_mats, self.coll, self.torso); self.head = head.finish('mech_copilot_head', cab_mats, self.coll, self.torso)
        self._hip = E + hip; self._neck = E + neck
        self.body.location = self._hip; self.head.location = self._neck
        self.arm = {}
        for nm, d in parts.items():
            self.arm[nm] = {k: mb.finish('mech_arm%s_%s' % (nm, k), fore_mats if (nm, k) == ('R', 'fore') else arm_mats, self.coll_arms, self.torso) for k, mb in d.items()}
        self.arm['R']['glow'].visible_shadow = False

        # ---- lights (all under the torso so they ride with the cabin)
        self._lights = {}
        self._area('dome', (0.0, -0.75, 0.86), (0.1, 1.5, -0.35), 0.8, (1.0, 0.80, 0.62), 1.0)
        self._area('glare', (-0.4, 0.35, 0.72), (-0.4, 1.0, -0.8), 0.5, (0.75, 0.9, 1.0), 1.0)
        self._area('copilot', (0.55, 0.5, 0.75), (1.05, 1.3, -0.5), 0.45, (1.0, 0.86, 0.7), 1.0)
        self._area('caution', (0.0, -0.5, 0.6), (0.0, 1.2, -0.3), 0.8, (1.0, 0.05, 0.02), 0.0)
        # soft work-light on the arms only (light-linked), so they keep their form against the dusk
        self._area('armfill', (0.0, 7.0, 16.0), (0.0, 40.0, -12.0), 9.0, (0.80, 0.90, 1.0), 1.0, linked=self.coll_arms)
        self._dusk = self._area('dusk', (-3.4, 1.3, 0.3), (0.5, 1.2, -0.2), 1.6, (1.0, 0.42, 0.18), 5.0)
        self._area('cglow', (1.5, 2.9, -0.7), (0.0, 0.7, 0.25), 1.4, (0.40, 0.88, 1.0), 0.0)
        self._base = {'dome': 7.0, 'glare': 2.4, 'copilot': 2.6, 'armfill': 6500.0}
        self._state = {}
        self.pose()

    _BARREL = 8.2

    def _area(self, name, loc, target, size, color, power, linked=None):
        l = bpy.data.lights.new('mech_' + name, 'AREA'); l.shape = 'SQUARE'; l.size = size; l.color = color; l.energy = power; l.specular_factor = 0.6
        ob = bpy.data.objects.new('mech_' + name, l); self.coll.objects.link(ob); ob.parent = self.torso; ob.visible_camera = False
        ob.matrix_basis = self._light_matrix(loc, target)
        if linked is not None:
            try: ob.light_linking.receiver_collection = linked
            except Exception: pass
        self._lights[name] = l
        return ob

    def _light_matrix(self, loc, target):
        """Matrix for a light at `loc` shining at `target` (both relative to the eye)."""
        loc = np.asarray(loc, float) + self._E; target = np.asarray(target, float) + self._E
        Z = _n(loc - target); X = _n(np.cross((0.0, 0.0, 1.0), Z) if abs(Z[2]) < 0.99 else (1.0, 0.0, 0.0)); Y = np.cross(Z, X)
        return Matrix(_frame(loc, X, Y, Z).tolist())

    # ---- arm keys (right-arm coordinates; the left arm mirrors x)
    def _key(self, state, side):
        name = state[0]; t = float(state[1]); rel = state[2] if len(state) > 2 else None
        D = self.DUR; HD = self.HOLD; I = K_IDLE.copy(); I[5] += 0.25 * np.sin(t * 1.9) if name == 'idle' else 0.0
        tip = self.REACH - FIST_HALF
        if name == 'idle': return I
        if name == 'punch':
            th = D['punch']['hit']; td = D['punch']['dur']
            if side > 0:        # starboard: a straight, elbow low
                wind = _K((2, -3, 0), (17, 15, 63), (30, -6, 46), (1, -0.2, 0.7))
                hit = _K((-4.5, 8.5, 1.0), (1.2, tip, 71.0), (16, 28, 50), (1, 0, 0.45))
                back = _K((-4.0, 7.5, 1.0), (1.6, tip - 2.2, 70.6), (17, 26, 50), (1, 0, 0.45))
            else:               # port: a hook, elbow high and wide
                wind = _K((3, -3, 1), (25, 13, 67), (42, -2, 62), (1, 0, 0.6))
                hit = _K((-4.5, 8.0, 1.5), (1.2, tip, 71.5), (40, 30, 84), (0.2, -0.5, 1))
                back = _K((-4.0, 7.0, 1.5), (2.0, tip - 2.2, 71.2), (40, 28, 84), (0.2, -0.5, 1))
            return _track([(0, K_IDLE, 'io'), (th * 0.30, wind, 'io'), (th, hit, 'in'), (th + 0.07, back, 'out'), (td, K_IDLE, 'io')], t)
        if name == 'slam':
            th = D['slam']['hit']; td = D['slam']['dur']
            mid = _K((0, 0, 1), (11, 39, 78), (36, 8, 62), (0.3, -0.6, 1))
            top = _K((-1, 2, 3), (5.3, 40, 96), (38, 14, 86), (0, -1, 0.4))
            apex = _K((-1, 1, 3.5), (5.3, 37, 98.5), (38, 12, 88), (0, -1, 0.3))
            hit = _K((-2, 5, -1), (5.3, tip - 5.0, 63.0), (36, 26, 75), (0, 0.5, 1))
            reb = _K((-2, 4.5, -1), (5.3, tip - 6.0, 65.0), (36, 25, 75), (0, 0.5, 1))
            return _track([(0, K_IDLE, 'io'), (th * 0.28, mid, 'lin'), (th * 0.54, top, 'out'), (th * 0.66, apex, 'io'), (th, hit, 'in'), (th + 0.09, reb, 'out'), (td, K_IDLE, 'io')], t)
        if name == 'block':
            if side > 0: K = _K((-1, 2, 1), (-8.0, 31.0, 69.0), (38, 30, 68), (0, 1, 0.25))
            else: K = _K((-1, 1, 1.5), (-8.0, 24.0, 73.0), (38, 22, 72), (0, 1, 0.25))
            K = K.copy(); K[5] += 0.3 * np.sin(t * 7.0) * np.exp(-t * 2.0)
            u = _ease('io', t / HD['block']['in'])
            if rel is not None: u *= 1 - _ease('io', rel / HD['block']['out'])
            return I + (K - I) * u
        if name in ('charge', 'fire'):
            # shoulder drawn back, forearm level and converging on the centre line about 70 m out
            Ed = np.array([22.5, 19.5, 65.5]); A = np.array([0.0, 70.0, 68.5]); dr = _n(A - Ed)
            K = _K((0, -4, 1), Ed + dr * L2, Ed, (-0.22, -0.1, 1))
            if name == 'charge':
                u = _ease('io', t / HD['charge']['in'])
                if rel is not None: u *= 1 - _ease('io', rel / HD['charge']['out'])
                return I + (K - I) * u
            kick = _K((0.5, -7.5, 1.4), Ed + dr * L2 - dr * 5.0 + (0, 0, 1.6), Ed + (1.5, -3.0, 0.5), (-0.22, -0.1, 1))
            return _track([(0, K, 'lin'), (0.045, kick, 'out'), (0.24, K, 'io'), (0.27, K, 'lin'), (D['fire']['dur'], K_IDLE, 'io')], t)
        raise ValueError('unknown arm state %r' % (name,))

    def _solve(self, K, side):
        """Key -> (shoulder, elbow, fist, upper frame, yoke frame, forearm frame) in the torso frame."""
        mir = np.array([side, 1.0, 1.0])
        S = (SHOULDER + K[0:3]) * mir; F = K[3:6] * mir; H = K[6:9] * mir; up = K[9:12] * mir
        d = F - S; dist = np.linalg.norm(d)
        lim = L1 + L2 - 0.4
        if dist > lim: F = S + d * (lim / dist); d = F - S; dist = lim
        dr = d / dist
        a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist); h = np.sqrt(max(L1 * L1 - a * a, 0.0))
        p = H - S; p = p - (p @ dr) * dr; p = _n(p)
        El = S + a * dr + h * p
        u1 = (El - S) / L1; u2 = _n(F - El)
        nrm = _n(np.cross(dr, p))
        MU = _frame(S, nrm, u1, np.cross(nrm, u1)); MY = _frame(El, nrm, u2, np.cross(nrm, u2)); MF = _aim(El, u2, up)
        return S, El, F, MU, MY, MF

    # ---- public
    def pose(self, L=('idle', 0.0), R=('idle', 0.0), charge=0.0, twist=0.0, pitch=0.0, bob=(0.0, 0.0, 0.0), sway=0.0, damage=0.0, cabin=1.0):
        """L / R = (state, seconds into it). L: idle, punch, block, slam. R: also charge, fire (fire starts from the
        raised charge pose and ends in idle; every other state starts in idle; punch, slam and fire also end there).
        A hold state may carry a third element, seconds since release, e.g. ('block', t, r), to ease back to idle.
        charge 0..1 lights the cannon; twist = upper-body yaw (rad); bob = (dx, dy, dz) m of the upper body in the
        root frame; sway = roll about the forward axis through the eye (rad, + puts the right side down);
        pitch only nudges the co-pilot's head; damage 0..1 = flicker + red caution glow; cabin = instrument brightness."""
        E = self._E
        self._tm = _T(*bob) @ _RZ(twist) @ _T(E) @ _RY(sway) @ _T(-E)
        self.torso.matrix_basis = Matrix(self._tm.tolist())
        for nm, st, side in (('R', R, 1.0), ('L', L, -1.0)):
            S, El, F, MU, MY, MF = self._solve(self._key(st, side), side)
            ob = self.arm[nm]
            ob['upper'].matrix_basis = Matrix(MU.tolist()); ob['yoke'].matrix_basis = Matrix(MY.tolist()); ob['fore'].matrix_basis = Matrix(MF.tolist())
            a0 = (MU @ np.append(RAM_U, 1.0))[:3]; a1 = (MY @ np.append(RAM_F, 1.0))[:3]; dv = a1 - a0; dist = np.linalg.norm(dv); X = MU[:3, 0]
            ob['barrel'].matrix_basis = Matrix(_aim(a0, dv, np.cross(X, dv)).tolist())
            Mr = _aim(a1, -dv, np.cross(X, dv)); Mr[:3, 1] *= max(dist - 0.5, 0.5)
            ob['rod'].matrix_basis = Matrix(Mr.tolist())
            self._state[nm] = (F, MF)
        MF = self._state['R'][1]
        self.arm['R']['glow'].matrix_basis = Matrix(MF.tolist())
        # cannon glow
        g = float(np.clip(charge, 0.0, 1.0))
        if R[0] == 'fire': g = max(g * max(0.0, 1 - R[1] / 0.12), float(np.exp(-R[1] / 0.07)))
        self._core[1].outputs[0].default_value = 0.02 + 9.0 * g ** 1.6
        self._seg[1].outputs[0].default_value = float(np.clip(charge, 0.0, 1.0)) if R[0] != 'fire' else g
        for k in self._fglow: k.outputs[0].default_value = 11.0 * g ** 1.6
        self._lights['cglow'].energy = 26.0 * g ** 1.8
        # the last light in the west, kept on the world's west side of the cabin whatever the heading
        h = -(float(self.root.rotation_euler.z) + twist); ch, sh = np.cos(h), np.sin(h)
        d = _n((ch * SUN_DIR[0] - sh * SUN_DIR[1], sh * SUN_DIR[0] + ch * SUN_DIR[1], 0.0))
        self._dusk.matrix_basis = self._light_matrix(d * 3.4 + (0.0, 1.5, 0.3), (-0.55 * d[0], 1.2, -0.2))
        # instruments: brightness, damage flicker (a hash of the pose, so a frame renders the same alone), master caution
        seed = abs(np.sin(12.9898 * (L[1] + 1.3 * R[1]) + 78.233 * (bob[0] + bob[1] + bob[2]) + 37.719 * (twist + sway) + 4.1 * charge)) * 43758.5453
        dm = float(np.clip(damage, 0.0, 1.0))
        for i, (m, k, gl) in enumerate(self._disp):
            r = (seed * (i + 1.37)) % 1.0
            drop = 1.0 - dm * (0.92 if r < 0.25 * dm else 0.35 * r)
            k.outputs[0].default_value = cabin * drop
            gl.outputs[0].default_value = dm * (0.3 + 3.0 * ((seed * (i + 2.11)) % 1.0)) if dm > 0 else 0.0
        self._warn[1].outputs[0].default_value = 0.012 + dm * (0.75 + 0.25 * ((seed * 0.71) % 1.0))
        fl = 1.0 - 0.45 * dm * ((seed * 3.3) % 1.0)
        for nm in ('dome', 'glare', 'copilot'): self._lights[nm].energy = self._base[nm] * cabin * fl
        self._lights['caution'].energy = 14.0 * dm
        self._lights['armfill'].energy = self._base['armfill']
        # the co-pilot rides the motion: leans against sway, nods with vertical bob, turns a little into the twist
        bx = float(np.clip(bob[2] * 0.02, -0.05, 0.05)); by = float(np.clip(-sway * 0.8, -0.07, 0.07))
        self.body.rotation_euler = (bx, by, 0.0)
        self.head.location = self._hip + (_RY(by) @ _RX(bx))[:3, :3] @ (self._neck - self._hip)
        self.head.rotation_euler = (bx + float(np.clip(bob[2] * 0.05 + pitch * 0.15, -0.15, 0.15)), by + float(np.clip(-sway * 1.2, -0.15, 0.15)), float(np.clip(twist * 0.25, -0.2, 0.2)))

    def _world(self, p):
        return (np.array(self.root.matrix_basis) @ self._tm @ np.append(np.asarray(p, float), 1.0))[:3]

    def eye(self):
        return self._world(self._E)

    def fist(self, side):
        return self._world(self._state['R' if side > 0 else 'L'][0])

    def knuckles(self, side):
        F, MF = self._state['R' if side > 0 else 'L']
        return self._world(F + MF[:3, 1] * FIST_HALF)

    def muzzle(self):
        MF = self._state['R'][1]
        return self._world((MF @ np.append(MUZZLE, 1.0))[:3])

    def aim(self):
        M = np.array(self.root.matrix_basis) @ self._tm
        return _n(M[:3, :3] @ self._state['R'][1][:3, 1])

    def basis(self):
        """World-space (right, forward, up) of the cabin for the current pose (includes twist and sway)."""
        M = (np.array(self.root.matrix_basis) @ self._tm)[:3, :3]
        return M[:, 0].copy(), M[:, 1].copy(), M[:, 2].copy()
