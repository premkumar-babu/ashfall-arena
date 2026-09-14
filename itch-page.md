# Ashfall Arena — itch.io page copy

Paste-ready text for the itch.io project page. This is the *player-facing*
description; `README.md` is the developer one and should not go on the page.

---

## Project settings

| Field | Value |
|---|---|
| Title | **Ashfall Arena** |
| Short description / tagline | A 2.5D sword-fighting game that runs in your browser |
| Classification | Game |
| Kind of project | **HTML** |
| Uploads | tick **This file will be played in the browser** |
| Viewport dimensions | **1280 x 720** |
| Fullscreen button | **enabled** |
| Mobile friendly | off — it needs a keyboard |
| Genre | Fighting |
| Tags | `fighting`, `threejs`, `webgl`, `3d`, `arcade`, `versus`, `local-multiplayer`, `no-install` |
| Average session | A few minutes |
| Multiplayer | Local multiplayer, 2 players |
| Inputs | Keyboard, Gamepad |

**Give it a moment on first load** — it fetches character models up front.
Consider saying so in the tagline or the first line of the description.

---

## Page description

> Two fighters, one courtyard, best of three.
>
> Ashfall Arena is a browser fighting game built from scratch in Three.js — no
> engine, no install, no download. Pick a fighter, pick a summon, and fight the
> CPU or a friend on the same keyboard.
>
> **Four fighters, and they do not play the same.** Cinderward is a straight
> sword and steady pressure. Pale Vigil is longer reach and a faster walk.
> Bronzemaw hits like a truck and moves like one. Nocturne is the quickest thing
> on the stage and the most fragile.
>
> **Two summons.** Emberwraith leaps in and throws a cinder orb. The Carrion Idol
> hangs in the air and comes down as a shockwave that spreads along the ground.
> Both cost half your meter and lock out for six seconds.
>
> **Fill the meter all the way and you can spend it instead on Overdrive** —
> eight seconds at double speed, trailing light.
>
> Dash by double-tapping a direction. Jump-ins work: light and heavy stay live in
> the air and carry the momentum you jumped with. Blocking cuts most of the
> damage and kills the knockback, but only while you are facing the blow — and it
> breaks the attacker's combo.
>
> Hits land with freeze frames, screen shake, hand-drawn impact art struck at
> the exact point of contact, and a combo counter that bumps on every link.
>
> **Five stages, and they are the same courtyard at five different hours.**
> ASHFALL at dusk with ash coming down and the lanterns lit. DAYBREAK under a
> high clear sun. BLOOD MOON through an eclipse. FROSTFALL in snow. VOIDGATE
> somewhere the sun never was. Press `T` or pick one on the select screen — it
> changes the sky, the fog, every light, the stonework, what falls out of the
> air and the colour grade, all at once, and it remembers your choice.

---

## Controls block

Paste this under the description — itch renders the table.

> ### Controls
>
> | | Player 1 | Player 2 | Gamepad |
> |---|---|---|---|
> | Move | `A` `D` | `←` `→` | Stick / D-pad |
> | Dash | `AA` / `DD` | `←←` / `→→` | double-tap the stick |
> | Jump | `W` | `↑` | `A` |
> | Block | `S` | `↓` | Triggers |
> | Light attack | `J` | `1` *(or `,`)* | `X` |
> | Heavy attack | `K` | `2` *(or `.`)* | `Y` |
> | Summon | `L` | `3` *(or `/`)* | `B` |
> | Overdrive | `I` | `0` *(or `'`)* | `RB` |
>
> `Space` locks in your fighter and starts the match — the button is clickable
> too. `Esc` pauses. `T` changes the stage. `M` sound, `N` music,
> `P` post-processing.
>
> Player 2 is CPU by default — switch to **2P VERSUS** on the select screen to
> play a friend. Gamepads are picked up automatically; pad 1 is Player 1.
>
> **Click the game once before you start** so it takes keyboard focus.

---

## Devlog / "how it was made", if you want one

> The whole thing is one HTML file. The fighters are built twice over: a
> hand-made primitive rig that carries every hitbox and never leaves the scene,
> and the imported character model layered on top of it. That means the combat
> geometry is identical no matter which art is loaded, and a model that finishes
> downloading mid-match can't move a hitbox out from under you.
>
> The imported models arrive fully rigged but with no usable animation, so their
> bones are driven procedurally from the same state machine that poses the
> primitive rig — each bone aimed by rotating its rest direction onto a target,
> which avoids having to know any particular rig's axis convention.
>
> The camera is two systems that deliberately don't talk to each other: a slow
> dolly that frames both fighters, and a fast accumulator that leans in on a
> wind-up, snaps in on the active frames, and narrows the lens while it pushes.

---

## Things worth knowing before you publish

- **First load is heavy.** The character models are ~149 MB, and one of them is
  116 MB on its own. See the `P3.fbx` section of `README.md` — most of that is
  texture maps the renderer throws away. Shrinking it is the single biggest
  favour you can do your players.
- **Set the viewport to 1280x720 and enable the fullscreen button.** The game
  fills whatever box it is given, but it reads best wide.
- **Audio starts muted until you press a key** — browsers require a gesture
  before audio can start. That is normal, not a bug.
- **Credit the character models.** If they came from Mixamo, Adobe's licence
  covers use in a game but a credit line on the page is good practice.
- **One credit is a licence condition, not a courtesy.** The hand-painted floor
  and stone are CC BY 4.0 by **beefpuppy**, which *requires* attribution
  wherever you publish. The impact and particle art is CC0 (Brackeys' VFX
  Bundle — Kenney, Picster, CodeManu) and does not require it, but costs
  nothing to give. Paste this at the bottom of the page:

  > **Credits** — Impact and particle art from
  > [Brackeys' VFX Bundle](https://brackeysgames.itch.io/brackeys-vfx-bundle)
  > (CC0; originally by Kenney, Picster and CodeManu). Surface textures from
  > [Hand Painted Tiling Textures](https://beefpuppy.itch.io/hand-painted-tiling-textures)
  > by beefpuppy (CC BY 4.0). Built with [three.js](https://threejs.org).
  > Type: Cinzel, Teko, Barlow Condensed and JetBrains Mono (OFL).

  The full breakdown is in `CREDITS.md`.
- **Tag it `asset-pack-friendly`, not just `fighting`.** The five stage themes
  and the theme switcher are the thing screenshots sell; take one shot per
  theme rather than five of the same courtyard.

---

## Update — what changed with the sunset build

Worth rewriting the page description around, because the two headline items are
both visible in the first screenshot.

**The stage.** `SUNDOWN` is now the default of six themes: a low sun sitting on
the waterline with its glitter path running toward you, layered headland
silhouettes, palms at the edges of frame and planking underfoot. `T` cycles the
rest — ASHFALL, DAYBREAK, BLOOD MOON, FROSTFALL, VOIDGATE. Take one screenshot
per theme; the variety is the thing that sells it.

**The fighters move.** Every state — idle, walk, jump, punch, kick, block, hit
reaction, knockout — plays a real animation clip now, retargeted onto each
character at load from a shared library. Armed fighters swing the sword they
are holding; unarmed ones use hands and feet.

### Which archive to upload

**`ashfall-arena-itch.zip` — 6.4 MB.** This is the one. The complete game
with the CLASSIC cast: four rigged characters from the three.js example set,
every animation state bound, and a first load measured in seconds rather than
minutes.

`ashfall-arena-itch-lite.zip` (2.9 MB) is the same game with KayKit’s chibi
Adventurers — smaller again, and a different art style rather than a reduced
one. `ashfall-arena-itch-authored.zip` (150 MB) exists for the authored cast;
if you upload it, warn players about the first load in the description.

All three are the same `index.html` with a different default cast baked in, and
all three let the player switch casts from the select screen — but switching to
a cast the archive does not contain will 404 and fall back to the primitive
rigs, so ship the one whose art you want seen first.

### Credits block for the page

> **Credits** — Characters from the
> [three.js example models](https://github.com/mrdoob/three.js) (Mixamo; the
> robot CC0 by Tomás Laulhé, modified by Don McCurdy). Animation and the
> compact cast from [KayKit](https://kaylousberg.itch.io) by Kay Lousberg
> (CC0). Impact and
> particle art from [Brackeys' VFX Bundle](https://brackeysgames.itch.io/brackeys-vfx-bundle)
> (CC0; originally Kenney, Picster and CodeManu). Surface textures from
> [Hand Painted Tiling Textures](https://beefpuppy.itch.io/hand-painted-tiling-textures)
> by beefpuppy (CC BY 4.0). Built with [three.js](https://threejs.org). Type:
> Cinzel, Teko, Barlow Condensed and JetBrains Mono (OFL).

Only the beefpuppy line is a licence requirement; the rest are courtesy.
