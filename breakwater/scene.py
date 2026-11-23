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
    def __init__(self, sortie, width=960, height=540, samples=12):
        from .mech import Mech
        from .creature import Creature
        self.sortie = sortie
        sc = bl.reset(width, height, samples)
        sc.cycles.max_bounces = 3; sc.cycles.diffuse_bounces = 2; sc.cycles.glossy_bounces = 2
        sc.cycles.use_light_tree = False       # thousands of tiny lamp emitters make the light tree cost a third of the frame; they light nothing
        self.env = sky.equirect(2048, 1024)
        self.bg = bl.set_world(self.env, 1.0)
        self.world = world.build()
        self.mech = Mech()
        self.mech._base['armfill'] *= 0.5              # the arms' work light, pulled down toward the dusk
        self.creature = Creature()
        self.cam = bl.camera(fov_deg=FOV)
        self.plasma = self._light('plasma', (0.35, 0.8, 1.0), 2.5)
        self.bio = self._light('bio', (0.25, 1.0, 0.12), 7.0)
        # a searchlight from a helicopter holding station off the creature's flank: it is what lets the pilot see the hide
        sp = bpy.data.lights.new('search', 'SPOT'); sp.color = (0.82, 0.90, 1.0); sp.energy = 0.0; sp.spot_size = np.radians(16); sp.spot_blend = 0.5; sp.shadow_soft_size = 22.0; sp.specular_factor = 0.3      # broad and mostly diffuse: the wet hide sparkles under a hard light at this sample count
        self.search = bpy.data.objects.new('search', sp); bpy.context.scene.collection.objects.link(self.search)

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
        look = float(np.clip(np.arctan2(m['y'] - c['y'], abs(m['x'] - c['x'])), -0.6, 0.6)) if c['surfaced'] else 0.0      # + is the creature's left
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
            self.plasma.location = muzzle + (chest - muzzle) * b; self.plasma.data.energy = 6.0e4
        elif 0 <= age < 0.5:
            self.plasma.location = chest + np.array([10.0, 0, 0]); self.plasma.data.energy = 9.0e4 * np.exp(-age * 7)
        elif t - s.fire_t < 0.15 and t >= s.fire_t:
            self.plasma.location = muzzle; self.plasma.data.energy = 3.0e4
        else:
            self.plasma.location = muzzle + f * 1.5; self.plasma.data.energy = 1.5e3 * m['charge'] ** 2
        self.bio.location = chest + np.array([14.0, 0, 4.0]); self.bio.data.energy = 5.0e3 * c['glow'] * (1.0 if c['surfaced'] else 0.0)
        head = np.asarray(self.creature.anchor('head'), float)
        src = np.array([c['x'] + 130.0, c['y'] - 250.0, 235.0])                       # holding station off the creature's flank, on the pilot's left
        aim = (chest + head) / 2 if c['surfaced'] else np.array([c['x'], c['y'], 4.0])
        from mathutils import Vector
        self.search.location = src
        self.search.rotation_euler = Vector(aim - src).to_track_quat('-Z', 'Y').to_euler()
        on = float(np.clip((t - s.p['contact']) / 0.6, 0, 1)) * (1.0 - 0.75 * float(np.clip((t - s.death_t - 2.5) / 1.5, 0, 1)))
        self.search.data.energy = 7.0e6 * on
        bpy.context.view_layer.update()
        return dict(t=t, search=src.tolist(), aim=aim.tolist(), search_on=on, eye=eye.tolist(), right=list(map(float, r)), up=list(map(float, u)), fwd=list(map(float, f)), tan_half_fov=float(np.tan(np.radians(FOV) / 2)),
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
