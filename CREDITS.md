# Credits

Ashfall Arena is one hand-written HTML file. Everything in it is either
procedural or listed below.

---

## Engine

| | |
|---|---|
| [three.js](https://threejs.org) r128 | MIT — Mr.doob and contributors |
| `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `ShaderPass`, `FBXLoader`, `GLTFLoader`, `SkeletonUtils` | MIT, shipped with three.js examples |
| [tween.js](https://github.com/tweenjs/tween.js) 18.6.4 | MIT — the PLAY camera move, and nothing else |

Loaded from cdnjs and jsDelivr at run time; no build step, no bundler, no
package manager.

---

## Visual effects — `assets/vfx/`

**[Brackeys' VFX Bundle](https://brackeysgames.itch.io/brackeys-vfx-bundle)**
— **CC0**, attribution not required but given anyway.

That pack is itself a repackaging, and the people who actually drew these are:

| Files | Artist |
|---|---|
| `circle_05.png`, `spark_05.png`, `slash_02.png`, `light_01.png` | [Picster](https://github.com/RPicster/Godot-particle-and-vfx-textures) and [Kenney](https://kenney.nl/assets/particle-pack) |
| `big_hit_6x5.png`, `impact_white_6x4.png`, `electric_ring_6x5.png`, `fire_ring_6x5.png`, `charge_7x6.png`, `star_explosion_6x5.png` | [CodeManu](https://codemanu.itch.io/vfx-free-pack) |

Where each one is used:

| Sprite | Used for |
|---|---|
| `big_hit_6x5` | the impact drawn at the contact point of a heavy blow |
| `impact_white_6x4` | the same for a light hit, and for a guard |
| `star_explosion_6x5` | the burst on a K.O. |
| `charge_7x6` | Overdrive activating |
| `fire_ring_6x5` | the summon portal tearing open |
| `electric_ring_6x5` | shockwaves |
| `slash_02` | the swing arc thrown off an attack |
| `spark_05` | impact debris, motion trails and weapon trails |
| `circle_05` | falling ash, snow, embers and near-field dust |
| `light_01` | the lantern glows |

---

## Surfaces — `assets/textures/`

**[Hand Painted Tiling Textures](https://beefpuppy.itch.io/hand-painted-tiling-textures)**
by **beefpuppy** — **CC BY 4.0**, so this credit is a licence condition, not a
courtesy.

Re-encoded here from the 512px PNG set to JPEG at quality 86 to keep the
download small; not otherwise modified.

| File | From | Used for |
|---|---|---|
| `stone_tile.jpg` | `Tile_01_512.png` | the courtyard floor |
| `rock.jpg` | `Rock_01_512.png` | dais, balustrade, plinths, guardian statues, pagoda |
| `timber.jpg` | `Wood_01_512.png` | pavilion posts and lantern arms |
| `brick.jpg` | `Brick_01_512.png` | held in reserve |

### The slate set

**[slate_floor_02](https://polyhaven.com/a/slate_floor_02)** from
**[Poly Haven](https://polyhaven.com)** — **CC0**, attribution not required
but given anyway.

| File | From | Used for |
|---|---|---|
| `slate_diff.jpg` | `slate_floor_02_diff_1k.jpg` | the OBSIDIAN courtyard albedo |
| `slate_nor.jpg` | `slate_floor_02_nor_gl_1k.jpg` | its tangent-space normals |
| `slate_rough.jpg` | `slate_floor_02_rough_1k.jpg` | its roughness variation |

1K JPEG, unmodified apart from the filenames. The normal and roughness maps
are loaded with `linear: true` so they are **not** sRGB-decoded — they are
data, not colour, and gamma-decoding a normal map bends every vector toward
the surface.

---

Every one of these is tinted by the active stage theme rather than used raw,

so the same stone reads as warm sandstone at dusk and blue-grey under snow.

---

## Type

Served from Google Fonts.

| Family | Licence | Used for |
|---|---|---|
| [Cinzel](https://fonts.google.com/specimen/Cinzel) | OFL 1.1 | the logo and fighter names |
| [Teko](https://fonts.google.com/specimen/Teko) | OFL 1.1 | the round clock, combo counter and announcer |
| [Barlow Condensed](https://fonts.google.com/specimen/Barlow+Condensed) | OFL 1.1 | interface text |
| [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) | OFL 1.1 | frame data and the dev panel |

---

## Animation — `assets/anim/`

**[KayKit — Character Animations](https://kaylousberg.itch.io/kaykit-character-animations)**
by **Kay Lousberg** — **CC0**, attribution not required.

Three of the eight `Rig_Medium` sets ship here; the rest of the 161 are on the
pack page if you want them.

| File | Gives |
|---|---|
| `Rig_Medium_General.glb` | `Idle_A/B`, `Hit_A/B`, `Death_A/B`, interact, spawn |
| `Rig_Medium_MovementBasic.glb` | `Walking_A/B/C`, `Running_A/B`, the five `Jump_*` clips |
| `Rig_Medium_CombatMelee.glb` | one-handed, two-handed, unarmed and dual-wield attacks, plus `Melee_Block` / `Melee_Blocking` |

These drive **every** fighter, including the authored cast, which was rigged in
Mixamo and shares no bone names with them. See *Bone naming* in `README.md`.

---

## The classic cast — `assets/models/x*.glb`

The default cast. Four rigged characters from the
**[three.js example models](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf)**,
copied here at their published size and otherwise unmodified.

| File | Originally | Plays | Rig | Licence |
|---|---|---|---|---|
| `x1.glb` | `Xbot.glb` | Cinderward | Mixamo | Mixamo — free for use in a game |
| `x2.glb` | `Michelle.glb` | Pale Vigil | Mixamo | Mixamo — free for use in a game |
| `x3.glb` | `RobotExpressive.glb` | Bronzemaw | custom | **CC0** — Tomás Laulhé, modified by [Don McCurdy](https://donmccurdy.com) |
| `x4.glb` | `Soldier.glb` | Nocturne | Mixamo | Mixamo — free for use in a game |

The assists reuse `x3.glb` and `x1.glb` rather than adding two more downloads.

Three of the four are Mixamo exports, which is the reason this cast is the
default: they share a skeleton with nothing in this project and yet need no
special case at all, because the KayKit library above is retargeted onto bone
*roles* rather than bone names. All four bind every one of the eight animation
states — idle, walk, jump, punch, kick, block, hit reaction, knockout — with no
stand-ins. The robot is the interesting one: its rig is not Mixamo and not
KayKit, and it still clears the retargeting threshold, while also carrying its
own `Idle` / `Walking` / `Jump` / `Punch` / `Death` as a fallback.

`index.html` also holds the upstream URL for each of these four as a last-resort
candidate, so a checkout with no `assets/` folder still fills its roster from
the three.js repository. The local copy always wins — a release must not depend
on GitHub being reachable.

---

## The compact cast — `assets/models/k*.glb`, `ks*.glb`

**[KayKit — Character Pack: Adventurers](https://kaylousberg.itch.io/kaykit-adventurers)**
by **Kay Lousberg** — **CC0**, attribution not required.

| File | Originally | Plays |
|---|---|---|
| `k1.glb` | Knight | Cinderward |
| `k2.glb` | Rogue (hooded) | Pale Vigil |
| `k3.glb` | Barbarian | Bronzemaw |
| `k4.glb` | Mage | Nocturne |
| `ks1.glb` | Ranger | Emberwraith |
| `ks2.glb` | Rogue | Carrion Idol |

Renamed only. The pack's own licence text is kept beside them as
`assets/models/KAYKIT-LICENSE.txt`.

---

## Characters — `assets/models/`

`p1.glb`, `P2.fbx`, `P3.fbx`, `P4.fbx` and `S2.fbx` were supplied by the project
owner and are not credited here because they are yours. If any of them came
from Mixamo, Adobe's licence permits use in a game, and a credit line on the
store page is good practice.

They carry no usable animation of their own beyond an idle and a walk, which is
why the KayKit library above exists: it is retargeted onto their Mixamo
skeletons at load time rather than replacing them.

---

## Interface effects

The border beam, the liquid-metal sheen and the drifting orbs are written
for this file after the visual language of [libraries.dev](https://libraries.dev).
That site sells React components under a Pro licence; **none of its code is
used here**. The techniques — a masked conic-gradient ring, a travelling
specular band, blurred radial gradients — are common CSS and are
reimplemented from scratch against this project’s own tokens.

---

## Everything else

Written for this project: the courtyard, the fighters' primitive rigs, the
five stage themes, the painted sky, the toon ramp, the flagstone and water
canvases, the grade and vignette shader, the audio, and all of the code.

## If a file is missing

Nothing here is load-bearing. Every texture is fetched after the scene is
already running and only swapped in if it arrives, so a blocked request, an
offline first run or a deleted folder costs the improvement and nothing else —
the procedural version it replaced is still there underneath. `H` opens the dev
panel; the **ART** row reports how many landed.
