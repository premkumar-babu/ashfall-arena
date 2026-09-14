# Ashfall Arena — web

The modular build of Ashfall Arena: Vite 8, TypeScript 7 (strict), three.js r186
on `WebGPURenderer` with automatic WebGL2 fallback.

The single-file build (`../index.html`) is untouched and remains what the
itch.io zips and the published artifact ship from until this build has had a
visual pass on every stage.

## Scripts

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm run build      # typecheck, then bundle to dist/
npm run preview    # serve dist/ on :4173
```

`public/assets` is a directory junction to `../assets`, so both builds share one
copy of the models, animation library, textures and VFX sheets.

## Asset pipeline

```bash
npm run assets              # everything: textures, props, models  (~3 min)
npm run assets -- textures  # or one stage: textures | props | models
```

`scripts/build-assets.mjs` never touches the source art. It writes optimised
copies to `../assets/opt/` plus `opt/manifest.json`, and the game reads that
manifest at boot (`src/assets/pipeline.ts`):

| Stage    | What happens                                                                  |
| -------- | ----------------------------------------------------------------------------- |
| models   | dedup → prune (bones kept) → resample → weld → textures to KTX2 → Draco       |
| textures | surface JPEGs and VFX flipbooks → KTX2: ETC1S for colour/data, UASTC+Zstd for normals; power-of-two, mipmapped, pre-flipped |
| props    | rocks, stone lanterns and grass generated in the script, up to 3 LODs each, Draco, one GLB |

At run time every loader shares one `LoadingManager`. `GLTFLoader` is wired to
`DRACOLoader`, `KTX2Loader` and the meshopt decoder. The Draco and Basis
WebAssembly decoders need no setup: both loaders locate them with
`new URL(…, import.meta.url)`, which Vite serves in dev and emits into
`dist/assets` on build, so they always match the installed three.js. Game code still asks for source paths
(`assets/models/x1.glb`, `textures/slate_nor.jpg`); the pipeline swaps in the
optimised file when the manifest has one and the device can transcode it, and
falls back to the source file otherwise. A checkout that never ran the build
loads exactly what it did before.

Loads are cached per path and reference-counted: `Assets.release(path)` frees
the GPU resources behind the last reference (the animation library's rig
meshes are released as soon as its clips are extracted), and `Assets.dispose()`
frees everything still cached and terminates the decoder workers on teardown.

Result on the classic cast: models + textures 17.8 MB → 7.2 MB on disk, and
live texture memory from ~206 MB to a few tens of MB — KTX2 stays compressed on
the GPU (BC7 / ASTC / ETC2), where a PNG decodes to full RGBA.

## Loading

The curtain (`src/ui/boot-curtain.ts`) reads the pipeline's job list: every
file is registered up front with its real size from the manifest, so the bar
moves in bytes, and four stages (arena, surfaces, fighters, motion) light up as
they land. It lifts once the arena, surfaces and cast are in, after 12 s
regardless, or on a click. Whatever is still arriving afterwards shows in a
small streaming pill. The scene renders underneath from the first frame and
every asset has a stand-in, so the game is playable throughout.

## World

- `world/landscape.ts`: a polar heightfield from the courtyard walls to the
  horizon, with a moat, an open lake behind the duel, banks and hills, and
  islands under the far pavilions and the tower. It is vertex-coloured by height
  and slope. An instanced retaining wall and coping run round the floor.
  Rocks, lanterns and wind-blown grass (TSL vertex sway) are scattered from the
  props GLB with a fixed seed.
- `world/instanced-lod.ts`: LOD for instanced scenery. One `InstancedMesh`
  per level per part; each instance is bucketed by on-screen size (radius ÷
  distance, scaled by the lens, so the fight camera's zoom is accounted for),
  with hysteresis, only when the camera has moved.
- `world/instancing.ts`: `collapseInstances(root)` folds meshes sharing a
  geometry and material into `InstancedMesh` draws after a group is built. The
  arena uses it for balusters, columns, lantern posts, blossom, palm fronds and
  the tower; clouds are one instanced draw updated as they drift.

## Audio and game feel

Everything is synthesised with the Web Audio API; there are no audio files.

```
voices → stereo pan → sfx ──┐
             └→ courtyard reverb
score ─────────────→ music ─┼→ master (volume, mute) → limiter → out
3D beds ───────────→ amb ───┘
```

- `audio/sfx.ts`: the engine and every effect. Master, music, effects and
  ambience each have their own gain (all four are sliders in SETTINGS → AUDIO);
  mute is one ramp on master. Each one-shot gets a little random pitch and
  level so repeats never machine-gun, a voice cap drops low-priority sounds
  under load, and combat sounds are panned by world X relative to the camera.
- `audio/music.ts`: a procedural score in D minor on a lookahead scheduler.
  Pad, bass, drums and arpeggio layers fade with intensity (title 0, select 1,
  fight 2, clutch 3 = final round or a human low on health); stingers for
  round start, KO, victory and defeat; ducking under impacts; a low-pass
  "underwater" sweep on KO.
- `audio/ambience.ts`: brazier crackle and lake water on 3D `PannerNode`s with
  the listener riding the camera, over an unpositioned wind bed.
- `fx/juice.ts`: every important event calls `impact(kind)`, one row per kind
  of hit-stop, trauma (shake = trauma²), lens punch, aberration and exposure
  kick, and music duck, plus a jolt on the struck health bar. `knockout()`
  adds slow motion through the loop's time scale, desaturation, a camera lean
  toward the fallen fighter and a muffled score. Rounds open with the lens
  easing in from wide, and the last five seconds tick. Shake and lens motion
  follow the SCREEN SHAKE setting and `prefers-reduced-motion`.

## URL flags

| Flag            | Effect                                                   |
| --------------- | -------------------------------------------------------- |
| `?webgl`        | Force the WebGL2 backend (test the fallback on any GPU)  |
| `?stats`        | Show the stats-gl overlay (FPS, CPU and GPU frame time)  |
| `?cast=compact` | Pick a cast: `classic` (default), `compact`, `authored`  |

In game: **B** hit/hurtboxes, **P** post-processing, **T** / **Shift+T** stage theme.
With `?dev` or `?stats` in the URL, **H** also toggles the dev panel and the
CPU/GPU overlay; without it no timing overlay can appear.

## Project structure

Dependencies point downward: `config` and `core` import nothing from the
game; `game` never imports `ui` screens except through small hooks (announcer,
HUD handles, menu focus).

```
web/
  index.html            every screen's markup: boot, title, select, HUD, pause, modal, results
  vite.config.ts        base './', single three copy
  scripts/
    build-assets.mjs    offline pipeline → ../assets/opt (npm run assets)
  src/
    main.ts             boot order, one Disposer for teardown, HMR dispose
    debug.ts            window.__ASH / window.__ash inspection handles
    config/             data only
      constants.ts        enums, physics, meter, framing
      roster.ts           fighters and summons (balanced to one damage budget)
      themes.ts           the seven stages
      controls.ts         every feel number for input and movement
      quality.ts          LOW / MEDIUM / HIGH presets, AUTO device guess
    core/               engine plumbing, no game knowledge
      renderer.ts         WebGPURenderer + WebGL2 fallback
      loop.ts             120 Hz fixed step, per-frame presentation, time scale
      frame-governor.ts   demand rendering + adaptive quality
      resize.ts, disposal.ts, stats.ts, spring.ts, math.ts, platform.ts
    assets/             pipeline.ts (manifest, Draco, KTX2, ref-counted cache),
                        loader.ts, texture-loader.ts, models.ts (casts, merge, dressing)
    render/             stage (scene, camera, lights), post (TSL chain), theme, materials, textures
    world/              arena, landscape, instancing (instances + static merge),
                        instanced-lod, ambience, surfaces
    physics/            Rapier port, world, character controller, colliders, props, debris
    game/               game.ts (simulate / present), match, fsm, movement, collision,
                        meter, assist, bot, pose, rigs, fighter, state
    anim/               clip library + retargeting, bone driver
    camera/             camera-rig.ts: title drift, select portrait, fight springs, PLAY tween
    fx/                 juice.ts (impact feel), particles, flipbook, vfx pools, ribbon, strike lights
    audio/              sfx.ts (engine + effects), music.ts (procedural score), ambience.ts (3D beds)
    input/              bindings, controller, buffer, feedback (haptics), devices/*
    ui/                 front-end (menus, settings), menu-nav, hud, select, portraits,
                        announcer, boot-curtain, settings, dom
    styles/             game.css (base, HUD), screens.css (overlays, transitions, mobile), touch.css
assets/                 source art; opt/ is generated and committed
```

## Performance and quality

| Preset | Render scale | AO | AA | DOF | Shadow map | Scenery LOD | Grass |
| ------ | ------------ | -- | -- | --- | ---------- | ----------- | ----- |
| LOW    | 0.7          | —  | FXAA | — | 1024       | ×2.2 coarser | off  |
| MEDIUM | 1.0          | 8 samples | SMAA | — | 2048 | ×1.4 | on |
| HIGH   | 2.0          | 16 samples | SMAA | on | 2048 | ×1 | on |

AUTO (the default) picks a preset from the device (touch, memory, cores,
backend) and `core/frame-governor.ts` steps it down if frames stay above
~21 ms for four seconds; picking a preset turns that off. The governor also
redraws a paused match at 10 fps instead of 60.

Draw calls, fight on the default cast: 212 → 105; triangles 472k → 51k.
- KayKit characters' 7–9 skinned parts merge into one skinned mesh at load
  (same skeleton, bind pose and material are checked first).
- `collapseInstances` folds repeated scenery into `InstancedMesh`;
  `mergeStatic` bakes one-off pieces sharing a material into one mesh per
  group (pavilions 9 → 5 draws, statues 10 → 6), keeping per-group culling.
- Effects are pooled (particles, flipbooks, arcs, rings, streaks, sparks,
  debris) and hidden when idle; summon echo rings run on the effect clock.

## Frame model

`simulate(dt)` runs at a fixed 120 Hz and is the only code that changes match
state: input, bot, state machine, meter, physics, assists, posing (the hitboxes
hang off the posed rig) and collision. `present(frameDt)` runs once per
displayed frame and only reads state: camera, particles, HUD and the draw.
Hit-stop and pause are simulation states, so they are identical on every
refresh rate.

## Rendering

`src/render/post.ts` builds a `RenderPipeline` (the WebGPU-era EffectComposer;
EffectComposer, N8AO and the WebGL SMAA pass cannot run under WebGPURenderer).
Every stage is a TSL node, so it runs on both backends:

```
scene (HDR, no MSAA) → GTAO (half-res, normals from depth) → HDR bloom
  → Neutral tone mapping → sRGB → depth of field (high) → SMAA / FXAA
  → grade (split-tone, contrast, saturation, fringing, vignette, grain)
```

| Quality | AO            | AA   | DOF | Shadow map        | Max pixel ratio |
| ------- | ------------- | ---- | --- | ----------------- | --------------- |
| low     | off           | FXAA | off | 1024, VSM r3      | 0.7             |
| med     | GTAO 8 samples| SMAA | off | 2048, VSM r5      | 1.0             |
| high    | GTAO 16       | SMAA | on  | 2048, VSM r7      | 2.0             |

- Soft shadows are variance shadow maps (`VSMShadowMap`), blurred once per light.
- The stage uses PBR presets from `render/materials.ts` (`pbrMat`: stone, timber,
  tile, metal trim, cloth, clay) with a per-material sky reflection strength;
  foliage and the primitive fighter rigs stay cel-shaded.
- Flames, sparks and swing ribbons (`fx/ribbon.ts`) are authored above 1.0 so
  HDR bloom picks them out; lit stone is not.

## Controls

Keyboard, mouse (Player 1), gamepads (first pad → P1, second → P2) and an
on-screen touch overlay all feed one controller per player.

```
src/input/
  controller.ts         PlayerController: devices → InputBuffer → Intent; acknowledge() spends presses
  buffer.ts             per-action press windows (0.10 s), aged only while the match runs
  bindings.ts           rebindable keys (now including Dash)
  feedback.ts           gamepad rumble / phone vibration on contact
  devices/
    keyboard-device.ts  held keys + per-step press latch (sub-step taps are never lost)
    gamepad-device.ts   standard mapping, radial deadzone, stick hysteresis, menu edges, rumble
    mouse-device.ts     left light · right heavy · middle summon · thumb buttons OD / dash
    touch-controls.ts   floating stick + face buttons, multitouch via pointer capture
src/config/controls.ts  every feel number: accel/stop/turn times, air control, jump cut, buffers, deadzones
src/core/spring.ts      critically damped spring used by the fight camera
src/ui/pad-menu.ts      gamepad navigation of title, select, pause and results
```

Feel: linear acceleration (0.075 s to full walk, 0.055 s to stop, 0.045 s to
turn), running jumps keep their momentum, holding jump extends the arc and
releasing early cuts it, holding block in the air fast-falls, coyote time and
jump buffering on landing. The camera is a side-on tracking camera on springs
that frames both fighters from the live aspect ratio (so portrait phones work)
with a small look-ahead and noise-based shake.

## Physics (Rapier)

`@dimforge/rapier3d-compat`, loaded lazily as its own chunk. Game code only
imports `src/physics/port.ts`; if Rapier fails to load, fighters fall back to
the original clamp-and-floor movement.

```
src/physics/
  port.ts             the interface the game uses; attachFighterBodies()
  rapier-physics.ts   builds the Rapier implementation of the port
  world.ts            World, fixed step, body→mesh bindings with interpolation, blasts
  character.ts        FighterBody: kinematic capsule + KinematicCharacterController
  arena-colliders.ts  floor, balustrade, statues, lantern posts, fighter-only bounds
  props.ts            dynamic urns and crates beside the lane, reset every round
  debris.ts           pooled stone chips (one InstancedMesh, CCD, sleep → fade)
  debug-draw.ts       collider wireframes (B)
  groups.ts           collision-group matrix
src/game/movement.ts  planMotion (velocities) → resolveMotion (pushboxes + controller sweep)
```

Hit detection is still the authored box-vs-box volumes on the posed rig, not
Rapier sensors, so frame data is unchanged.

## Known differences from the single-file build

- Light intensities are converted from pre-r155 units (×π) and point lights use
  `decay: 0`. Values match the old build numerically, but shadow filtering and
  PMREM differ between r128 and r186, so each stage needs a visual check.
- `PCFSoftShadowMap` does not exist on the node renderer; soft shadows come from `VSMShadowMap` instead.
- Particles are instanced sprites instead of `THREE.Points`. WebGPU draws points
  at 1 px, so this change was required.
