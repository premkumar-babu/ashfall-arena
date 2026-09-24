import * as THREE from 'three/webgpu';
import { JUGGLE, MOVES, PLANE_Z, S, type FighterState, type Move } from '../config/constants';
import { DUEL_FEEL, MOVEMENT } from '../config/controls';
import { Sfx } from '../audio/sfx';
import { clamp, easeOut } from '../core/math';
import { Burst } from '../fx/particles';
import { spawnArc, spawnRing } from '../fx/vfx';
import type { Fighter } from './fighter';
import { ACT, type Intent } from './intent';
import { trySpecial } from './specials';
import { tryFatalBlow } from './fatalblow';
import { throwing, tryThrow } from './throws';
import { state } from './state';

export type Limb = 'fist' | 'foot' | 'blade';
export type AttackPhase = 'startup' | 'active' | 'recovery';

export const DASH = { speed: 15.5, time: 0.17, cd: 0.42 } as const;

const _v = new THREE.Vector3();
const _arcP = new THREE.Vector3();

export function enterState(f: Fighter, next: FighterState, move: Move | null = null): void {
  f.state = next;
  f.stateTime = 0;
  f.move = move;
  f.hitLanded = false;
  f.activeHitbox = null;
  f.arcFired = false;                 // per-attack, not per-lifetime
  if (next === S.PUNCH || next === S.KICK) {
    f.lockFace = f.face;              // committing to a swing commits the facing
    f.airMove = !f.grounded;
  } else if (next !== S.HITSTUN) {
    f.lockFace = 0;
  }
}

/** Armed fighters swing the blade where an unarmed fighter would kick. */
export function limbFor(f: Fighter, move: Move): Limb {
  return (move === MOVES.KICK || move === MOVES.SWEEP) && f.def.armed ? 'blade' : move.limb;
}

/*
  Is this fighter's heavy a sword swing rather than a kick? Answering it in one
  place keeps the hitbox, the primitive pose and the bone driver from
  disagreeing — which is what once left an armed fighter kicking the air while
  the blade that actually carried the hitbox hung off a limp arm.
*/
export function slashing(f: Fighter): boolean {
  return f.state === S.KICK && f.def.armed;
}

export function kickingLeg(f: Fighter): boolean {
  return f.state === S.KICK && !f.def.armed;
}

export function attackPhase(f: Fighter): AttackPhase | null {
  const m = f.move;
  if (!m) return null;
  const t = f.stateTime;
  if (t < m.startup) return 'startup';
  if (t < m.startup + m.active) return 'active';
  return 'recovery';
}

/**
 * How far into the swing the limb is: dips to -0.22 through startup (the
 * wind-up), holds 1 through the active frames, then eases back to 0 over
 * recovery. The primitive pose and the bone driver both read it, so the art
 * and the hitbox can never be at different points of the same swing.
 */
export function attackExtension(f: Fighter): number {
  const m = f.move;
  if (!m) return 0;
  const t = f.stateTime;
  if (t < m.startup) return -0.22 * Math.sin((t / m.startup) * Math.PI * 0.9);
  if (t < m.startup + m.active) return 1;
  return 1 - easeOut(clamp((t - m.startup - m.active) / m.recovery, 0, 1));
}

/* Standing, or walked off an edge a moment ago. Coyote time never grants a
   second jump: launching sets airTime past the window. */
export function canJump(f: Fighter): boolean {
  return f.grounded || (f.state !== S.JUMP && f.vy <= 0 && f.airTime < MOVEMENT.coyoteTime);
}

/*
  Every press the state machine acts on is marked consumed on the intent, so a
  buffered press fires exactly once. A press it cannot act on yet — a punch
  during recovery, a dash on cooldown — is left in the buffer and fires the
  moment it becomes legal, if that happens inside the buffer window.

  Guard held on the ground turns punch into the uppercut and kick into the
  sweep — the crouching pair every fighter in this genre is built around.
  Guard is already the "down" direction on every device, so there is nothing
  new to learn: down + punch, down + kick.
*/
function tryAttack(f: Fighter, intent: Intent): boolean {
  if (tryFatalBlow(f, intent)) return true;
  if (tryThrow(f, intent)) return true;
  if (trySpecial(f, intent)) return true;
  // a special that cannot go yet still comes out as the jab it was pressed as
  if (intent.specialDown) intent.punchDown = true;
  const low = intent.block && f.grounded;
  if (intent.punchDown) {
    intent.consumed |= ACT.PUNCH;
    enterState(f, S.PUNCH, low ? MOVES.UPPERCUT : MOVES.PUNCH);
    Sfx.whiff(f.x);
    return true;
  }
  if (intent.kickDown) {
    intent.consumed |= ACT.KICK;
    enterState(f, S.KICK, low ? MOVES.SWEEP : MOVES.KICK);
    Sfx.whiff(f.x);
    return true;
  }
  return false;
}

export function stepState(f: Fighter, intent: Intent, dt: number): void {
  f.stateTime += dt;
  if (f.dashCd > 0) f.dashCd -= dt;
  if (f.dashTime > 0) f.dashTime -= dt;

  switch (f.state) {
    case S.IDLE:
    case S.WALK:
    case S.BLOCK:
      if (tryAttack(f, intent)) break;
      if (intent.jumpDown && canJump(f)) {
        intent.consumed |= ACT.JUMP;
        launchJump(f, intent.move);
        break;
      }
      if (intent.dash && f.grounded && f.dashCd <= 0) {
        intent.consumed |= ACT.DASH;
        startDash(f, intent.dash);
      }
      if (intent.block) {
        if (f.state !== S.BLOCK) enterState(f, S.BLOCK);
        break;
      }
      if (intent.move !== 0) {
        if (f.state !== S.WALK) enterState(f, S.WALK);
      } else if (f.state !== S.IDLE) {
        enterState(f, S.IDLE);
      }
      break;

    case S.JUMP:
      // jump-ins are the backbone of a fighting game: attacks stay live in the
      // air, and the move rides out the arc instead of cancelling it
      if (tryAttack(f, intent)) break;
      if (f.grounded) enterState(f, intent.move !== 0 ? S.WALK : S.IDLE);
      break;

    case S.PUNCH:
    case S.KICK: {
      const move = f.move!;
      const phase = attackPhase(f);
      // a special's blow is its bolt, spear or body (specials.ts), never the limb
      f.activeHitbox = phase === 'active' && !f.hitLanded && !move.special ? f.hitboxes[limbFor(f, move)] : null;
      if (phase === 'active' && !f.arcFired && !move.special) {
        f.arcFired = true;
        // the uppercut rises with the fist
        if (move === MOVES.UPPERCUT && f.grounded) {
          f.vy = 5.2;
          f.grounded = false;
          f.airTime = MOVEMENT.coyoteTime;
        }
        const heavy = move === MOVES.KICK || move === MOVES.UPPERCUT;
        // the arc belongs on the limb actually swinging, not on a guess a metre in front
        f.hitboxes[limbFor(f, move)].anchor.getWorldPosition(_arcP);
        spawnArc(_arcP.x, _arcP.y, f.face, f.def.accent, heavy ? (f.def.armed ? 1.02 : 0.86) : 0.58);
        Sfx.swish(heavy ? 1 : 0.6, f.x);
      }
      if (f.stateTime >= move.total) {
        // landing out of an air attack drops straight back to neutral
        enterState(f, f.grounded ? S.IDLE : S.JUMP);
      }
      break;
    }

    case S.HITSTUN:
      /* A launched fighter who lands is knocked down: flat on the stones for a
         moment, then up. Without it a launch ended the instant they touched
         the floor and a juggle had no full stop. */
      if (f.launched && f.grounded && !throwing(f)) {     // a throw puts them down itself
        f.launched = false;
        f.juggles = 0;
        f.downT = JUGGLE.knockdown;
        f.stunTime = f.stateTime + JUGGLE.knockdown + 0.2;
        f.land = 1;
        Burst.emit(_v.set(f.x, 0.15, PLANE_Z), 0xC9BCA2, 18, 4, 0.8);
        Sfx.land(1, f.x);
      }
      /* Up only when actually up: a knockdown keeps them in hitstun until the
         body has risen, so nobody punches while still lying on the stones. */
      if (f.stateTime >= f.stunTime && f.grounded && f.downT <= 0 && f.lean.rotation.x > -0.5) enterState(f, S.IDLE);
      break;

    case S.KO:
      break;
  }
}

/** A jump carries the momentum it was launched with, so a running jump-in actually crosses ground. */
export function launchJump(f: Fighter, dir: number): void {
  /* A jump with a direction is a somersault, forward or back, over the whole
     arc — the jump this genre is known for. RUSH has its own flips. */
  if (dir !== 0 && !state.rush) {
    f.flip = 0.001;
    f.flipDir = dir === f.face ? 1 : -1;
    f.flipTime = 0.72;
  }
  f.vy = f.def.jump * (state.rush ? 1 : DUEL_FEEL.jump);
  f.grounded = false;
  f.airTime = MOVEMENT.coyoteTime;     // spent: no coyote jump out of a jump
  f.jumpReleased = false;              // the hold that decides this jump's height starts now
  f.vx = dir * f.def.speed * 0.92;
  enterState(f, S.JUMP);
  Burst.emit(_v.set(f.x, 0.12, PLANE_Z), 0xC9BCA2, 8, 2.6, 0.7);
  Sfx.jump(f.x);
}

export function startDash(f: Fighter, dir: number): void {
  f.dashTime = DASH.time;
  f.dashCd = DASH.cd;
  f.dashDir = dir;
  f.vx = dir * DASH.speed;
  Burst.emit(_v.set(f.x - dir * 0.3, 0.35, PLANE_Z), 0xD8CBB0, 12, 4.2, 0.6);
  spawnRing(_v.set(f.x - dir * 0.4, 0.9, PLANE_Z), 0xE8DCC4);
  Sfx.dash(f.x);
}
