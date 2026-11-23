# BREAKWATER

A cockpit-view giant-mech game set in San Francisco Bay at dusk. You stand hip-deep in the bay
inside the head of an 85-metre harbour-defence machine and fight sea monsters coming in under
the Golden Gate before they reach the waterfront. A second pilot can join the same machine.

Everything is code: three.js for rendering, WebAudio for sound. There are no downloaded models,
textures, or audio clips. The world, creatures, machine, materials and sounds are generated
when the page loads.

## Run it

```
npm start            # node serve.mjs 8080
```

Open <http://localhost:8080/>. To try the two-pilot link on one computer, open
<http://localhost:8080/?mock> in two tabs (a BroadcastChannel stands in for the real room).

## Controls

| | Keyboard and mouse | Gamepad | Touch |
|---|---|---|---|
| Walk | W A S D | Left stick | Left thumb |
| Turn and aim | Mouse (or arrow keys) | Right stick | Drag on the right |
| Port / starboard fist | Left click (J) / right click (K) | LB / RB | LEFT / RIGHT |
| Double hammer | E, or both clicks together | X | SLAM |
| Brace | Space | LT | Hold BLOCK |
| Forearm cannon | Hold F to charge, release to fire | Hold RT | Hold CANNON |
| Thruster dash | Shift | A | DASH |
| Outside view | V | Y | VIEW |
| Mute / pause | M / P | Start | II |

## Two pilots

One pilot hosts and gets the port fist, the legs and the heading. The other joins and gets the
starboard fist and the cannon, which fires where they look. Punches thrown within a third of a
second of each other become a sync strike. The co-pilot can drop in mid-fight; if they leave,
the host gets the whole machine back.

The link uses the Artifact `room` capability (presence only), so it works when the page is
published as a Claude Artifact and both pilots are signed-in viewers it has been shared with.
The host simulates; the co-pilot renders snapshots and sends controls.

## Layout

| File | What it holds |
|---|---|
| `game.html` | The page: styles, HUD, menus, loader. Written as an Artifact body (no doctype); `serve.mjs` wraps it for local play. |
| `src/core.js` | Maths, noise, shared sky and fog GLSL, lighting rig, environment map. |
| `src/world.js` | Terrain, city, Golden Gate and Bay bridges, Alcatraz, ships, helicopters, every lamp. |
| `src/ocean.js` | Gerstner swell, sky reflection, shore wash, foam around giants. |
| `src/fx.js` | HDR pipeline (depth fog, bloom, canopy rain, grade), particles, rain, fog banks. |
| `src/mech.js` | The machine: exterior, cockpit interior, procedural animation. |
| `src/kaiju.js` | Three creature species from one parametric rig, procedural animation. |
| `src/audio.js` | Synthesised sound effects, ambience and music bed. |
| `src/input.js` | Keyboard, mouse, touch, gamepad. |
| `src/net.js` | Two-pilot link over room presence. |
| `src/game.js` | Simulation, co-pilot replica, camera, HUD, menus, main loop. |
| `dev/` | Harness pages for looking at one module at a time, and the mock room. |
| `tools/` | Headless screenshot and play-through scripts (Playwright). |
| `vendor/three.min.js` | three.js r160 (MIT), used locally and as the fallback beside the published page. |

## Notes

- Geography is compressed about 1 : 2.5 but laid out like the real bay: west is the Golden Gate,
  south is the city, north is Marin, with Alcatraz in the middle of the arena.
- Rendering adapts resolution to the device. Phones get fewer rain streaks, no MSAA and a
  shorter bloom chain.
- The machine and the creatures are original designs.
