import * as THREE from 'three/webgpu';
import { Ambience } from '../audio/ambience';
import { Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { PHASE } from '../config/constants';
import type { FixedStepLoop } from '../core/loop';
import { clamp, damp } from '../core/math';
import { REDUCED_MOTION } from '../core/platform';
import type { Fighter } from '../game/fighter';
import { match } from '../game/match';
import { state } from '../game/state';
import { post } from '../render/post';
import { camera } from '../render/stage';
import { dom } from '../ui/dom';
import { settings } from '../ui/settings';
import { arena } from '../world/arena';

/*
  Game feel, in one place.

  Every important event used to set its own shake and hit-stop numbers where
  it happened, and nothing else answered: the camera shook, the lens did not
  move, the music did not notice. impact() is now the one call, and each kind
  of event is a row in a table:

      hit-stop       frames the simulation holds on contact
      trauma         added to a 0–1 trauma value; shake is trauma², so small
                     knocks stay gentle and big ones get violent
      fov            a lens punch in degrees that eases back (negative = in)
      aberration     a fringing kick in the grade
      flash          an exposure kick
      duck           how far the score dips under it

  plus a jolt on the struck fighter's health bar. knockout() adds slow motion
  (the loop's time scale), desaturation, a camera lean toward the fallen
  fighter, the KO sting and a muffled score. roundIntro() eases the lens in
  from wide. updateFeel() runs every presented frame: it decays all of it,
  drives the post-processing kick, points the audio listener along the camera,
  ticks the last seconds of the clock and sets the music's intensity.

  Screen shake and lens motion respect the SCREEN SHAKE setting and the OS
  reduced-motion preference; the audio and hit-stop always play.
*/

export type ImpactKind = 'light' | 'heavy' | 'block' | 'assist' | 'super' | 'quake' | 'ko';

interface ImpactRow {
  readonly stop: number;
  readonly trauma: number;
  readonly fov: number;
  readonly ab: number;
  readonly flash: number;
  readonly duck: number;
}

const IMPACT: Readonly<Record<ImpactKind, ImpactRow>> = {
  light: { stop: 0.055, trauma: 0.30, fov: -0.7, ab: 0.004, flash: 0.04, duck: 0.12 },
  heavy: { stop: 0.095, trauma: 0.55, fov: -1.8, ab: 0.010, flash: 0.10, duck: 0.30 },
  block: { stop: 0.035, trauma: 0.20, fov: -0.3, ab: 0.002, flash: 0.00, duck: 0.05 },
  assist: { stop: 0.110, trauma: 0.62, fov: -2.2, ab: 0.012, flash: 0.14, duck: 0.35 },
  super: { stop: 0.000, trauma: 0.42, fov: 2.6, ab: 0.008, flash: 0.20, duck: 0.20 },
  quake: { stop: 0.060, trauma: 0.90, fov: 1.4, ab: 0.014, flash: 0.08, duck: 0.40 },
  ko: { stop: 0.160, trauma: 0.95, fov: -3.8, ab: 0.022, flash: 0.35, duck: 0.60 },
};

const KO_SLOWMO = { seconds: 1.05, scale: 0.22, rampOut: 0.3 } as const;
/** How fast trauma bleeds away, per second. */
const TRAUMA_DECAY = 1.6;

const feel = {
  trauma: 0,
  fov: 0,
  ab: 0,
  flash: 0,
  desat: 0,
  slowT: 0,
  koX: null as number | null,
  lastTick: -1,
};

let loopRef: FixedStepLoop | null = null;
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

export function bindFeelLoop(loop: FixedStepLoop | null): void {
  loopRef = loop;
}

const motionAllowed = (): boolean => !REDUCED_MOTION && settings.shakeOn;

/* A health bar kicks sideways when its owner is hit. */
function joltBar(slot: 0 | 1, heavy: boolean): void {
  const block = dom.block[slot];
  block.classList.remove('jolt', 'jolt-heavy');
  void block.offsetWidth;                          // restart the keyframes
  block.classList.add(heavy ? 'jolt-heavy' : 'jolt');
}

export interface ImpactOptions {
  /** Scales every column but hit-stop, which is clamped to ±30%. */
  readonly scale?: number;
  /** The fighter slot that took it, for the health-bar jolt. */
  readonly victim?: 0 | 1;
}

export function impact(kind: ImpactKind, o: ImpactOptions = {}): void {
  const row = IMPACT[kind];
  const s = o.scale ?? 1;
  if (row.stop > 0) {
    match.freeze = Math.max(match.freeze, row.stop * clamp(s, 0.7, 1.3));
    match.lastStop = Math.round(match.freeze * 1000);
  }
  feel.trauma = Math.min(1, feel.trauma + row.trauma * s);
  feel.fov = clamp(feel.fov + row.fov * s, -6, 6);
  feel.ab = Math.max(feel.ab, row.ab * s);
  feel.flash = Math.max(feel.flash, row.flash * s);
  Music.duck(row.duck * Math.min(1, s));
  if (o.victim !== undefined && kind !== 'block') joltBar(o.victim, kind !== 'light');
}

/** A little shake with no hit-stop: hard landings, props hitting the floor. */
export function addTrauma(amount: number): void {
  feel.trauma = Math.min(1, feel.trauma + amount);
}

export function knockout(loser: Fighter): void {
  impact('ko', { victim: loser.slot === 0 ? 0 : 1 });
  feel.slowT = KO_SLOWMO.seconds;
  feel.koX = loser.x;
  Sfx.ko(loser.x);
  Music.stinger('ko');
  Music.muffle(KO_SLOWMO.seconds + 0.2);
}

/** A new round: the lens starts wide and settles in while the gong rings. */
export function roundIntro(): void {
  feel.fov = motionAllowed() ? 5 : 0;
  Sfx.gong();
  Music.stinger('round');
}

export function fightCall(): void {
  Sfx.fight();
  addTrauma(0.25);
}

export function roundOver(reason: string): void {
  // a KO already made its noise in knockout(); a time-out needs its own
  if (reason === 'TIME UP' || reason === 'DRAW') {
    Sfx.timeUp();
    Music.duck(0.4, 0.6);
  }
}

/** true: a human won · false: the CPU won · null: a draw. */
export function matchOver(humanWon: boolean | null): void {
  if (humanWon === false) {
    Sfx.defeat();
    Music.stinger('defeat');
  } else {
    Sfx.victory();
    Music.stinger('victory');
  }
}

/** Start the positional beds once audio exists. Safe to call repeatedly. */
export function startAmbience(): void {
  if (Ambience.running || !arena) return;
  Ambience.start(
    arena.braziers.map((b) => b.flame.getWorldPosition(new THREE.Vector3())),
    { x: 0, y: -1.1, z: -24 },
  );
}

/** Shake strength for the camera: trauma squared, or nothing if shake is off. */
export function feelShake(): number {
  return motionAllowed() ? feel.trauma * feel.trauma : 0;
}

/** Degrees to add to the fight lens this frame. */
export function feelFov(): number {
  return motionAllowed() ? feel.fov : 0;
}

/** World X the camera should lean toward during a KO, or null. */
export function koFocus(): number | null {
  return feel.slowT > 0 ? feel.koX : null;
}

/** How fast presentation-only effects (particles, ambience) should run: slowed with the KO. */
export function presentScale(): number {
  return loopRef?.timeScale ?? 1;
}

function musicIntensity(): number {
  if (state.phase === PHASE.TITLE) return 0;
  if (state.phase === PHASE.SELECT || document.body.classList.contains('results')) return 1;
  const { P1, P2 } = state;
  const humans = state.mode1P ? [P1] : [P1, P2];
  const finalRound = P1.rounds === 1 && P2.rounds === 1;
  const clutch = finalRound || humans.some((f) => f.hp > 0 && f.hp <= 30);
  return clutch ? 3 : 2;
}

export function updateFeel(dt: number): void {
  feel.trauma = Math.max(0, feel.trauma - dt * TRAUMA_DECAY);
  feel.fov = damp(feel.fov, 0, 6.5, dt);
  feel.ab = damp(feel.ab, 0, 9, dt);
  feel.flash = damp(feel.flash, 0, 11, dt);

  // KO slow motion: held, then ramped back to full speed so it never snaps
  let scale = 1;
  if (feel.slowT > 0) {
    feel.slowT -= dt;
    scale = feel.slowT > KO_SLOWMO.rampOut
      ? KO_SLOWMO.scale
      : KO_SLOWMO.scale + (1 - KO_SLOWMO.scale) * (1 - Math.max(0, feel.slowT) / KO_SLOWMO.rampOut);
    if (feel.slowT <= 0) feel.koX = null;
  }
  if (match.paused || state.phase !== PHASE.FIGHT) scale = 1;
  if (loopRef) loopRef.timeScale = scale;
  feel.desat = damp(feel.desat, feel.slowT > 0 ? 0.55 : 0, feel.slowT > 0 ? 10 : 3, dt);

  const kick = REDUCED_MOTION ? 0.3 : 1;
  post?.setKick(feel.ab * kick, feel.flash * kick, feel.desat);

  // the audio listener rides the camera: stereo for one-shots, 3D for the beds
  const dist = Math.max(1, Math.abs(camera.position.z));
  const halfW = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect;
  Sfx.setListener(camera.position.x, halfW);
  camera.getWorldDirection(_fwd);
  _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
  Ambience.update({ position: camera.position, forward: _fwd, up: _up });

  // the last five seconds of a round tick
  if (state.phase === PHASE.FIGHT && !match.over && !match.paused) {
    const secs = Math.ceil(match.time);
    if (secs <= 5 && secs > 0 && secs !== feel.lastTick) Sfx.tick(secs <= 3);
    feel.lastTick = secs;
  }

  Music.setIntensity(musicIntensity());
}

export function resetFeel(): void {
  feel.trauma = feel.fov = feel.ab = feel.flash = feel.desat = feel.slowT = 0;
  feel.koX = null;
  feel.lastTick = -1;
  if (loopRef) loopRef.timeScale = 1;
  post?.setKick(0, 0, 0);
}

export function feelDebug(): Readonly<typeof feel> & { timeScale: number; music: number } {
  return { ...feel, timeScale: loopRef?.timeScale ?? 1, music: Music.level };
}
