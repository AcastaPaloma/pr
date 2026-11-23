"""A bare lit stage for looking at one model at a time under the film's real sky.

    from breakwater import stage
    stage.make()                                   # sky, water plane at z = 0, sea floor at z = SEA_FLOOR
    ... build your objects ...
    secs = stage.shoot('/tmp/x.png', cam_pos=(120, -260, 40), target=(0, 0, 30), fov=40)

`shoot` renders with Cycles, applies the film's exposure and tone curve (no fog, bloom or denoise)
and writes a PNG. It returns the render time in seconds.
"""
import os, time, tempfile
import numpy as np
import bpy
from . import bl, sky, SEA_FLOOR, EXPOSURE

_cam = None


def make(width=960, height=540, samples=24, water=True):
    global _cam
    sc = bl.reset(width, height, samples)
    bl.set_world(sky.equirect(1024, 512), 1.0)
    if water:
        q = np.array([[-30000, -30000, 0], [30000, -30000, 0], [30000, 30000, 0], [-30000, 30000, 0]], float)
        w = bl.mesh_object('stage_water', q, [[0, 1, 2, 3]])
        mat, n = bl.material('stage_water')
        nz = n.new('ShaderNodeTexNoise', inputs={'Scale': 0.35, 'Detail': 5.0, 'Roughness': 0.6})
        bump = n.new('ShaderNodeBump', inputs={'Strength': 0.25, 'Distance': 1.0, 'Height': nz.outputs[0]})
        p = bl.principled(n, Base_Color=(0.004, 0.012, 0.016, 1), Roughness=0.04, Normal=bump.outputs[0])
        n.output(p.outputs[0]); w.data.materials.append(mat)
        f = bl.mesh_object('stage_floor', q + np.array([0, 0, SEA_FLOOR]), [[0, 1, 2, 3]])
        mat, n = bl.material('stage_floor'); p = bl.principled(n, Base_Color=(0.02, 0.02, 0.018, 1), Roughness=1.0); n.output(p.outputs[0]); f.data.materials.append(mat)
    _cam = bl.camera(fov_deg=40)
    return sc


def tonemap(rgb, exposure=EXPOSURE):
    x = np.maximum(rgb, 0) * exposure
    x = np.clip((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0, 1)
    return x ** (1 / 2.2)


def shoot(png, cam_pos, target=None, forward=None, fov=40.0, exposure=EXPOSURE):
    from PIL import Image
    cam = _cam
    cam.data.lens = 12.0 / np.tan(np.radians(fov) / 2)
    fwd = np.asarray(forward, float) if forward is not None else np.asarray(target, float) - np.asarray(cam_pos, float)
    bl.look(cam, cam_pos, fwd)
    tmp = os.path.join(tempfile.gettempdir(), 'bw_stage_%d' % os.getpid())
    t = time.time()
    exr = bl.render(tmp)
    secs = time.time() - t
    d = bl.read_exr(exr)
    Image.fromarray((tonemap(d['rgb'], exposure) * 255).astype(np.uint8)).save(png)
    os.remove(exr)
    return secs
