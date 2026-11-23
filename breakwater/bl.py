"""Thin helpers over Blender's Python API (`bpy`): meshes from NumPy, node materials, render, EXR in."""
import numpy as np
import bpy


def reset(width=960, height=540, samples=24):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    cy = sc.cycles
    cy.device = 'CPU'
    cy.samples = samples
    cy.use_adaptive_sampling = False
    cy.use_denoising = False                    # this build ships no denoiser; post.py has its own
    cy.max_bounces = 4; cy.diffuse_bounces = 2; cy.glossy_bounces = 3; cy.transmission_bounces = 2; cy.volume_bounces = 0
    cy.sample_clamp_indirect = 4.0; cy.sample_clamp_direct = 0.0
    cy.caustics_reflective = False; cy.caustics_refractive = False
    cy.pixel_filter_type = 'BLACKMAN_HARRIS'
    sc.render.resolution_x = width; sc.render.resolution_y = height; sc.render.resolution_percentage = 100
    sc.render.use_persistent_data = True
    sc.render.threads_mode = 'AUTO'
    ims = sc.render.image_settings
    if hasattr(ims, 'media_type'): ims.media_type = 'MULTI_LAYER_IMAGE'      # Blender 5 splits single / multilayer output
    ims.file_format = 'OPEN_EXR_MULTILAYER'
    sc.render.image_settings.color_depth = '32'
    sc.render.image_settings.exr_codec = 'NONE'              # big but quick to write; frames are deleted once graded
    sc.view_settings.view_transform = 'Standard'
    vl = sc.view_layers[0]
    vl.use_pass_z = True; vl.use_pass_position = True; vl.use_pass_normal = True; vl.use_pass_emit = True
    return sc


def mesh_object(name, verts, faces, uvs=None, smooth=False, attrs=None, collection=None):
    """verts (N, 3); faces: (M, 3|4) int array or a list of index lists. uvs: per-loop (L, 2).
    attrs: {name: per-vertex float (N,) or colour (N, 3|4) array}."""
    me = bpy.data.meshes.new(name)
    verts = np.asarray(verts, dtype=np.float64)
    f = faces.tolist() if isinstance(faces, np.ndarray) else faces
    me.from_pydata(verts.tolist(), [], f)
    if uvs is not None:
        layer = me.uv_layers.new(name='UVMap')
        layer.data.foreach_set('uv', np.asarray(uvs, dtype=np.float32).ravel())
    if attrs:
        for k, a in attrs.items():
            a = np.asarray(a, dtype=np.float32)
            if a.ndim == 1:
                at = me.attributes.new(k, 'FLOAT', 'POINT'); at.data.foreach_set('value', a)
            else:
                if a.shape[1] == 3: a = np.concatenate([a, np.ones((len(a), 1), np.float32)], 1)
                at = me.attributes.new(k, 'FLOAT_COLOR', 'POINT'); at.data.foreach_set('color', a.ravel())
    if smooth:
        me.polygons.foreach_set('use_smooth', np.ones(len(me.polygons), dtype=bool))
    me.update()
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    return ob


def image_from_array(name, arr, colorspace='Non-Color'):
    """Float image from an (H, W, 3|4) array, row 0 at the bottom. Packed in memory, never a file."""
    arr = np.asarray(arr, dtype=np.float32)
    if arr.shape[2] == 3: arr = np.concatenate([arr, np.ones(arr.shape[:2] + (1,), np.float32)], 2)
    h, w = arr.shape[:2]
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=True)
    img.colorspace_settings.name = colorspace
    img.pixels.foreach_set(arr.ravel())
    img.pack()
    return img


class Nodes:
    """Tiny builder for shader node trees: n = Nodes(material); x = n.new('ShaderNodeMath', operation='ADD', inputs={0: a, 1: 2.0})"""

    def __init__(self, owner):
        owner.use_nodes = True
        self.tree = owner.node_tree
        self.nodes = self.tree.nodes; self.links = self.tree.links

    def clear(self):
        self.nodes.clear(); return self

    def new(self, kind, inputs=None, **props):
        nd = self.nodes.new(kind)
        for k, v in props.items(): setattr(nd, k, v)
        for k, v in (inputs or {}).items(): self.set(nd.inputs[k], v)
        return nd

    def set(self, sock, v):
        if hasattr(v, 'bl_idname') and hasattr(v, 'outputs'): v = v.outputs[0]
        if hasattr(v, 'is_output'): self.links.new(v, sock)
        else:
            try: sock.default_value = v
            except (TypeError, ValueError): sock.default_value = tuple(v) + (1.0,) * (len(sock.default_value) - len(v))

    def math(self, op, a, b=None, c=None, clamp=False):
        nd = self.new('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.set(nd.inputs[0], a)
        if b is not None: self.set(nd.inputs[1], b)
        if c is not None: self.set(nd.inputs[2], c)
        return nd.outputs[0]

    def vmath(self, op, a, b=None, scale=None):
        nd = self.new('ShaderNodeVectorMath', operation=op)
        self.set(nd.inputs[0], a)
        if b is not None: self.set(nd.inputs[1], b)
        if scale is not None: self.set(nd.inputs['Scale'], scale)
        return nd.outputs['Value'] if op in ('DOT_PRODUCT', 'LENGTH', 'DISTANCE') else nd.outputs[0]

    def mix(self, fac, a, b, kind='RGBA'):
        nd = self.new('ShaderNodeMix', data_type=kind)
        i = {'RGBA': (6, 7, 2), 'FLOAT': (2, 3, 0), 'VECTOR': (4, 5, 1)}[kind]
        self.set(nd.inputs[0], fac); self.set(nd.inputs[i[0]], a); self.set(nd.inputs[i[1]], b)
        return nd.outputs[i[2]]

    def ramp(self, fac, stops):
        nd = self.new('ShaderNodeValToRGB')
        el = nd.color_ramp.elements
        while len(el) < len(stops): el.new(0.5)
        for e, (pos, col) in zip(el, stops):
            e.position = pos; e.color = tuple(col) + (1.0,) * (4 - len(col)) if not np.isscalar(col) else (col, col, col, 1.0)
        self.set(nd.inputs[0], fac)
        return nd.outputs[0]

    def output(self, surface, displacement=None):
        out = self.new('ShaderNodeOutputMaterial')
        self.links.new(surface, out.inputs['Surface'])
        if displacement is not None: self.links.new(displacement, out.inputs['Displacement'])
        return out


def material(name):
    mat = bpy.data.materials.new(name)
    n = Nodes(mat).clear()
    return mat, n


def principled(n, **inputs):
    nd = n.new('ShaderNodeBsdfPrincipled')
    for k, v in inputs.items(): n.set(nd.inputs[k.replace('_', ' ')], v)
    return nd


def set_world(env_rgba, strength=1.0):
    sc = bpy.context.scene
    w = sc.world or bpy.data.worlds.new('World'); sc.world = w
    n = Nodes(w).clear()
    img = bpy.data.images.get('env') or image_from_array('env', env_rgba, 'Linear Rec.709')
    if img.size[0] == env_rgba.shape[1]: img.pixels.foreach_set(np.asarray(env_rgba, np.float32).ravel())
    tex = n.new('ShaderNodeTexEnvironment', image=img)
    bg = n.new('ShaderNodeBackground', inputs={'Color': tex.outputs[0], 'Strength': strength})
    out = n.new('ShaderNodeOutputWorld'); n.links.new(bg.outputs[0], out.inputs['Surface'])
    return bg


def camera(name='cam', fov_deg=74.0):
    cam = bpy.data.cameras.new(name)
    ob = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(ob)
    bpy.context.scene.camera = ob
    cam.sensor_fit = 'VERTICAL'; cam.sensor_height = 24.0
    cam.lens = 12.0 / np.tan(np.radians(fov_deg) / 2)       # vertical field of view
    cam.clip_start = 0.3; cam.clip_end = 60000
    return ob


def look(ob, pos, forward, up=(0, 0, 1), roll=0.0):
    """Aim a camera (looks down local -Z, +Y up) from `pos` along `forward`."""
    from mathutils import Matrix, Vector
    f = Vector(forward).normalized(); r = f.cross(Vector(up)).normalized(); u = r.cross(f)
    if roll:
        c, s = np.cos(roll), np.sin(roll); r, u = r * c + u * s, u * c - r * s
    m = Matrix(((r.x, u.x, -f.x, pos[0]), (r.y, u.y, -f.y, pos[1]), (r.z, u.z, -f.z, pos[2]), (0, 0, 0, 1)))
    ob.matrix_world = m
    return np.array(r), np.array(u), np.array(f)


def render(path):
    sc = bpy.context.scene
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return path if path.endswith('.exr') else path + '.exr'


from .bl_exr import read_exr   # noqa: E402  (re-exported; lives in its own module so post needs no Blender)
