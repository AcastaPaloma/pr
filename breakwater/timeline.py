"""The sortie: one continuous first-person shot, described as pure functions of time.

`Sortie.state(t)` returns everything a frame needs (where the machine and the creature are, what
each limb is doing, where the pilot is looking, what the instruments read). Nothing is integrated
frame to frame, so any frame can be rendered on its own, and picture, particles and sound all read
the same numbers. Beat times live in `DEFAULT`; pass a dict (or a JSON file via the CLI) to
re-direct the fight.
"""
import numpy as np
from . import SEA_FLOOR

DEFAULT = dict(
    duration=21.5,
    mech_y=-110.0, mech_x0=-800.0, mech_hold=-880.0, mech_final=-905.0,     # the machine wades west along y = mech_y
    creature_y=-101.0, swim_x0=-1480.0, emerge_x=-1140.0,
    glance=(0.9, 3.0, 0.72),            # start, end, peak yaw (rad, left = toward the city)
    contact=2.7,                        # klaxon, target lock on the wake
    emerge=3.6, roar=6.2, run=8.4,
    charge=(8.7, 10.05),                # cannon: hold from, release at
    bolt_flight=0.42,
    run2_end=13.0,                      # creature arrives in reach; windup starts
    swipe=13.75, punch_l=14.3, punch_r=14.95, slam=15.6,
    lightning=6.9,
    callsign='MUDSHARK', klass='CLASS III',
)
MECH_DUR = {'punch': {'dur': 0.62, 'hit': 0.24}, 'slam': {'dur': 0.95, 'hit': 0.42}, 'fire': {'dur': 0.5}}
CREATURE_DUR = {'emerge': 2.6, 'roar': 2.2, 'windup': 0.75, 'swipe': {'dur': 0.95, 'hit': 0.28}, 'stagger': 0.9, 'death': 4.5}
STRIDE = 19.0          # metres per footfall
WEST = np.pi / 2       # heading (rotation about Z; 0 faces +Y)


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _pulse(t, t0, decay):
    return np.exp(-(t - t0) * decay) if t >= t0 else 0.0


class Sortie:
    def __init__(self, script=None, mech_dur=None, creature_dur=None):
        self.p = dict(DEFAULT); self.p.update(script or {})
        self.md = mech_dur or MECH_DUR; self.cd = creature_dur or CREATURE_DUR
        p = self.p
        self.duration = p['duration']
        self.fire_t = p['charge'][1]
        self.impact_t = self.fire_t + p['bolt_flight']
        self.swipe_hit = p['swipe'] + self.cd['swipe']['hit']
        self.hit_l = p['punch_l'] + self.md['punch']['hit']
        self.hit_r = p['punch_r'] + self.md['punch']['hit']
        self.slam_hit = p['slam'] + self.md['slam']['hit']
        self.death_t = self.slam_hit
        self.splash_t = self.death_t + 1.75                       # the body meets the water
        # creature action track: (start, action, amp)
        self.track = [(-99.0, 'swim', 1.0), (p['emerge'], 'emerge', 1.0), (p['roar'], 'roar', 1.0), (p['run'], 'walk', 1.0),
                      (self.impact_t, 'stagger', 1.0), (self.impact_t + self.cd['stagger'], 'walk', 1.0),
                      (p['run2_end'], 'windup', 1.0), (p['swipe'], 'swipe', 1.0),
                      (self.hit_l, 'stagger', 0.35), (self.hit_l + 0.5, 'idle', 1.0), (self.hit_r, 'stagger', 0.5), (self.hit_r + 0.36, 'idle', 1.0),
                      (self.death_t, 'death', 1.0)]
        # distance walked by the machine, tabulated once so the gait phase is a pure lookup
        ts = np.linspace(0, self.duration, 4301)
        xs = np.array([self._mech_x(t) for t in ts])
        self._ts = ts; self._dist = np.concatenate([[0], np.cumsum(np.abs(np.diff(xs)))])
        ph = self._dist / STRIDE
        self.steps = [(float(ts[i]), 1 if int(np.floor(ph[i])) % 2 else -1) for i in range(1, len(ts)) if np.floor(ph[i]) != np.floor(ph[i - 1])]
        self.events = self._events()

    # ---------------------------------------------------------------- the machine
    def _mech_x(self, t):
        p = self.p
        x = p['mech_x0'] + (p['mech_hold'] - p['mech_x0']) * smooth(-1.2, p['emerge'] + 0.6, t)           # wade in, slow as it surfaces
        x += (p['mech_final'] - p['mech_hold']) * smooth(p['run'] + 0.3, p['run2_end'] - 0.6, t)          # step up to meet it
        x += 9.0 * _pulse(t, self.swipe_hit, 2.2) * (1 - _pulse(t, self.swipe_hit, 9.0))                  # shoved back by the hit
        return float(x)

    def mech(self, t):
        p = self.p
        x = self._mech_x(t)
        speed = (self._mech_x(t + 0.02) - self._mech_x(t - 0.02)) / 0.04
        ph = float(np.interp(t, self._ts, self._dist)) / STRIDE
        effort = min(1.0, abs(speed) / 22.0)
        s = np.sin(np.pi * (ph % 1.0))
        bob = (np.sin(np.pi * ph) * 0.9 * effort, 0.0, -(s ** 2) * 1.5 * effort + 0.2 * np.sin(t * 0.9))
        sway = np.sin(np.pi * ph) * 0.016 * effort
        L = ('idle', t); R = ('idle', t); charge = 0.0
        c0, c1 = p['charge']
        if c0 <= t < c1: R = ('charge', t - c0); charge = min(1.0, (t - c0) / 1.15)
        elif c1 <= t < c1 + self.md['fire']['dur']: R = ('fire', t - c1)
        if p['run2_end'] + 0.25 <= t < p['punch_l'] - 0.05: L = ('block', t - p['run2_end'] - 0.25)        # braces as it winds up
        if p['punch_l'] <= t < p['punch_l'] + self.md['punch']['dur']: L = ('punch', t - p['punch_l'])
        if p['punch_r'] <= t < p['punch_r'] + self.md['punch']['dur']: R = ('punch', t - p['punch_r'])
        if p['slam'] <= t < p['slam'] + self.md['slam']['dur']: L = R = ('slam', t - p['slam'])
        damage = min(1.0, _pulse(t, self.swipe_hit, 0.9))
        hull = 1.0 - 0.18 * smooth(self.swipe_hit, self.swipe_hit + 0.25, t)
        reactor = 1.0 - 0.30 * smooth(c0, c1, t) + 0.30 * smooth(c1 + 0.5, c1 + 4.5, t) - 0.10 * smooth(p['slam'], self.slam_hit, t) + 0.10 * smooth(self.slam_hit + 1, self.slam_hit + 4, t)
        return dict(x=x, y=p['mech_y'], heading=WEST, speed=speed, effort=effort, phase=ph, bob=bob, sway=sway, L=L, R=R, charge=charge,
                    damage=damage, hull=hull, reactor=reactor)

    # ---------------------------------------------------------------- the creature
    def creature(self, t):
        p = self.p
        i = max(k for k, seg in enumerate(self.track) if seg[0] <= t)
        start, action, amp = self.track[i]
        prev = (self.track[i - 1][1], t - self.track[i - 1][0]) if i > 0 else None
        mix = float(np.clip((t - start) / 0.25, 0, 1))
        # position along the approach line
        final = p['mech_final'] - 63.0
        a_end = p['emerge_x'] + 78.0                                   # where the plasma catches it
        x = p['swim_x0'] + (p['emerge_x'] - p['swim_x0']) * (1 - (1 - np.clip(t / p['emerge'], 0, 1)) ** 1.6)
        x += (a_end - p['emerge_x']) * smooth(p['run'], self.impact_t, t) ** 0.9
        x -= 7.0 * smooth(self.impact_t, self.impact_t + 0.35, t)
        x += (final - (a_end - 7.0)) * smooth(self.impact_t + self.cd['stagger'] - 0.1, p['run2_end'] + 0.15, t)
        x -= 3.0 * smooth(self.hit_l, self.hit_l + 0.2, t) + 4.0 * smooth(self.hit_r, self.hit_r + 0.2, t) + 9.0 * smooth(self.slam_hit, self.slam_hit + 0.5, t)
        y = p['creature_y'] + 26.0 * np.sin(t * 1.3) * (1 - smooth(p['emerge'] - 1.5, p['emerge'], t))            # a weaving wake
        glow = 1.0
        if action == 'swim': glow = 1.5
        if action == 'roar': glow = 1.0 + 1.6 * np.sin(np.clip((t - start) / self.cd['roar'], 0, 1) * np.pi) ** 0.6
        if action in ('windup', 'swipe'): glow = 1.5
        glow += 1.2 * (_pulse(t, self.impact_t, 5) + _pulse(t, self.hit_l, 6) + _pulse(t, self.hit_r, 6))
        if action == 'death': glow = max(0.0, 1.4 * (1 - (t - start) / 3.2))
        hp = 1.0 - 0.28 * smooth(self.impact_t, self.impact_t + 0.2, t) - 0.12 * smooth(self.hit_l, self.hit_l + 0.15, t) \
            - 0.14 * smooth(self.hit_r, self.hit_r + 0.15, t) - 0.46 * smooth(self.slam_hit, self.slam_hit + 0.2, t)
        return dict(x=float(x), y=float(y), heading=-WEST, action=action, t=t - start, prev=prev, mix=mix, amp=amp, glow=float(glow),
                    hp=float(max(hp, 0.0)), surfaced=t >= p['emerge'], dist=abs(self._mech_x(t) - float(x)))

    # ---------------------------------------------------------------- the pilot's head
    def camera(self, t):
        p = self.p
        g0, g1, gy = p['glance']
        yaw = gy * smooth(g0, g0 + 0.9, t) * (1 - smooth(g1 - 0.9, g1 + 0.2, t))
        pitch = -0.02 - 0.03 * smooth(p['emerge'], p['emerge'] + 1.0, t)
        d0 = self.death_t
        pitch += -0.20 * smooth(d0 + 0.6, d0 + 2.2, t) * (1 - smooth(d0 + 3.0, d0 + 4.6, t)) + 0.05 * smooth(d0 + 3.2, d0 + 5.0, t)
        pitch += 0.05 * np.sin(np.clip((t - p['roar']) / 2.2, 0, 1) * np.pi)                    # leans back from the roar
        tr = 0.0
        for st, _ in self.steps: tr += 0.10 * _pulse(t, st, 7.0)
        tr += 0.30 * _pulse(t, p['emerge'], 2.0) + 0.22 * np.sin(np.clip((t - p['roar']) / 2.2, 0, 1) * np.pi)
        tr += 0.35 * _pulse(t, self.fire_t, 5.0) + 1.0 * _pulse(t, self.swipe_hit, 2.6) + 0.45 * _pulse(t, self.hit_l, 5.0) + 0.45 * _pulse(t, self.hit_r, 5.0)
        tr += 0.8 * _pulse(t, self.slam_hit, 3.0) + 0.35 * _pulse(t, self.splash_t, 2.5) + 0.25 * _pulse(t, p['lightning'] + 1.6, 1.5)
        tr = float(min(tr, 1.0)); s = tr * tr; q = t * 31.0
        shake = (s * 0.030 * np.sin(q * 1.7 + 1.3), s * 0.034 * np.sin(q * 1.3), s * 0.040 * np.sin(q * 1.1 + 4.0))      # yaw, pitch, roll
        return dict(yaw=float(yaw + shake[0]), pitch=float(pitch + shake[1]), roll=float(shake[2]), lift=float(s * 1.0 * np.sin(q * 2.1)), trauma=tr)

    # ---------------------------------------------------------------- everything else a frame needs
    def bolt(self, t):
        """Fraction of the plasma bolt's flight, or None."""
        if self.fire_t <= t < self.impact_t: return (t - self.fire_t) / self.p['bolt_flight']
        return None

    def flash(self, t):
        l = self.p['lightning']
        return float(min(1.0, _pulse(t, l, 7.0) + 0.7 * _pulse(t, l + 0.21, 9.0)))

    def fade(self, t):
        return float(smooth(0.0, 0.7, t) * (1 - smooth(self.duration - 0.6, self.duration - 0.05, t)))

    def hud(self, t):
        p = self.p; banner = None
        def win(a, b): return float(smooth(a, a + 0.25, t) * (1 - smooth(b - 0.4, b, t)))
        if p['contact'] <= t < p['emerge'] + 0.3: banner = ('CONTACT', 'INBOUND UNDER THE GOLDEN GATE', win(p['contact'], p['emerge'] + 0.3))
        elif p['emerge'] + 0.3 <= t < p['roar'] + 0.4: banner = (p['callsign'] + ' SURFACING', p['klass'] + ' - BEARING 271', win(p['emerge'] + 0.3, p['roar'] + 0.4))
        elif self.slam_hit - 0.15 <= t < self.slam_hit + 1.3: banner = ('SYNC STRIKE', 'BOTH PILOTS COMMITTED', win(self.slam_hit - 0.15, self.slam_hit + 1.3))
        elif self.death_t + 2.0 <= t < self.duration: banner = ('LEVIATHAN DOWN', 'BAY SECURE - CITY STANDING 100', win(self.death_t + 2.0, self.duration + 1))
        return dict(banner=banner, lock=float(smooth(p['contact'], p['contact'] + 0.4, t) * (1 - smooth(self.death_t + 2.2, self.death_t + 3.2, t))),
                    boot=float(smooth(0.2, 1.4, t)), glitch=float(min(1.0, _pulse(t, self.swipe_hit, 2.2))), hit=float(min(1.0, _pulse(t, self.swipe_hit, 1.8))))

    def state(self, t):
        return dict(t=t, mech=self.mech(t), creature=self.creature(t), cam=self.camera(t), bolt=self.bolt(t), flash=self.flash(t), fade=self.fade(t), hud=self.hud(t))

    def _events(self):
        p = self.p
        ev = [(st, 'step', side) for st, side in self.steps if st < p['run2_end']]
        ev += [(p['contact'], 'klaxon', 0), (p['emerge'], 'emerge', 0), (p['roar'], 'roar', 0), (p['lightning'] + 1.6, 'thunder', 0),
               (p['charge'][0], 'charge', p['charge'][1] - p['charge'][0]), (self.fire_t, 'cannon', 0), (self.impact_t, 'plasma_hit', 0),
               (p['run2_end'], 'growl', 0), (p['swipe'] + 0.05, 'whoosh_heavy', 0), (self.swipe_hit, 'hull_hit', 0),
               (p['punch_l'], 'whoosh', -1), (self.hit_l, 'impact', -1), (p['punch_r'], 'whoosh', 1), (self.hit_r, 'impact', 1),
               (p['slam'], 'whoosh', 0), (self.slam_hit, 'slam', 0), (self.slam_hit + 0.1, 'sync', 0), (self.death_t + 0.2, 'death_bellow', 0), (self.splash_t, 'big_splash', 0)]
        return sorted(ev, key=lambda e: e[0])
