# Ashfall Arena

A 2.5D fighting game in Three.js. Four fighters, two summons, best of three
rounds, one CPU opponent or two players at one keyboard. One self-contained
`index.html` — no build step, no dependencies to install.

- [Run it](#run-it)
- [Put it online](#put-it-online)
- [Controls](#controls)
- [Stage themes](#stage-themes)
- [Assets](#assets)
- [Animation](#animation)
- [How it is built](#how-it-is-built)
- [Tuning reference](#tuning-reference)
- [Debugging a running match](#debugging-a-running-match)
- [Known gaps](#known-gaps)

---

## Run it

**The folder has to be served over HTTP.** Opening `index.html` from `file://`
loads the game but **not the models** — browsers block `file://` XHR, and
FBXLoader hangs on it without ever firing its error callback, so you get no
error, just fighters that never arrive.

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open <http://localhost:8080>. Use `serve.ps1 -Port 8090` if 8080 is taken.
There is no Python on this machine, which is why the server ships as a
PowerShell script rather than a `python -m http.server` line.

Check the **MODELS** row in the dev panel (`H`) to confirm what loaded.

---

## Put it online

Three options, in order of how much work they are.

### 1. The published Artifact — already live, nothing to do

<https://claude.ai/code/artifact/1d7ab4c1-623e-4dfc-8a9e-2fa03a685b8a>

Artifacts are **private by default** — open that page, use its share menu and
turn on link sharing, or anyone you send it to hits an access error. After that
people can play immediately, on any device, with no install.

**Caveat:** the sprite and texture art is published alongside the page, so the
artifact gets the full stage — sky, themes, impact art, dock, palms. Character
models do not: `.glb` is not a servable media type there, so the fighters fall
back to the built-in primitive rigs. That fallback is a complete, playable game
and the stage looks right; it just is not the loaded-model version.

This is the right link for *"look what I made"*. Upload the lite zip to itch.io
if you want the characters.

### 2. itch.io — the full version, models included

[itch.io](https://itch.io/docs/creators/html5) is built for exactly this:
free browser-game hosting with a shareable project page.

Its HTML5 limits are **200 MB per file and 500 MB per project**, which this
project fits — 149 MB total, largest file 116 MB.

Two upload archives are built and ready in `dist/`. Both have `index.html` at
the archive root, which is where itch looks for it.

| | Size | Roster |
|---|---|---|
| `ashfall-arena-itch.zip` | 145 MB | the authored cast, models included |
| `ashfall-arena-itch-lite.zip` | 5 MB | the COMPACT cast — the whole game, fully animated, no 100 MB files |

Upload as an **HTML** project, tick "This file will be played in the browser",
set the viewport to **1280x720** and enable the fullscreen button. See
`itch-page.md` for paste-ready page copy.

**Upload the lite build.** It is not a cut-down version any more — it is the
same game with the COMPACT cast, which is fully animated and 2.3 MB instead of
146. 116 MB of the full build is one character's textures, and a two-minute
wait before anything appears costs you more players than a different art style
does. [Shrink P3.fbx](#p3fbx-is-116-mb) if you want the authored cast online.

To rebuild either archive, note that `Compress-Archive` on Windows PowerShell
5.1 writes entry names with **backslashes**, which the ZIP spec forbids; many
extractors then produce one file literally named `assets\models\P2.fbx` instead
of a folder tree, and every model 404s. Build through `ZipArchive` and replace
the separators yourself.

### 3. Static hosts — free, but mind the per-file caps

| Host | Per-file limit | Verdict here |
|---|---|---|
| [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) | 1 GB per site, but Git itself refuses files over 100 MB | `P3.fbx` is rejected at `git push` unless you use LFS |
| [Cloudflare Pages](https://developers.cloudflare.com/pages/platform/limits/) | 25 MB per file, 1 GB per deploy | `P3.fbx` rejected; everything else fits |
| Netlify | drag-and-drop a folder, no published static per-file cap | works, but 116 MB is still a bad first load |

All three are fine once `P3.fbx` is a sane size.

### What about Google AI Studio?

**No — wrong tool for this.** AI Studio's Build tab is a *Gemini app* builder:
you describe an app in plain language, Gemini writes it against the Gemini API,
and you press "Deploy to Cloud Run" (free for up to two apps, no billing account
needed). It is a genuinely good product for that job.

It is not a static file host. There is no path to get a 149 MB folder of `.fbx`
binaries into it, and the game does not call the Gemini API, so nothing about the
Build tab helps. If you want a Google-hosted version, deploy the folder to
Firebase Hosting or Cloud Run directly rather than going through AI Studio.

### P3.fbx is 116 MB

That is an export accident, not an inherent cost. The file is binary FBX (good),
but it carries **ten embedded PNG textures** — Diffuse, Normal, Specular,
Glossiness and Emissive for each of two material sets, at full resolution.

The game uses the **diffuse map** and, where present, the normal map. Specular,
glossiness and emissive are read off disk and thrown away — FBXLoader even warns
about them in the console (`ShininessExponent map is not supported`). So roughly
two-thirds of that 116 MB is downloaded for nothing.

Fix it by re-downloading that character from Mixamo at a lower texture
resolution, or by opening the FBX in Blender and deleting the unused image
datablocks before re-exporting. The other three characters are 4–13 MB, which
is where this one should land.

---

## Controls

Left hand moves, right hand attacks — the standard PC fighting-game home
position. Player 2 takes the arrow cluster plus the numpad.

| | Player 1 | Player 2 | Gamepad |
|---|---|---|---|
| Move | `A` `D` | `←` `→` | Left stick / D-pad |
| Dash | `AA` / `DD` | `←←` / `→→` | double-tap the stick |
| Jump | `W` | `↑` | `A` / stick up |
| Block | `S` | `↓` | Triggers / stick down |
| Light | `J` | `1` *(or `,`)* | `X` |
| Heavy | `K` | `2` *(or `.`)* | `Y` |
| Assist (50% meter) | `L` or `R` | `3` *(or `/`)* | `B` |
| Overdrive (100%) | `I` | `0` *(or `'`)* | `RB` |

The `,` `.` `/` `'` fallbacks exist for laptops without a numpad.

Both players also accept a **gamepad** — pad 1 drives Player 1, pad 2 drives
Player 2, auto-detected. Keyboard and pad are OR'd into one raw state and
edge-detected once, so a key and a button can never double-fire an attack.

**System:** `B` hitbox overlay · `M` sound · `N` music · `P` post-processing ·
`T` stage theme (`Shift+T` steps back) · `H` dev stats · `Esc` pause.

**`Esc` pauses**, it does not abandon. The overlay has RESUME, RESTART
MATCH, CONTROLS, SETTINGS, QUIT TO SELECT and MAIN MENU; `Esc`, `Space` or
`Enter` all resume. Losing a match to one stray
keystroke, with no way back, was a bad trade for the keystroke it saved.
Alt-tabbing pauses too, so leaving the window costs you the tab and not the
round.

The game opens on a title screen: any key or a click promotes the logo to the
menu, then **PLAY** goes to select, `C` opens CONTROLS, `S` opens SETTINGS and
`Esc` steps back. Settings are remembered between visits.

On the character select screen, **Space** locks in your fighter and then starts
the match. Cards are also clickable. Player 2 is CPU-controlled by default;
switch to `2P VERSUS` for two humans.

### Stage themes

Seven of them, on `T` or on the swatch row under the mode switch. Each one is a
row of the `THEMES` table and drives the whole look at once — the painted sky
and where its sun sits, the fog colour and density, every light in the rig, the
water, the stonework, what falls out of the air, the bloom curve, the final
colour grade, and the HTML palette. The choice is remembered in `localStorage`.

| | |
|---|---|
| **SUNDOWN** | the dock at the end of the day — the default. Sun on the waterline, palms at the edges of frame, planking underfoot |
| **ASHFALL** | dusk over the cinder courtyard — the one the game is named after |
| **DAYBREAK** | clear morning, high sun. The look the game had before themes existed |
| **BLOOD MOON** | an eclipse nobody asked for. Crimson fog, violet kicker, heavy bloom |
| **FROSTFALL** | snow on the duelling stones. Pale, low contrast, slow drift |
| **VOIDGATE** | somewhere the sun never was. Near-black with magenta and cyan |

Two things are deliberately *not* themed: `--strike` red and `--spectre` blue.
Those two carry meaning — a hit landed, a hit was blocked — and a player should
never have to re-learn them because they changed the stage.

The sky is repainted into a canvas on every switch and re-run through
`PMREMGenerator`, so the loaded character models are ambient-lit by the sky
that is actually behind them rather than staying lit for whichever theme they
were authored under.

### Difficulty

`EASY` / `NORMAL` / `HARD`, next to the mode switch — it disappears in 2P since
it means nothing against a human. It scales how fast the bot thinks between
moves, how often it blocks on reaction, how long its strings are, how willing
it is to dash in or jump at you, and how hard it hits.

Only the **CPU's** damage is scaled. Your numbers never move, so the frame data
below stays honest at every setting.

`NORMAL` is exactly the bot that existed before the setting did. `EASY` exists
because the default will beat a first-time player 2-0 in about thirty seconds.

The control legend fades to a ghost once you are clearly playing — eight seconds
in, or the first time you attack or dash. Hover it to bring it back.

### What the moves actually do

**Dash** is a double-tap inside 0.26s. The direction has to be released and
re-pressed, so holding one never accumulates into a dash. 0.42s cooldown, and it
leaves an accent-coloured smear behind it.

**Jump-ins work.** Light and heavy stay available in the air, the move rides out
the jump arc instead of cancelling it, and the horizontal momentum the jump was
launched with carries through the attack. A grounded swing steps into the blow
instead of sliding on the spot.

**Facing locks the moment a swing commits.** Otherwise an opponent crossing under
a jump-in spins the attacker round on the active frame and throws the hitbox out
behind them.

**Heavy is a sword slash for armed fighters and a kick for unarmed ones** —
Cinderward and Pale Vigil cut, Bronzemaw and Nocturne kick. Different animation,
different hitbox, different reach.

**Blocking** mitigates most of the damage and cancels knockback, but only while
you are facing the attacker, and it breaks the attacker's combo string.

**One meter, two gauges.** 0–50% fills ASSIST, 50–100% fills OVERDRIVE. Calling
an assist spends 50 and starts a 6-second lockout that the gauge counts down.
Overdrive spends the lot for 8 seconds of double speed and a light on the body.

### How a round ends

First to two rounds, five rounds maximum.

The round is **not** settled inside the hit that lands it. It is settled once
per frame, after every hitbox on both sides has been resolved — otherwise the
first collision tested closed the round, and a genuine simultaneous KO silently
awarded the win to whichever hitbox the loop happened to reach first.

- **K.O.** — one fighter down.
- **PERFECT** — you won the round without being touched.
- **DOUBLE K.O.** — both down on the same frame.
- **TIME UP** — the clock ran out with someone ahead.
- **DRAW** — the clock ran out level.

A draw awards **both** fighters the point. Awarding nobody meant two even
players could replay round after round while the counter climbed and the stocks
stayed 0-0; taking the point terminates, and if both reach two the match ends
as `DRAW GAME`.

---

## Assets

### Where the art comes from

See **[CREDITS.md](CREDITS.md)** for the full list and licences. In short:
impact sprites and particle art are **CC0** from Brackeys' VFX Bundle (Kenney,
Picster, CodeManu); the hand-painted floor, stone and timber are **CC BY 4.0**
by beefpuppy; the type is OFL from Google Fonts.

All of it is optional by construction. Textures are fetched *after* the scene
is already running and swapped in only if they arrive, so a blocked request or
a deleted `assets/vfx/` folder costs the improvement and nothing else — the
procedural canvas version each one replaced is still there underneath. The
**ART** row in the dev panel (`H`) reports how many landed.

### Character models

One file per character, so any pedestal can show any fighter and a mirror match
still works:

```
assets/models/p1.fbx  p2.fbx  p3.fbx  p4.fbx   → the four fighters
assets/models/s1.fbx  s2.fbx                   → the two assists
```

### The fallback chain

Every slot degrades quietly, in this order:

1. `pN.fbx` — the lowercase name
2. `PN.fbx` — the capitalised one, which is how Mixamo often names downloads
   (Windows treats the two as identical; Linux would not)
3. `pN.glb` — the same basename as glTF
4. **a sibling's mesh**, borrowed
5. that character's built-in primitive rig

Step 4 is worth explaining. Every slot is tinted to its own accent anyway, so a
borrowed mesh reads as a different character; a primitive one reads as a missing
asset. With `s1.fbx` absent, this is the difference between one player summoning
a character and the other summoning a cone. The HUD reports it as `+1 stand-in`.
If nothing in the set loaded at all, the primitive rig is still there and still
correct.

Loading is preloaded and cached: all six files are fetched once into
`ASSETS.cache`, then cloned per pedestal with `SkeletonUtils.clone`, so switching
selection is an instant clone rather than a refetch.

### Scale

`scale.setScalar(0.01)` is the standard Mixamo cm→m normalisation, which lands a
character near 1.8 units. Our rigs are 3.2, so a second measured factor is
applied on top, giving `0.01 × fit`.

The fit is measured from **bone positions, not the bounding box**. A
SkinnedMesh's bind-pose geometry can be authored at a completely different scale
from the skeleton driving it — trusting the box scaled one Mixamo rig about 176×
too large.

### Your files need animation clips

The FBX files currently in `assets/models/` load and scale correctly but stand in
**bind pose**. They do carry animation tracks, but those are stubs —
`mixamo.com` at 0.03s and `Take 001` at 0.00s — a single bind-pose frame each,
which is what a character-only Mixamo export produces.

Any clip shorter than `MIN_CLIP` (0.12s) is rejected rather than bound, because
playing a one-frame clip is indistinguishable from being frozen and would hide
the problem. The HUD reports this as `(no motion)`.

In Mixamo, add animations to your queue and download **with** the character (or
merge them) so each `.fbx` carries real clips.

### One clip per file: `clips.json`

An auto-rigging service returns one animation baked into one GLB, so a full
move set arrives as seven or eight separate files rather than one file with
seven clips. `assets/models/clips.json` maps those files onto the game's
states — see `clips.example.json` for a documented template.

```json
{
  "p1": {
    "model": "p1_rigged.glb",
    "clips": { "IDLE": "p1_idle.glb", "PUNCH": "p1_punch.glb" }
  }
}
```

Both fields are optional, and so is the whole file: with no `clips.json` the
loader behaves exactly as it did before. `model` is tried *ahead* of the
authored `pN.fbx`, so a rigged output can replace the mesh it was made from.
The **filename decides the slot**, so these never go through the clip-name
matching table.

**Partial sets are the expected case, not an edge case.** Buying two clips
gives you those two; every other state stays on the procedural bone driver.
`driveMixer()` makes that decision per state rather than all-or-nothing —
owning a PUNCH clip must not mean standing frozen while idle.

**Clips are retargeted by bone name before they are bound.** This matters more
than it sounds: an AnimationClip binds by track name and nothing else, so
handing a mixer a clip authored against `Hips` when the model calls that bone
`mixamorigHips` attaches without complaint, plays, and moves nothing — exactly
the silent failure the stub clips already cost us once. Track names are
normalised (`arm_r`, `Right_Arm`, `arm.R`, `mixamorigRightArm` all resolve to
the same bone) and a clip matching under 30% of the skeleton is **rejected**
rather than bound. The dev panel reports those as `N unbindable`.

Bone matching throughout is normalised the same way, so an auto-rig that names
bones `upperarm_r` or `thigh.L` still drives limbs, mounts the sword on the
right hand, and reports its facing correctly.

### Getting the combat animations from Mixamo

Mixamo requires an Adobe sign-in, so these have to be downloaded by hand:

1. Sign in at <https://www.mixamo.com>.
2. Pick a character (**Characters** tab). Anything humanoid works.
3. In **Animations**, add each of these to your queue:
   - `Idle` — or `Fighting Idle` for a proper stance
   - `High Kick`
   - `Sword Slash` — or `Standing Melee Attack Downward` if unarmed
   - `Hit Reaction` — this is what Mixamo calls hit stun
4. Open the queue and **Download** with: format **FBX Binary**, skin **With
   Skin**, **30** fps, keyframe reduction **none**.
5. Save as `assets/models/p1.fbx`, and repeat per character.

### How clips are matched

`ANIM_MAP` matches clip names by fragment, case-insensitively:

| State | Matches on |
|---|---|
| `IDLE` | idle, breath, stand, fighting stance |
| `WALK` | walk, strafe |
| `JUMP` | jump, run |
| `PUNCH` | punch, jab, **slash**, **sword**, cut, stab, attack |
| `KICK` | **kick**, roundhouse |
| `BLOCK` | block, guard, brace |
| `HITSTUN` | **hit**, hurt, impact, stagger, react |
| `KO` | death, dying, fall, knock |

Mixamo names every *single* animation download `mixamo.com`, which matches
nothing. Unmatched clips are dealt out positionally instead, in the order
`IDLE, KICK, PUNCH, HITSTUN, KO, WALK` — so queue them in that order and a stack
of single downloads still lands correctly. Merged downloads keep their real names
and match on the table above.

Anything still missing borrows the nearest clip (no kick → uses punch; no block →
uses idle), so a partial set never breaks.

---

## The front end

Three overlays sit in front of the canvas, and a body class decides which is
up. None of them is a separate page — the scene keeps rendering behind all of
them, which is why the title screen has a live sunset in it rather than a
screenshot.

| Body class | Shows | Reached from |
|---|---|---|
| `attract` | logo + `PRESS ENTER TO BEGIN` | load |
| `titling` | logo + PLAY / CONTROLS / SETTINGS / HELP / QUIT | any key or click on attract |
| `selecting` | the fighter select screen | **PLAY** |
| `paused` | the pause card | `Esc` during a match |
| `modal` | CONTROLS, SETTINGS or HELP | either menu |
| `bye` | the thanks-for-playing card | **QUIT** |
| `results` | the end-of-set card | a set ending |

`phase` moves `TITLE → SELECT → FIGHT`. The title's key handler is registered
in **capture** so it answers before the match input does and returns early —
nothing falls through to the fight controls while an overlay is up.

### One modal, two openers

CONTROLS and SETTINGS are a single overlay with two panes, reachable from the
title screen and from a paused match. It remembers which opened it (`UI.modalBack`)
so closing returns you there. Opened from the pause menu it does **not** unpause:
it has a higher `z-index` than the pause card and simply sits on top of it, which
means reading the controls mid-match cannot cost you the round.

### Settings

Every switch drives the function the keyboard shortcut already drove, so the
two can never disagree — the menu toggle and `M` are the same switch seen from
two places.

| Setting | Drives | Key |
|---|---|---|
| Master volume | the final gain before the destination | — |
| SFX volume | the gain every effect passes through, under master | — |
| Sound effects | `Sfx.toggle()` | `M` |
| Music | `Music.toggle()` | `N` |
| Post-processing | `setPost()` | `P` |
| Bloom | `bloomPass.strength`, zeroed rather than removed | — |
| Graphics quality | render scale, 0.7 / 1.0 / 2.0 capped at the device ratio | — |
| Screen shake | gates the camera kick | — |

They persist to `localStorage` under `ashfall.settings`. Audio is the exception
to restoring immediately: a browser will not start an `AudioContext` without a
gesture, so a remembered mute is held and applied inside `leaveTitle()` once
**PLAY** has provided one.

Graphics quality sets the pixel ratio on both the renderer and the composer —
they have to agree, or the composer keeps drawing at the old size into a target
that moved — then forces the resize path that rebuilds the passes. `onResize()`
short-circuits on an unchanged box, so the width cache is invalidated first.


### Type

Four families do the work, and each one earns its place rather than being
decoration:

| Family | Used for |
|---|---|
| Cinzel Decorative | the `ASHFALL ARENA` logo and the quit card |
| Cinzel | headings, fighter names on the select screen |
| Orbitron | menu buttons, HUD nameplates, section headers — anything that should read as a machine talking |
| Rajdhani | the small HUD labels, where Orbitron's width would blow the line out |
| Teko | the round clock and combo counter (tabular, condensed) |
| Barlow Condensed | body copy |
| JetBrains Mono | frame data and the dev panel |

### The embers

The title's particle layer is nine `<span>`s and one `@keyframes`. Each gets
its left offset, size, duration and delay from an `:nth-child` rule, so the
whole effect costs one element per particle, no script and no canvas — and
`prefers-reduced-motion` removes it with a single `display:none`.


### The PLAY transition

Every other camera move in the file is a damped pursuit — write a target,
ease toward it at some lambda. That is the right tool when the target keeps
moving: two fighters, a separation dolly, a wind-up lean. The PLAY move is
the one exception. It has a known start, a known end and a duration somebody
chose, so it is authored as a tween rather than approximated with a rate
constant.

`tween.js` 18.6.4 (UMD, ~10 KB) does the interpolation:

| | |
|---|---|
| From | the camera's live pose, near `TITLE_CAM` — `(0, 4, 12)` |
| To | `SELECT_CAM` — `(0, 1.5, 5)` |
| Duration | 1500 ms |
| Easing | `TWEEN.Easing.Quadratic.InOut` |

Measured against the curve: 12.5% of the distance at 25% of the time, 50% at
50%, 87.5% at 75%. Symmetric ease in and out, landing exactly on the target.

Three things make it work, and all three are the kind of bug you only see
once it is wrong:

**It tweens `rigBase`, not `camera.position`.** `updateCameraSelect()` damps
`rigBase` every frame and copies it onto the camera, so a tween writing the
camera directly would be overwritten on the very next frame.

**The damping stands down while the tween runs.** Easing toward the same pose
underneath the tween does not cancel out — it pulls the ease-in forward and
flattens the ease-out, so the authored curve is not the curve you get.

**The clock starts a frame late, on purpose.** A tween is time-based, so
frames lost to work underneath it are not slowed down, they are *skipped*.
The first SELECT frame builds the pedestal preview and re-shoots the
portraits; on this machine that one frame cost 480 ms, and the camera
appeared already a third of the way through its own move — losing precisely
the ease-in the tween exists to provide. So PLAY calls `requestCamTween()`,
and the clock starts at the end of the first SELECT frame, once that cost is
behind it. The rig is held still for that one frame, because a 480 ms `dt`
through `damp(…, 3.0, dt)` would otherwise take 76% of the gap in a single
step.

If `tween.js` fails to load, or the viewer has `prefers-reduced-motion`,
`startCamTween()` returns false and the old damping runs instead. It reaches
the same pose, a little less deliberately.

**Framing note.** `SELECT_CAM` at `z: 5` is a close-up. At 45° vertical FOV
and 16:9 that gives a visible half-width of 3.68 at the fighter plane, so the
fighters at `x: ±2.3` sit comfortably inside it but the assist summons at
`x: ±5.7` fall outside the frame, and the bottom edge lands at `y ≈ 0.31`,
cropping the plinth tops. `z: 8.2` (half-width 6.04, bottom edge `y ≈ -1.0`)
frames the whole set. The constant is the only thing that needs changing.

### Why the panel is not really glass

The modal wants `backdrop-filter`, and it has it — on `#modal`, the layer
behind the panel. It deliberately does **not** also have it on `.mbox`.

Nesting one `backdrop-filter` inside another drops the inner element
entirely on compositors that fall back to software rendering: the panel is
laid out, hit-testable and reported visible by `getComputedStyle`, and paints
nothing at all. That is a far worse failure than looking slightly less glassy,
and it is invisible in testing unless you happen to run on the affected path.

So the blur lives on the backdrop, and `.mbox` carries alphas (`.86`/`.93`)
that stay legible with no blur whatsoever. The glass reads as glass where the
compositor cooperates and as a dark panel where it does not, and the text is
readable either way.



### The results card

The set used to end by dropping straight back to the select screen, which
threw away the only moment a match has to say what happened. `showResults()`
puts a card up instead: verdict, winner, round score, and three tallies —
damage dealt, biggest combo, rounds taken.

Nothing on it is measured specially. `dealt` is accumulated at the one place
health actually changes, off the **real** drop (`before - def.hp`), so chip
damage on a guard counts once and a blow that overkills does not bank damage
the fighter never had. `bestCombo` is a high-water mark taken in `bumpCombo`,
which already ran on every link.

REMATCH re-runs `startMatch()` with the same two fighters. Every route out of
the card calls `hideResults()` first, and `Esc` / `Enter` / `Space` behave as
CHARACTER SELECT — pausing a match that is already over would be nonsense.

### The bot is a named state machine

The behaviour was always spacing, strings, reaction-block and assist, but it
was expressed as one priority cascade: you could not ask the bot what it was
doing, only watch and guess. The branches now carry names and the winning one
is recorded on the brain.

| State | Entered when |
|---|---|
| `STUNNED` | hit, downed, or the set is over — no input at all |
| `GUARD` | a committed swing was read, inside `blockChance` |
| `ASSIST` | meter full and the summon off cooldown |
| `RETREAT` | under `lowHealth` and too close, or inside `MIN_GAP` |
| `PRESSURE` | running a queued attack string |
| `ANTIAIR` | punishing a jump-in on the way down |
| `APPROACH` | out of range, walking or dashing in |
| `SPACING` | in range, choosing when to commit |

**Behaviour is unchanged by design.** Every threshold and probability is the
one that was there before; this is a renaming, not a retuning, so the
difficulty table still means what it meant. The current state is on the dev
panel (`H`) as **BOT STATE**, which is the point — it can now be watched.

### Cross-fading

`playAction()` used to start a `fadeIn` on the incoming action and a
`fadeOut` on the outgoing one. Two independent fades do not sum to 1 in the
middle — the skeleton sags toward its rest pose partway through the blend,
which is visible on a hit reaction where the fade is short and the pose
change is large. `crossFadeTo` ties both weights to one clock.

Durations are per-state: `0.06s` into PUNCH, KICK, HITSTUN and KO, `0.16s`
everywhere else. An attack has to be on screen the frame it is thrown or the
animation is lying about the frame data.

### Bloom is a bias now, not a value

The baseline is `strength 0.35 / threshold 0.80`, down from `0.78 / 0.88`.
The old numbers lit the energy trails beautifully and blew the sky and the
bone-white HUD text out along with them.

Themes still bend it — an eclipse should bloom harder than a snowfield — but
they bend *relative* to the baseline rather than replacing it:

```js
BLOOM.strength = BLOOM_BASE.strength * (T.bloom.s / 0.78);
```

The `/ 0.78` is the old baseline those per-theme numbers were authored
against, so the whole set keeps its shape and moves down together.

### On purging the primitive rigs

The brief said to purge procedural geometry — mannequins, primitives, debug
hitboxes. Three of those four are already gone from the screen and the fourth
cannot go:

- **Debug hitboxes** are off by default; `B` toggles them.
- **The dev panel** is `display:none` until `H`.
- **The control legend** now hides completely once you are clearly playing
  (8 seconds, or your first attack), instead of lingering at 13% opacity.
- **The primitive rig stays**, invisible. `f.body.visible = false` the moment
  a model binds, so nothing procedural renders — but that rig *is* the
  combat geometry. Every hurtbox and every hitbox hangs off its bones, and
  the loaded model is posed to follow it. Deleting it would delete the
  collision volumes and the game would stop registering hits entirely.

If a fighter still looks like a grey mannequin, that is Xbot — the actual
three.js example asset — not a placeholder.



### OBSIDIAN, and a real PBR floor

The default stage is now a dark-fantasy court built around two lights rather
than a painted sky.

| | |
|---|---|
| Key | `#FFAA44` directional, intensity 2.5, casting 2048² soft shadows |
| Fill | `#004466` directional from the opposite side and behind |
| Fog | `FogExp2(0x0A0710, 0.035)` |
| Floor | slate albedo + normal + roughness, `roughness 0.3`, `metalness 0.1` |
| Bloom | `strength 0.25 / radius 0.40 / threshold 0.85` |

**Data maps are not colour maps.** `loadTex()` used to stamp
`sRGBEncoding` on everything it loaded, which is right for albedo and wrong
for the other two. A gamma-decoded normal map bends every vector toward the
surface — the lighting goes soft in a way that is easy to misread as a bad
`normalScale`. The loader takes `linear: true` now, and the normal and
roughness maps use it.

`syncFloorTex()` swaps the whole material rather than just the albedo. A
theme asking for `slate: true` gets all three maps; a dock or a painted
courtyard gets `normalMap` and `roughnessMap` set back to `null`, because
leaving a slate normal map under timber planking reads as broken lighting
long before anyone works out why.

#### Two numbers that did not survive contact

Both of these were specified, and both had to move for the stage to look
like the reference rather than like a bug. They are worth knowing about if
you tune this again:

- **The key at 2.5 blows the stage out on its own.** three.js r128 uses
  legacy light units, and the other six themes key at 0.72–0.94. The
  intensity is kept at 2.5 because the *ratio* to the fill is what the look
  depends on — but everything that is not one of those two lights came down
  to compensate: ambient to `0.05`, hemisphere to `0.09`, exposure to
  `0.66`. The shadow side of a fighter should fall to almost nothing and be
  rescued by the teal, not filled in by ambient.
- **`#004466` at intensity 1.0 is not a rim light.** Its brightest channel
  is `0x66`, about 0.4 — against a key at 2.5 it contributes almost nothing.
  The colour is kept exactly; the intensity is 2.2 so that it does the job
  the brief actually asked for, which was a cold edge on a silhouette.

#### `bare`

Palms and blossom used to be a two-state switch: `palms: true` gave a beach,
`palms: false` gave a cherry-blossom courtyard. There was no way to ask for
neither, so OBSIDIAN's first build came up with a canopy of lavender blossom
hanging over a black court. `bare: true` is the third state.



## The design system

The HUD used to be part of the stage: warm ember chrome that shifted with
whatever theme was loaded. It now sits on its own tokens and does not move.

| Token | Value | Used for |
|---|---|---|
| `--amber` | `#FFAA00` | charge, readiness, primary action |
| `--crimson` | `#E63946` | damage, active frames, destructive buttons |
| `--glass` | `rgba(15,15,22,.85)` | every panel ground |
| `--metal` | `#333344` | every 1px edge |
| `--hp-full` / `--hp-mid` | `#7BE0A0` / `#E8D24A` | the health ramp |

**Why the HUD is not themed.** `--acc` is still written per stage and per
fighter, and the 3D still uses it — but a health bar that changes colour with
the stage is a health bar you have to re-learn every time you press `T`.
Stage colour lives in the render; the interface stays put. The only themed
thing left in the HUD is the fighter's own name.

### Typography

Three faces, one job each. Cinzel Decorative on headings and announcements,
Rajdhani on every number and label (tabular figures, so the clock does not
jitter), Orbitron on buttons and switches.

### The health bar was backwards

Two layers, one target value. `syncHud()` writes the same `scaleX` to both;
the tiers come entirely from their transitions — `.hp` settles in `0.14s`,
`.chip` waits `0.22s` then takes `0.66s`. The gap between them is the damage
just taken.

The previous skin had `.hp` red and `.chip` gold, which meant a **full** bar
was red and a **dying** one was gold. Readable once you knew it; wrong at a
glance, which is the only speed a health bar is read at. Now `.hp` ramps
green → yellow → dark gold as it drops and `.chip` is flat crimson, so the
band that appears after a hit is the hit.

### Hexagonal meter badges

Assist and Super were two more horizontal bars stacked under a horizontal
health bar — three parallel lines saying three unrelated things. They are
hexagons now: discrete, countable, and a shape that has somewhere to put a
glow when it fills.

The markup and the JS are unchanged. `clip-path` makes the hexagon, the fill
is the same `scaleX` the gauges always used, and `.lit` / `.cooling` still
come from the same two lines in `syncHud()`. The metallic edge is a masked
underlay rather than a `border`, because `clip-path` cuts borders off.

### The keyboard grid is gone

`#keys` was a reference card printed over the game — the thing that reads as
"developer build" in a screenshot faster than anything else. The same content
is in CONTROLS, one key away. `display:none`, not an opacity fade.



## Loading

### The curtain

`#boot` covers the title while the cast downloads. It is a **curtain, not a
gate** — the scene renders underneath from the first frame, and every asset
in this file already degrades to something playable if it never arrives. The
curtain hides a cold start; it does not introduce a dependency on one.

That distinction is the whole design. A real gate would mean a blocked
request now costs you the game instead of costing you an improvement, which
would undo the robustness the rest of the loader was built for. So the
curtain lifts on whichever comes first:

- the cast is accounted for — `loaded + failed + borrowed >= total`,
- twelve seconds pass,
- or the player clicks it.

### Progress

One `THREE.LoadingManager` sits behind every loader in the file — the
texture loader and both model loaders. Progress is read from it rather than
from our own tallies, because the manager counts real requests and cannot
drift out of step with them the way a hand-maintained counter can.

It is blended, though, because the manager's raw ratio lies: it knows how
many requests are outstanding but not how many are still to be queued, so it
snaps to 100% between waves. `Boot.ratio()` weights the cast tally at 0.7
against the request ratio at 0.3, and `paint()` never lets the bar go
backwards.

The base64-JSON fallback (`tryWrapped`) uses a raw `XMLHttpRequest` and is
invisible to the manager. That is why the cast tally carries most of the
weight: on the published artifact, where every model arrives through that
path, the manager would otherwise report almost nothing.

## Two animation fixes

### A model with no clips was left in its bind pose

`bindClips()` returned early on `if (!usable.length) return;` — **above** the
`playAction(target, "IDLE")` at the bottom of the function. A model that
arrived with no usable animation therefore got no mixer, no action and no
idle, while `applyModel()` had already set `f.body.visible = false` and
hidden the primitive rig that would otherwise have been posing it. The result
is a T-pose.

It never showed, because `driveMixer()` falls through to `driveBones()` and
the procedural bone driver posed the mesh anyway. That is a mask, not a fix:
it only holds for rigs the driver can map, and it left
`applyLibraryClips()` with no mixer to retarget onto. The mixer is now
created before the early return.

### Cross-fade durations

`0.15s` for `IDLE`, `WALK`, `JUMP` and `BLOCK`, as asked.

`PUNCH`, `KICK`, `HITSTUN` and `KO` stay at `0.06s`, and this one is worth
keeping: a 0.15s blend means a punch is only ~40% of the way into its pose
when its active frames open. The hitbox is already out and doing damage
while the model is still visibly winding up, so the animation contradicts
the frame data. Combat states have to be on screen the frame they start.

### Hit-stop

Flat **60ms** on every clean hit, 35ms on a guard. This was previously
60–85ms scaled by damage; that has been removed.



## Scaling, grounding and the material pass

### Box3 does not measure a skinned character

`Box3.setFromObject` walks each node's geometry bounding box through its
world matrix — and a `SkinnedMesh`'s geometry is its **bind pose**, authored
at whatever scale the artist used, not the scale the skeleton drives it at.

Measured on the shipped cast, against an actual fitted height of 3.2:

| | Box3 height |
|---|---|
| Xbot | **0.028** |
| Michelle | **0.007** |

It is not slightly off, it is meaningless. So `prepModel()` only lets the box
ground a model when its height is at least half the target — which in
practice means static meshes. Everything skinned grounds off the lowest
**bone**, which is what `measureFit()` already walks.

Verified after grounding: lowest bone world Y of `0.004` and `0.051`. The
second is the ankle joint sitting ~5cm above the sole of a boot, which is
the offset bones will always have against geometry, and is why the fit
carries a `× 1.16` correction.

### Height is the rig's, not a round number

`ASSETS.fitHeight` is deliberately the **primitive rig's** height and not a
tidy 2.0. The rig carries every hitbox and every hurtbox; the model is art
laid over it. Normalise the art to 2.0 while the rig stays 3.2 and you get a
fighter whose head can be hit from a foot above it. Change the cast's `fit`
and the models follow.

### The material pass, and who owns `emissive`

`applyPBR()` sets `roughness 0.3`, `metalness 0.8`, `emissive 0x221100` on
every character material after `tintModel()` has converted them.

Metalness that high is a strong read: a metal surface has almost no diffuse
response, so what these fighters show is very largely a reflection of
`MODEL_ENV`. That is why the environment probe exists and why it is rebuilt
per theme — without it, metalness 0.8 renders them close to black.

It also has to write `userData.baseEmissive`. `applyFlash()` restores
emissive from that snapshot every time a hit flash decays, and the snapshot
was taken in `tintModel()` before this pass ran — so setting only
`m.emissive` held for a few frames and was then quietly reverted by the first
punch that landed. Confirmed to survive 18 exchanges now.

## Widescreen layout

The HUD sizes in `vh` from the layout pass down, every value clamped at both
ends. `vh` and not `vw`: the frame is letterboxed to the window and vertical
space is what runs out first — a bar sized in `vw` grows without limit on an
ultrawide.

| Element | Placement |
|---|---|
| Health + names | top edge, `clamp(14px, 2.2vh, 30px)` inset |
| Timer | centre column of the status grid, octagonal plate |
| Assist / Super | bottom corners, stacked, P1 left and P2 right |
| Combo | below the meters, same corner as its owner |

The timer is centred by the grid it sits in — the status row is
`1fr auto 1fr`, so the middle column already *is* the centre of the frame and
a `translateX(-50%)` would only fight it.

### The select camera is a portrait framing

`y 1.40, z 4.2, fov 40`. At that distance a 40-degree lens is **1.53 units of
half-width** at the fighter plane. The previews stood at `x = ±2.3` for the
old wide framing and fell clean outside this one, so the portrait framing
moves them to `±1.05` and skips posing the assist summons at `±5.7`
altogether rather than animating them off-camera.



### Beam, sheen and orbs

Three effects after the look of libraries.dev, written natively here. Their
components are React and sold under a Pro licence, so none of their source
is in this file — these are the same well-known techniques against our own
tokens.

**Border beam.** A conic gradient rotated around a panel and masked to a
1px ring (`mask-composite: exclude` on padding-box vs border-box). The angle
has to be a **registered** custom property — an unregistered `--beam-angle`
jumps 0 to 360 instead of sweeping, because the browser has no idea it is
an angle. Where `@property` is missing the beam simply stops travelling and
the static metallic edge underneath is what shows, which is why that edge is
still declared separately.

Speed carries meaning: resting panels 9s, ordinary buttons 6s, the primary
action 3.2s, hover 2.4s.

**Liquid sheen.** A specular band travelling across the logo's existing
`background-clip: text` fill, as a second layer in the same background stack
rather than an overlay — an overlay would sit in front of the glyphs and
grey them out.

**Orbs.** Three large, heavily blurred radial gradients drifting behind the
boot curtain and the title. The cheapest way to stop a near-black panel
reading as an empty div.

All three stop under `prefers-reduced-motion`.



## Rebindable controls

`SETTINGS → REMAP KEYS`. All eight actions, both players, persisted to
`localStorage` under `ashfall.keys`.

`BINDINGS` stays the single source of truth — remapping writes into the same
table the input layer reads every frame, so nothing downstream needs to know
that keys can move. Three details that matter:

- **Defaults are snapshotted at load**, before any saved map is applied.
  "Restore defaults" has to mean the code's defaults, not whatever was in
  `localStorage` when the page opened.
- **A clash swaps rather than duplicates.** Binding a key that another action
  already owns hands it over and gives that action the key you just freed.
  Two actions answering to one key is never what anyone meant, and silently
  refusing the press is worse.
- **Newly bound keys join `SWALLOW`**, or a freshly mapped Space or arrow
  scrolls the page mid-match.

The on-screen legends read from `glyph`, which used to be hand-written
alongside the fixed bindings and is now derived from them.

## Assists stay on the floor

Three separate things were lifting a summon off the ground plane:

| | was | now |
|---|---|---|
| RUSH | `(idol ? 1.1 : 0) + sin(...) * 0.10` | `0` |
| RETREAT | damps to `1.4` (idol) / `0.35` | damps to `0` |
| Idol wind-up | climbs to `3.1`, holds `0.24s` | climbs to `1.9`, commits at `0.18s` |

Plus a hard `y < 0` clamp so nothing sinks through the floor.

The leap's ballistic arc is deliberately kept — it peaks around 1.35 and it
*is* the attack. Grounding that too would not fix a bug, it would delete the
move. Measured after the change: RUSH `0.000`, RETREAT max `0.087`.

A summon on stage now also pushes the camera in (`camPush` 0.62, the same
accumulator the attack lean uses, so it damps back out on its own).
Measured: 0.48 units of dolly, returning to rest afterwards.

## Why the cast looked like bronze statues

`metalness 0.8`, which was asked for and which I shipped with a note that it
was a strong read. It is worth writing down *why* it flattens a roster: a
metal surface has almost no diffuse response, so **albedo stops contributing**
— and albedo was the only thing making four characters look like four
characters. They all collapse to the same reflection of the same environment
probe.

Now `metalness 0.25`, `roughness 0.42`, and materials that arrived above 0.6
keep their own values, so a pauldron stays metal while skin and cloth do not.


## How it is built

### Layers

```
WebGL canvas  →  #veil (scrims)  →  #hud (pointer-events:none)  →  #select
```

The canvas sits at the bottom; every DOM layer above it is absolutely placed and
transparent to the mouse unless a control opts back in.

### Why the primitive rig never goes away

A loaded model is layered **on top of** the hand-built primitive rig rather than
replacing it. The primitive rig stays in the scene, hidden, and keeps being posed
every frame — because all hit and hurtboxes are anchored to its bones.

Combat geometry therefore stays authored and identical no matter which art is
showing, and a model that finishes loading mid-match cannot shift a hitbox.

### Bone driving

A loaded Mixamo model arrives **fully rigged** — 49 to 65 bones depending on
whether the export kept the fingers, all named `mixamorigHips` downward — but
with the stub clips rejected there is nothing driving any of them. The procedural animation poses the *primitive* rig,
which is hidden, so the visible model stood in bind pose while only its root
moved. That is what reads as stiff.

`driveBones()` aims the real limb bones from the same state machine: shoulders,
forearms, thighs, shins, hips, spine and neck. Each bone is aimed by rotating its
**rest direction** — taken from where its child bone sits — onto a desired
direction, converted into the parent bone's space. That sidesteps having to know
each rig's local axis convention, so it works on any humanoid.

An armed fighter's heavy is driven from the lead arm as an overhead cut that
draws up behind the shoulder and sweeps down through hip height. Unarmed fighters
kick, and the kick chambers before it extends rather than shoving a straight leg
forward. The pose, the bone driver and the hitbox all read the same
`slashing()` / `kickingLeg()` test, so they cannot disagree.

The neutral pose is not static. Every stance above is a constant direction, so
without a breathing layer a clip-less model holds one exact pose forever, which
is most of what still read as stiff once the limbs were being aimed correctly.
Two slow out-of-phase oscillations do it — a breath up the spine and a weight
shift across the hips — and both fade out as the fighter picks up speed so they
never fight the walk cycle.

Bone driving steps aside **per state**, not all at once: where a real clip
exists for the current state `driveMixer()` hands that state to the
AnimationMixer, and where one does not it stops every action so the mixer
writes nothing and the procedural driver takes the skeleton back. The summon
performance layer drops to a 30% overlay whenever a mixer exists.

### The sword follows the loaded model

The weapon is built as a child of the primitive rig's lead fist, and that whole
rig is hidden the moment a model loads — so an armed fighter used to swing SLASH
with no sword in frame while the hitbox tracked an invisible blade.

`rehomeWeapon()` re-parents it to the model's own `RightHand` bone, which fixes
both at once: the blade-tip anchor carrying the hitbox is a child of the weapon
and comes along with it. Two things get undone on the way — the bone's world
scale (the model is normalised by `0.01 × fit` while the weapon is authored at
rig scale, so the weapon is counter-scaled by `1/k`), and the bone's local axis
convention, which is read off the hand's own child bone rather than assumed.

### Materials

Every loaded material is rebuilt as a `MeshStandardMaterial`. FBXLoader hands
back `MeshPhongMaterial` and glTF hands back `MeshStandardMaterial`, so the two
formats graded completely differently under one light rig. The diffuse map is
kept and tagged `sRGBEncoding`, and the accent tint is weighted by whether there
is a texture worth preserving — heavy on flat colour so the roster still reads
apart, light where a real texture is doing the work.

Mixamo character textures are authored for a studio three-point setup, not for
one key light over a daylit courtyard, and several of them rendered as near-black
silhouettes. The diffuse uniform is a plain multiplier and is not clamped to 1,
so it is lifted above unity and the tone mapper pulls the highlights back.

Fill comes from an **environment map applied per material**, not from a light.
Three.js has no per-object light filtering, so a fill light bright enough to lift
the fighters also bleached the cel-shaded stage. `MeshToonMaterial` ignores
`envMap` entirely, so an IBL reaches exactly the objects that need it. It is
assigned per material rather than through `scene.environment`, which would also
catch the arena's own standard materials — the flagstone floor being the loudest
— and wash the whole courtyard milky.

The damage flash drives those materials too. It used to live only on the
primitive rig, which is hidden once a model loads, so a hit on a loaded fighter
registered nothing at all on the body.

### Camera

The rig damps toward a target derived from the pair: X follows the midpoint, Z
opens with their separation, Y rises with both separation and the higher fighter.

On top of that, `attackCamera()` keeps its own accumulator so it never fights the
separation dolly. It leans in on startup, snaps in hard on the active frames,
eases out through recovery, drifts laterally toward whoever is swinging, and
narrows the lens as it pushes — a dolly-zoom rather than a move.

Shake is applied **after** `lookAt()`, so it translates the frame rather than
orbiting the look target, and it is written to a scratch offset rather than back
into the damped position — otherwise it feeds into the next frame's target and
cancels itself.

### Post-processing

`RenderPass → UnrealBloomPass → vignette/grain/aberration/grade`. The composer
target is sRGB-encoded, so bloom thresholds work on display values.

The final pass carries a grade: an S-curve, a small saturation lift, and a
cool-shadow / warm-highlight split-tone. The raw render is a bright, evenly lit
courtyard, which comes out flat and milky without one.

Bloom sits at `0.78 / 0.58 / 0.88`. The threshold has to clear the pale sky and
the water horizon, or the whole skyline glares.

Press `P` to toggle the whole chain; a CSS vignette stands in when it is off.

### Combat feel

- **Hit-stop** scales with the blow but stays inside a 50–80 ms band; 35 ms on a
  block.
- **Camera shake** decays to nothing in about 0.2s.
- **Two-stage damage flash**: the first couple of rendered frames blow the body
  out to emissive white, which bloom turns into a hard pop, then it falls back to
  a decaying red tint. It is not re-applied during hit-stop, so the white frame
  holds for the freeze.
- **Hit sparks** burst from the actual overlap of hitbox and hurtbox, not from a
  guessed midpoint.
- **Combo strings** survive while hits keep landing inside a 1.15s window. The
  counter only appears from the second hit.
- **Drawn impact art.** Everything above is timing; until recently nothing was
  actually *struck* on screen but a pair of expanding rings. A flipbook now
  plays at the contact point — a 30-frame sheet for a heavy, a flatter 24-frame
  one for a light or a guard — billboarded to the camera and rolled to a random
  angle so repeated hits never stamp the same picture twice.
- **Squash and stretch.** Fighters used to be rigid volumes that changed height
  only by bending at the hip, so a jump read as a lift and a landing read as a
  stop. They now stretch on the way up and compress on touchdown in proportion
  to how hard they land. The scale rides on the body group and the loaded model,
  never on the root, so footing and world position are untouched.
- **Directional stagger.** A blow leans the victim away from where it came
  from, rather than straight back regardless of which side it landed on.

### Robustness

A zero-area canvas is a real state, not a theoretical one — a hidden panel, a
collapsed container, a tab restored in the background. Pushing it into `setSize`
leaves every framebuffer with a zero-size attachment, which WebGL complains about
on every single draw call until it gives up reporting. Sizing is skipped while
there is no area and re-applied the moment there is.

**Deferred callbacks carry a match epoch.** The round-end callout schedules work
2.4 seconds out, and that timer only checked "are we in a fight?". Leave a match
mid-callout and start another inside those 2.4s and it fired into the *new*
match — bumping its round counter and resetting both fighters mid-round.
`match.epoch` increments on every start and every exit, and each deferred
callback bails if it no longer matches.

**The AudioContext starts on a pointer too.** It used to be created only from
`keydown`, so anyone who picked a fighter with the mouse and clicked START
played the whole match in silence: every sound call was a no-op because the
context had never existed. A click is a valid user gesture and now creates it.

---

## Tuning reference

Everything below lives in named constants near the top of the script.

Frame data is authored in **seconds**, not frames, so it holds at any refresh
rate. Frame counts below are the 60 Hz equivalent, rounded.

| | |
|---|---|
| Rounds to win | 2, five rounds maximum, 99-second clock |
| Difficulty | CPU damage x0.72 easy / x1.0 normal / x1.15 hard |
| Light (`PUNCH`) | 0.09s startup / 0.07 active / 0.15 recovery — about 5 / 4 / 9 f, 7 damage |
| Heavy (`KICK` or `SLASH`) | 0.15 / 0.10 / 0.29 — about 9 / 6 / 17 f, 12 damage |
| Dash | 15.5 u/s for 0.17s, 0.42s cooldown, 0.26s tap window |
| Meter | assist 50, overdrive 100, 6s assist lockout, 8s overdrive |
| Hit-stop | 50–80 ms, 35 ms blocked |
| Bloom | strength 0.78, radius 0.58, threshold 0.88 |
| Camera | fov 38 fighting / 45 on select, z 7.6–19.5 |
| Clip rejection | anything under 0.12s |

---

## Debugging a running match

Everything lives in an IIFE, which is right for a shipped page but leaves no way
to inspect a live fight. `window.__ASH` exposes a read-only view:

```js
__ASH.snapshot()             // phase, round, clock, camera, both fighters
__ASH.p1 / .p2 / .match      // live objects
__ASH.press("KeyJ")          // synthesise a keydown; pass true for keyup

__ASH.clips                  // manifest + added / rejected / missing counts
__ASH.bonesOf(__ASH.p1.model)   // every bone and what it normalises to
__ASH.normBone("upperarm_r")    // -> "rightupperarm"
__ASH.retarget(model, clip)     // returns the remapped clip, or null if it
                                // matches too little of this skeleton
```

If a bought clip does nothing, `__ASH.retarget` is the place to look: a `null`
means its track names do not correspond to this model's bones, and
`__ASH.bonesOf` shows what they would have to be.

Press `H` for the on-screen dev panel (frame data, camera rail, live hitboxes,
particle count, asset status) and `B` for the hitbox overlay — hurtboxes in
green, hitboxes in red while they are live.

---

## Known gaps

- **`p1.fbx` and `s1.fbx` are missing.** Cinderward falls through to `p1.glb`;
  the Emberwraith borrows the other summon's mesh. Both work, neither is what
  you intended.
- **The authored cast still has no animation of its own.** It does not need
  any now — the shared library drives all eight states on every fighter — but
  the motion is generic where it could be characterful. Cinderward and Pale
  Vigil swing the same two sword clips as each other with different names.
  Dropping real per-character clips into `clips.json` still overrides the
  library slot by slot.
- **Retargeting is rotation-only.** Proportion differences are absorbed by the
  target rig's own bone lengths, which is the point, but anything that depended
  on hip translation is lost — a death animation folds rather than falls, and
  the crouch before a jump is flatter than authored.
- **`P3.fbx` is 116 MB** for textures the renderer mostly discards. See
  [above](#p3fbx-is-116-mb).
- **Air blocking is not implemented** — blocking is grounded only. That matches
  most of the genre, so it is a design choice rather than an omission, but it
  is worth knowing before you complain about a jump-in.
- **The bot does not learn.** It picks from weighted random behaviour, so it
  will never adapt to a habit you repeat.
- **The select portraits are only as distinct as the models are.** Each card is
  a real render of the fighter it names, shot once into a render target. On the
  CLASSIC and COMPACT casts that is four different bodies; on AUTHORED, with
  `p1.fbx` absent and one mesh standing in for another, several cards are the
  same body in four accent colours. Supplying the missing models fixes them for
  free; no portrait code is involved.
- **The six themes re-light the stage, not the character textures.** A model's
  own albedo is baked, so Cinderward reads warm under every theme. The
  environment probe, the fog and the grade do the rest of the work, which is
  enough at a glance and not the same as a real per-theme lighting pass.

---

## Animation

### Where the movement comes from

Nothing in the authored cast animates. The FBX files carry a stub clip or two
and nothing usable, which is why the fighters used to stand in bind pose while
only the group under them moved — the thing that read as "standing still with
no movements".

The fix is a **shared animation library**: one set of clips authored against
one skeleton, retargeted onto every character at load. `assets/anim/` holds
three KayKit sets (general, basic movement, melee combat — CC0, see
[CREDITS.md](CREDITS.md)), and `ANIM_LIB` near the top of the clip code maps
them onto the state machine:

```js
common: { IDLE: "Melee_Unarmed_Idle", WALK: "Walking_A", JUMP: "Jump_Idle",
          PUNCH: "Melee_Unarmed_Attack_Punch_A", KICK: "Melee_Unarmed_Attack_Kick",
          BLOCK: "Melee_Blocking", HITSTUN: "Hit_A", KO: "Death_A" }
```

`perId` overrides that per fighter, so the two armed ones swing the sword they
are actually holding (`Melee_1H_Attack_Stab`, `..._Slice_Diagonal`) and the two
unarmed ones keep hands and feet.

Four files, about 3 MB, drive all six characters. A new fighter costs a mesh,
not a move set.

### Whose clip wins

Per slot, not all-or-nothing:

- **IDLE, WALK, JUMP** — the model's own clip wins if it has one. A character's
  idle is a large part of what makes it read as that character.
- **PUNCH, KICK, BLOCK, HITSTUN, KO** — the library always wins. A model
  exported for something other than a fighting game brings a wave and a shrug,
  and the gap-filler deals those into PUNCH and BLOCK because something has to
  go there. `ANIM_LIB.force` is that list.
- Anything still empty falls through to the procedural bone driver, exactly as
  before.

### Retargeting

Two rigs can agree on every joint and still share no names. Mixamo calls the
upper arm `Arm` and the shin `Leg`; the animation rig calls the same two
`upperarm` and `lowerleg`. `BONE_ALIAS` collapses those disagreements after
`normBone` has already normalised prefix (`mixamorig`, `mixamorig1`, `DEF-`),
separator and which side of the name carries `L`/`R`.

Names are the easy half. The hard half is that **a rotation track is not a
pose — it is a pose relative to where the bone rests**. Copying tracks across
by name alone put every fighter flat on their back, because the animation rig
is authored Z-up and the Mixamo rig Y-up, and the hip rotation carried that
difference with it. Each key is therefore taken out of the source bone's rest
frame and put into the target's:

```
Qt = Rt · Rs⁻¹ · Qs
```

which needs both bind poses, so `captureRest()` records the target's the moment
a model lands and before a single frame has posed it. Position and scale tracks
are dropped outright: a skeletal pose is fully described by rotation plus the
target rig's own bone lengths, and copying translations authored in another
rig's units is how you get a fighter whose hips are behind their head.

Press `H` — the **MODELS** row reports `+N lib` for clips bound this way.

### Three casts

| | Files | Size | Animation |
|---|---|---|---|
| **CLASSIC** *(default)* | `x1–x4.glb` | ~8.8 MB | library, retargeted + native |
| **AUTHORED** | `p1.glb`, `P2–P4.fbx`, `S2.fbx` | ~146 MB | library, retargeted |
| **COMPACT** | `k1–k4.glb`, `ks1–ks2.glb` | ~2.3 MB | library, native rig |

The CLASSIC cast is four rigged characters from the three.js example set —
Xbot, Michelle, RobotExpressive and Soldier. It is the default because it is
the best trade in the table: recognisable human proportions at under nine
megabytes, and every one of the four binds all eight animation states with no
stand-ins. Three are Mixamo exports the library retargets onto directly; the
robot is a rig belonging to neither family and clears the threshold anyway,
while carrying its own `Idle` / `Walking` / `Jump` / `Punch` / `Death` behind
that as a fallback.

The COMPACT cast is KayKit's Adventurers, rigged to the same skeleton the
library was authored on. Switch with the **CAST** buttons on the select screen
or `?cast=classic` / `?cast=compact`; the choice is remembered and the page
reloads, because it changes which files are fetched.

COMPACT exists for three reasons: it is the honest answer to a 146 MB download,
it is proof the retargeting is doing real work (the same clips drive all three
casts), and it is the guaranteed-animated fallback if an authored file goes
missing.

Each cast declares its own `fit` height. Normalising every model to one total
height is right for realistic proportions and wrong for a four-heads-tall
chibi — matching the totals makes the head enormous.

Every CLASSIC file also carries its upstream three.js URL as a last-resort
candidate, after the local copy and after every filename spelling. A checkout
with no `assets/` folder still fills its roster; a release still never depends
on GitHub being up.
