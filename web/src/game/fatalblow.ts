import * as THREE from 'three/webgpu';
import { FLASH_FRAMES, MOVES, PLANE_Z, S } from '../config/constants';
import { Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { setCinematic } from '../camera/camera-rig';
import { pool, spray } from '../fx/blood';
import { addTrauma, impact, setMood } from '../fx/juice';
import { Burst } from '../fx/particles';
import { spawnRing, spawnStreaks } from '../fx/vfx';
import { banner } from '../ui/banner';
import { landHit } from './collision';
import type { Fighter } from './fighter';
import { attackPhase, enterState } from './fsm';
import { ACT, type Intent } from './intent';
import { match } from './match';
import { state } from './state';

/*
  The fatal blow: the comeback super the genre's current games are built round.

  Below 30% health, once a match, OVERDRIVE becomes it — the HUD writes FATAL
  BLOW into the bar when it is there to use. It comes out armoured (a blow
  landed on its startup does not stop it), lunges, and if it connects the fight
  stops for a cinematic: three blows, three camera cuts, the stage drained of
  colour, and the last one throws them across the stage. A whiff is not wasted,
  only put on a cooldown, the way the genre does it.

  The damage lands through landHit at the end, so blood, juggles, K.O. and
  FINISH THEM all follow from it exactly as they would from a punch.
*/

export const FATAL_BLOW = {
  /** Health at or below which it is available. */
  threshold: 30,
  damage: 26,
  /** How far ahead the lunge connects. */
  reach: 2.7,
  lunge: 13,
  /** Seconds before a whiffed one can be tried again. */
  cooldown: 7,
  launch: 11,
  knockback: 9,
} as const;

/** The cinematic's beats, in seconds from contact. */
const BEAT = { hit1: 0.18, cut2: 0.62, hit2: 0.8, cut3: 1.25, hit3: 1.45, end: 1.85 } as const;

interface Runtime {
  used: boolean;
  cd: number;
  lunged: boolean;
}

interface Scene {
  att: Fighter;
  def: Fighter;
  t: number;
  dir: number;
  hits: number;
  cuts: number;
}

const runtime = new WeakMap<Fighter, Runtime>();
const _v = new THREE.Vector3();
let scene: Scene | null = null;

function rt(f: Fighter): Runtime {
  let r = runtime.get(f);
  if (!r) {
    r = { used: false, cd: 0, lunged: false };
    runtime.set(f, r);
  }
  return r;
}

/** Low enough, not yet spent this match, not cooling down: the HUD shows FATAL BLOW. */
export function fatalReady(f: Fighter): boolean {
  if (state.rush || f.state === S.KO || f.hp <= 0 || f.hp > FATAL_BLOW.threshold) return false;
  const r = rt(f);
  return !r.used && r.cd <= 0;
}

/** The fight is stopped for the cinematic. */
export function inFatalBlow(): boolean {
  return scene !== null;
}

/** A fatal blow's startup cannot be knocked out of. */
export function fatalArmored(f: Fighter): boolean {
  return f.move === MOVES.FATAL && f.state === S.PUNCH && attackPhase(f) === 'startup' && !rt(f).lunged;
}

/** Called by the state machine: OVERDRIVE at low health is the fatal blow instead. */
export function tryFatalBlow(f: Fighter, intent: Intent): boolean {
  if (!intent.powerDown || !fatalReady(f) || !f.grounded) return false;
  intent.consumed |= ACT.POWER;
  intent.powerDown = false;                        // and not Overdrive as well
  rt(f).lunged = false;
  enterState(f, S.PUNCH, MOVES.FATAL);
  banner(f.slot === 0 ? 0 : 1, 'FATAL BLOW', 1800);
  _v.set(f.x, 1.6, PLANE_Z);
  Burst.emit(_v, 0xFF3A2A, 40, 5, 0.6);
  spawnRing(_v, 0xFFE2A8);
  impact('super');
  Sfx.power();
  Music.duck(0.5, 1.5);
  return true;
}

function begin(att: Fighter, def: Fighter): void {
  const r = rt(att);
  r.used = true;
  scene = { att, def, t: 0, dir: att.face, hits: 0, cuts: 0 };
  att.vx = def.vx = 0;
  enterState(def, S.HITSTUN);
  def.stunTime = 99;
  document.body.classList.add('cine');
  setMood(0.55, 0.3);
  // the first cut: low and close on the contact
  setCinematic({ x: (att.x + def.x) / 2, y: 2.0, dist: 4.8, yaw: att.face * 0.95, h: -0.9 });
}

function strike(n: number): void {
  const S2 = scene!;
  const { att, def, dir } = S2;
  S2.hits = n;
  // the attacker's body goes through a swing for each blow; no hitbox, the damage is at the end
  enterState(att, n === 2 ? S.KICK : S.PUNCH, MOVES.FATAL);
  _v.set(def.x - dir * 0.25, 1.5 + n * 0.25, PLANE_Z + 0.2);
  def.flash = 1;
  def.white = FLASH_FRAMES;
  def.hitDir = dir;
  spray(_v, dir, 22 + n * 18, 6 + n * 2);
  spawnStreaks(_v, dir, 0xFFF2C0, 8);
  Burst.emit(_v, 0xFFB454, 26, 7, 0.4);
  impact('heavy', { victim: def.slot === 0 ? 0 : 1, scale: 1.1 + n * 0.1 });
  Sfx.crunch(def.x);
  Sfx.gore(0.8 + n * 0.25, def.x);
  if (n === 3) Sfx.bass(1.2, def.x);
  addTrauma(0.2 + n * 0.1);
}

/** After planMotion: the lunge, the contact check, and the cinematic when it is running. */
export function stepFatalBlow(dt: number): void {
  const { P1, P2 } = state;
  for (const [f, foe] of [[P1, P2], [P2, P1]] as const) {
    const r = rt(f);
    if (r.cd > 0) r.cd = Math.max(0, r.cd - dt);
    if (scene || f.move !== MOVES.FATAL || f.state !== S.PUNCH || match.over) continue;
    const phase = attackPhase(f);
    if (phase === 'active') {
      if (!r.lunged) {
        r.lunged = true;
        f.vx = f.face * FATAL_BLOW.lunge;
        Sfx.whoosh(f.x);
      }
      const gap = foe.x - f.x;
      if (foe.state !== S.KO && Math.sign(gap) === f.face && Math.abs(gap) < FATAL_BLOW.reach && Math.abs(foe.y - f.y) < 2) {
        begin(f, foe);
        return;
      }
    } else if (phase === 'recovery' && r.lunged && !r.used && r.cd <= 0) {
      r.cd = FATAL_BLOW.cooldown;                  // a whiff: try again later
    }
  }

  if (!scene) return;
  const S2 = scene;
  S2.t += dt;
  const { att, def, dir } = S2;
  att.vx = def.vx = 0;

  if (S2.t >= BEAT.hit1 && S2.hits < 1) strike(1);
  if (S2.t >= BEAT.cut2 && S2.cuts < 1) {
    S2.cuts = 1;
    setCinematic({ x: def.x, y: 2.2, dist: 5.2, yaw: -dir * 0.7, h: -0.5 });
  }
  if (S2.t >= BEAT.hit2 && S2.hits < 2) strike(2);
  if (S2.t >= BEAT.cut3 && S2.cuts < 2) {
    S2.cuts = 2;
    setCinematic({ x: (att.x + def.x) / 2 + dir * 1.5, y: 1.9, dist: 8.5, yaw: dir * 0.25, h: 1.4 });
  }
  if (S2.t >= BEAT.hit3 && S2.hits < 3) strike(3);

  if (S2.t >= BEAT.end) {
    scene = null;
    document.body.classList.remove('cine');
    setMood(0, 0);
    setCinematic(null);
    def.stunTime = 0.9;
    enterState(att, S.IDLE);
    pool(def.x + dir * 0.6, 0.9);
    landHit(def, {
      owner: att, attacker: att, fromX: att.x, dir,
      damage: FATAL_BLOW.damage * att.def.power, knockback: FATAL_BLOW.knockback, hitstun: 1.1,
      shake: 1.3, contact: _v.set(def.x - dir * 0.3, 1.8, PLANE_Z + 0.2), label: 'FATAL BLOW',
      sparkColor: 0xFF4A2A, burst: 70, burstSpeed: 10, launch: FATAL_BLOW.launch, extraRings: 2,
    });
  }
}

/** A new match: everyone has theirs again. */
export function resetFatalBlows(newMatch: boolean): void {
  // a cinematic cut short (a quit, a restart) must not leave the HUD hidden or the stage dimmed
  if (scene) {
    document.body.classList.remove('cine');
    setMood(0, 0);
    setCinematic(null);
  }
  scene = null;
  for (const f of state.fighters ?? []) {
    const r = rt(f);
    r.cd = 0;
    r.lunged = false;
    if (newMatch) r.used = false;
  }
}
