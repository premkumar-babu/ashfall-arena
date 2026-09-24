import * as THREE from 'three/webgpu';
import { BOUND, GRAVITY, GROUND, METER, MIN_GAP, MOVES, PLANE_Z, S } from '../config/constants';
import { DUEL_FEEL, MOVEMENT } from '../config/controls';
import { Sfx } from '../audio/sfx';
import { clamp, damp } from '../core/math';
import { addTrauma } from '../fx/juice';
import { Burst } from '../fx/particles';
import { spawnRing } from '../fx/vfx';
import type { MoveResult } from '../physics/port';
import type { Fighter } from './fighter';
import { attackPhase, DASH } from './fsm';
import type { Intent } from './intent';
import { state } from './state';

/*
  Fighter movement, in two phases per simulation step.

  planMotion() is the game's side: facing, acceleration, air control, jump
  height, dash and attack lunges. It only changes velocities — every number
  that makes the game feel like itself lives here and in config/controls.ts.

  resolveMotion() turns those velocities into positions through the physics
  body: pushboxes first, then one character-controller sweep per fighter,
  which is where walls, the floor and ground detection come from.

  Both fighters are planned before either is moved, so neither side gets an
  advantage in a body-to-body shove from being processed first.
*/

const _v = new THREE.Vector3();

/** How far a grounded fighter probes downward each step, so walking off a ledge is noticed and snapping stays engaged. */
const SNAP_PROBE = 0.05;

function toward(v: number, target: number, maxDelta: number): number {
  return v < target ? Math.min(target, v + maxDelta) : Math.max(target, v - maxDelta);
}

/*
  Walking and air steering: linear acceleration toward a target speed.

  The old model was exponential drag toward the target, which is responsive
  at the start of a move but has a long soft tail — the last 10% of a stop
  takes as long as the first 60%, and that tail is what reads as "floaty".
  Linear rates reach the target and stop, and a turn-around gets its own,
  faster rate because reversing is a deliberate input.

  In the air the stick steers toward a reduced speed but never brakes a
  running jump down to it quickly: jump-ins keep their momentum.
*/
function steer(f: Fighter, target: number, topSpeed: number, dt: number): void {
  if (f.grounded) {
    const reversing = target !== 0 && f.vx !== 0 && Math.sign(target) !== Math.sign(f.vx);
    const slowing = !reversing && Math.abs(target) < Math.abs(f.vx);
    const time = reversing ? MOVEMENT.turnTime : slowing ? MOVEMENT.stopTime : MOVEMENT.accelTime;
    f.vx = toward(f.vx, target, (topSpeed / time) * dt);
  } else {
    const coasting = target === 0 || (Math.sign(target) === Math.sign(f.vx) && Math.abs(f.vx) > Math.abs(target));
    const time = coasting ? MOVEMENT.airDragTime : MOVEMENT.airAccelTime;
    f.vx = toward(f.vx, target, (topSpeed / time) * dt);
  }
}

export function planMotion(f: Fighter, intent: Intent, foe: Fighter, dt: number): void {
  /* Facing is re-evaluated every step EXCEPT while a swing is committed.
     Letting it flip mid-attack as the opponent crossed under a jump-in spun
     the fighter round on the active frame and threw the hitbox out behind them. */
  if (f.lockFace) f.face = f.lockFace;
  else if (f.state !== S.KO && f.state !== S.HITSTUN) f.face = foe.x >= f.x ? 1 : -1;

  const attacking = f.state === S.PUNCH || f.state === S.KICK;
  const mobile = f.state === S.IDLE || f.state === S.WALK || f.state === S.JUMP;
  const topSpeed = f.def.speed * (f.powered ? METER.powerSpeedMul : 1);

  if (mobile && f.dashTime <= 0) {
    // the duel walks slower, and slower again backing away; RUSH runs flat out
    const duel = !state.rush;
    const toward = intent.move !== 0 && Math.sign(intent.move) === f.face;
    const walk = duel ? (toward ? DUEL_FEEL.walkForward : DUEL_FEEL.walkBack) : 1;
    const air = duel ? DUEL_FEEL.airControl : MOVEMENT.airControl;
    steer(f, intent.move * topSpeed * (f.grounded ? walk : air), topSpeed, dt);
  } else {
    /* Everything the player is not steering — knockback, K.O. slides, blocking,
       dashes, air attacks — keeps its authored drag profile. */
    let want = 0;
    let drag = f.state === S.HITSTUN ? 5.5 : f.state === S.KO ? 4.0 : f.grounded ? 34 : 12;
    if (attacking && !f.grounded) {
      want = f.vx;                                 // an air attack rides out the jump's momentum
      drag = 0.8;
    }
    if (f.dashTime > 0) {
      want = f.dashDir * DASH.speed;
      drag = 26;
      if (Math.random() < 0.55) {
        Burst.emit(_v.set(f.x - f.dashDir * 0.35, 0.9 + Math.random() * 0.8, PLANE_Z), f.def.accent, 1, 1.4, 0.3);
      }
    }
    f.vx += (want - f.vx) * Math.min(1, drag * dt);
  }
  if (Math.abs(f.vx) < 0.02) f.vx = 0;

  if (!f.grounded) {
    /* Variable jump height. Releasing jump on the way up caps the rise, so a
       tap is a short hop and a hold is the full arc. Checked every step, so
       the release registers the step it happens. */
    if (f.vy > 0 && !intent.jumpHeld && !f.jumpReleased) {
      f.jumpReleased = true;
      f.vy = Math.min(f.vy, f.def.jump * MOVEMENT.jumpCut);
    }
    let g = GRAVITY;
    if (intent.block && f.state === S.JUMP && f.vy < 1) g *= MOVEMENT.fastFall;
    else if (intent.jumpHeld && Math.abs(f.vy) < MOVEMENT.apexHangVy) g *= MOVEMENT.apexHang;
    f.vy += g * dt;
  } else if (attacking && !f.airMove && !f.move?.special) {
    // a grounded swing steps into the blow rather than sliding on the spot
    const lunge = (f.move === MOVES.KICK ? 3.1 : 1.9) * f.def.reach;
    const ph = attackPhase(f);
    if (ph === 'startup') f.vx = damp(f.vx, -f.face * lunge * 0.22, 12, dt);
    else if (ph === 'active') f.vx = damp(f.vx, f.face * lunge, 18, dt);
  }

  if (f.flash > 0) f.flash = Math.max(0, f.flash - dt * 4.2);
  if (f.blockFlash > 0) f.blockFlash = Math.max(0, f.blockFlash - dt * 5.0);
}

export function resolveMotion(P1: Fighter, P2: Fighter, dt: number): void {
  const dx1 = P1.vx * dt;
  const dx2 = P2.vx * dt;

  /* Pushboxes. Fighters don't collide in the physics world (a controller
     treats another body as a wall to stop at); in a fighting game walking into
     your opponent shoves them. The shove goes through each fighter's own sweep
     below, so a cornered fighter is held by the wall rather than pushed
     through it. */
  let push = 0;
  const gap = P1.x + dx1 - (P2.x + dx2);
  if (Math.abs(gap) < MIN_GAP && Math.abs(P1.y - P2.y) < 1.4) {
    push = (MIN_GAP - Math.abs(gap)) * 0.5 * (gap >= 0 ? 1 : -1);
  }

  moveFighter(P1, dx1 + push, dt);
  moveFighter(P2, dx2 - push, dt);
}

const unbodied: MoveResult = { x: 0, y: GROUND, grounded: true, movedY: 0 };

/** The pre-physics movement: a clamp and a floor. Used only if Rapier failed to load. */
function integrateUnbodied(f: Fighter, dx: number, dy: number): MoveResult {
  const y = Math.max(GROUND, f.y + dy);
  unbodied.x = clamp(f.x + dx, -BOUND, BOUND);
  unbodied.movedY = y - f.y;
  unbodied.y = y;
  unbodied.grounded = y <= GROUND;
  return unbodied;
}

function moveFighter(f: Fighter, dx: number, dt: number): void {
  const wasGrounded = f.grounded;
  const dy = wasGrounded ? -SNAP_PROBE : f.vy * dt;
  const r = f.physicsBody ? f.physicsBody.move(dx, dy) : integrateUnbodied(f, dx, dy);

  f.x = r.x;

  // rising off the floor at jump start still touches it; only a descent can land
  const landed = !wasGrounded && r.grounded && f.vy <= 0;
  if (landed) {
    const fall = -f.vy;
    if (fall > 3) Sfx.land(clamp(fall / 14, 0.25, 1), f.x);
    if (fall > 6) {
      Burst.emit(_v.set(f.x, 0.12, PLANE_Z), 0xC9BCA2, 14, 3.4, 0.8);
      spawnRing(_v.set(f.x, 0.2, PLANE_Z), 0xD8CBB0);
    }
    // a hard landing thumps the camera a little
    if (fall > 11) addTrauma(0.14);
    // how hard they hit the stones, for the squash on the way out
    if (fall > 1.5) f.land = clamp(fall / 15, 0, 1);
    f.vy = 0;
  } else if (!wasGrounded && f.vy > 0 && r.movedY < dy * 0.5) {
    f.vy = 0;                                      // head met something on the way up
  }

  // a grounded fighter whose floor vanished starts to fall
  f.grounded = landed || (wasGrounded && r.grounded);
  f.y = f.grounded && r.y < GROUND + 0.02 ? GROUND : r.y;
  if (f.grounded) {
    f.airTime = 0;
    f.jumpReleased = true;
  } else {
    f.airTime += dt;
  }
}
