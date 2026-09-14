import * as THREE from 'three/webgpu';
import { BLOCK_BLUE, HIT_RED, PLANE_Z, S } from '../config/constants';
import { driveMixer, playAction } from '../anim/animation';
import { SELECT_CAM } from '../camera/camera-rig';
import { clamp, damp } from '../core/math';
import { Burst } from '../fx/particles';
import { ageSwingRibbon, pushSwingRibbon } from '../fx/ribbon';
import { legacyIntensity } from '../render/lights';
import { arena } from '../world/arena';
import type { Assist } from './assist-rig';
import type { Fighter } from './fighter';
import { attackExtension, attackPhase, kickingLeg, limbFor, slashing } from './fsm';
import { assistRigs, rigs } from './rigs';
import { state } from './state';

/*
  Posing the primitive rig from the state machine.

  This runs on every presentation frame, not every simulation step: it is
  what the fighter looks like, not what the fighter is. The hitboxes it moves
  are re-synced from it before collision runs.
*/

const _tp = new THREE.Vector3();

/*
  Squash on the landing frame, stretch on the way up. Twelve per cent for a
  sixth of a second is the whole difference between a jump that reads as a
  lift and one that reads as a leap. The scale rides on the body and the
  loaded model, never the root, so footing and world position are untouched.
*/
function applySquash(f: Fighter, dt: number): void {
  if (f.land > 0) f.land = Math.max(0, f.land - dt * 6.2);
  const sq = f.land * 0.155;
  const air = f.grounded ? 0 : clamp(-f.vy / 26, -0.06, 0.085);
  const sy = 1 - sq + air;
  const sx = 1 + sq * 0.68 - air * 0.55;
  f.body.scale.set(sx, sy, sx);
  if (f.model && f.modelFit) f.model.scale.set(f.modelFit * sx, f.modelFit * sy, f.modelFit * sx);
}

export function poseFighter(f: Fighter, dt: number, t: number): void {
  const b = f.body;
  applySquash(f, dt);
  f.root.position.set(f.x, f.y, PLANE_Z);
  f.root.rotation.y = damp(f.root.rotation.y, f.face * Math.PI / 2, 12, dt);

  const speed = Math.abs(f.vx) / f.def.speed;
  const idle = t * 2.1 + f.phase;
  const stride = t * 10.5 + f.phase;
  /* An armed fighter's heavy is a SLASH and the blade hangs off the lead fist,
     so it is driven from the arm. Only unarmed heavies are kicks. */
  const punching = f.state === S.PUNCH;
  const slash = slashing(f);
  const kicking = kickingLeg(f);
  const swinging = punching || slash;
  const ext = f.state === S.PUNCH || f.state === S.KICK ? attackExtension(f) : 0;

  const au = f.powered ? 1 : 0;
  f.aura.visible = f.powered;
  f.aura.material.opacity = au * (0.22 + Math.sin(t * 18) * 0.07);
  f.aura.scale.set(1 + Math.sin(t * 12) * 0.05, 1.55 + Math.sin(t * 9) * 0.08, 1);

  const sway = -f.vx * 0.10 + Math.sin(t * 3.1 + f.phase) * 0.18;
  f.ribbons[0]!.rotation.x = sway - 0.25;
  f.ribbons[1]!.rotation.x = sway * 0.8 - 0.2;
  f.tail.rotation.x = -0.7 - f.vx * 0.06 + Math.sin(t * 2.6) * 0.12;
  f.skirt.rotation.z = -f.vx * 0.02;

  if (f.powered) {
    f.powerLight.distance = 11;
    f.powerLight.intensity = legacyIntensity(3.1 + Math.sin(t * 16) * 1.0);
    f.trail.push(f.x, f.y, PLANE_Z);
  }
  f.trail.fade(dt);

  if (f.state === S.KO) {
    b.rotation.x = damp(b.rotation.x, -1.15, 5, dt);
    b.rotation.z = damp(b.rotation.z, 0.22, 5, dt);
    b.position.y = damp(b.position.y, -0.9, 4, dt);
    (f.blob.material as THREE.MeshBasicMaterial).opacity = 0.3;
    applyFlash(f);
    f.swingTrail.fade(dt);
    ageSwingRibbon(f, dt);
    return;
  }

  const recoil = f.state === S.HITSTUN ? 1 : 0;
  const guard = f.state === S.BLOCK ? 1 : 0;

  b.position.y = -0.13 + Math.sin(idle) * 0.05 + Math.abs(Math.sin(stride)) * 0.10 * speed;
  // a blow knocks them sideways as well as back, away from where it came from
  b.rotation.z = damp(b.rotation.z, -f.vx * 0.028 + recoil * f.hitDir * 0.24, 14, dt);
  b.rotation.x = damp(
    b.rotation.x,
    guard * 0.16 + recoil * 0.34 - (kicking ? ext * 0.20 : 0) + (slash ? clamp(ext, 0, 1) * 0.26 : 0),
    16, dt,
  );
  // hips lead the strike, which is what sells a punch
  f.torso.rotation.y = 0.30 + Math.sin(idle * 0.8) * 0.06 + f.vx * 0.02
    - (punching ? ext * 0.85 : 0) - (kicking ? ext * 0.45 : 0)
    - (slash ? clamp(ext, 0, 1) * 0.70 - clamp(-ext / 0.22, 0, 1) * 0.35 : 0);
  f.neck.rotation.x = Math.sin(idle * 1.1) * 0.05 - 0.06 + recoil * 0.30;

  const swing = Math.sin(stride) * 0.85 * speed;
  const air = f.grounded ? 0 : 0.55;

  if (kicking) {
    // chamber, then extend: the knee comes up with the shin folded under it
    const kdraw = clamp(-ext / 0.22, 0, 1);
    const kreach = clamp(ext, 0, 1);
    f.legF.hip.rotation.x = -0.15 - Math.max(kdraw * 0.75, kreach) * 1.55;
    f.legF.knee.rotation.x = 1.35 - kdraw * 0.20 - kreach * 1.45;
    f.legB.hip.rotation.x = damp(f.legB.hip.rotation.x, 0.22 + kreach * 0.14, 18, dt);
    f.legB.knee.rotation.x = damp(f.legB.knee.rotation.x, 0.30 + kreach * 0.16, 18, dt);
  } else {
    // wide horse stance: front leg forward, back leg braced and bent
    f.legF.hip.rotation.x = damp(f.legF.hip.rotation.x, -0.30 + swing + air * 0.7 + guard * 0.10, 18, dt);
    f.legB.hip.rotation.x = damp(f.legB.hip.rotation.x, 0.34 - swing + air * 0.3 - guard * 0.10, 18, dt);
    f.legF.knee.rotation.x = damp(f.legF.knee.rotation.x, 0.30 + Math.max(0, -swing) * 0.9 + air * 0.9, 18, dt);
    f.legB.knee.rotation.x = damp(f.legB.knee.rotation.x, 0.46 + Math.max(0, swing) * 0.9 + air * 0.5, 18, dt);
  }

  if (punching) {
    f.armF.shoulder.rotation.x = -0.62 - ext * 1.05;
    f.armF.elbow.rotation.x = -1.32 + ext * 1.30;
    f.armF.shoulder.rotation.z = -0.30 + ext * 0.26;
    f.armB.shoulder.rotation.x = -0.50 + ext * 0.55;   // the rear arm counter-pulls
    f.armB.elbow.rotation.x = -1.55 - ext * 0.30;
  } else if (slash) {
    /* Overhead diagonal cut: drawn up and back behind the shoulder on the
       wind-up, then swept down and through. The arm stays straight through
       the cut so the blade tip — which carries the hitbox — travels a real arc. */
    const draw = clamp(-ext / 0.22, 0, 1);
    const cut = clamp(ext, 0, 1);
    f.armF.shoulder.rotation.x = -2.55 - draw * 0.55 + cut * 3.05;
    f.armF.elbow.rotation.x = -0.85 + draw * -0.35 + cut * 0.80;
    f.armF.shoulder.rotation.z = -0.55 - draw * 0.25 + cut * 0.70;
    f.armB.shoulder.rotation.x = -0.40 - draw * 0.35 + cut * 0.75;
    f.armB.elbow.rotation.x = -1.50;
  } else {
    f.armF.shoulder.rotation.x = damp(f.armF.shoulder.rotation.x, -0.72 + guard * -0.34 + recoil * 0.34, 20, dt);
    f.armF.elbow.rotation.x = damp(f.armF.elbow.rotation.x, -1.38 + Math.sin(idle) * 0.05 + guard * -0.44, 20, dt);
    f.armF.shoulder.rotation.z = damp(f.armF.shoulder.rotation.z, -0.34 - guard * 0.20, 18, dt);
  }
  if (!swinging) {
    f.armB.shoulder.rotation.x = damp(f.armB.shoulder.rotation.x, -0.52 + Math.sin(idle + 1) * 0.06 - swing * 0.3 + recoil * 0.34, 16, dt);
    f.armB.elbow.rotation.x = damp(f.armB.elbow.rotation.x, -1.62 + guard * -0.36, 16, dt);
  }
  f.armB.shoulder.rotation.z = damp(f.armB.shoulder.rotation.z, 0.24 + guard * 0.18 - (slash ? clamp(ext, 0, 1) * 0.30 : 0), 16, dt);

  f.cape.rotation.x = damp(f.cape.rotation.x, -0.14 - f.vx * 0.05, 8, dt);
  f.blob.scale.setScalar(clamp(1 - f.y * 0.16, 0.42, 1));
  (f.blob.material as THREE.MeshBasicMaterial).opacity = clamp(0.42 - f.y * 0.06, 0.1, 0.42);

  applyFlash(f);
  strikeTrail(f, dt, t);
}

/* A ribbon streaming off whichever limb is mid-swing, plus dust as the feet
   land — the small motion cues that stop a walk cycle reading flat. */
function strikeTrail(f: Fighter, dt: number, t: number): void {
  const phase = f.state === S.PUNCH || f.state === S.KICK ? attackPhase(f) : null;
  if ((phase === 'startup' || phase === 'active') && f.move) {
    f.hitboxes[limbFor(f, f.move)].anchor.getWorldPosition(_tp);
    f.swingTrail.push(_tp.x, _tp.y - 0.6, _tp.z);
    pushSwingRibbon(f, limbFor(f, f.move));
    if (phase === 'active' && Math.random() < 0.45) Burst.emit(_tp, f.def.accent, 1, 2.2, 0.2);
  }
  f.swingTrail.fade(dt);
  ageSwingRibbon(f, dt);

  // footfall dust, gated so it fires once per step rather than every frame
  if (f.grounded && Math.abs(f.vx) > 1.6) {
    const beat = Math.sin(t * 10.5 + f.phase);
    if (beat > 0.94 && f.stepGate !== 1) {
      f.stepGate = 1;
      Burst.emit(_tp.set(f.x - f.face * 0.25, 0.12, PLANE_Z), 0xC9BCA2, 5, 1.7, 0.5);
    } else if (beat < 0.5) {
      f.stepGate = 0;
    }
  }
}

/*
  Two-stage damage flash. The first couple of rendered frames blow the body
  out to emissive white — which bloom turns into a hard pop — then it falls
  back to a decaying red tint. Not called during hit-stop, so the white frame
  holds for the whole freeze.
*/
export function applyFlash(f: Fighter): void {
  const hit = f.flash;
  const blk = f.blockFlash;

  if (f.white > 0) {
    for (const m of f.skin) {
      m.color.setRGB(1, 0.93, 0.90);
      m.emissive.setRGB(1, 0.72, 0.62);
      m.emissiveIntensity = 0.55;
    }
    flashModel(f, 1, HIT_RED, true, 0);
    f.glow.emissiveIntensity = 3.2;
    f.white -= 1;
    return;
  }

  for (const m of f.skin) {
    m.emissiveIntensity = 1;
    m.color.copy(m.userData.base as THREE.Color);
    if (hit > 0) m.color.lerp(HIT_RED, hit * 0.9);
    else if (blk > 0) m.color.lerp(BLOCK_BLUE, blk * 0.45);
    m.emissive.copy(hit > 0 ? HIT_RED : BLOCK_BLUE).multiplyScalar(hit > 0 ? hit * 0.7 : blk * 0.35);
  }
  flashModel(f, hit > 0 ? hit : 0, hit > 0 ? HIT_RED : BLOCK_BLUE, false, blk);
  f.glow.emissiveIntensity = 1.15 + hit * 4.0 + (f.powered ? 2.0 : 0);
}

/* The damage flash used to live only on the primitive rig's materials — hidden
   the moment a model loads, so a hit on a loaded fighter registered nothing on
   the body. The model's materials are driven from the same two counters. */
function flashModel(f: Fighter, hit: number, colour: THREE.Color, blown: boolean, blk: number): void {
  const list = f.modelMats;
  if (!list || list.length === 0) return;
  for (const m of list) {
    if (blown) {
      m.color.setRGB(1, 0.94, 0.90);
      m.emissive.setRGB(1, 0.74, 0.64);
      continue;
    }
    m.color.copy(m.userData.baseColor as THREE.Color);
    if (hit > 0) m.color.lerp(HIT_RED, hit * 0.75);
    else if (blk > 0) m.color.lerp(BLOCK_BLUE, blk * 0.4);
    m.emissive.copy(m.userData.baseEmissive as THREE.Color);
    if (hit > 0) m.emissive.lerp(colour, hit * 0.85);
    else if (blk > 0) m.emissive.lerp(BLOCK_BLUE, blk * 0.5);
    if (f.powered) m.emissive.addScalar(0.12);
  }
}

/* ── select-screen preview posing ─────────────────────────────────────── */

function posePreviewFighter(f: Fighter, x: number, dt: number, t: number, slotIdx: number): void {
  f.root.visible = true;
  f.land = 0;
  applySquash(f, dt);                  // resets to identity on the pedestal
  f.root.position.set(x, 0, 0.2);
  // a three-quarter angle turned toward the opponent
  const face = slotIdx === 0 ? 0.62 : -0.62;
  f.root.rotation.y = face + Math.sin(t * 0.55 + slotIdx * 1.7) * 0.10;
  f.powerLight.distance = 5.0;         // hug the model, do not flood the floor
  f.powerLight.intensity = legacyIntensity(0.85 + Math.sin(t * 2.4 + slotIdx) * 0.2);

  const idle = t * 1.9 + f.phase;
  f.body.position.y = Math.sin(idle) * 0.05;
  f.body.rotation.set(0, 0, 0);
  f.torso.rotation.y = Math.sin(idle * 0.7) * 0.1;
  f.neck.rotation.x = Math.sin(idle * 1.1) * 0.06 - 0.05;
  f.armF.shoulder.rotation.x = damp(f.armF.shoulder.rotation.x, -0.42 + Math.sin(idle) * 0.05, 8, dt);
  f.armF.elbow.rotation.x = damp(f.armF.elbow.rotation.x, -0.95, 8, dt);
  f.armF.shoulder.rotation.z = damp(f.armF.shoulder.rotation.z, -0.18, 8, dt);
  f.armB.shoulder.rotation.x = damp(f.armB.shoulder.rotation.x, -0.36 + Math.sin(idle + 1) * 0.05, 8, dt);
  f.armB.elbow.rotation.x = damp(f.armB.elbow.rotation.x, -1.05, 8, dt);
  f.armB.shoulder.rotation.z = damp(f.armB.shoulder.rotation.z, 0.2, 8, dt);
  f.legF.hip.rotation.x = damp(f.legF.hip.rotation.x, 0.12, 8, dt);
  f.legB.hip.rotation.x = damp(f.legB.hip.rotation.x, -0.12, 8, dt);
  f.legF.knee.rotation.x = damp(f.legF.knee.rotation.x, 0.06, 8, dt);
  f.legB.knee.rotation.x = damp(f.legB.knee.rotation.x, 0.06, 8, dt);
  f.cape.rotation.x = damp(f.cape.rotation.x, -0.16, 6, dt);
  (f.blob.material as THREE.MeshBasicMaterial).opacity = 0.34;
  applyFlash(f);
}

function posePreviewAssist(a: Assist, x: number, dt: number, t: number, slotIdx: number): void {
  a.group.visible = true;
  // a loaded humanoid stands; only the primitive spirit builds hover
  const hover = a.model ? 0.10 : a.def.build === 'idol' ? 1.35 : 0.8;
  a.group.position.set(x, hover + Math.sin(t * 1.6 + slotIdx) * (a.model ? 0.05 : 0.14), -6.5);
  a.group.rotation.y = Math.sin(t * 0.42 + slotIdx) * 0.9;
  a.group.rotation.z = 0;
  a.group.scale.setScalar(0.8);
  a.parts.lamp.position.set(x, 1.9, -6.5);
  a.parts.lamp.intensity = legacyIntensity(2.6);
  a.parts.core.rotation.y += dt * 3;
  a.parts.core.scale.setScalar(1 + Math.sin(t * 10) * 0.12);
}

export function stageSelectPreview(dt: number, t: number): void {
  for (const s of [0, 1] as const) {
    for (const r of rigs[s]) r.root.visible = false;
    for (const a of assistRigs[s]) {
      a.group.visible = false;
      a.group.scale.setScalar(1);
    }
  }
  arena.plinths[0]!.visible = arena.plinths[1]!.visible = true;

  const sel = state.sel;
  const pv0 = rigs[0][sel[0].fighter]!;
  const pv1 = rigs[1][sel[1].fighter]!;
  /* A 40° lens at z 4.2 is 1.53 units of half-width at the fighter plane. The
     previews stood at ±2.3 for the old wide framing and fall clean outside this
     one, so the portrait framing moves them in. */
  const px = SELECT_CAM.portrait ? 1.05 : 2.3;
  posePreviewFighter(pv0, -px, dt, t, 0);
  posePreviewFighter(pv1, px, dt, t, 1);
  driveMixer(pv0, dt, t);
  driveMixer(pv1, dt, t);

  const av0 = assistRigs[0][sel[0].assist]!;
  const av1 = assistRigs[1][sel[1].assist]!;
  if (av0.mixer) { playAction(av0, 'IDLE'); av0.mixer.update(dt); }
  if (av1.mixer) { playAction(av1, 'IDLE'); av1.mixer.update(dt); }
  // a waist-up portrait framing cannot hold the summons at ±5.7, so they stay
  // hidden rather than being animated off-camera
  if (!SELECT_CAM.portrait) {
    posePreviewAssist(av0, -5.7, dt, t, 0);
    posePreviewAssist(av1, 5.7, dt, t, 1);
  }
}
