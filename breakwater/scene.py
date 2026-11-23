"""Assemble the Blender scene and render frames: world + machine + creature, posed from the timeline.

Each frame is written as a multilayer EXR (beauty, emission, position, normal, albedo) with a JSON
sidecar holding the camera and a few world-space anchors, so post-processing needs no Blender.
"""
import json, os, time
import numpy as np
import bpy
from . import bl, sky, world, SEA_FLOOR, FPS

FOV = 74.0


def _forward(heading, yaw, pitch):
    a = heading + yaw
    return np.array([-np.sin(a) * np.cos(pitch), np.cos(a) * np.cos(pitch), np.sin(pitch)])


class Film:
    def __init__(self, sortie, width=960, height=540, samples=16):
        from .mech import Mech
        from .creature import Creature
        self.sortie = sortie
        sc = bl.reset(width, height, samples)
        sc.cycles.max_bounces = 3; sc.cycles.diffuse_bounces = 2; sc.cycles.glossy_bounces = 2
        self.env = sky.equirect(2048, 1024)
        self.bg = bl.set_world(self.env, 1.0)
        self.world = world.build()
        self.mech = Mech()
        self.creature = Creature()
        self.cam = bl.camera(fov_deg=FOV)
        self.plasma = self._light('plasma', (0.35, 0.8, 1.0), 2.5)
        self.bio = self._light('bio', (0.25, 1.0, 0.12), 7.0)

    @staticmethod
    def _light(name, color, radius):
        l = bpy.data.lights.new(name, 'POINT'); l.color = color; l.energy = 0.0; l.shadow_soft_size = radius
        ob = bpy.data.objects.new(name, l); bpy.context.scene.collection.objects.link(ob)
        return ob

    def set_time(self, t):
        """Pose everything for time t (seconds). Returns the sidecar dict."""
        s = self.sortie; st = s.state(t)
        m, c, cam = st['mech'], st['creature'], st['cam']
        self.mech.root.location = (m['x'], m['y'], SEA_FLOOR); self.mech.root.rotation_euler = (0, 0, m['heading'])
        self.mech.pose(L=m['L'], R=m['R'], charge=m['charge'], twist=cam['yaw'] * 0.55, pitch=cam['pitch'], bob=m['bob'], sway=m['sway'] + cam['roll'] * 0.5,
                       damage=m['damage'], cabin=st['hud']['boot'])
        self.creature.root.location = (c['x'], c['y'], SEA_FLOOR); self.creature.root.rotation_euler = (0, 0, c['heading'])
        look = float(np.clip(np.arctan2(m['y'] - c['y'], abs(m['x'] - c['x'])) * -1.0, -0.6, 0.6)) if c['surfaced'] else 0.0
        self.creature.pose(c['action'], c['t'], prev=c['prev'], mix=c['mix'], look=look, glow=c['glow'], amp=c['amp'])
        bpy.context.view_layer.update()
        eye = np.asarray(self.mech.eye(), float) + np.array([0, 0, cam['lift']])
        fwd = _forward(m['heading'], cam['yaw'], cam['pitch'])
        r, u, f = bl.look(self.cam, eye, fwd, roll=cam['roll'])
        self.world['water_time'].default_value = t
        self.bg.inputs['Strength'].default_value = 1.0 + 2.6 * st['flash']
        muzzle = np.asarray(self.mech.muzzle(), float)
        chest = np.asarray(self.creature.anchor('chest'), float)
        # the plasma light rides the emitter, then the bolt, then lingers where it lands
        b = st['bolt']; age = t - s.impact_t
        if b is not None:
            self.plasma.location = muzzle + (chest - muzzle) * b; self.plasma.data.energy = 1.0e6
        elif 0 <= age < 0.5:
            self.plasma.location = chest + np.array([10.0, 0, 0]); self.plasma.data.energy = 2.5e6 * np.exp(-age * 7)
        elif t - s.fire_t < 0.15 and t >= s.fire_t:
            self.plasma.location = muzzle; self.plasma.data.energy = 8e5
        else:
            self.plasma.location = muzzle + f * 1.5; self.plasma.data.energy = 2.2e5 * m['charge'] ** 2
        self.bio.location = chest + np.array([14.0, 0, 4.0]); self.bio.data.energy = 1.2e5 * c['glow'] * (1.0 if c['surfaced'] else 0.0)
        bpy.context.view_layer.update()
        return dict(t=t, eye=eye.tolist(), right=list(map(float, r)), up=list(map(float, u)), fwd=list(map(float, f)), tan_half_fov=float(np.tan(np.radians(FOV) / 2)),
                    muzzle=muzzle.tolist(), chest=chest.tolist(), head=np.asarray(self.creature.anchor('head'), float).tolist())

    def render_frame(self, index, out_dir):
        """Frame `index` (0-based) -> out_dir/f_####.exr + .json. Skips frames already on disk."""
        exr = os.path.join(out_dir, 'f_%04d.exr' % index); side = exr[:-4] + '.json'
        if os.path.exists(exr) and os.path.exists(side): return 0.0
        meta = self.set_time(index / FPS)
        t0 = time.time()
        tmp = bl.render(os.path.join(out_dir, 'tmp_%04d' % index))
        with open(side, 'w') as fh: json.dump(meta, fh)
        os.replace(tmp, exr)                                   # the EXR appears only when complete
        return time.time() - t0
