import * as THREE from 'three/webgpu';
import { BOUND, GRAVITY, MIN_GAP, PLANE_Z, S } from '../config/constants';
import { MOVEMENT } from '../config/controls';
import { Sfx } from '../audio/sfx';
import { clamp, damp } from '../core/math';
import { addTrauma, impact } from '../fx/juice';
import { Burst } from '../fx/particles';
import { spawnRing } from '../fx/vfx';
import type { Fighter } from './fighter';
import { DASH, enterState } from './fsm';
import { ACT, blankIntent, type Intent } from './intent';
import { match } from './match';
import { state } from './state';

/*
  RUSH: the movement-only mode.

  Playtesting said the attacks are the least interesting thing in the duel and
  the movement is the part worth caring about, so this mode deletes everything
  else. No punches, no kicks, no summons, no health. You win by putting the
  other fighter off the edge of the stage using nothing but momentum — a
  shoulder charge is a dash into a body, and the stage has no walls to save
  anyone (see RINGOUT in config/constants.ts).

  The four fighters are separated here by how they MOVE rather than by damage:
  weight decides who wins a collision, and each one gets a different answer to
  "I am in the air and I want to be somewhere else".
*/

export interface RushKit {
  /** Shown on the select screen, so the difference is legible before you pick. */
  readonly blurb: string;
  /** Resistance to being shoved, and the weight behind your own checks. */
  readonly mass: number;
  readonly push: number;
  /** Walk speed, and how sharply it is reached, as multipliers on the duel's numbers. */
  readonly speed: number;
  readonly accel: number;
  /** Steering and fall rate in the air. */
  readonly airCtl: number;
  readonly gravity: number;
  /** Jumps per airtime (1 = ground jump only), air dashes per airtime, dash length. */
  readonly jumps: number;
  readonly airDash: number;
  readonly dashMul: number;
  /** Hold down in the air to drop like a stone and shove whatever you land beside. */
  readonly slam: boolean;
}

export const RUSH_KITS: Readonly<Record<string, RushKit>> = {
  cinderward: {
    blurb: 'HEAVY · SLAM', mass: 1.35, push: 1.30, speed: 0.95, accel: 1.35,
    airCtl: 0.80, gravity: 1.15, jumps: 1, airDash: 0, dashMul: 1.00, slam: true,
  },
  palevigil: {
    blurb: 'FLOATS · AIR DASH', mass: 0.85, push: 0.95, speed: 1.05, accel: 0.85,
    airCtl: 1.55, gravity: 0.78, jumps: 1, airDash: 1, dashMul: 1.10, slam: false,
  },
  bronzemaw: {
    blurb: 'HEAVIEST · CHARGE', mass: 1.65, push: 1.55, speed: 0.85, accel: 1.55,
    airCtl: 0.65, gravity: 1.20, jumps: 1, airDash: 0, dashMul: 1.45, slam: true,
  },
  nocturne: {
    blurb: 'LIGHT · TRIPLE JUMP', mass: 0.70, push: 0.85, speed: 1.15, accel: 0.70,
    airCtl: 1.25, gravity: 0.95, jumps: 3, airDash: 0, dashMul: 0.95, slam: false,
  },
};

const DEFAULT_KIT: RushKit = RUSH_KITS.cinderward!;

/** The shove itself, in one place: what counts as a check, and how hard it throws. */
const CHECK = {
  /** Closing speed a body needs before contact reads as a check rather than a lean. */
  minSpeed: 5.5,
  /** Closing speed → launch speed. */
  gain: 1.02,
  minLaunch: 9,
  maxLaunch: 40,
  lift: 0.16,
  /** The checker keeps a little of its own run, reversed: a charge does not tailgate. */
  recoil: -0.18,
  stun: 0.24,
  /** Seconds before the same pair can trade another check, so contact cannot machine-gun. */
  cooldown: 0.18,
  freeze: 0.05,
} as const;

const SLAM = { fall: -26, range: 3.6, power: 17, lift: 5.5 } as const;

/** How a launch bleeds off once its victim is back on their feet. */
const SLIDE = { decel: 30, keep: 7 } as const;

interface RushRuntime {
  jumpsLeft: number;
  airDashLeft: number;
  slamming: boolean;
  /** Speed a launch put into this fighter, while it still owns the slide. */
  slide: number;
}

const runtime = new WeakMap<Fighter, RushRuntime>();
const _v = new THREE.Vector3();
let checkCooldown = 0;

function rt(f: Fighter): RushRuntime {
  let r = runtime.get(f);
  if (!r) {
    r = { jumpsLeft: 0, airDashLeft: 0, slamming: false, slide: 0 };
    runtime.set(f, r);
  }
  return r;
}

export function rushKit(f: Fighter): RushKit {
  return RUSH_KITS[f.def.id] ?? DEFAULT_KIT;
}

/** Called when a round starts: nobody carries an air dash into a fresh stage. */
export function resetRush(): void {
  checkCooldown = 0;
  if (!state.fighters) return;
  for (const f of state.fighters) {
    const r = rt(f);
    const kit = rushKit(f);
    r.jumpsLeft = kit.jumps - 1;
    r.airDashLeft = kit.airDash;
    r.slamming = false;
    r.slide = 0;
  }
}

/* Attacks do not exist in this mode. Stripping the intent rather than the state
   machine means the keyboard, pad, touch buttons and the CPU are all silenced
   by one rule, and the duel's own code is left untouched. */
export function stripAttacks(intent: Intent): void {
  intent.punchDown = false;
  intent.kickDown = false;
  intent.assistDown = false;
  intent.powerDown = false;
}

/*
  The per-fighter movement kit, applied after planMotion has done the duel's own
  movement for this step. Everything here is additive on top of that, so the
  base feel — acceleration times, jump cut, coyote time — still holds.
*/
export function stepRush(f: Fighter, intent: Intent, dt: number): void {
  const kit = rushKit(f);
  const r = rt(f);

  if (f.grounded) {
    r.jumpsLeft = kit.jumps - 1;
    r.airDashLeft = kit.airDash;
    if (r.slamming) landSlam(f, kit);
  }

  // weight: heavier fighters take longer to get going, and top out slower
  const top = f.def.speed * kit.speed;
  if (f.grounded && (f.state === S.IDLE || f.state === S.WALK) && f.dashTime <= 0) {
    if (kit.accel !== 1) f.vx = damp(f.vx, intent.move * top, (1 / MOVEMENT.accelTime) / kit.accel, dt);
    /* Only a fighter driving itself is held to its top speed. Clamping
       unconditionally also clamped a knockback slide the moment hitstun ended,
       which stopped a launched fighter dead a metre from the edge — in the one
       mode where carried momentum is the whole game. Everything the player is
       not steering keeps its speed and is bled off by drag instead. */
    const driving = intent.move !== 0 && Math.sign(f.vx) === Math.sign(intent.move);
    if (driving && Math.abs(f.vx) > top) f.vx = Math.sign(f.vx) * top;

    /* Keep a launched fighter sliding. The duel brakes hard in IDLE — that is
       a courtesy to a player who let go of the stick — and it erased a body
       check the moment hitstun ended, stopping people dead a stride from the
       edge. While the slide is still faster than a walk and its owner is not
       steering out of it, it decays on its own terms instead. */
    if (r.slide > SLIDE.keep && !driving) {
      const decayed = r.slide - SLIDE.decel * dt;
      r.slide = Math.max(0, decayed);
      if (Math.abs(f.vx) < Math.abs(r.slide)) f.vx = Math.sign(r.slide || f.vx || 1) * Math.abs(r.slide);
    } else if (driving || Math.abs(f.vx) <= top) {
      r.slide = 0;
    }
  } else if (f.grounded) {
    r.slide = 0;
  }

  if (!f.grounded) {
    // fall rate is a character trait here, not a global
    if (kit.gravity !== 1) f.vy += GRAVITY * (kit.gravity - 1) * dt;

    /* Extra air steering, on top of the duel's own air control. It may only ever
       ADD speed toward where you are pointing: steering into your own air dash
       or a launch used to brake it, which made every airborne moment feel the
       same. Momentum is the whole game here, so nothing but gravity slows you. */
    if (intent.move && kit.airCtl !== 1) {
      const target = intent.move * top * MOVEMENT.airControl * kit.airCtl;
      const faster = Math.sign(f.vx) === Math.sign(target) && Math.abs(f.vx) >= Math.abs(target);
      if (!faster) f.vx = damp(f.vx, target, 1 / MOVEMENT.airAccelTime, dt);
    }

    // double / triple jump
    if (intent.jumpDown && r.jumpsLeft > 0) {
      r.jumpsLeft--;
      f.vy = f.def.jump * 0.92;
      f.jumpReleased = false;
      intent.jumpDown = false;
      intent.consumed |= ACT.JUMP;
      Burst.emit(_v.set(f.x, f.y + 0.6, PLANE_Z), f.def.accent, 10, 3.2, 0.5);
      spawnRing(_v.set(f.x, f.y + 0.7, PLANE_Z), f.def.accent);
      Sfx.dash(f.x);
    }

    // air dash: the glider's way out of trouble, and its best approach
    if (intent.dash && r.airDashLeft > 0) {
      r.airDashLeft--;
      f.vx = intent.dash * DASH.speed * kit.dashMul * 1.05;
      f.vy = Math.max(f.vy, 1.4);
      f.face = intent.dash > 0 ? 1 : -1;
      intent.dash = 0;
      intent.consumed |= ACT.DASH;
      Burst.emit(_v.set(f.x, f.y + 1.0, PLANE_Z), f.def.accent, 14, 4.4, 0.45);
      Sfx.dash(f.x);
    }

    // slam: hold down in the air. A committal drop — almost no steering on the way.
    if (kit.slam && !r.slamming && intent.block && f.vy < 2.5) {
      r.slamming = true;
      f.vy = SLAM.fall;
      Burst.emit(_v.set(f.x, f.y, PLANE_Z), f.def.accent, 12, 3.6, 0.4);
    }
    if (r.slamming) f.vx *= 0.86;
  }

  // dash weight: the charger's dash is longer, the light ones flick
  if (f.dashTime > 0 && kit.dashMul !== 1) f.vx = f.dashDir * DASH.speed * kit.dashMul;
}

/** A slam landing shoves whoever is standing near the crater. */
function landSlam(f: Fighter, kit: RushKit): void {
  rt(f).slamming = false;
  addTrauma(0.32);
  Burst.emit(_v.set(f.x, 0.2, PLANE_Z), f.def.accent, 34, 7.5, 0.7);
  spawnRing(_v.set(f.x, 0.25, PLANE_Z), 0xFFE2A8);
  Sfx.bass(0.9, f.x);
  const foe = state.fighters.find((o) => o !== f);
  if (!foe || match.over || foe.state === S.KO) return;
  const gap = foe.x - f.x;
  if (Math.abs(gap) > SLAM.range || Math.abs(foe.y - f.y) > 2.2) return;
  const dir = gap >= 0 ? 1 : -1;
  foe.vx = dir * SLAM.power * (kit.push / rushKit(foe).mass);
  foe.vy = Math.max(foe.vy, SLAM.lift);
  foe.hitDir = dir;
  foe.stunTime = CHECK.stun;
  enterState(foe, S.HITSTUN);
  rt(foe).slide = Math.abs(foe.vx);
  impact('heavy', { victim: foe.slot === 0 ? 0 : 1, scale: 1.1 });
}

/*
  The CPU in RUSH. The duel's bot is a fighting-game brain — spacing, strings,
  reaction blocks — and none of that exists in this mode, so this one is
  deliberately small: walk at them, charge when close, and above all do not
  walk off the stage. Edge awareness comes first, because a CPU that rings
  itself out is not a test of anything.
*/
export function rushBotIntent(f: Fighter, foe: Fighter): Intent {
  const i = blankIntent();
  if (match.over || f.state === S.KO || f.state === S.HITSTUN) return i;

  const own = Math.sign(f.x) || 1;
  const gap = foe.x - f.x;
  const dir: 1 | -1 = gap >= 0 ? 1 : -1;
  const dist = Math.abs(gap);

  // thrown off the stage: steer back, and spend a jump if the kit has one
  if (Math.abs(f.x) > BOUND - 0.5) {
    i.move = -own;
    if (!f.grounded) {
      i.jumpHeld = true;
      if (f.vy < 0) i.jumpDown = true;
    }
    return i;
  }

  // backed up near the edge: stop retreating and meet them instead
  if (Math.abs(f.x) > BOUND - 2.6 && dir === own) {
    i.move = -own;
    if (dist < 3.0 && f.grounded && f.dashCd <= 0) i.dash = -own;
    return i;
  }

  i.move = dir;
  if (dist < 3.4 && f.grounded && f.dashCd <= 0) i.dash = dir;
  // hop over an incoming charge now and then, so it is not a pure walk-in
  if (dist < 2.4 && Math.abs(foe.vx) > 10 && f.grounded && Math.random() < 0.09) i.jumpDown = true;
  return i;
}

/*
  The body check. Two fighters overlapping is already handled as a pushbox in
  movement.ts; this asks whether the overlap arrived fast enough to count as a
  hit. The faster body wins, scaled by the two weights, so a charging Bronzemaw
  runs through a walking Nocturne and a dashing Nocturne still moves a standing
  one — but only just.
*/
export function resolveBodyCheck(P1: Fighter, P2: Fighter, dt: number): void {
  checkCooldown = Math.max(0, checkCooldown - dt);
  if (match.over || checkCooldown > 0) return;
  if (P1.state === S.KO || P2.state === S.KO) return;

  const gap = P2.x - P1.x;
  if (Math.abs(gap) > MIN_GAP + 0.25 || Math.abs(P1.y - P2.y) > 1.6) return;

  // closing speed: how fast each one is travelling into the other
  const dir1 = gap >= 0 ? 1 : -1;
  const close1 = P1.vx * dir1;
  const close2 = P2.vx * -dir1;
  const best = Math.max(close1, close2);
  if (best < CHECK.minSpeed) return;

  const att = close1 >= close2 ? P1 : P2;
  const def = att === P1 ? P2 : P1;
  const dir = att === P1 ? dir1 : -dir1;
  const kitA = rushKit(att);

  const power = (best * CHECK.gain * kitA.push * kitA.mass) / rushKit(def).mass;
  def.vx = dir * clamp(power, CHECK.minLaunch, CHECK.maxLaunch);
  def.vy = Math.max(def.vy, 3.2 + power * CHECK.lift);
  def.hitDir = dir;
  def.stunTime = CHECK.stun;
  enterState(def, S.HITSTUN);
  rt(def).slide = Math.abs(def.vx);                // the slide survives hitstun ending
  att.vx *= CHECK.recoil;

  checkCooldown = CHECK.cooldown;
  match.freeze = Math.max(match.freeze, CHECK.freeze);
  match.lastTrade = `${att.def.name} → CHECK`;

  const heavy = power > 18;
  _v.set((att.x + def.x) / 2, 1.25, PLANE_Z);
  impact(heavy ? 'heavy' : 'light', { victim: def.slot === 0 ? 0 : 1, scale: clamp(power / 18, 0.7, 1.3) });
  Burst.emit(_v, att.def.accent, heavy ? 30 : 18, heavy ? 7 : 5, 0.35);
  spawnRing(_v, 0xFFF2C0);
  addTrauma(heavy ? 0.3 : 0.18);
  Sfx.hit(clamp(power / 20, 0.5, 1.2), _v.x);
}
