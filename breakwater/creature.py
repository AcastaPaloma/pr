"""The creature: a hunched, heavy-armed amphibious biped, about 84 metres to the top of its back.

Design: a broad flat skull with an undershot jaw and uneven teeth, small eyes deep under brow shelves, a frill of
bony cheek spikes, a shoulder hump carrying clusters of long quills that shrink to a keel down the tail, long
forearms ending in three hooked claws. Dark wet hide with a pale banded belly; sickly green light organs in rows
along the flanks, forearms and throat, faint veins that only show strongly when the glow flares.

Technique
---------
* The body is sculpted once, in a bind pose, as a signed distance field: ~130 round cones and ellipsoids (muscle
  masses, skull, jaw, hands ...) merged with smooth unions, plus smooth subtractions (mouth cavity, eye sockets).
  The field is meshed with surface nets on a rectilinear grid that is finer around the head, the vertices are
  projected onto the exact surface and pushed around by 3-D noise for lumps and skin folds.
* Skin weights come from the same primitives (each belongs to a bone) and are relaxed over the mesh. Teeth, claws,
  eyes, quills and cheek spikes are small lofted meshes in the same object that ride on single bones or on the skin.
* `pose()` is pure NumPy forward kinematics + linear blend skinning written straight into the mesh. Shaders read the
  bind position and normal from the `rest` / `restn` attributes, so the tri-planar skin maps (two tileable NumPy
  textures: scales, creases, warts / veins, spots, mottle) stick to the body in every pose.
* The glow is emission behind one Value node per material (all set by `pose(glow=...)`), multiplied by a light-path
  gate and with emission sampling off: it is seen by the camera (and dimly in glossy reflections) but never lights
  the scene, so it adds no noise.

Local frame: the root is at the feet ON THE SEA FLOOR, the creature faces +Y, +X is its right, the sea surface is
at local z = 22. `look` > 0 turns the head to its left (counter-clockwise from above, like rotation_euler.z).
At the end of 'death' (and in 'swim') the body is partly below the floor plane: the bay is shallower than the torso
is thick, so "submerged" assumes an opaque sea.
"""
import time
import numpy as np
import bpy
from . import bl, SEA_FLOOR

_D = np.pi / 180.0
SURF = -SEA_FLOOR                      # local height of the sea surface above the feet
GREEN = (0.2, 1.0, 0.1)                # species colour, linear RGB
REST_OPEN = 30.0                       # jaw opening (degrees) the mesh is sculpted with


# --------------------------------------------------------------------------------------------
# small maths
# --------------------------------------------------------------------------------------------
def _smooth(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _nrm(v):
    v = np.asarray(v, float)
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-12)


def _rx(deg):
    a = deg * _D; c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def _ry(deg):
    a = deg * _D; c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def _rz(deg):
    a = deg * _D; c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def _euler_mats(E):
    """(n, 3) radians (rx, ry, rz) -> (n, 3, 3) with R = Rz @ Rx @ Ry (roll, then pitch, then yaw)."""
    cx, sx = np.cos(E[:, 0]), np.sin(E[:, 0]); cy, sy = np.cos(E[:, 1]), np.sin(E[:, 1]); cz, sz = np.cos(E[:, 2]), np.sin(E[:, 2])
    R = np.empty((len(E), 3, 3))
    R[:, 0, 0] = cz * cy - sz * sx * sy; R[:, 0, 1] = -sz * cx; R[:, 0, 2] = cz * sy + sz * sx * cy
    R[:, 1, 0] = sz * cy + cz * sx * sy; R[:, 1, 1] = cz * cx; R[:, 1, 2] = sz * sy - cz * sx * cy
    R[:, 2, 0] = -cx * sy; R[:, 2, 1] = sx; R[:, 2, 2] = cx * cy
    return R


def _hash3(ix, iy, iz, seed):
    h = (ix * 374761393 + iy * 668265263 + iz * 2147483647 + seed * 1442695041) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(1 << 24)


def _vnoise3(p, seed=0):
    pi = np.floor(p); f = p - pi; f = f * f * (3 - 2 * f)
    ix, iy, iz = (pi[:, 0].astype(np.int64), pi[:, 1].astype(np.int64), pi[:, 2].astype(np.int64))
    out = 0.0
    for dx in (0, 1):
        wx = f[:, 0] if dx else 1 - f[:, 0]
        for dy in (0, 1):
            wy = f[:, 1] if dy else 1 - f[:, 1]
            for dz in (0, 1):
                wz = f[:, 2] if dz else 1 - f[:, 2]
                out = out + wx * wy * wz * _hash3(ix + dx, iy + dy, iz + dz, seed)
    return out


def _fbm3(p, octaves=3, seed=0):
    s = 0.0; a = 0.5; norm = 0.0; f = 1.0
    for i in range(octaves):
        s = s + a * _vnoise3(p * f + i * 13.7, seed + i); norm += a; a *= 0.5; f *= 2.03
    return s / norm


# --------------------------------------------------------------------------------------------
# skeleton (bind pose, metres, feet at z = 0)
# --------------------------------------------------------------------------------------------
_PEL = np.array([0.0, -8.0, 34.0]); _SP1 = np.array([0.0, -5.5, 40.0]); _SP2 = np.array([0.0, 0.5, 50.0]); _SP3 = np.array([0.0, 9.0, 60.0])
_NK1 = np.array([0.0, 16.5, 67.5]); _NK2 = np.array([0.0, 22.0, 70.5])
_H = np.array([0.0, 27.0, 73.5])                    # head pivot (back of the skull)
_J = _H + np.array([0.0, 1.5, -3.3])                # jaw hinge
_S = np.array([18.5, 9.5, 69.0])                    # right shoulder
_E = _S + 22.0 * _nrm([0.50, 0.20, -0.84])          # right elbow
_W = _E + 27.0 * _nrm([0.38, 0.36, -0.85])          # right wrist
_HD = _nrm([0.28, 0.40, -0.87])                     # hand direction
_PALM = _nrm(np.cross(np.cross(_HD, [0.25, -1.0, 0.0]), _HD))   # palm normal (faces back/inward)
_LAT = _nrm(np.cross(_HD, _PALM))                   # across the knuckles
_HIP = np.array([9.5, -7.0, 31.5]); _KNEE = np.array([12.5, 3.0, 18.0]); _ANK = np.array([12.5, -7.0, 6.0]); _TOE = np.array([13.0, 5.0, 2.0])
_TAILN = 8
_TP = np.array([[0.0, -15.0 - 9.5 * i, 30.0 - 1.8 * i] for i in range(_TAILN + 1)])
_TR = np.array([8.2, 7.2, 6.2, 5.2, 4.3, 3.4, 2.6, 1.8, 0.9])
_RIB = np.array([0.0, 9.4, 57.5])                   # centre of the rib cage
_CHEEK = [(np.array([6.3, -0.6, 1.6]), _nrm([0.72, -0.62, 0.30]), 7.0), (np.array([7.0, -0.2, -0.8]), _nrm([0.86, -0.50, -0.05]), 8.5),
          (np.array([6.2, 0.6, -3.2]), _nrm([0.74, -0.42, -0.52]), 6.0)]      # cheek spikes: base (relative to the head pivot), direction, length


def _knuckle(i):
    return _W + 5.4 * _HD + _LAT * (i - 1) * 2.7 - _HD * abs(i - 1) * 0.5


def _fdir(i):
    return _nrm(_HD + _LAT * (i - 1) * 0.30)


def _skeleton():
    B = [('root', None, (0, 0, 0)), ('pelvis', 'root', _PEL), ('spine1', 'pelvis', _SP1), ('spine2', 'spine1', _SP2), ('spine3', 'spine2', _SP3),
         ('neck1', 'spine3', _NK1), ('neck2', 'neck1', _NK2), ('head', 'neck2', _H), ('jaw', 'head', _J)]
    for sd, sg in (('R', 1.0), ('L', -1.0)):
        m = np.array([sg, 1, 1])
        B += [('clav_' + sd, 'spine3', np.array([7, 10.5, 67.0]) * m), ('uarm_' + sd, 'clav_' + sd, _S * m),
              ('farm_' + sd, 'uarm_' + sd, _E * m), ('hand_' + sd, 'farm_' + sd, _W * m)]
        B += [('f%d_%s' % (i + 1, sd), 'hand_' + sd, _knuckle(i) * m) for i in range(3)]
        B += [('uleg_' + sd, 'pelvis', _HIP * m), ('lleg_' + sd, 'uleg_' + sd, _KNEE * m), ('foot_' + sd, 'lleg_' + sd, _ANK * m)]
        B += [('gill_' + sd, 'head', (_H + [6.0, 0.0, -0.5]) * m)]
    B += [('tail%d' % (i + 1), 'pelvis' if i == 0 else 'tail%d' % i, _TP[i]) for i in range(_TAILN)]
    names = [b[0] for b in B]
    parent = np.array([-1 if b[1] is None else names.index(b[1]) for b in B])
    piv = np.array([np.asarray(b[2], float) for b in B])
    return names, parent, piv


# --------------------------------------------------------------------------------------------
# signed distance sculpture
# --------------------------------------------------------------------------------------------
class _Sculpt:
    """A list of SDF primitives, each owned by a bone. Evaluated in order with smooth min / max."""

    def __init__(self, ix):
        self.ix = ix; self.prims = []; self.R = np.eye(3); self.piv = np.zeros(3)

    def frame(self, R=None, pivot=None):
        self.R = np.eye(3) if R is None else R; self.piv = np.zeros(3) if pivot is None else np.asarray(pivot, float)

    def _w(self, p):
        return self.piv + self.R @ (np.asarray(p, float) - self.piv)

    def _bone(self, bone, sg):
        return self.ix[bone.replace('_R', '_L') if sg < 0 else bone]

    def rc(self, bone, a, b, ra, rb, k=2.0, s=(1, 1, 1), mir=False, sub=False):
        s = np.asarray(s, float)
        for sg in ((1, -1) if mir else (1,)):
            m3 = np.array([sg, 1, 1.0])
            aw, bw = self._w(np.asarray(a, float) * m3), self._w(np.asarray(b, float) * m3)
            mid = (aw + bw) / 2
            al = ((aw - mid) @ self.R) / s; bl_ = ((bw - mid) @ self.R) / s
            rmax = max(ra, rb) * s.max()
            self.prims.append(dict(kind=0, bone=self._bone(bone, sg), m=mid, rot=self.R.copy(), s=s, a=al, b=bl_, ra=ra, rb=rb, k=k, sub=sub,
                                   lo=np.minimum(aw, bw) - rmax, hi=np.maximum(aw, bw) + rmax, rad=(ra + rb) / 2 * s.mean()))

    def el(self, bone, c, r, k=2.0, rot=None, mir=False, sub=False):
        r = np.asarray(r, float)
        for sg in ((1, -1) if mir else (1,)):
            m3 = np.array([sg, 1, 1.0])
            cw = self._w(np.asarray(c, float) * m3)
            R = self.R if rot is None else self.R @ (np.diag(m3) @ rot @ np.diag(m3))
            self.prims.append(dict(kind=1, bone=self._bone(bone, sg), m=cw, rot=R.copy(), r=r, k=k, sub=sub,
                                   lo=cw - r.max(), hi=cw + r.max(), rad=r.mean()))

    def sp(self, bone, a, b, r, k=2.0, mir=False, sub=False):
        """Spheroid whose long axis runs from a to b, radius r across."""
        a = np.asarray(a, float); b = np.asarray(b, float)
        d = _nrm(b - a); u = _nrm(np.cross(d, [0.31, 0.53, 0.79])); v = np.cross(d, u)
        self.el(bone, (a + b) / 2, (r, r, np.linalg.norm(b - a) / 2), k=k, rot=np.stack([u, v, d], 1), mir=mir, sub=sub)

    @staticmethod
    def _eval(pr, P):
        q = (P - pr['m'].astype(P.dtype)) @ pr['rot'].astype(P.dtype)
        if pr['kind'] == 0:
            q = q / pr['s'].astype(P.dtype)
            a = pr['a'].astype(P.dtype); ba = (pr['b'] - pr['a']).astype(P.dtype)
            pa = q - a
            t = np.clip((pa @ ba) / max(float(ba @ ba), 1e-9), 0.0, 1.0)
            d = np.linalg.norm(pa - t[:, None] * ba, axis=1) - (pr['ra'] + (pr['rb'] - pr['ra']) * t)
            return d * float(pr['s'].min())
        r = pr['r'].astype(P.dtype)
        k0 = np.linalg.norm(q / r, axis=1); k1 = np.linalg.norm(q / (r * r), axis=1)
        return k0 * (k0 - 1.0) / np.maximum(k1, 1e-6)

    @staticmethod
    def _combine(d, di, k, sub):
        if sub:
            h = np.clip(0.5 - 0.5 * (d + di) / k, 0.0, 1.0)
            return d * (1 - h) - di * h + k * h * (1 - h)
        h = np.clip(0.5 + 0.5 * (d - di) / k, 0.0, 1.0)
        return d * (1 - h) + di * h - k * h * (1 - h)

    def sdf(self, P, pad=1.5):
        """Field value at points (N, 3). Primitives further than their blend radius + pad are skipped."""
        P = np.asarray(P, np.float64)
        d = np.full(len(P), 1e3)
        x, y, z = (np.ascontiguousarray(P[:, i]) for i in range(3))
        for pr in self.prims:
            lo = pr['lo'] - pr['k'] - pad; hi = pr['hi'] + pr['k'] + pad
            m = np.nonzero((x > lo[0]) & (x < hi[0]) & (y > lo[1]) & (y < hi[1]) & (z > lo[2]) & (z < hi[2]))[0]
            if not len(m): continue
            d[m] = self._combine(d[m], self._eval(pr, P[m]), pr['k'], pr['sub'])
        return d

    def grad(self, P, e=0.08):
        g = np.zeros((len(P), 3))                              # tetrahedral differences: four evaluations
        for o in ((1, -1, -1), (-1, -1, 1), (-1, 1, -1), (1, 1, 1)):
            o = np.array(o, float)
            g += o * self.sdf(P + o * e)[:, None]
        return _nrm(g)

    def field(self, axes):
        """Node-sampled field on a rectilinear grid given by three coordinate arrays."""
        D = np.full([len(a) for a in axes], 1e3, np.float32)
        for pr in self.prims:
            pad = pr['k'] + 1.4
            i0 = [max(int(np.searchsorted(axes[i], pr['lo'][i] - pad)) - 1, 0) for i in range(3)]
            i1 = [min(int(np.searchsorted(axes[i], pr['hi'][i] + pad)) + 1, len(axes[i])) for i in range(3)]
            if any(i1[i] <= i0[i] for i in range(3)): continue
            ax = [axes[i][i0[i]:i1[i]].astype(np.float32) for i in range(3)]
            P = np.stack(np.meshgrid(*ax, indexing='ij'), -1).reshape(-1, 3)
            di = self._eval(pr, P).reshape([len(a) for a in ax])
            sl = tuple(slice(i0[i], i1[i]) for i in range(3))
            D[sl] = self._combine(D[sl], di, np.float32(pr['k']), pr['sub'])
        return D

    def bone_dist(self, P, nb, pad=6.0):
        """(N, nb) distance from each point to the nearest additive primitive of every bone, and a per-bone size."""
        Db = np.full((len(P), nb), 1e3); rad = np.zeros(nb); cnt = np.zeros(nb)
        for pr in self.prims:
            if pr['sub']: continue
            b = pr['bone']
            m = np.all((P > pr['lo'] - pad) & (P < pr['hi'] + pad), axis=1)
            Db[m, b] = np.minimum(Db[m, b], self._eval(pr, P[m]))
            rad[b] += pr['rad']; cnt[b] += 1
        return Db, rad / np.maximum(cnt, 1)


def _sculpt(ix):
    S = _Sculpt(ix)
    A = np.array
    H, J = _H, _J
    # ---- torso: hunched, the rib cage carried well forward of the hips ----------------------------
    lean = _rx(-33.0)
    S.el('pelvis', _PEL, (11.5, 9.5, 8.5), k=3)
    S.rc('spine1', _SP1 + A([0, 0.5, -2.5]), _SP2 + A([0, 0.5, -1.0]), 10.3, 11.3, k=3, s=(1.12, 1, 1))
    S.el('spine1', _SP1 * 0.55 + _SP2 * 0.45 + A([0, 6.5, 0]), (8.5, 6.5, 9.0), k=3)                 # gut
    S.el('spine2', _RIB, (14.8, 11.8, 13.5), k=3.5, rot=lean)                                        # rib cage
    S.el('spine2', _RIB + A([7.2, 9.0, -4.5]), (6.8, 4.2, 5.8), k=2.5, rot=lean, mir=True)           # pectorals
    S.el('spine2', _RIB + A([12.8, -3.0, -5.0]), (4.0, 7.0, 8.0), k=3, mir=True)                     # lats
    S.el('spine3', (0, 5.5, 72.0), (13.8, 11.0, 10.2), k=3.5, rot=_rx(-20.0))                        # shoulder hump
    S.el('spine3', (10.8, 9.0, 72.5), (7.2, 7.2, 6.2), k=3, mir=True)                                # trapezius
    S.rc('neck1', (0, 13.0, 66.0), _NK2, 8.6, 7.1, k=3)
    S.rc('neck2', _NK2, H + A([0, -0.5, -0.3]), 7.1, 6.0, k=2.5)
    S.el('neck2', H + A([0, -2.5, -8.3]), (5.2, 5.8, 4.8), k=2)                                      # throat pouch
    S.sp('neck1', (4.8, 17.5, 62.5), (3.7, 26.0, 69.5), 2.2, k=1.6, mir=True)                        # neck cords
    # ---- skull: a broad flat wedge ---------------------------------------------------------------
    S.el('head', H + A([0, 1.0, 1.0]), (6.4, 5.6, 3.9), k=1.5)
    S.rc('head', H + A([0, 3.0, 0.4]), H + A([0, 13.0, -0.6]), 4.6, 3.3, k=1.2, s=(1.42, 1, 0.72))    # muzzle
    S.rc('head', H + A([2.3, 9.4, 2.2]), H + A([6.4, 3.2, 3.5]), 1.1, 1.5, k=1.0, mir=True)           # brow shelf
    S.rc('head', H + A([6.0, 3.0, 3.1]), H + A([4.9, -5.8, 3.9]), 1.6, 1.0, k=1.8, mir=True)          # crest sweeping back
    S.el('head', H + A([5.9, 0.5, -1.0]), (2.4, 3.6, 3.6), k=1.2, mir=True)                             # jaw muscle
    for bp, d, L in _CHEEK: S.el('head', H + bp, (1.7, 1.7, 1.7), k=1.0, mir=True)                      # sockets of the cheek spikes
    S.el('head', H + A([1.7, 14.4, 0.9]), (1.0, 1.3, 0.8), k=0.7, mir=True)                             # nostril bumps
    S.el('head', H + A([0, 7.0, 2.6]), (1.6, 4.5, 1.2), k=1.2)                                          # ridge down the muzzle
    S.rc('head', H + A([0, 3.8, -1.9]), H + A([0, 12.6, -2.9]), 3.5, 2.3, k=0.6, s=(1.42, 1, 0.72), sub=True)   # palate
    S.el('head', H + A([4.95, 7.8, 1.35]), (1.25, 1.25, 1.0), k=0.5, mir=True, sub=True)                # eye sockets
    # ---- lower jaw, sculpted open: heavier and longer than the muzzle -----------------------------
    S.frame(_rx(-REST_OPEN), J)
    S.rc('jaw', J + A([0, 0.5, -1.0]), J + A([0, 13.6, -1.2]), 3.6, 3.2, k=1.2, s=(1.62, 1, 0.85))
    S.el('jaw', J + A([0, 13.2, -2.7]), (4.2, 2.7, 2.3), k=1.2)                                         # chin
    S.el('jaw', J + A([4.9, 3.0, -1.6]), (1.9, 3.6, 2.7), k=1.2, mir=True)                              # jaw angle
    S.rc('jaw', J + A([0, 1.8, 1.5]), J + A([0, 13.0, 1.2]), 2.6, 2.2, k=0.6, s=(1.62, 1, 0.85), sub=True)   # bowl
    S.el('jaw', J + A([0, 6.5, -0.3]), (2.3, 5.2, 1.0), k=0.8)                                          # tongue
    S.frame()
    # ---- arms -------------------------------------------------------------------------------
    Sh, E, W = _S, _E, _W
    S.el('uarm_R', Sh + A([0.5, 0, 0.8]), (7.8, 7.4, 7.8), k=3, mir=True)                               # deltoid
    S.rc('uarm_R', Sh, E, 6.2, 4.8, k=2.5, mir=True)
    S.sp('uarm_R', Sh * 0.75 + E * 0.25 + A([0.3, 2.2, 0]), Sh * 0.2 + E * 0.8 + A([0.3, 1.6, 0]), 4.8, k=2, mir=True)   # biceps
    S.sp('uarm_R', Sh * 0.8 + E * 0.2 + A([0.6, -2.4, 0]), Sh * 0.15 + E * 0.85 + A([0.4, -2.0, 0]), 4.6, k=2, mir=True)  # triceps
    S.el('farm_R', E, (4.9, 4.9, 4.9), k=2, mir=True)
    S.rc('farm_R', E, W, 5.0, 3.5, k=2, mir=True)
    S.sp('farm_R', E * 0.95 + W * 0.05 + A([1.2, 0.4, 0]), E * 0.4 + W * 0.6 + A([0.8, 0.2, 0]), 5.6, k=2, mir=True)      # forearm mass
    for i, f in enumerate((0.20, 0.38, 0.56, 0.74)):                                                    # bony knobs down the outer forearm
        S.el('farm_R', E * (1 - f) + W * f + A([4.2 - 1.0 * f, -1.8, 1.0]), (1.9 - 0.25 * i,) * 3, k=1.1, mir=True)
    S.sp('hand_R', W - 0.8 * _HD, W + 6.8 * _HD, 3.6, k=1.6, mir=True)
    S.el('hand_R', W + 3.0 * _HD + _PALM * -1.4, (2.8, 2.8, 2.8), k=1.5, mir=True)                      # back of the hand
    for i in range(3):
        K = _knuckle(i); d = _fdir(i)
        S.el('hand_R', K - _PALM * 0.7, (2.0, 2.0, 2.0), k=1.0, mir=True)                               # knuckle
        S.rc('f%d_R' % (i + 1), K, K + 5.6 * d + _PALM * 0.8, 1.85, 1.4, k=1.0, mir=True)
    # ---- legs -------------------------------------------------------------------------------
    S.rc('uleg_R', _HIP, _KNEE, 8.6, 5.6, k=3, mir=True)
    S.sp('uleg_R', _HIP + A([1, 2.5, -2]), _KNEE + A([0, 1.5, 3]), 6.6, k=2.5, mir=True)
    S.el('lleg_R', _KNEE, (5.4, 5.4, 5.4), k=2, mir=True)
    S.rc('lleg_R', _KNEE, _ANK, 5.2, 3.6, k=2, mir=True)
    S.sp('lleg_R', _KNEE + A([0, -3, -1]), _KNEE * 0.4 + _ANK * 0.6 + A([0, -2.2, 0]), 4.2, k=2, mir=True)
    S.rc('foot_R', _ANK, _TOE, 3.8, 2.7, k=2, s=(1.3, 1, 0.8), mir=True)
    for i in range(3):
        S.rc('foot_R', _TOE + A([(i - 1) * 2.0, 0, -0.3]), _TOE + A([(i - 1) * 4.0, 6.0, -0.6]), 1.8, 1.2, k=1.2, mir=True)
    # ---- tail -------------------------------------------------------------------------------
    for i in range(_TAILN):
        S.rc('tail%d' % (i + 1), _TP[i], _TP[i + 1], _TR[i], _TR[i + 1], k=2.5, s=(0.82, 1, 1.08))
    return S


def _axis(lo, hi, hc, hf, fine):
    """Node coordinates from lo to hi: spacing hf inside the `fine` interval, hc outside, blended over 3 m."""
    out = [lo]
    while out[-1] < hi:
        x = out[-1]
        f = float(_smooth(fine[0] - 3.0, fine[0], x) * (1 - _smooth(fine[1], fine[1] + 3.0, x)))
        out.append(x + hc + (hf - hc) * f)
    return np.array(out)


def _surface_nets(D, axes):
    """Quad mesh of the zero level set of a node-sampled field on a rectilinear grid. Returns verts (N, 3), quads (M, 4)."""
    neg = D < 0
    nx, ny, nz = D.shape
    corners = [(i, j, k) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
    cnt = np.zeros((nx - 1, ny - 1, nz - 1), np.uint8)
    for dx, dy, dz in corners:
        cnt += neg[dx:nx - 1 + dx, dy:ny - 1 + dy, dz:nz - 1 + dz]
    act = (cnt > 0) & (cnt < 8)
    ci, cj, ck = np.nonzero(act)
    nv = len(ci)
    vid = np.full(act.shape, -1, np.int32); vid[ci, cj, ck] = np.arange(nv, dtype=np.int32)
    vals = np.stack([D[ci + dx, cj + dy, ck + dz] for dx, dy, dz in corners], 1).astype(np.float64)
    C = np.array(corners, float)
    acc = np.zeros((nv, 3)); num = np.zeros(nv)
    for a in range(8):
        for b in range(a + 1, 8):
            if np.abs(C[a] - C[b]).sum() != 1: continue
            va, vb = vals[:, a], vals[:, b]
            cr = (va < 0) != (vb < 0)
            t = np.where(cr, va / np.where(cr, va - vb, 1.0), 0.0)
            acc += (C[a] + t[:, None] * (C[b] - C[a])) * cr[:, None]; num += cr
    fi = np.stack([ci, cj, ck], 1) + acc / num[:, None]
    pos = np.stack([np.interp(fi[:, i], np.arange(len(axes[i])), axes[i]) for i in range(3)], 1)
    quads = []
    # edges along x
    ii, jj, kk = np.nonzero(neg[:-1, 1:-1, 1:-1] != neg[1:, 1:-1, 1:-1]); jj = jj + 1; kk = kk + 1
    q = np.stack([vid[ii, jj - 1, kk - 1], vid[ii, jj, kk - 1], vid[ii, jj, kk], vid[ii, jj - 1, kk]], 1)
    fl = ~neg[ii, jj, kk]; q[fl] = q[fl][:, ::-1]; quads.append(q)
    # edges along y
    ii, jj, kk = np.nonzero(neg[1:-1, :-1, 1:-1] != neg[1:-1, 1:, 1:-1]); ii = ii + 1; kk = kk + 1
    q = np.stack([vid[ii - 1, jj, kk - 1], vid[ii - 1, jj, kk], vid[ii, jj, kk], vid[ii, jj, kk - 1]], 1)
    fl = ~neg[ii, jj, kk]; q[fl] = q[fl][:, ::-1]; quads.append(q)
    # edges along z
    ii, jj, kk = np.nonzero(neg[1:-1, 1:-1, :-1] != neg[1:-1, 1:-1, 1:]); ii = ii + 1; jj = jj + 1
    q = np.stack([vid[ii - 1, jj - 1, kk], vid[ii, jj - 1, kk], vid[ii, jj, kk], vid[ii - 1, jj, kk]], 1)
    fl = ~neg[ii, jj, kk]; q[fl] = q[fl][:, ::-1]; quads.append(q)
    return pos, np.concatenate(quads)


def _neighbour_avg(n, quads):
    """Returns a function averaging per-vertex data over mesh neighbours (uniform Laplacian step)."""
    e = np.concatenate([quads[:, [0, 1]], quads[:, [1, 2]], quads[:, [2, 3]], quads[:, [3, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    e = np.unique(e, axis=0)
    order = np.argsort(e[:, 0], kind='stable'); e = e[order]
    present, starts, deg = np.unique(e[:, 0], return_index=True, return_counts=True)

    def avg(X):
        out = np.array(X, dtype=np.float64, copy=True)
        s = np.add.reduceat(X[e[:, 1]], starts, axis=0)
        out[present] = s / (deg[:, None] if X.ndim > 1 else deg)
        return out
    return avg


def _loft(rings, tip=None):
    """rings (nr, m, 3) -> verts, faces (list of lists), s in 0..1 per vertex. Rings wind counter-clockwise about the axis."""
    nr, m = rings.shape[:2]
    V = rings.reshape(-1, 3)
    F = []
    for i in range(nr - 1):
        for j in range(m):
            j1 = (j + 1) % m
            F.append([i * m + j, i * m + j1, (i + 1) * m + j1, (i + 1) * m + j])
    s = np.repeat(np.linspace(0, 1, nr + (1 if tip is not None else 0))[:nr], m)
    if tip is not None:
        V = np.concatenate([V, np.asarray(tip, float)[None]])
        t = nr * m
        for j in range(m):
            F.append([(nr - 1) * m + j, (nr - 1) * m + (j + 1) % m, t])
        s = np.concatenate([s, [1.0]])
    return V, F, s


def _horn(base, d, length, r0, bend_dir=None, bend=0.0, m=8, nr=5, power=1.0, flat=1.0, side=None):
    """Curved cone from `base` along `d`; bends toward `bend_dir`; cross-section squashed by `flat` across `side`."""
    d = _nrm(d)
    a = _nrm(np.cross(d, [0.37, 0.61, 0.70])) if side is None else _nrm(np.asarray(side, float) - d * np.dot(side, d))
    b = np.cross(d, a)
    bd = np.zeros(3) if bend_dir is None else np.asarray(bend_dir, float)
    ph = np.linspace(0, 2 * np.pi, m, endpoint=False)
    ss = np.linspace(0, 1, nr + 1)
    cen = lambda s: np.asarray(base, float) + length * (s * d + bend * s * s * bd)
    rings = np.stack([cen(s) + r0 * (1 - s) ** power * (np.cos(ph)[:, None] * a * flat + np.sin(ph)[:, None] * b) for s in ss[:-1]])
    return _loft(rings, cen(1.0))


def _ball(c, r, nu=10, nv=6):
    V = [np.asarray(c, float) + np.array([0, 0, -r])]; F = []
    for j in range(1, nv):
        th = np.pi * j / nv
        for i in range(nu):
            ph = 2 * np.pi * i / nu
            V.append(np.asarray(c, float) + r * np.array([np.sin(th) * np.cos(ph), np.sin(th) * np.sin(ph), -np.cos(th)]))
    V.append(np.asarray(c, float) + np.array([0, 0, r]))
    top = len(V) - 1
    for i in range(nu):
        i1 = (i + 1) % nu
        F.append([0, 1 + i1, 1 + i])
        for j in range(nv - 2):
            a = 1 + j * nu
            F.append([a + i, a + i1, a + nu + i1, a + nu + i])
        F.append([1 + (nv - 2) * nu + i, 1 + (nv - 2) * nu + i1, top])
    return np.array(V), F


def _voronoi_tile(size, G, rng, warp=None, jitter=0.9, reach=2):
    """Tileable Voronoi on a jittered G x G lattice: F1, F2 (in cell units) and a random id per cell, (size, size)."""
    pts = ((np.stack(np.meshgrid(np.arange(G), np.arange(G), indexing='ij'), -1) + 0.5 + (rng.random((G, G, 2)) - 0.5) * jitter) / G).astype(np.float32)
    ids = rng.random((G, G)).astype(np.float32)
    u = ((np.arange(size) + 0.5) / size).astype(np.float32)
    U, Vv = np.meshgrid(u, u, indexing='xy')
    if warp is not None: U = U + warp[0].astype(np.float32); Vv = Vv + warp[1].astype(np.float32)
    ci = np.floor(U * G).astype(np.int32); cj = np.floor(Vv * G).astype(np.int32)
    f1 = np.full(U.shape, 9.0, np.float32); f2 = f1.copy(); idv = np.zeros(U.shape, np.float32)
    for di in range(-reach, reach + 1):
        for dj in range(-reach, reach + 1):
            ii = (ci + di) % G; jj = (cj + dj) % G
            p = pts[ii, jj]
            dx = (U - p[..., 0] + 0.5) % 1.0 - 0.5; dy = (Vv - p[..., 1] + 0.5) % 1.0 - 0.5
            d = np.hypot(dx, dy) * G
            nearer = d < f1
            f2 = np.where(nearer, f1, np.minimum(f2, d)); idv = np.where(nearer, ids[ii, jj], idv); f1 = np.where(nearer, d, f1)
    return f1, f2, idv


def _skin_textures(seed, size=768):
    """Two tileable RGBA maps, sampled tri-planar in bind space (cheap for Cycles, no Voronoi in the shader).
    A: R scale height, G creases, B per-scale tone, A warts.   B: R veins, G vein halo, B light-organ spots, A mottle."""
    from .noise import tile_fbm
    rng = np.random.default_rng(seed + 100)
    wa = tile_fbm(size, periods=(3, 6, 12), seed=seed + 1) - 0.5; wb = tile_fbm(size, periods=(3, 6, 12), seed=seed + 2) - 0.5
    f1, f2, idv = _voronoi_tile(size, 38, rng, warp=(wa * 0.02, wb * 0.02), jitter=0.8, reach=1)
    g1, g2, _ = _voronoi_tile(size, 9, rng, warp=(wa * 0.06, wb * 0.06), jitter=0.75, reach=1)
    scales = _smooth(0.03, 0.30, f2 - f1) * (0.55 + 0.45 * _smooth(0.0, 0.085, g2 - g1)) * (0.7 + 0.3 * idv)
    crease = 1 - np.abs(2 * tile_fbm(size, periods=(5, 10, 20, 40, 80), seed=seed + 3) - 1)
    w1, _, wid = _voronoi_tile(size, 13, rng, jitter=0.8, reach=1)
    wart = np.clip(1 - (w1 / (0.14 + 0.28 * wid)) ** 2, 0, 1) * (wid > 0.38)
    A = np.stack([scales, crease, idv, wart], -1)
    v1, v2, _ = _voronoi_tile(size, 8, rng, warp=(wa * 0.07, wb * 0.07), jitter=0.75, reach=1)
    c1, c2, _ = _voronoi_tile(size, 21, rng, warp=(wb * 0.035, wa * 0.035), jitter=0.75, reach=1)
    e, e2 = v2 - v1, c2 - c1
    veins = np.maximum(1 - _smooth(0.010, 0.045, e), 0.5 * (1 - _smooth(0.02, 0.08, e2)))
    halo = np.maximum(1 - _smooth(0.0, 0.30, e), 0.4 * (1 - _smooth(0.0, 0.3, e2))) ** 2
    s1, _, sid = _voronoi_tile(size, 30, rng, jitter=0.8, reach=1)
    r = 0.08 + 0.11 * sid
    spots = (1 - _smooth(0.4 * r, r, s1)) * (sid > 0.35)
    mott = tile_fbm(size, periods=(3, 6, 12, 24, 48), seed=seed + 4)
    B = np.stack([veins, halo, spots, mott], -1)
    imgs = []
    for nm, arr in (('creature_skin_a', A), ('creature_skin_b', B)):
        img = bl.image_from_array(nm, arr.astype(np.float32)); img.alpha_mode = 'CHANNEL_PACKED'; imgs.append(img)
    return imgs


# --------------------------------------------------------------------------------------------
# the creature
# --------------------------------------------------------------------------------------------
class Creature:
    HEIGHT = 84.0                # standing, floor to the top of the shoulder hump (the quills on it reach ~87.5)
    HEAD_TOP = 81.0              # the head is carried lower and forward: floor to the top of the skull, standing
    REACH = 63.0                 # how far in front of the root the right claw tips are at the swipe hit time (about 79 m above the floor)
    DUR = {'emerge': 2.6, 'roar': 2.2, 'swipe': {'dur': 0.95, 'hit': 0.28}, 'stagger': 0.9, 'death': 4.5}
    WALK_PERIOD = 2.7            # seconds per full gait cycle (two steps)
    WALK_SPEED = 13.0            # metres per second the root should travel for the feet not to skate
    SCALE = 1.03                 # applied to the sculpt (which is modelled ~82 m to the top of the hump)
    VOXEL = 0.66                 # sculpt resolution, metres
    VOXEL_FINE = 0.40            # ... and around the head
    GLOW_STRENGTH = 1.2
    GLOSSY_GLOW = 0.35           # how much of the glow is visible in glossy reflections (the sea); 0 = camera rays only

    def __init__(self, seed=7):
        t0 = time.time()
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        self.names, self.parent, self.piv = _skeleton()
        self.nb = len(self.names)
        self.ix = {n: i for i, n in enumerate(self.names)}
        self._glow_nodes = []; self._eye_nodes = []
        self._build_mesh()
        self._build_materials()
        self._build_poses()
        self.root = bpy.data.objects.new('creature_root', None)
        bpy.context.scene.collection.objects.link(self.root)
        self.root.empty_display_size = 5.0
        self.obj.parent = self.root
        self._S = None
        self.pose('idle', 0.0)
        self.build_secs = time.time() - t0

    # ----------------------------------------------------------------------------------------
    # geometry
    # ----------------------------------------------------------------------------------------
    def _build_mesh(self):
        rng = self.rng; nb = self.nb; ix = self.ix
        S = self.sculpt = _sculpt(ix)
        hc, hf = self.VOXEL, self.VOXEL_FINE                   # finer cells around the head, where the camera looks
        axes = [_axis(-52.0, 52.0, hc, hf, (-7.5, 7.5)), _axis(-91.0, 47.0, hc, hf, (20.5, 99.0)), _axis(-3.0, 89.0, hc, hf, (64.0, 99.0))]
        D = S.field(axes)
        V, Q = _surface_nets(D, axes)
        del D
        for _ in range(2):                                     # onto the exact surface
            V = V - S.grad(V) * S.sdf(V)[:, None]
        avg = _neighbour_avg(len(V), Q)
        V = 0.5 * V + 0.5 * avg(V)                             # relax the net a little, then re-project
        V = V - S.grad(V) * S.sdf(V)[:, None]
        N = S.grad(V)
        fn = np.cross(V[Q[:, 1]] - V[Q[:, 0]], V[Q[:, 2]] - V[Q[:, 0]])
        if np.sum(fn * N[Q[:, 0]]) < 0: Q = Q[:, ::-1].copy()

        # ---- skin weights ---------------------------------------------------------------------
        Db, rad = S.bone_dist(V, nb)
        tau = np.clip(0.30 * rad, 0.45, 2.0)
        Wt = np.exp(-np.maximum(Db, 0.0) / tau[None, :])
        Wt[:, rad == 0] = 0.0
        Wt /= Wt.sum(1, keepdims=True)
        for _ in range(6):
            Wt = 0.5 * Wt + 0.5 * avg(Wt)
        Wt[Wt < 0.02] = 0.0
        Wt /= Wt.sum(1, keepdims=True)

        # ---- masks (bind space) ---------------------------------------------------------------
        def seg_d(P, a, b):
            a = np.asarray(a, float); b = np.asarray(b, float); ba = b - a
            t = np.clip(((P - a) @ ba) / (ba @ ba), 0, 1)
            return np.linalg.norm(P - a - t[:, None] * ba, axis=1)

        vd = np.zeros((nb, 3)); bw = np.zeros(nb)            # ventral direction and belly strength per bone
        def ven(name, d, w, mir=False):
            for sg in ((1, -1) if mir else (1,)):
                i = ix[name.replace('_R', '_L') if sg < 0 else name]; vd[i] = _nrm(np.array(d, float) * [sg, 1, 1]); bw[i] = w
        ven('pelvis', (0, 0.8, -0.6), 1.0); ven('spine1', (0, 0.95, -0.3), 1.0); ven('spine2', (0, 0.85, -0.5), 1.0); ven('spine3', (0, 0.8, -0.6), 0.9)
        ven('neck1', (0, 0.7, -0.7), 1.0); ven('neck2', (0, 0.55, -0.85), 1.0); ven('head', (0, 0.1, -1), 0.6); ven('jaw', (0, 0.45, -0.9), 0.9)
        ven('uarm_R', (-0.8, 0.45, -0.2), 0.45, True); ven('farm_R', (-0.75, 0.3, 0.3), 0.4, True); ven('hand_R', tuple(_PALM), 0.5, True)
        ven('uleg_R', (-0.7, 0.5, 0), 0.6, True); ven('lleg_R', (-0.6, -0.3, 0), 0.4, True)
        for i in range(_TAILN): ven('tail%d' % (i + 1), (0, 0, -1), 0.9)
        belly = _smooth(0.15, 0.8, np.sum(N * (Wt @ vd), 1)) * (Wt @ bw)

        cav = 1.0 - np.clip(S.sdf(V + N * 1.3) / 1.3, 0, 1)
        cav = np.clip(0.6 * cav + 0.6 * (1.0 - np.clip(S.sdf(V + N * 4.0, pad=4.5) / 4.0, 0, 1)), 0, 1)

        mouth_p = [pr for pr in S.prims if pr['sub'] and pr['kind'] == 0]
        md = np.minimum(S._eval(mouth_p[0], V), S._eval(mouth_p[1], V))
        mouth = 1.0 - _smooth(0.15, 0.7, np.abs(md))
        mouth *= (Wt[:, ix['head']] + Wt[:, ix['jaw']]) > 0.5
        deep = _smooth(11.0, 2.0, V[:, 1] - _H[1])            # 1 at the back of the mouth

        # dorsal line: march from the body's centre line out through the back
        cl = np.array([[0, 25, 74], [0, 19, 71], [0, 12, 69.5], [0, 7, 64.5], [0, 3, 56], [0, -2, 47], [0, -6.5, 39], [0, -11, 33], [0, -15, 30.3]] + [list(p) for p in _TP[1:]], float)
        for _ in range(3):                                     # Chaikin smoothing
            cl = np.concatenate([cl[:1], np.stack([0.75 * cl[:-1] + 0.25 * cl[1:], 0.25 * cl[:-1] + 0.75 * cl[1:]], 1).reshape(-1, 3), cl[-1:]])
        seg = np.linalg.norm(np.diff(cl, axis=0), axis=1); arc = np.concatenate([[0], np.cumsum(seg)])
        sa = np.arange(0.0, arc[-1] - 1.0, 0.5)
        cs = np.stack([np.interp(sa, arc, cl[:, i]) for i in range(3)], 1)
        tg = _nrm(np.gradient(cs, axis=0))
        dd = np.stack([np.zeros(len(sa)), tg[:, 2], -tg[:, 1]], 1)
        ts = np.arange(0.0, 24.0, 0.2)
        vals = S.sdf((cs[:, None, :] + ts[None, :, None] * dd[:, None, :]).reshape(-1, 3)).reshape(len(sa), len(ts))
        dors = cs + ts[np.argmax(vals > 0, axis=1)][:, None] * dd     # points on the skin along the spine and tail
        dmin = np.full(len(V), 1e3)
        for i in range(0, len(dors) - 2, 2):
            dmin = np.minimum(dmin, seg_d(V, dors[i], dors[i + 2]))

        Vm = np.stack([np.abs(V[:, 0]), V[:, 1], V[:, 2]], 1)  # mirrored to the right side
        sgn = np.where(V[:, 0] < 0, -1.0, 1.0)
        g = 0.7 * np.exp(-(dmin / 1.4) ** 2)
        g = np.maximum(g, 1.0 * np.exp(-(seg_d(V, _H + [0, 1.5, -7.5], (0, 23.0, 58.0)) / 4.6) ** 2))           # throat
        g = np.maximum(g, 0.8 * np.exp(-(seg_d(Vm, _RIB + [14.5, 0.5, 1.0], (11.5, -3.5, 43.0)) / 3.8) ** 2))   # flanks
        g = g * (1 - mouth) + mouth * 0.75 * deep
        g *= 1.0 - 0.9 * (Wt[:, ix['head']] * (1 - mouth))    # keep the face dark so the eyes carry it
        glowm = np.clip(g, 0, 1)

        # ---- photophores: uneven rows of soft light organs, placed on the skin --------------------
        def row(pts, lo_, hi_):
            pts = np.asarray(pts, float); sg_ = np.linalg.norm(np.diff(pts, axis=0), axis=1); ar = np.concatenate([[0], np.cumsum(sg_)])
            q = np.cumsum(rng.uniform(lo_, hi_, int(ar[-1] / lo_) + 2)); q = q[q < ar[-1]]
            return np.stack([np.interp(q, ar, pts[:, i]) for i in range(3)], 1)
        rows = [row([_RIB + [15.0, -3.0, 7.0], _RIB + [14.6, -5.0, -2.0], (12.5, -5.5, 45), (11.8, -9.0, 37), (7.5, -17, 32)] + [(0.82 * _TR[i] + 0.3, _TP[i][1], _TP[i][2] + 1.2) for i in range(1, _TAILN)], 3.2, 7.5),
                row([_RIB + [14.6, 4.0, -3.0], (13.0, 4.0, 47), (12.0, -1.0, 40), (12.0, -5.0, 35)], 3.0, 6.5),
                row([_E + [4.8, 0.5, -5.0], _W + [3.2, 0.5, 2.5]], 3.0, 6.0),
                row([_H + [5.6 * np.sin(a), -2.0 + 5.8 * np.cos(a), -9.3] for a in np.linspace(0.2, 1.8, 6)], 1.8, 3.2),
                row([_H + [4.4 * np.sin(a), -2.0 + 4.8 * np.cos(a), -11.6] for a in np.linspace(0.3, 1.6, 6)], 1.8, 3.2)]
        # each vertex stores the centre, radius and brightness of its nearest organ; the shader draws the round spot
        phot = np.zeros(len(V)); photr = np.ones(len(V)); pj = np.full(len(V), -1); best = np.full(len(V), 1e9)
        for pts in rows:
            for sg_ in (1.0, -1.0):
                for c in pts * [sg_, 1, 1]:
                    j = np.argmin(np.sum((V - c) ** 2, 1))
                    r2 = np.sum((V - V[j]) ** 2, 1); sig = rng.uniform(0.30, 0.62)
                    m = (r2 < (5 * sig + 1.5) ** 2) & (r2 < best)
                    phot[m] = rng.uniform(0.2, 1.0) ** 1.5; photr[m] = sig; pj[m] = j; best[m] = r2[m]

        # ---- lumpy mass -------------------------------------------------------------------------
        detail = np.ones(nb)
        for nme, f in (('head', 0.3), ('jaw', 0.3), ('hand_R', 0.5), ('hand_L', 0.5), ('neck2', 0.7)): detail[ix[nme]] = f
        for nme in self.names:
            if nme[0] == 'f' and nme[1].isdigit(): detail[ix[nme]] = 0.25
        for i in range(_TAILN): detail[ix['tail%d' % (i + 1)]] = max(1.0 - 0.11 * i, 0.2)
        amp = (Wt @ detail) * (1 - mouth)
        Pn = V + rng.uniform(0, 100, 3)
        disp = 1.1 * (_fbm3(Pn * 0.10, 3, seed=self.seed) - 0.5) + 0.5 * (_fbm3(Pn * 0.30, 2, seed=self.seed + 5) - 0.5)
        fold = 1.0 - np.abs(2 * _fbm3(Pn * [0.16, 0.16, 0.30] + 31.0, 2, seed=self.seed + 9) - 1)      # skin folds, mostly across the limbs
        disp += 0.55 * (0.3 - fold ** 4)
        V0 = V
        V = V + N * (disp * amp)[:, None]
        Nr = N
        photc = np.where((pj >= 0)[:, None], V[np.maximum(pj, 0)], V + 500.0)

        nbody = len(V)
        parts_V = [V]; parts_F = Q.tolist(); parts_W = [Wt]; parts_N = [Nr]
        mat_idx = [np.zeros(len(Q), np.int32)]
        a_h = [np.zeros(nbody)]; a_kind = [np.zeros(nbody)]
        off = nbody

        def add(Vp, Fp, hp, Wp, mat, kind):
            nonlocal off
            parts_V.append(Vp); parts_F.extend([[i + off for i in f] for f in Fp]); parts_W.append(np.broadcast_to(Wp, (len(Vp), nb)))
            parts_N.append(np.tile([0.0, 0.0, 1.0], (len(Vp), 1)))
            mat_idx.append(np.full(len(Fp), mat, np.int32)); a_h.append(hp); a_kind.append(np.full(len(Vp), kind, float))
            off += len(Vp)

        def one(bone):
            w = np.zeros(nb); w[ix[bone]] = 1.0; return w

        def near_w(p):
            return Wt[np.argmin(np.sum((V0 - p) ** 2, 1))]

        def plant(p0, d, maxd=5.0):
            """March from p0 along d until inside the body; returns the entry point or None."""
            ts_ = np.arange(0.0, maxd, 0.1)
            v = S.sdf(p0[None] + ts_[:, None] * d[None])
            if v[0] < 0.05 or not np.any(v < 0): return None
            return p0 + ts_[np.argmax(v < 0)] * d

        # ---- teeth: uneven, the lower ones longer and standing outside the upper lip ----------------
        Rj = _rx(-REST_OPEN)
        def upper(x, y, L, out):
            p = plant(_H + np.array([x, y, -4.4]), np.array([0, 0, 1.0]), 3.4)
            if p is None: return
            d = _nrm(np.array([out[0] * 0.2, out[1] * 0.2, -1.0]))
            Vp, Fp, hp = _horn(p - d * 0.7, d, L + 0.7, 0.17 * L + 0.2, bend_dir=-np.array([out[0], out[1], 0.0]), bend=0.14, m=7, nr=3, power=0.8)
            add(Vp, Fp, hp, one('head'), 1, 0.0)

        def lower(x, y, L, out):
            p0 = _J + Rj @ np.array([x, y, 3.8]); dn = Rj @ np.array([0, 0, -1.0])
            p = plant(p0, dn, 4.8)
            if p is None: return
            d = Rj @ _nrm(np.array([out[0] * 0.12, out[1] * 0.12, 1.0]))
            Vp, Fp, hp = _horn(p - d * 0.7, d, L + 0.7, 0.15 * L + 0.22, bend_dir=Rj @ -np.array([out[0], out[1], 0.0]), bend=0.16, m=7, nr=3, power=0.8)
            add(Vp, Fp, hp, one('jaw'), 1, 0.0)

        for sg in (1, -1):
            for s in np.arange(0.24, 1.0, 0.085):                                # along the sides
                r = 4.6 - 1.3 * s
                upper(sg * (r * 1.42 - 0.85), 3.0 + 10.0 * s + rng.uniform(-0.15, 0.15), rng.uniform(1.0, 2.2), (sg, 0))
            for s in np.arange(0.2, 1.0, 0.115):
                rl = 3.6 - 0.4 * s
                lower(sg * (rl * 1.62 - 0.8), 0.5 + 13.1 * s + rng.uniform(-0.2, 0.2), rng.uniform(1.6, 3.4) * (1.5 if 0.5 < s < 0.64 else 1.0), (sg, 0))
            for a in (15, 40, 65, 86):                                           # around the front
                c, s_ = np.cos(a * _D), np.sin(a * _D)
                upper(sg * 3.8 * c, 13.0 + 2.4 * s_, rng.uniform(1.2, 2.2), (sg * c, s_))
            for a in (12, 38, 64, 85):
                c, s_ = np.cos(a * _D), np.sin(a * _D)
                lower(sg * 4.35 * c, 13.6 + 2.35 * s_, rng.uniform(2.0, 3.2) * (1.75 if a == 38 else 1.0), (sg * c, s_))

        # ---- claws and spurs --------------------------------------------------------------------
        for sd, sg in (('R', 1.0), ('L', -1.0)):
            m3 = np.array([sg, 1, 1])
            for i in range(3):
                K = _knuckle(i); d = _fdir(i)
                base = K + 4.5 * d + _PALM * 0.65
                Vp, Fp, hp = _horn(base * m3, _nrm(d - _PALM * 0.25) * m3, 9.0, 1.45, bend_dir=_PALM * m3, bend=0.42, m=8, nr=6, power=0.85, flat=0.8, side=_LAT * m3)
                if sg < 0: Fp = [f[::-1] for f in Fp]
                add(Vp, Fp, hp, one('f%d_%s' % (i + 1, sd)), 1, 1.0)
            Vp, Fp, hp = _horn((_E + [0.3, -3.2, 1.0]) * m3, _nrm([0.25, -0.8, 0.55]) * m3, 6.0, 1.8, bend_dir=np.array([0, 0.2, 1.0]), bend=0.2, m=8, nr=4)
            if sg < 0: Fp = [f[::-1] for f in Fp]
            add(Vp, Fp, hp, one('farm_' + sd), 1, 1.0)

        # ---- cheek spikes: a frill of bony quills behind the jaw, on their own bones so they can flare ----
        for sd, sg in (('R', 1.0), ('L', -1.0)):
            m3 = np.array([sg, 1, 1])
            for bp, d, L in _CHEEK:
                Vp, Fp, hp = _horn((_H + bp - d * 1.0) * m3, d * m3, L + 1.0, 1.25, bend_dir=np.array([0, -1.0, 0.25]), bend=0.22, m=8, nr=5, power=0.9, flat=0.75, side=(0, 0, 1))
                if sg < 0: Fp = [f[::-1] for f in Fp]
                add(Vp, Fp, hp, 0.7 * one('gill_' + sd) + 0.3 * one('head'), 1, 1.0)

        # ---- eyes: small, deep under the brow shelf ----------------------------------------------
        for sg in (1, -1):
            c = _H + np.array([sg * 4.55, 7.65, 1.35])
            Vp, Fp = _ball(c, 0.46)
            look = _nrm([sg * 0.6, 0.8, 0.0])
            add(Vp, Fp, _smooth(0.3, 0.95, _nrm(Vp - c) @ look), one('head'), 3, 0.0)

        # ---- dorsal spines: clusters of long quills on the hump, shrinking to a keel on the tail ----
        total = sa[-1]
        def size_at(s):
            return float(np.interp(s, [0, 5, 13, 22, 34, 46, 56, 72, total], [1.2, 3.0, 9.0, 12.5, 8.5, 5.5, 5.0, 3.6, 0.9]))
        def spine(i, L, lean_x):
            d = _nrm(dd[i] + tg[i] * 0.55 + np.array([lean_x, 0, 0]))
            base = dors[i] + np.array([lean_x * 2.2, 0, 0]) - d * (1.0 + 0.06 * L)
            Vp, Fp, hp = _horn(base, d, L + 1.0, 0.085 * L + 0.42, bend_dir=tg[i], bend=0.22, m=7, nr=5, power=0.9, flat=0.62, side=(1, 0, 0))
            add(Vp, Fp, hp, near_w(dors[i]), 2, 0.0)
        s = 3.5
        while s < total - 2.0:
            L = size_at(s) * rng.uniform(0.8, 1.2)
            i = int(np.searchsorted(sa, s))
            spine(i, L, rng.uniform(-0.06, 0.06))
            if L > 4.0:                                                         # flanking quills
                for sg in (1, -1):
                    j = min(i + int(rng.integers(0, 3)), len(sa) - 1)
                    spine(j, L * rng.uniform(0.45, 0.7), sg * rng.uniform(0.22, 0.4))
            s += 0.30 * L + 1.3
        for sg in (1, -1):                                                      # a few stray quills on the shoulders
            for (x, y, z, L) in ((8.5, 2.0, 75.0, 6.0), (13.0, 5.0, 74.5, 4.2), (7.5, -1.0, 67.0, 4.5)):
                p0 = np.array([sg * x, y + 4.0, z - 5.0]); d = _nrm([sg * 0.12, -0.6, 0.78])
                tsm = np.arange(0, 18, 0.2); v = S.sdf(p0[None] + tsm[:, None] * d[None])
                p = p0 + tsm[np.argmax(v > 0)] * d
                d2 = _nrm(d + [0, -0.35, -0.1])
                Vp, Fp, hp = _horn(p - d2 * 1.2, d2, L * rng.uniform(0.9, 1.15) + 1.2, 0.085 * L + 0.42, bend_dir=np.array([0, -0.6, -0.8]), bend=0.22, m=7, nr=5, flat=0.62, side=(1, 0, 0))
                add(Vp, Fp, hp, near_w(p), 2, 0.0)

        k = self.SCALE                                        # sculpted slightly small; scale everything to the film's size
        V_all = np.concatenate(parts_V) * k; W_all = np.concatenate(parts_W).astype(np.float32); N_all = np.concatenate(parts_N)
        photc = photc * k; photr = photr * k; self.piv = self.piv * k
        nall = len(V_all); npart = nall - nbody
        pad = lambda a, v=0.0: np.concatenate([a, np.full(npart, v)])
        attrs = {'belly': pad(belly), 'cav': pad(cav), 'glowm': pad(glowm), 'mouth': pad(mouth), 'phot': pad(phot), 'photr': pad(photr, 1.0), 'h': np.concatenate(a_h), 'kind': np.concatenate(a_kind)}
        self.obj = bl.mesh_object('creature', V_all, parts_F, smooth=True, attrs=attrs)
        me = self.obj.data
        for nm, arr in (('rest', V_all), ('restn', N_all), ('photc', np.concatenate([photc, np.full((npart, 3), 999.0)]))):
            at = me.attributes.new(nm, 'FLOAT_VECTOR', 'POINT'); at.data.foreach_set('vector', arr.astype(np.float32).ravel())
        me.polygons.foreach_set('material_index', np.concatenate(mat_idx))
        me.update()
        self.rest = V_all.astype(np.float32)
        self._rest1 = np.concatenate([self.rest, np.ones((nall, 1), np.float32)], 1)
        self.W = W_all
        self.tris = int(sum(len(f) - 2 for f in parts_F))
        self.nverts = nall
        self._anchors = {'head': [(ix['head'], k * (_H + np.array([0, 5.0, 0.8])))],
                         'chest': [(ix['spine2'], k * (_RIB + np.array([0, 10.5, -6.0])))],
                         'mouth': [(ix['head'], k * (_H + np.array([0, 12.5, -3.0]))), (ix['jaw'], k * (_J + _rx(-REST_OPEN) @ np.array([0, 12.5, 1.5])))]}

    # ----------------------------------------------------------------------------------------
    # materials
    # ----------------------------------------------------------------------------------------
    def _glow_gate(self, n):
        """Glow value node times a light-path gate: full for camera rays, reduced in glossy reflections, zero as a light."""
        val = n.new('ShaderNodeValue'); val.outputs[0].default_value = 1.0
        lp = n.new('ShaderNodeLightPath')
        gate = n.math('ADD', lp.outputs['Is Camera Ray'], n.math('MULTIPLY', lp.outputs['Is Glossy Ray'], self.GLOSSY_GLOW), clamp=True)
        return val, n.math('MULTIPLY', val.outputs[0], gate)

    def _finish(self, mat):
        mat.cycles.emission_sampling = 'NONE'        # the glow is seen, never sampled as a light: no light tree, no noise
        self.obj.data.materials.append(mat)

    def _build_materials(self):
        me = self.obj.data
        img_a, img_b = _skin_textures(self.seed)

        def attr(n, name, out):
            return n.new('ShaderNodeAttribute', attribute_name=name).outputs[out]            # 0 colour, 1 vector, 2 factor

        def ss(n, x, a, b, lo=0.0, hi=1.0):
            return n.new('ShaderNodeMapRange', interpolation_type='SMOOTHSTEP', inputs={0: x, 1: a, 2: b, 3: lo, 4: hi}).outputs[0]

        def mul(n, a, b): return n.math('MULTIPLY', a, b)
        def add(n, a, b): return n.math('ADD', a, b)

        # ---- hide ---------------------------------------------------------------------------------
        mat, n = bl.material('creature_hide')
        rest = attr(n, 'rest', 1); belly = attr(n, 'belly', 2); cav = attr(n, 'cav', 2); gm = attr(n, 'glowm', 2); mouth = attr(n, 'mouth', 2)
        pd = n.math('DIVIDE', n.vmath('DISTANCE', rest, attr(n, 'photc', 1)), attr(n, 'photr', 2))          # light organs: round spots in bind space
        phot = mul(n, attr(n, 'phot', 2), add(n, ss(n, pd, 1.0, 0.35), mul(n, ss(n, pd, 2.6, 0.5), 0.10)))
        sn = n.new('ShaderNodeSeparateXYZ', inputs={0: attr(n, 'restn', 1)})
        w = [n.math('POWER', n.math('ABSOLUTE', sn.outputs[i]), 4.0) for i in range(3)]
        tot = add(n, add(n, w[0], w[1]), add(n, w[2], 1e-4))
        w = [n.math('DIVIDE', wi, tot) for wi in w]

        def tri(img, scale):
            """Tri-planar lookup in bind space, blended by the bind normal -> ([r, g, b], a)."""
            sp = n.new('ShaderNodeSeparateXYZ', inputs={0: n.vmath('SCALE', rest, scale=scale)}).outputs
            col = None; alp = None
            for (a, b), wi in zip(((sp[1], sp[2]), (sp[2], sp[0]), (sp[0], sp[1])), w):
                t = n.new('ShaderNodeTexImage', image=img, inputs={'Vector': n.new('ShaderNodeCombineXYZ', inputs={0: a, 1: b}).outputs[0]})
                c = n.vmath('SCALE', t.outputs['Color'], scale=wi); al = mul(n, t.outputs['Alpha'], wi)
                col = c if col is None else n.vmath('ADD', col, c); alp = al if alp is None else add(n, alp, al)
            return n.new('ShaderNodeSeparateXYZ', inputs={0: col}).outputs, alp

        (sc_h, crease, tone), wart = tri(img_a, 1 / 21.0)          # scales about half a metre across
        (plate, fold, _), blob = tri(img_a, 1 / 83.0)             # the same map, big: plates, folds, crust blobs
        (veins, halo, spots), mottle = tri(img_b, 1 / 58.0)

        sep = n.new('ShaderNodeSeparateXYZ', inputs={0: rest})    # belly scutes: bands across the trunk
        band = n.math('FRACT', mul(n, add(n, add(n, sep.outputs[2], mul(n, sep.outputs[1], 0.35)), mul(n, fold, 1.6)), 0.40))
        band_h = mul(n, ss(n, band, 0.0, 0.25), ss(n, band, 1.0, 0.28))
        bellyf = ss(n, belly, 0.25, 0.75)
        far = ss(n, n.new('ShaderNodeCameraData').outputs['View Distance'], 80.0, 300.0)      # sub-pixel bumps only sparkle: fade them with distance
        near = n.math('SUBTRACT', 1.0, mul(n, far, 0.8))
        skin_h = add(n, mul(n, add(n, add(n, mul(n, sc_h, 0.085), mul(n, wart, 0.15)), mul(n, crease, 0.06)), near), add(n, mul(n, fold, 0.34), mul(n, plate, 0.12)))
        belly_h = add(n, mul(n, band_h, 0.32), mul(n, add(n, mul(n, sc_h, 0.03), mul(n, crease, 0.07)), near))
        height = n.mix(bellyf, skin_h, belly_h, 'FLOAT')
        height = mul(n, height, n.math('SUBTRACT', 1.0, mul(n, mouth, 0.75)))
        bump = n.new('ShaderNodeBump', inputs={'Strength': 0.75, 'Distance': 1.0, 'Height': height})

        mo = ss(n, mottle, 0.36, 0.66)
        back = n.mix(mo, (0.017, 0.022, 0.026, 1), (0.066, 0.068, 0.052, 1))
        back = n.mix(mul(n, tone, 0.5), back, (0.045, 0.036, 0.026, 1))
        back = n.mix(mul(n, wart, 0.4), back, (0.13, 0.12, 0.09, 1))
        bel = n.mix(mo, (0.17, 0.14, 0.092, 1), (0.28, 0.23, 0.14, 1))
        col = n.mix(mul(n, bellyf, add(n, 0.6, mul(n, mo, 0.4))), back, bel)
        groove = n.mix(bellyf, sc_h, add(n, 0.3, mul(n, band_h, 0.7)), 'FLOAT')
        col = n.mix(mul(n, n.math('SUBTRACT', 1.0, groove, clamp=True), 0.65), col, (0.007, 0.008, 0.007, 1))
        crust = mul(n, mul(n, ss(n, blob, 0.15, 0.6), ss(n, mottle, 0.50, 0.62)), n.math('SUBTRACT', 1.0, bellyf))   # pale encrustation
        col = n.mix(mul(n, crust, 0.6), col, (0.26, 0.25, 0.21, 1))
        col = n.mix(mul(n, cav, 0.8), col, (0.006, 0.007, 0.006, 1))                      # grime in the creases
        flesh = n.mix(cav, (0.30, 0.05, 0.055, 1), (0.045, 0.008, 0.012, 1))
        col = n.mix(mouth, col, flesh)
        rough = n.mix(bellyf, add(n, 0.33, mul(n, mo, 0.14)), 0.30, 'FLOAT')
        rough = add(n, rough, mul(n, crust, 0.3))
        rough = n.mix(mouth, rough, 0.17, 'FLOAT')
        rough = add(n, rough, mul(n, far, 0.10))

        val, gate = self._glow_gate(n); self._glow_nodes.append(val)
        flare = n.math('MAXIMUM', n.math('SUBTRACT', val.outputs[0], 1.0), 0.0)             # veins only show strongly when it flares
        zone = mul(n, ss(n, gm, 0.15, 0.8), n.math('SUBTRACT', 1.0, mouth, clamp=True))
        core = ss(n, gm, 0.5, 0.95)
        e = mul(n, zone, add(n, add(n, mul(n, spots, 0.5), mul(n, halo, 0.03)), mul(n, mul(n, veins, core), add(n, 0.14, mul(n, flare, 0.45)))))
        e = add(n, e, add(n, mul(n, phot, 1.0), mul(n, mul(n, mul(n, mouth, mul(n, gm, gm)), add(n, 0.5, veins)), add(n, 0.02, mul(n, flare, 0.2)))))        # the throat lights up when it flares
        p = bl.principled(n, Base_Color=col, Roughness=rough, Normal=bump.outputs[0], Coat_Weight=0.65, Coat_Roughness=add(n, 0.17, mul(n, far, 0.15)),
                          Emission_Color=GREEN + (1.0,), Emission_Strength=mul(n, mul(n, e, gate), self.GLOW_STRENGTH))
        n.links.new(bump.outputs[0], p.inputs['Coat Normal'])
        n.output(p.outputs[0]); self._finish(mat)

        # ---- teeth, claws ---------------------------------------------------------------------------
        mat, n = bl.material('creature_horn')
        hh = attr(n, 'h', 2); kind = attr(n, 'kind', 2); rest = attr(n, 'rest', 1)
        st = n.new('ShaderNodeTexNoise', inputs={'Vector': rest, 'Scale': 2.2, 'Detail': 2.0}).outputs[0]
        tooth = n.mix(ss(n, hh, 0.05, 0.6), (0.085, 0.055, 0.028, 1), (0.42, 0.37, 0.25, 1))
        claw = n.mix(ss(n, hh, 0.1, 0.95), (0.022, 0.02, 0.018, 1), (0.19, 0.16, 0.11, 1))
        col = n.mix(kind, tooth, claw)
        col = n.mix(mul(n, st, 0.5), col, (0.03, 0.025, 0.02, 1))
        bump = n.new('ShaderNodeBump', inputs={'Strength': 0.5, 'Distance': 0.1, 'Height': st})
        p = bl.principled(n, Base_Color=col, Roughness=0.3, Normal=bump.outputs[0], Coat_Weight=0.5, Coat_Roughness=0.1)
        n.output(p.outputs[0]); self._finish(mat)

        # ---- dorsal spines --------------------------------------------------------------------------
        mat, n = bl.material('creature_spine')
        hh = attr(n, 'h', 2); rest = attr(n, 'rest', 1)
        stri = n.new('ShaderNodeTexNoise', inputs={'Vector': rest, 'Scale': 1.4, 'Detail': 3.0}).outputs[0]
        ring = n.math('FRACT', mul(n, hh, 9.0))
        col = n.mix(stri, (0.016, 0.018, 0.018, 1), (0.07, 0.062, 0.048, 1))
        col = n.mix(ss(n, hh, 0.5, 1.0), col, (0.15, 0.13, 0.095, 1))                      # worn pale tips
        bump = n.new('ShaderNodeBump', inputs={'Strength': 0.6, 'Distance': 0.2, 'Height': add(n, stri, mul(n, ring, 0.5))})
        val, gate = self._glow_gate(n); self._glow_nodes.append(val)
        e = mul(n, n.math('POWER', n.math('SUBTRACT', 1.0, hh, clamp=True), 7.0), add(n, 0.2, stri))
        p = bl.principled(n, Base_Color=col, Roughness=0.4, Normal=bump.outputs[0], Coat_Weight=0.5, Coat_Roughness=0.12,
                          Emission_Color=GREEN + (1.0,), Emission_Strength=mul(n, mul(n, e, gate), self.GLOW_STRENGTH * 0.12))
        n.output(p.outputs[0]); self._finish(mat)

        # ---- eyes -----------------------------------------------------------------------------------
        mat, n = bl.material('creature_eye')
        hh = attr(n, 'h', 2)
        val, gate = self._glow_gate(n); self._eye_nodes.append(val)
        p = bl.principled(n, Base_Color=(0.01, 0.012, 0.008, 1), Roughness=0.08, Emission_Color=(0.5, 1.0, 0.12, 1),
                          Emission_Strength=mul(n, mul(n, add(n, 0.10, hh), gate), 4.0))
        n.output(p.outputs[0]); self._finish(mat)

    # ----------------------------------------------------------------------------------------
    # poses.  A pose is an (nb + 1, 3) array: Euler degrees per bone, last row = pelvis offset (m).
    # ----------------------------------------------------------------------------------------
    def _Z(self):
        return np.zeros((self.nb + 1, 3))

    def _add(self, V, name, rx=0.0, ry=0.0, rz=0.0):
        V[self.ix[name]] += (rx, ry, rz)

    def _sym(self, V, name, rx=0.0, ry=0.0, rz=0.0):
        V[self.ix[name + '_R']] += (rx, ry, rz); V[self.ix[name + '_L']] += (rx, -ry, -rz)

    def _fingers(self, V, curl, side='RL'):
        for sd in side:
            for i in range(3): V[self.ix['f%d_%s' % (i + 1, sd)], 0] += curl

    def _jaw(self, V, open_deg):
        V[self.ix['jaw'], 0] = REST_OPEN - open_deg

    def _tail(self, V, rx=None, rz=None):
        for i in range(_TAILN):
            if rx is not None: V[self.ix['tail%d' % (i + 1)], 0] += rx[i]
            if rz is not None: V[self.ix['tail%d' % (i + 1)], 2] += rz[i]

    def _arm(self, V, side, u, f, hand=0.0, curl=None):
        """Aim an arm: `u`, `f` are the wanted upper-arm and forearm directions in the chest's frame, written for the
        RIGHT arm (x is mirrored for the left). Solves the shoulder Euler angles and the elbow flex."""
        u = _nrm(u); f = _nrm(f)
        u0 = _nrm(_E - _S); f0 = _nrm(_W - _E)
        want = np.arccos(np.clip(u @ f, -1, 1))
        th = np.arange(-10.0, 150.0, 1.0)
        fl = np.array([_rx(t) @ f0 for t in th])
        k = int(np.argmin(np.abs(np.arccos(np.clip(fl @ u0, -1, 1)) - want)))
        def basis(d1, d2):
            e3 = np.cross(d1, d2); e3 = e3 / (np.linalg.norm(e3) + 1e-9); return np.stack([d1, np.cross(e3, d1), e3], 1)
        R = basis(u, f) @ basis(u0, fl[k]).T
        e = np.array([np.arcsin(np.clip(R[2, 1], -1, 1)), np.arctan2(-R[2, 0], R[2, 2]), np.arctan2(-R[0, 1], R[1, 1])]) / _D
        if side == 'L': e = e * [1, -1, -1]
        V[self.ix['uarm_' + side]] = e; V[self.ix['farm_' + side]] = (th[k], 0, 0); V[self.ix['hand_' + side]] = (hand, 0, 0)
        if curl is not None:
            for i in range(3): V[self.ix['f%d_%s' % (i + 1, side)]] = (curl, 0, 0)

    def _arms(self, V, u, f, hand=0.0, curl=None):
        self._arm(V, 'R', u, f, hand, curl); self._arm(V, 'L', u, f, hand, curl)

    def _build_poses(self):
        Z, add, sym, fingers, jaw, tail, arm, arms = self._Z, self._add, self._sym, self._fingers, self._jaw, self._tail, self._arm, self._arms
        T = self.nb
        # standing: knuckles low, forearms hanging forward over the water
        ST = Z()
        arms(ST, (0.30, 0.22, -0.93), (0.02, 0.60, -0.80), hand=8, curl=-22)
        jaw(ST, 7); tail(ST, rx=[16, 10, 2, -8, -12, -10, -6, -3])
        self.P_stand = ST
        # swimming: prone, arms swept back along the flanks, only the hump and its quills above the water
        SW = Z()
        add(SW, 'pelvis', -60); SW[T] = (0, -12, -27.5)
        add(SW, 'spine1', 4); add(SW, 'spine2', 5); add(SW, 'spine3', 6); add(SW, 'neck1', 8); add(SW, 'neck2', 8); add(SW, 'head', 10)
        arms(SW, (0.32, -0.50, -0.80), (0.12, -0.42, -0.90), hand=0, curl=-30)
        sym(SW, 'uleg', 8, 0, 0); sym(SW, 'lleg', -22, 0, 0); sym(SW, 'foot', 50, 0, 0)
        jaw(SW, 4); tail(SW, rx=[30, 22, 10, 0, 0, 0, 0, 0])
        self.P_swim = SW
        # rising out of the water: chest out, head back, arms thrown down and back to shed the sea
        RI = ST.copy()
        add(RI, 'spine1', 4); add(RI, 'spine2', 7); add(RI, 'spine3', 8); add(RI, 'neck1', 6); add(RI, 'neck2', 8); add(RI, 'head', 14)
        arms(RI, (0.62, -0.30, -0.72), (0.70, 0.25, -0.67), hand=10, curl=26); jaw(RI, 30); RI[T] = (0, 0, 1.5)
        self.P_rise = RI
        # roar: jaws wide, head thrown, arms spread with the claws open
        RO = ST.copy()
        add(RO, 'pelvis', 1); add(RO, 'spine1', 2); add(RO, 'spine2', 3); add(RO, 'spine3', 3); add(RO, 'neck1', 2); add(RO, 'neck2', 4); add(RO, 'head', 8)
        sym(RO, 'clav', 0, -6, 0); arms(RO, (0.74, -0.22, -0.63), (0.55, 0.62, -0.56), hand=14, curl=30)
        sym(RO, 'uleg', 6, -3, 0); sym(RO, 'lleg', -10, 0, 0); RO[T] = (0, -1.0, -1.2)
        jaw(RO, 58); tail(RO, rx=[-6, -6, -4, 0, 0, 0, 0, 0]); sym(RO, 'gill', 0, -14, 26)
        self.P_roar = RO
        # anticipation before the roar
        AN = ST.copy()
        add(AN, 'spine1', -4); add(AN, 'spine2', -6); add(AN, 'spine3', -5); add(AN, 'neck1', -6); add(AN, 'head', -10)
        arms(AN, (0.22, 0.30, -0.93), (-0.10, 0.75, -0.65), hand=8, curl=-40); AN[T] = (0, 0.5, -1.5); jaw(AN, 3)
        self.P_antic = AN
        # windup: right claw raised high and cocked, torso wound to the right, left arm forward as a guard
        WU = ST.copy()
        add(WU, 'pelvis', 0, 0, -8); add(WU, 'spine1', 2, 2, -5); add(WU, 'spine2', 4, 3, -7); add(WU, 'spine3', 2, 0, -6)
        add(WU, 'neck1', 0, 0, 8); add(WU, 'neck2', 0, 0, 8); add(WU, 'head', -4, 0, 8)
        arm(WU, 'R', (0.80, -0.42, 0.42), (0.30, -0.05, 0.95), hand=-6, curl=16)
        arm(WU, 'L', (0.34, 0.45, -0.83), (-0.15, 0.90, -0.40), hand=6, curl=-10)
        sym(WU, 'gill', 0, -8, 14); WU[T] = (1.0, -2.5, -1.2); jaw(WU, 18)
        self.P_windup = WU
        # the hit: the arm thrown straight at the target at head height, claws leading
        HT = ST.copy()
        add(HT, 'pelvis', -3, 0, 8); add(HT, 'spine1', -2, 0, 6); add(HT, 'spine2', -3, -2, 8); add(HT, 'spine3', -1, 0, 6)
        add(HT, 'neck1', 2, 0, -6); add(HT, 'neck2', 3, 0, -6); add(HT, 'head', 6, 0, -5)
        arm(HT, 'R', (0.93, -0.25, 0.26), (-0.30, 0.92, 0.25), hand=-40, curl=6)
        arm(HT, 'L', (0.50, -0.25, -0.83), (0.35, 0.45, -0.82), hand=8, curl=-20)
        HT[T] = (-1.0, -2.0, -1.5); jaw(HT, 34)
        self.P_hit = HT
        # follow-through: the claw rakes down and across to the left
        FO = ST.copy()
        add(FO, 'pelvis', -5, 0, 16); add(FO, 'spine1', -3, 0, 11); add(FO, 'spine2', -4, -3, 13); add(FO, 'spine3', -2, 0, 9)
        add(FO, 'neck1', 2, 0, -12); add(FO, 'neck2', 3, 0, -11); add(FO, 'head', 6, 0, -9)
        arm(FO, 'R', (0.55, 0.70, -0.45), (-0.75, 0.45, -0.48), hand=-30, curl=-30)
        arm(FO, 'L', (0.55, -0.30, -0.78), (0.40, 0.40, -0.82), hand=8, curl=-20)
        FO[T] = (-2.0, 4.0, -2.2); jaw(FO, 24)
        self.P_follow = FO
        # stagger: knocked back (stored as a delta on top of standing)
        SG = ST.copy()
        add(SG, 'pelvis', 9, 2, 6); add(SG, 'spine1', 6, 0, 3); add(SG, 'spine2', 7, 0, 3); add(SG, 'spine3', 5); add(SG, 'neck1', 8); add(SG, 'neck2', 9); add(SG, 'head', 14, 0, -8)
        arm(SG, 'R', (0.55, 0.45, -0.70), (0.45, 0.80, 0.10), hand=10, curl=20)
        arm(SG, 'L', (0.62, 0.10, -0.78), (0.30, 0.75, -0.55), hand=10, curl=20)
        jaw(SG, 33); sym(SG, 'uleg', 10, 0, 0); sym(SG, 'lleg', -16, 0, 0)
        tail(SG, rx=[-10, -8, -4, 0, 0, 0, 0, 0]); SG[T] = (0.8, -7.0, -2.0)
        self.P_stagger = SG - ST
        # death: sag, topple forward, lie awash, sink
        D1 = ST.copy()
        add(D1, 'spine1', -6); add(D1, 'spine2', -8); add(D1, 'spine3', -6); add(D1, 'neck1', -10); add(D1, 'neck2', -8); add(D1, 'head', -16, 5, 8)
        arm(D1, 'R', (0.30, 0.05, -0.95), (0.20, 0.25, -0.95), hand=0, curl=-5); arm(D1, 'L', (0.26, 0.10, -0.96), (0.15, 0.30, -0.94), hand=0, curl=-5); jaw(D1, 24)
        sym(D1, 'uleg', 18, 0, 0); sym(D1, 'lleg', -34, 0, 0); sym(D1, 'foot', 16, 0, 0); D1[T] = (0.5, 1.0, -3.5)
        D2 = ST.copy()
        add(D2, 'pelvis', -40, 5, 4); D2[T] = (1.0, 5.0, -15.0)
        add(D2, 'spine1', -4); add(D2, 'spine2', -4); add(D2, 'spine3', -2); add(D2, 'neck1', 4); add(D2, 'neck2', 2); add(D2, 'head', -6, 6, 10)
        arm(D2, 'R', (0.35, 0.55, -0.76), (0.20, 0.80, -0.56), hand=0, curl=5); arm(D2, 'L', (0.30, 0.45, -0.84), (0.20, 0.70, -0.68), hand=0, curl=5); jaw(D2, 30)
        sym(D2, 'uleg', 50, 0, 0); sym(D2, 'lleg', -70, 0, 0); sym(D2, 'foot', 30, 0, 0); tail(D2, rx=[14, 8, 0, 0, 0, 0, 0, 0])
        D3 = SW.copy()
        add(D3, 'pelvis', -6, 7, 4); D3[T] = (1.5, 10.0, -29.0)
        arm(D3, 'R', (0.50, 0.40, -0.76), (0.35, 0.85, -0.38), hand=0, curl=10); arm(D3, 'L', (0.45, 0.20, -0.87), (0.30, 0.70, -0.64), hand=0, curl=10)
        jaw(D3, 26); add(D3, 'head', -6, 8, 12)
        D4 = D3.copy(); D4[T] = (2.0, 11.0, -50.0); add(D4, 'pelvis', -3, 6, 2); tail(D4, rx=[4, 4, 4, 2, 0, 0, 0, 0])
        self.P_death = [D1, D2, D3, D4]

    # ---- motion layers ---------------------------------------------------------------------------
    def _alive(self, V, t, k=1.0):
        """Breathing, weight shift, tail sway, small hand and jaw motion. Added on top of a pose."""
        ix = self.ix; w = 2 * np.pi
        br = np.sin(w * t / 3.7); br2 = np.sin(w * t / 3.7 - 0.9)
        V[ix['spine2'], 0] += 1.3 * br * k; V[ix['spine3'], 0] += 1.0 * br2 * k; V[ix['neck1'], 0] -= 0.9 * br2 * k; V[ix['head'], 0] -= 0.9 * br2 * k
        V[self.nb, 2] += 0.3 * br * k
        V[ix['pelvis'], 1] += 1.0 * np.sin(w * t / 6.3) * k; V[ix['spine1'], 1] -= 0.8 * np.sin(w * t / 6.3) * k
        V[ix['head'], 2] += 2.2 * np.sin(w * t / 7.1 + 1.0) * k; V[ix['head'], 1] += 1.2 * np.sin(w * t / 5.3) * k
        V[ix['jaw'], 0] -= (1.8 + 1.8 * np.sin(w * t / 3.7 + 0.4)) * k
        for sd, sg, ph in (('R', 1, 0.0), ('L', -1, 1.7)):
            V[ix['uarm_' + sd], 1] -= sg * 1.4 * br * k; V[ix['uarm_' + sd], 0] += 1.5 * np.sin(w * t / 4.9 + ph) * k
            V[ix['farm_' + sd], 0] += 2.5 * np.sin(w * t / 4.1 + ph + 0.6) * k
            for i in range(3): V[ix['f%d_%s' % (i + 1, sd)], 0] += 5.0 * np.sin(w * t / 2.9 + ph + i * 0.9) * k
        for i in range(_TAILN):
            V[ix['tail%d' % (i + 1)], 2] += (2.0 + 0.9 * i) * np.sin(w * t / 5.2 - 0.6 * i) * k
        return V

    def _idle(self, t):
        return self._alive(self.P_stand.copy(), t)

    def _swim(self, t):
        ix = self.ix; V = self.P_swim.copy(); w = 2 * np.pi; ph = w * t / 2.4
        V[self.nb] += (1.2 * np.sin(ph + 0.8), 0.0, 0.5 * np.sin(2 * ph))
        V[ix['pelvis'], 2] += 5.0 * np.sin(ph); V[ix['pelvis'], 1] += 2.0 * np.sin(ph + 0.5)
        for i, b in enumerate(('spine1', 'spine2', 'spine3', 'neck1', 'neck2')):
            V[ix[b], 1] += 3.5 * np.sin(ph + 0.7 * (i + 1))             # body is prone: local Y is the vertical axis here
        for i in range(_TAILN):
            a = (5.0 + 2.2 * i) * np.sin(ph - 0.75 * (i + 1))
            if i < 2: V[ix['tail%d' % (i + 1)], 1] -= a * 0.6
            V[ix['tail%d' % (i + 1)], 2] += a * (0.5 if i < 2 else 1.0)
        for sd, sg in (('R', 1), ('L', -1)):
            V[ix['uarm_' + sd], 0] += 8 * np.sin(ph + (0 if sg > 0 else np.pi)); V[ix['uleg_' + sd], 0] += 7 * np.sin(ph + (np.pi if sg > 0 else 0))
        return V

    def _walk(self, t):
        ix = self.ix; V = self.P_stand.copy(); T = self.nb
        ph = 2 * np.pi * t / self.WALK_PERIOD
        s, c = np.sin(ph), np.cos(ph)
        V[T] += (-2.2 * c, 0.0, -1.4 - 1.0 * np.cos(2 * ph))
        V[ix['pelvis']] += (-6.0, 3.5 * c, 7.0 * s)
        V[ix['spine1']] += (0.0, -2.0 * c, -4.0 * s); V[ix['spine2']] += (1.5 * np.cos(2 * ph), -2.0 * c, -6.0 * s); V[ix['spine3']] += (0, 0, -4.0 * s)
        V[ix['neck1']] += (3.0, 0, 3.0 * s); V[ix['head']] += (3.0 + 1.5 * np.cos(2 * ph + 0.6), 0, 4.0 * s)
        for sd, sg in (('R', 1.0), ('L', -1.0)):
            ss_, cc = sg * s, sg * c
            V[ix['uleg_' + sd], 0] += 4.0 + 21.0 * ss_
            V[ix['lleg_' + sd], 0] += -(9.0 + 30.0 * max(cc, 0.0) ** 1.5)
            V[ix['foot_' + sd], 0] += 6.0 * max(cc, 0.0) - 8.0 * ss_
            V[ix['uarm_' + sd], 0] += -13.0 * ss_; V[ix['uarm_' + sd], 1] += -sg * 2.0 * 0 - 3.0
            V[ix['farm_' + sd], 0] += 6.0 - 8.0 * ss_
            V[ix['clav_' + sd], 0] += -3.0 * ss_
        for i in range(_TAILN):
            V[ix['tail%d' % (i + 1)], 2] += (3.0 + 1.3 * i) * np.sin(ph - 0.7 - 0.55 * i)
        return self._alive(V, t, 0.5)

    @staticmethod
    def _spline(t, times, poses):
        """Catmull-Rom through pose keys (clamped ends)."""
        times = np.asarray(times, float)
        if t <= times[0]: return poses[0].copy()
        if t >= times[-1]: return poses[-1].copy()
        i = int(np.searchsorted(times, t, side='right') - 1)
        t0, t1 = times[i], times[i + 1]; s = (t - t0) / (t1 - t0)
        p0, p1 = poses[i], poses[i + 1]
        m0 = (p1 - poses[i - 1]) / (t1 - times[i - 1]) if i > 0 else np.zeros_like(p0)
        m1 = (poses[i + 2] - p0) / (times[i + 2] - t0) if i + 2 < len(poses) else np.zeros_like(p0)
        h00 = 2 * s ** 3 - 3 * s ** 2 + 1; h10 = s ** 3 - 2 * s ** 2 + s; h01 = -2 * s ** 3 + 3 * s ** 2; h11 = s ** 3 - s ** 2
        return h00 * p0 + h10 * (t1 - t0) * m0 + h01 * p1 + h11 * (t1 - t0) * m1

    def _emerge(self, t):
        d = self.DUR['emerge']
        if t >= d: return self._idle(t - d)
        u = _smooth(0.0, 0.62 * d, t) ** 1.25
        over = _smooth(0.2 * d, 0.55 * d, t) * (1 - _smooth(0.62 * d, 1.0 * d, t))
        sw = self._swim(0.0) if t < 0.3 else self.P_swim
        if t < 0.3: sw = sw * (1 - t / 0.3) + self.P_swim * (t / 0.3)
        V = sw * (1 - u) + self.P_stand * u + over * (self.P_rise - self.P_stand)
        V[self.ix['head'], 2] += 5.0 * over * np.sin(2 * np.pi * 2.6 * t)          # shaking the water off
        V[self.ix['neck2'], 1] += 3.0 * over * np.sin(2 * np.pi * 2.6 * t + 1.0)
        return self._alive(V, max(t - d, -d) + 0.0, _smooth(0.5 * d, d, t))

    def _roar(self, t):
        d = self.DUR['roar']
        if t >= d: return self._idle(t - d)
        an = _smooth(0.0, 0.2, t) * (1 - _smooth(0.24, 0.5, t))
        m = _smooth(0.22, 0.6, t) * (1 - _smooth(d - 0.55, d, t))
        V = self.P_stand + an * (self.P_antic - self.P_stand) + m * (self.P_roar - self.P_stand)
        V = self._alive(V, t - d, 1 - m)
        ix = self.ix; w = 2 * np.pi; tr = m * (0.6 + 0.4 * np.sin(w * 1.3 * t))
        V[ix['head'], 2] += 1.6 * tr * np.sin(w * 11.0 * t); V[ix['head'], 0] += 1.2 * tr * np.sin(w * 13.0 * t + 1.0) + 4.0 * m * np.sin(w * 0.9 * t)
        V[ix['neck2'], 2] += 5.0 * m * np.sin(w * 0.7 * t + 0.5)
        V[ix['jaw'], 0] += 2.5 * tr * np.sin(w * 9.0 * t)
        for sd, sg in (('R', 1), ('L', -1)):
            V[ix['uarm_' + sd], 0] += 1.5 * tr * np.sin(w * 8.0 * t + sg); V[ix['farm_' + sd], 0] += 2.0 * tr * np.sin(w * 7.0 * t + 2 * sg)
        return V

    def _windup(self, t):
        u = _smooth(0.0, 0.45, t)
        V = self.P_stand * (1 - u) + self.P_windup * u
        V = self._alive(V, t, 0.5)
        ix = self.ix; w = 2 * np.pi
        V[ix['uarm_R'], 2] += u * (-4.0 * (1 - np.exp(-max(t - 0.45, 0) * 1.5)) + 0.8 * np.sin(w * 6.0 * t))    # keeps coiling, trembling
        V[ix['farm_R'], 0] += u * 1.2 * np.sin(w * 7.0 * t + 1.0)
        return V

    def _swipe(self, t):
        d = self.DUR['swipe']['dur']; hit = self.DUR['swipe']['hit']
        if t >= d: return self._idle(t - d)
        idle0 = self._idle(0.0)
        tf = hit + 0.2
        V = self._spline(t, [0.0, hit, tf, d], [self.P_windup, self.P_hit, self.P_follow, idle0])
        if t < hit:                                                              # accelerate into the hit
            s = (t / hit) ** 1.8
            V = self.P_windup * (1 - s) + V * s if t < hit * 0.5 else self._spline(hit * s, [0.0, hit, tf, d], [self.P_windup, self.P_hit, self.P_follow, idle0])
        return V

    def _stagger(self, t, amp=1.0):
        d = self.DUR['stagger']
        if t >= d: return self._idle(t - d)
        V = self._idle(t - d)
        env = lambda tt: _smooth(0.0, 0.11, tt) * (1 - _smooth(0.22, d, tt)) ** 1.3
        e = np.full((self.nb + 1, 1), env(t))
        for b in ('neck1', 'neck2', 'head', 'jaw'): e[self.ix[b]] = env(t - 0.05)   # the head whips after the body
        for sd in 'RL':
            for b in ('uarm_', 'farm_'): e[self.ix[b + sd]] = env(t - 0.08)
        for i in range(_TAILN): e[self.ix['tail%d' % (i + 1)]] = env(t - 0.06 * i)
        V = V + amp * e * self.P_stagger
        V[self.ix['head'], 2] += amp * 3.0 * env(t) * np.sin(2 * np.pi * 5.0 * t)
        return V

    def _death(self, t):
        d = self.DUR['death']
        idle0 = self._idle(0.0)
        tt = min(t, d)
        V = self._spline(tt, [0.0, 0.16 * d, 0.44 * d, 0.64 * d, d], [idle0] + self.P_death)
        k = 1 - _smooth(0.0, 0.3 * d, tt)
        V = V + k * (self._idle(tt) - idle0)
        sh = _smooth(0.0, 0.3, tt) * (1 - _smooth(0.5, 1.6, tt))                  # death shudder
        V[self.ix['head'], 2] += 4.0 * sh * np.sin(2 * np.pi * 6.0 * tt); V[self.ix['spine2'], 1] += 2.0 * sh * np.sin(2 * np.pi * 5.0 * tt)
        drift = max(t - d, 0.0)                                                   # keeps settling very slowly, stays down
        V[self.nb, 2] -= 2.0 * (1 - np.exp(-drift * 0.4))
        return V

    def _action(self, action, t, amp=1.0):
        t = float(t)
        if action == 'idle': return self._idle(t)
        if action == 'swim': return self._swim(t)
        if action == 'walk': return self._walk(t)
        if action == 'emerge': return self._emerge(max(t, 0.0))
        if action == 'roar': return self._roar(max(t, 0.0))
        if action == 'windup': return self._windup(max(t, 0.0))
        if action == 'swipe': return self._swipe(max(t, 0.0))
        if action == 'stagger': return self._stagger(max(t, 0.0), amp)
        if action == 'death': return self._death(max(t, 0.0))
        raise ValueError('unknown creature action %r' % (action,))

    def _upright(self, action, t):
        """How much of the `look` yaw applies (0 while prone)."""
        if action == 'swim': return 0.0
        if action == 'emerge': return float(_smooth(0.45 * self.DUR['emerge'], self.DUR['emerge'], t))
        if action == 'death': return float(1 - _smooth(0.0, 0.25 * self.DUR['death'], t))
        return 1.0

    # ----------------------------------------------------------------------------------------
    # public
    # ----------------------------------------------------------------------------------------
    def pose(self, action, t, prev=None, mix=1.0, look=0.0, glow=1.0, amp=1.0):
        V = self._action(action, t, amp); up = self._upright(action, t)
        eye = 1.0 if action != 'death' else float(1 - _smooth(0.1 * self.DUR['death'], 0.55 * self.DUR['death'], t))
        mix = float(np.clip(mix, 0.0, 1.0))
        if prev is not None and mix < 1.0:
            Vp = self._action(prev[0], prev[1], amp)
            V = Vp * (1 - mix) + V * mix
            up = self._upright(prev[0], prev[1]) * (1 - mix) + up * mix
            if prev[0] == 'death': eye = eye * mix
        lk = float(np.clip(look, -0.8, 0.8)) / _D * up
        V[self.ix['neck1'], 2] += 0.30 * lk; V[self.ix['neck2'], 2] += 0.30 * lk; V[self.ix['head'], 2] += 0.40 * lk
        self._apply(V)
        g = max(float(glow), 0.0)
        for nd in self._glow_nodes: nd.outputs[0].default_value = g
        for nd in self._eye_nodes: nd.outputs[0].default_value = eye * min(g, 1.0) ** 0.5 * (1.0 + 0.25 * max(g - 1.0, 0.0))
        self._pose_vec = V

    def _apply(self, V):
        nb = self.nb
        R = _euler_mats(V[:nb] * _D)
        M = np.zeros((nb, 3, 4))
        pel = self.ix['pelvis']
        for b in range(nb):
            p = self.parent[b]
            if p < 0:
                M[b, :, :3] = R[b]; M[b, :, 3] = self.piv[b]
                continue
            off = self.piv[b] - self.piv[p]
            if b == pel: off = off + V[nb] * self.SCALE
            M[b, :, 3] = M[p, :, :3] @ off + M[p, :, 3]
            M[b, :, :3] = M[p, :, :3] @ R[b]
        S = M.copy()
        S[:, :, 3] = M[:, :, 3] - np.einsum('bij,bj->bi', M[:, :, :3], self.piv)
        self._S = S
        Mv = (self.W @ S.reshape(nb, 12).astype(np.float32)).reshape(-1, 3, 4)
        co = np.einsum('nij,nj->ni', Mv, self._rest1)
        self._co = co
        me = self.obj.data
        me.vertices.foreach_set('co', co.ravel())
        me.update()

    def _root_matrix(self):
        m = np.array(self.root.matrix_basis)
        if self.root.parent is not None: m = np.array(self.root.parent.matrix_world) @ m
        return m

    def anchor(self, name):
        """World-space position of 'mouth', 'chest' or 'head' for the current pose."""
        pts = [self._S[b, :, :3] @ p + self._S[b, :, 3] for b, p in self._anchors[name]]
        loc = np.mean(pts, axis=0)
        m = self._root_matrix()
        return m[:3, :3] @ loc + m[:3, 3]
