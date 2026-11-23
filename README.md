# BREAKWATER, the Python cut

A 21-second cockpit-view film: an 85-metre harbour-defence machine wades toward the Golden Gate
at dusk, something surfaces between it and the bridge, and two pilots put it back in the bay.

This branch contains only Python. Nothing is downloaded and nothing is hand-drawn:

- **Geometry and textures** are NumPy: the bay's heightfield, six thousand buildings with
  procedurally lit windows, the bridge, the creature's skeleton and hide, the cockpit, the sky.
- **Rendering** is Blender's Cycles path tracer, driven headless through the `bpy` module.
- **Post-processing** is NumPy: a denoiser, haze, particles, bloom, rain, the lens, and the
  head-up display, whose lettering is a stroke font defined in the source.
- **Sound** is NumPy: oscillators and shaped noise, no samples.
- **Encoding** is ffmpeg.

The interactive, two-player version of the same idea (three.js, runs in a browser) is on the
branch `claude/elegant-ptolemy-id8ryx`.

## Run it

```
pip install -r requirements.txt        # bpy is Blender itself, about 430 MB
python -m breakwater all --out out     # render, post, audio, mux, check
```

Or one stage at a time:

```
python -m breakwater render --out out            # path-trace frames (the slow part; resumable)
python -m breakwater post   --out out --follow   # grade frames as they appear
python -m breakwater audio  --out out
python -m breakwater mux    --out out            # out/breakwater.mp4
python -m breakwater check  --out out            # out/report.json, out/contact.png
python -m breakwater still  --out out --t 6.9 14.03   # single finished frames
```

`ffmpeg` must be on the path for `mux`. Only `render` and `still` need `bpy`.

## How it fits together

`timeline.py` is the single source of truth. `Sortie.state(t)` is a pure function of time that
returns where the machine and the creature are, what every limb is doing, where the pilot is
looking and what the instruments read. The picture, the particles and the soundtrack all read
it, so the servo whine follows the same walking effort that bobs the camera and the roar is
panned by the same head yaw that frames the creature. Any frame can be rendered on its own.

| File | What it does |
|---|---|
| `timeline.py` | The sortie: beats, motion, camera, events. |
| `sky.py` | The dusk sky as math; used for the light, the haze colour and reflections. |
| `world.py` | Terrain, city, bridge, lamps, water. |
| `creature.py` | The creature: body, hide, poses. |
| `mech.py` | The cockpit interior, the co-pilot, the arms. |
| `scene.py` | Assembles the Blender scene and renders frames with a camera sidecar. |
| `post.py` | Denoise, temporal accumulation, foam, haze, sprites, bloom, lens, HUD, grain. |
| `audio.py` | The soundtrack. |
| `check.py` | Self-inspection: exposure, dead or blown frames, unexplained jumps, sound levels at each scripted event, the encoded streams, and a contact sheet. |
| `bl.py`, `bl_exr.py`, `noise.py`, `stage.py` | Helpers: Blender wrappers, EXR reading, noise, a test stage. |

## Directing your own fight

Beat times and positions live in `timeline.DEFAULT`. Put overrides in a JSON file and pass
`--script`:

```json
{ "emerge": 4.4, "roar": 7.0, "glance": [0.9, 3.4, 0.9], "callsign": "RAKEBACK" }
```

This is direction, not play: the film is rendered offline, frame by frame.

## Notes

- Frames are path-traced at 960x540 with a low sample count, cleaned by the filter in
  `post.py` (this Blender build ships without a denoiser), then finished at 1920x1080.
- The machine and the creature are original designs.
