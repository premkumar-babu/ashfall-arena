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

## URL flags

| Flag            | Effect                                                   |
| --------------- | -------------------------------------------------------- |
| `?webgl`        | Force the WebGL2 backend (test the fallback on any GPU)  |
| `?stats`        | Show the stats-gl overlay (FPS, CPU and GPU frame time)  |
| `?cast=compact` | Pick a cast: `classic` (default), `compact`, `authored`  |

In game: **H** toggles the dev panel and the performance overlay together,
**B** hit/hurtboxes, **P** post-processing, **T** / **Shift+T** stage theme.

## Layout

```
src/
  main.ts            boot order, one Disposer for teardown, HMR dispose
  debug.ts           window.__ASH / window.__ash console handles
  core/              engine-agnostic plumbing
    renderer.ts        WebGPURenderer + backend detection
    loop.ts            FixedStepLoop: 120 Hz simulation, per-frame presentation
    resize.ts          ResizeObserver + DPR watcher → renderer, camera
    disposal.ts        Disposer, disposeObject / disposeMaterial
    stats.ts           stats-gl wrapper
    math.ts, platform.ts
  config/            data only: constants, roster, themes
  render/            stage (scene, camera, lights), post (TSL), theme, materials, textures
  world/             arena build, ambient animation, surface textures
  game/              fighter & assist rigs, state machine, physics, collision,
                     meter, assists, match / rounds / results, bot, pose, game.ts
  anim/              clip library + retargeting, bone driver
  assets/            texture loader, model loader, cast dressing
  camera/            camera rig and the PLAY tween
  fx/                instanced-sprite particles, flipbooks, VFX pools, strike lights
  input/             key bindings + remapping, keyboard/gamepad → Intent
  audio/             synthesised SFX, music
  ui/                DOM handles, HUD, select screen, portraits, front end, boot curtain
  styles/game.css
```

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
