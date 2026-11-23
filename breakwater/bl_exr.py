"""Read Cycles' multilayer EXR output into NumPy (no Blender needed)."""
import numpy as np


def read_exr(path):
    """Multilayer EXR -> {'rgb', 'pos', 'normal', 'albedo', 'emit' (H, W, 3), 'depth' (H, W)}, row 0 at the top.
    Blender 5 writes one EXR part per pass; older versions write one part with many channels."""
    import OpenEXR
    want = {'Combined': 'rgb', 'Depth': 'depth', 'Position': 'pos', 'Normal': 'normal', 'Diffuse Color': 'albedo', 'DiffCol': 'albedo', 'Emission': 'emit', 'Emit': 'emit'}
    out = {}
    with OpenEXR.File(path) as f:
        for part in f.parts:
            ch = part.channels
            for key, c in ch.items():
                bits = key.split('.')
                for nm, tag in want.items():
                    if nm not in bits: continue
                    px = np.asarray(c.pixels, dtype=np.float32)
                    if px.ndim == 3:                               # grouped RGB(A) channel
                        out[tag] = px[..., :3] if tag != 'depth' else px[..., 0]
                    else:                                          # one scalar channel per component
                        comp = bits[-1]
                        if tag == 'depth': out[tag] = px
                        else:
                            arr = out.setdefault(tag, np.zeros(px.shape + (3,), np.float32))
                            if comp in 'XYZ': arr[..., 'XYZ'.index(comp)] = px
                            elif comp in 'RGB': arr[..., 'RGB'.index(comp)] = px
    return out
