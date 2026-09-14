import * as THREE from 'three/webgpu';
import { Easing, Group, Tween } from '@tweenjs/tween.js';
import { A, MOVES, PLANE_Z, RIG, S, SHAKE } from '../config/constants';
import { clamp, damp } from '../core/math';
import { REDUCED_MOTION } from '../core/platform';
import { Spring } from '../core/spring';
import type { Fighter } from '../game/fighter';
import { attackPhase } from '../game/fsm';
import { match } from '../game/match';
import { state } from '../game/state';
import { ambLight, camera, hemiLight, key, LIGHTS } from '../render/stage';
import { settings } from '../ui/settings';

/*
  The camera rig.

  A fighting game wants a side-on tracking camera, not a first-person or free
  orbit one: both players have to read the same space, and the camera's job is
  to keep both fighters framed, lean into the action and get out of the way.
  So: one pursuit per phase (title drift, select portrait, fight dolly) plus
  the one authored move, the PLAY tween.

  The fight camera runs on critically damped springs, frames the pair from the
  viewport's real aspect ratio, leads slightly in the direction the fight is
  moving, and shakes along smooth noise instead of white noise.

  Runs on presentation frames with the real frame delta. It only reads
  fighter state, and a camera advanced in 8 ms steps would stutter against a
  variable refresh rate.
*/

export const rigState = { mid: 0, sep: 0, z: RIG.zBase as number, look: new THREE.Vector3(0, 2.2, PLANE_Z) };
const rigBase = new THREE.Vector3(0, 3.6, 11.4);
const shakeOff = new THREE.Vector3();

/* Waist-up on the select screen, full body in the fight. At z 4.2 with a 40°
   lens the frustum is 1.53 units either side of centre at the fighter plane,
   which is why the previews stand closer in and the summons are not posed. */
export const SELECT_CAM = { y: 1.40, z: 4.2, lookY: 1.95, fov: 40, portrait: true } as const;

/* Further back, higher and wider than the select screen, and drifting. */
const TITLE_CAM = { y: 4.0, z: 12.0, lookY: 2.9, fov: 54 } as const;
const FIGHT_FOV = 38;
/** Widest the fight lens may open on a narrow screen before distortion costs more than it frames. */
const FIGHT_FOV_MAX = 58;
/** Screens at least this wide keep the authored 38° lens. */
const WIDE_ASPECT = 4 / 3;

/*
  Narrower than 4:3 (a phone held upright), pulling the camera back alone
  shrinks the fighters to specks and still ran out of room at the dolly's
  limit. The lens widens first to keep the horizontal view a 4:3 screen
  gets, up to FIGHT_FOV_MAX; the dolly covers whatever is left.
*/
function fightFov(): number {
  if (camera.aspect >= WIDE_ASPECT) return FIGHT_FOV;
  const half = THREE.MathUtils.degToRad(FIGHT_FOV) / 2;
  const hRef = 2 * Math.atan(Math.tan(half) * WIDE_ASPECT);
  const need = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hRef / 2) / camera.aspect));
  return Math.min(FIGHT_FOV_MAX, need);
}

const FRAMING = {
  /** Space kept beyond each fighter's root, so a full extension or a knockback stays in frame. */
  margin: 2.4,
  /** Hard ceiling on pull-back, reached only on very narrow (portrait phone) screens. */
  zMaxFit: 40,
  /** Seconds of the pair's average velocity the camera leads by. */
  lead: 0.2,
  smoothX: 0.16,
  smoothY: 0.24,
  smoothZ: 0.30,
  smoothLook: 0.12,
} as const;

const springs = {
  x: new Spring(), y: new Spring(), z: new Spring(), lookX: new Spring(), lookY: new Spring(),
};

function resetSprings(): void {
  for (const s of Object.values(springs)) s.reset();
}

function dampFov(target: number, dt: number): void {
  const next = damp(camera.fov, target, 4.0, dt);
  if (Math.abs(next - camera.fov) > 0.002) {
    camera.fov = next;
    camera.updateProjectionMatrix();
  }
}

function dampLights(amb: number, hemi: number, keyI: number, dt: number): void {
  ambLight.intensity = damp(ambLight.intensity, amb, 3, dt);
  hemiLight.intensity = damp(hemiLight.intensity, hemi, 3, dt);
  key.intensity = damp(key.intensity, keyI, 3, dt);
}

/* ── the PLAY transition ────────────────────────────────────────────────
   Every other move is a pursuit of a moving target. This one has a known
   start, a known end and a chosen duration, so it is authored as a tween. The
   tween owns rigBase while it runs, and the select damping stands down.

   PLAY does not start the clock — it asks for it. The first SELECT frame
   builds the pedestal preview and re-shoots the portraits, so the request is
   queued and the clock starts at the end of that expensive frame. */
const tweens = new Group();
let camTween: Tween<CamPose> | null = null;
let camTweenPending = false;
const CAM_TWEEN_MS = 1500;

interface CamPose { x: number; y: number; z: number; fov: number; lookY: number; lookX: number }

export function stopCamTween(): void {
  camTweenPending = false;
  if (camTween) {
    camTween.stop();
    tweens.remove(camTween);
    camTween = null;
  }
}

export function requestCamTween(): void {
  camTweenPending = true;
}

function startCamTween(): void {
  stopCamTween();
  if (REDUCED_MOTION) return;                      // damping carries the move instead

  const from: CamPose = { x: rigBase.x, y: rigBase.y, z: rigBase.z, fov: camera.fov, lookY: rigState.look.y, lookX: rigState.look.x };
  const to: CamPose = { x: 0, y: SELECT_CAM.y, z: SELECT_CAM.z, fov: SELECT_CAM.fov, lookY: SELECT_CAM.lookY, lookX: 0 };

  const tween = new Tween(from, tweens)
    .to(to, CAM_TWEEN_MS)
    .easing(Easing.Quadratic.InOut)
    .onUpdate(() => {
      rigBase.set(from.x, from.y, from.z);
      rigState.look.x = from.lookX;
      rigState.look.y = from.lookY;
      if (camera.fov !== from.fov) {
        camera.fov = from.fov;
        camera.updateProjectionMatrix();
      }
    })
    .onComplete(() => {
      tweens.remove(tween);
      camTween = null;
    })
    .start();
  camTween = tween;
}

export function updateCamTweens(): void {
  if (camTween) tweens.update();
}

/** End of the first SELECT frame: start the queued PLAY move now that the expensive frame is behind us. */
export function flushCamTween(): void {
  if (!camTweenPending) return;
  camTweenPending = false;
  startCamTween();
}

function aimKeyAt(x: number, y: number, z: number, tx: number, ty: number): void {
  key.position.set(x, y, z);
  key.target.position.set(tx, ty, PLANE_Z);
  key.target.updateMatrixWorld();
}

export function updateCameraTitle(dt: number, t: number): void {
  resetSprings();
  dampLights(LIGHTS.ambSelect, LIGHTS.hemiSelect, LIGHTS.keySelect, dt);

  const drift = Math.sin(t * 0.12) * 1.5;
  rigBase.x = damp(rigBase.x, drift, 1.2, dt);
  rigBase.y = damp(rigBase.y, TITLE_CAM.y + Math.sin(t * 0.19) * 0.16, 1.6, dt);
  rigBase.z = damp(rigBase.z, TITLE_CAM.z, 1.6, dt);
  rigState.look.x = damp(rigState.look.x, drift * 0.35, 1.2, dt);
  rigState.look.y = damp(rigState.look.y, TITLE_CAM.lookY, 1.6, dt);
  dampFov(TITLE_CAM.fov, dt);

  camera.position.copy(rigBase);
  camera.lookAt(rigState.look);
  aimKeyAt(9, 12, 11, 0, 1.6);
}

export function updateCameraSelect(dt: number): void {
  resetSprings();                                   // the fight camera starts from rest, not from last match's velocity
  dampLights(LIGHTS.ambSelect, LIGHTS.hemiSelect, LIGHTS.keySelect, dt);
  if (!camTween && !camTweenPending) {
    rigBase.x = damp(rigBase.x, 0, 3.0, dt);
    rigBase.y = damp(rigBase.y, SELECT_CAM.y, 3.0, dt);
    rigBase.z = damp(rigBase.z, SELECT_CAM.z, 3.0, dt);
    rigState.look.x = damp(rigState.look.x, 0, 3.0, dt);
    rigState.look.y = damp(rigState.look.y, SELECT_CAM.lookY, 3.0, dt);
    dampFov(SELECT_CAM.fov, dt);
  }
  camera.position.copy(rigBase);
  camera.lookAt(rigState.look);
  aimKeyAt(9, 12, 11, 0, 1.6);
}

/* Dynamic attack camera: leans in as a blow winds up, snaps closer on contact,
   drifts toward whoever is swinging, and pushes in while a summon is on stage.
   Held in its own accumulator so it never fights the framing. */
const assistOnStage = (f: Fighter): boolean => !!f.assist && f.assist.state !== A.DORMANT;

let camPush = 0;
let camBias = 0;
let camRoll = 0;
let leadX = 0;
let shakeClock = 0;

function attackCamera(dt: number): void {
  let want = 0;
  let bias = 0;
  for (const f of state.fighters) {
    if (f.state !== S.PUNCH && f.state !== S.KICK) continue;
    const ph = attackPhase(f);
    const heavy = f.move === MOVES.KICK ? 1.6 : 1.0;
    if (ph === 'startup') want = Math.max(want, 0.30 * heavy);
    else if (ph === 'active') want = Math.max(want, 0.62 * heavy);
    else want = Math.max(want, 0.18 * heavy);
    bias += f.face * 0.35 * heavy;
  }
  const { P1, P2 } = state;
  if (P1.powered || P2.powered) want = Math.max(want, 0.35);
  if (assistOnStage(P1) || assistOnStage(P2)) want = Math.max(want, 0.62);

  camPush = damp(camPush, want, want > camPush ? 14 : 3.5, dt);  // push in fast, ease back out
  camBias = damp(camBias, bias, 6, dt);
  camRoll = damp(camRoll, bias * 0.012, 5, dt);
}

/*
  Distance from the fighter plane at which a half-width of `halfWidth` fits
  the viewport horizontally. The dolly used to be a fixed line in fighter
  separation, tuned on a 16:9 window — on a portrait phone the two fighters
  walked straight off the sides of the screen. The horizontal field of view
  comes from the vertical one and the live aspect ratio.
*/
function fitDistance(halfWidth: number): number {
  const vf = THREE.MathUtils.degToRad(camera.fov);
  const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
  return halfWidth / Math.tan(hf / 2);
}

/* Smooth, band-limited shake: three incommensurate sines per axis. Uniform
   random offsets every frame read as the image fizzing; noise with a few
   dominant frequencies reads as the ground actually moving. */
function shakeNoise(t: number, seed: number): number {
  return Math.sin(t * 37.1 + seed * 12.7) * 0.55
    + Math.sin(t * 61.7 + seed * 5.3) * 0.30
    + Math.sin(t * 93.3 + seed * 9.1) * 0.15;
}

export function updateCameraFight(dt: number): void {
  dampLights(LIGHTS.ambFight, LIGHTS.hemiFight, LIGHTS.keyFight, dt);
  dampFov(fightFov(), dt);
  const { P1, P2 } = state;
  const mid = (P1.x + P2.x) / 2;
  const sep = Math.abs(P1.x - P2.x);
  const highest = Math.max(P1.y, P2.y);
  rigState.mid = mid;
  rigState.sep = sep;

  attackCamera(dt);

  // lead a little toward where the fight is travelling
  leadX = damp(leadX, clamp(((P1.vx + P2.vx) / 2) * FRAMING.lead, -1.2, 1.2), 4, dt);

  // the authored dolly, never closer than what keeps both fighters on screen at this aspect
  const dollyZ = clamp(RIG.zBase + sep * RIG.zPerGap, RIG.zMin, RIG.zMax);
  const fitZ = PLANE_Z + fitDistance(sep / 2 + FRAMING.margin);
  const wantZ = Math.min(Math.max(dollyZ, fitZ), FRAMING.zMaxFit) - camPush * 1.2;

  // the rig's own position, kept free of shake so shake never feeds back into the springs
  rigBase.z = springs.z.step(rigBase.z, wantZ, FRAMING.smoothZ, dt);
  rigBase.x = springs.x.step(rigBase.x, clamp(mid * RIG.xPull + camBias + leadX, -8.5, 8.5), FRAMING.smoothX, dt);
  rigBase.y = springs.y.step(rigBase.y, RIG.yBase + sep * RIG.yPerGap + highest * 0.34 - camPush * 0.22, FRAMING.smoothY, dt);
  rigState.z = rigBase.z;

  rigState.look.x = springs.lookX.step(rigState.look.x, mid * 0.92 + leadX * 0.5, FRAMING.smoothLook, dt);
  rigState.look.y = springs.lookY.step(rigState.look.y, 1.66 + highest * 0.42, FRAMING.smoothLook, dt);

  camera.position.copy(rigBase);
  camera.lookAt(rigState.look);
  camera.rotation.z += camRoll;                    // slight bank toward the swing

  // shake after aiming, so it translates the frame rather than orbiting the target
  if (match.shake > 0.001 && !REDUCED_MOTION && settings.shakeOn) {
    shakeClock += dt;
    const m = match.shake * SHAKE.amount;
    shakeOff.set(shakeNoise(shakeClock, 0) * m * 0.5, shakeNoise(shakeClock, 1) * m * 0.5, 0);
    camera.position.add(shakeOff);
    camera.rotation.z += shakeNoise(shakeClock, 2) * match.shake * SHAKE.roll * 0.5;
    match.shake *= Math.exp(-SHAKE.lambda * dt);
    if (match.shake < 0.001) match.shake = 0;
  } else {
    match.shake = 0;
  }

  aimKeyAt(mid + 7, 15, 9, mid, 2);
}

export function resetCameraRig(): void {
  stopCamTween();
  tweens.removeAll();
  rigBase.set(0, 3.6, 11.4);
  rigState.look.set(0, 2.2, PLANE_Z);
  camPush = camBias = camRoll = leadX = shakeClock = 0;
  resetSprings();
}
