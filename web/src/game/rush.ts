import * as THREE from 'three/webgpu';
import { BOUND, GRAVITY, MIN_GAP, PLANE_Z, S } from '../config/constants';
import { MOVEMENT } from '../config/controls';
import { Sfx } from '../audio/sfx';
import { clamp, damp } from '../core/math';
import { addTrauma, impact, knockout } from '../fx/juice';
import { Burst } from '../fx/particles';
import { spawnRing, spawnStreaks } from '../fx/vfx';
import { legacyIntensity } from '../render/lights';
import { announce } from '../ui/announcer';
import type { Fighter } from './fighter';
import { DASH, enterState } from './fsm';
import { ACT, blankIntent, type Intent } from './intent';
import { endRound, match } from './match';
import { state } from './state';

/*
  RUSH: the movement-only mode.

  Playtesting said the attacks are the least interesting thing in the duel and
  the movement is the part worth caring about, so this mode deletes everything
  else. No punches, no kicks, no summons, no clock.

  It is a game of tag. One fighter carries the ember and it burns them: their
  bar drains for as long as they hold it. Touch the other fighter and it is
  theirs. Burn all the way down and the round is lost. So one player is always
  chasing and one is always running, and the walls turn every escape into a
  question of how you get past someone who is coming at you.

  (An earlier version ended rounds by knocking the other fighter off the edge
  of the stage. It played badly — a round could end on one shove, or on
  walking off by accident — so the walls are back and nobody can leave.)

  The four fighters are separated here by how they MOVE rather than by damage:
  weight decides who wins a collision, and each one gets a different answer to
  "someone is in the way and I need to be on the other side of them".
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

/*
  The ember. Twelve seconds of carrying it burns a full bar, so a round is at
  least that long and usually two or three times it. A pass locks the ember
  for most of a second: without that, two fighters in contact hand it back and
  forth every step and the one who touched first is decided by frame order.
*/
const EMBER = {
  burn: 12,
  lock: 0.9,
  /** Pushboxes stop two bodies at MIN_GAP, so a touch is anything just past that. */
  reach: MIN_GAP + 0.3,
  /** Vertical overlap that still counts: clearing someone's head is how you get past them. */
  height: 1.7,
  /** Nobody burns while ROUND ONE … FIGHT! is still being called. */
  grace: 1.25,
  color: 0xFF8A2A,
} as const;

interface RushRuntime {
  jumpsLeft: number;
  airDashLeft: number;
  slamming: boolean;
  /** Speed a launch put into this fighter, while it still owns the slide. */
  slide: number;
  /** In RUSH a fighter faces where they are going, not their opponent. */
  face: number;
  /** CPU only: a beat of indecision, so the bot can be caught and can be escaped. */
  hesitate: number;
}

const runtime = new WeakMap<Fighter, RushRuntime>();
const _v = new THREE.Vector3();
let checkCooldown = 0;
let holder: Fighter | null = null;
let passLock = 0;
let grace = 0;

function rt(f: Fighter): RushRuntime {
  let r = runtime.get(f);
  if (!r) {
    r = { jumpsLeft: 0, airDashLeft: 0, slamming: false, slide: 0, face: f.slot === 0 ? 1 : -1, hesitate: 0 };
    runtime.set(f, r);
  }
  return r;
}

export function rushKit(f: Fighter): RushKit {
  return RUSH_KITS[f.def.id] ?? DEFAULT_KIT;
}

/** Who is carrying the ember, for anything that wants to show it. */
export function emberHolder(): Fighter | null {
  return state.rush ? holder : null;
}

/** Called when a round starts: nobody carries an air dash into a fresh stage, and the ember alternates. */
export function resetRush(): void {
  checkCooldown = 0;
  passLock = 0;
  grace = EMBER.grace;
  holder = null;
  if (!state.fighters) return;
  for (const f of state.fighters) {
    const r = rt(f);
    const kit = rushKit(f);
    r.jumpsLeft = kit.jumps - 1;
    r.airDashLeft = kit.airDash;
    r.slamming = false;
    r.slide = 0;
    r.face = f.slot === 0 ? 1 : -1;
    r.hesitate = 0;
    douse(f);
  }
  if (state.rush) holder = state.fighters[(match.round + 1) % 2] ?? null;
}

/* Attacks do not exist in this mode. Stripping the intent rather than the state
   machine means the keyboard, pad, touch buttons and the CPU are all silenced
   by one rule, and the duel's own code is left untouched. Down on the ground is
   a block in the duel and would only root you to the spot here; in the air it
   is still the slam. */
export function stripAttacks(intent: Intent, f: Fighter): void {
  intent.punchDown = false;
  intent.kickDown = false;
  intent.assistDown = false;
  intent.powerDown = false;
  intent.specialDown = false;
  if (f.grounded) intent.block = false;
}

/*
  The per-fighter movement kit, applied after planMotion has done the duel's own
  movement for this step. Everything here is additive on top of that, so the
  base feel — acceleration times, jump cut, coyote time — still holds.
*/
export function stepRush(f: Fighter, intent: Intent, dt: number): void {
  const kit = rushKit(f);
  const r = rt(f);

  /* Facing follows the stick. The duel turns a fighter to face their opponent
     because every attack is aimed that way; with no attacks it only meant that
     running away was a backwards shuffle, and running away is half this mode. */
  if (f.state !== S.HITSTUN && f.state !== S.KO && intent.move) r.face = intent.move > 0 ? 1 : -1;
  f.face = r.face;

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
       unconditionally also clamped a knockback slide the moment hitstun ended.
       Everything the player is not steering keeps its speed and is bled off by
       drag instead. */
    const driving = intent.move !== 0 && Math.sign(f.vx) === Math.sign(intent.move);
    if (driving && Math.abs(f.vx) > top) f.vx = Math.sign(f.vx) * top;

    /* Keep a launched fighter sliding. The duel brakes hard in IDLE — that is
       a courtesy to a player who let go of the stick — and it erased a body
       check the moment hitstun ended. While the slide is still faster than a
       walk and its owner is not steering out of it, it decays on its own terms. */
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
       or a launch used to brake it, which made every airborne moment feel the same. */
    if (intent.move && kit.airCtl !== 1) {
      const target = intent.move * top * MOVEMENT.airControl * kit.airCtl;
      const faster = Math.sign(f.vx) === Math.sign(target) && Math.abs(f.vx) >= Math.abs(target);
      if (!faster) f.vx = damp(f.vx, target, 1 / MOVEMENT.airAccelTime, dt);
    }

    // double / triple jump, each one a front flip
    if (intent.jumpDown && r.jumpsLeft > 0) {
      r.jumpsLeft--;
      f.vy = f.def.jump * 0.92;
      f.jumpReleased = false;
      f.flip = 0.001;
      f.flipDir = 1;
      f.flipTime = 0.42;
      intent.jumpDown = false;
      intent.consumed |= ACT.JUMP;
      Burst.emit(_v.set(f.x, f.y + 0.6, PLANE_Z), f.def.accent, 10, 3.2, 0.5);
      spawnRing(_v.set(f.x, f.y + 0.7, PLANE_Z), f.def.accent);
      Sfx.dash(f.x);
    }

    // air dash: the glider's way over someone, and its best approach
    if (intent.dash && r.airDashLeft > 0) {
      r.airDashLeft--;
      f.vx = intent.dash * DASH.speed * kit.dashMul * 1.05;
      f.vy = Math.max(f.vy, 1.4);
      r.face = f.face = intent.dash > 0 ? 1 : -1;
      f.zip = 1;
      intent.dash = 0;
      intent.consumed |= ACT.DASH;
      Burst.emit(_v.set(f.x, f.y + 1.0, PLANE_Z), f.def.accent, 14, 4.4, 0.45);
      spawnStreaks(_v.set(f.x, f.y + 1.4, PLANE_Z), -f.face, f.def.accent, 6);
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
  f.land = 1;                                      // the deepest squash there is
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

/* ── the ember ─────────────────────────────────────────────────────────── */

function touching(a: Fighter, b: Fighter): boolean {
  return Math.abs(a.x - b.x) <= EMBER.reach && Math.abs(a.y - b.y) < EMBER.height;
}

/** The fighter's own light goes back to their colour and off. */
function douse(f: Fighter): void {
  f.powerLight.intensity = 0;
  f.powerLight.color.setHex(f.def.accent);
}

function passEmber(from: Fighter, to: Fighter): void {
  holder = to;
  passLock = EMBER.lock;
  douse(from);
  _v.set((from.x + to.x) / 2, 1.5, PLANE_Z);
  Burst.emit(_v, EMBER.color, 28, 6, 0.55);
  spawnRing(_v, 0xFFC46B);
  impact('light', { victim: to.slot === 0 ? 0 : 1 });
  Sfx.hit(0.7, _v.x);
  match.lastTrade = `${from.def.name} → TAG`;
  announce('TAG!', 650, 'toast');
}

function burnOut(f: Fighter): void {
  f.hp = 0;
  douse(f);
  enterState(f, S.KO);
  knockout(f);
  Burst.emit(_v.set(f.x, 1.4, PLANE_Z), EMBER.color, 60, 8, 0.8);
  endRound(state.fighters.find((o) => o !== f) ?? null, 'BURNED OUT');
}

/*
  One step of the ember: pass it on contact, burn whoever still has it. Runs
  after the physics step, on the positions this step actually ended at.
*/
export function stepEmber(dt: number): void {
  if (!holder || match.over) return;
  const other = state.fighters.find((f) => f !== holder);
  if (!other) return;

  passLock = Math.max(0, passLock - dt);
  if (passLock <= 0 && other.state !== S.KO && touching(holder, other)) passEmber(holder, other);

  const h = holder;
  const heat = 1 - h.hp / 100;
  h.powerLight.color.setHex(EMBER.color);
  h.powerLight.distance = 7;
  h.powerLight.intensity = legacyIntensity(1.6 + heat * 2.2 + Math.sin(state.elapsed * 17) * 0.5);
  // embers stream off the carrier, thicker the closer they are to burning out
  if (Math.random() < 0.45 + heat * 0.5) {
    _v.set(h.x + (Math.random() - 0.5) * 0.7, h.y + 0.9 + Math.random() * 1.4, PLANE_Z);
    Burst.emit(_v, Math.random() < 0.3 ? 0xFFD27A : EMBER.color, 1, 1.4 + heat, 0.5);
  }

  if (grace > 0) {
    grace -= dt;
    return;
  }
  h.hp = Math.max(0, h.hp - (100 / EMBER.burn) * dt);
  if (h.hp <= 0) burnOut(h);
}

/*
  The CPU in RUSH. The duel's bot is a fighting-game brain — spacing, strings,
  reaction blocks — and none of that exists in this mode, so this one is small.
  Carrying the ember it chases, and spends whatever its kit has to close the
  last metre. Without it, it runs; and when the wall is behind it, it goes over
  the top of you the way its kit allows. It hesitates now and then, which is
  what makes it catchable.
*/
export function rushBotIntent(f: Fighter, foe: Fighter, dt: number): Intent {
  const i = blankIntent();
  if (match.over || f.state === S.KO || f.state === S.HITSTUN) return i;

  const r = rt(f);
  const kit = rushKit(f);
  const gap = foe.x - f.x;
  const toward: 1 | -1 = gap >= 0 ? 1 : -1;
  const dist = Math.abs(gap);

  if (r.hesitate > 0) {
    r.hesitate -= dt;
    return i;
  }

  if (holder === f) {
    // chase — but not straight back into the one who just passed it: the lock would make that a gift
    i.move = passLock > 0 && dist < 3 ? 0 : toward;
    if (passLock <= 0 && dist < 3.8 && f.grounded && f.dashCd <= 0 && Math.random() < 0.2) i.dash = toward;
    // they went up: follow them up
    if (foe.y > f.y + 1 && dist < 4.5) {
      i.jumpHeld = true;
      if (f.grounded || (f.vy < 0 && r.jumpsLeft > 0)) i.jumpDown = true;
    }
    if (!f.grounded && r.airDashLeft > 0 && dist < 5 && dist > 1.6) i.dash = toward;
    // the heavies drop on you from above
    if (kit.slam && !f.grounded && dist < 2.2 && f.y > foe.y + 0.8) i.block = true;
    if (Math.random() < 0.004) r.hesitate = 0.2 + Math.random() * 0.25;
    return i;
  }

  const away: 1 | -1 = toward === 1 ? -1 : 1;
  const behind = away > 0 ? BOUND - f.x : f.x + BOUND;

  /* Nobody near: stand off, but not in a corner — that is where a chase ends.
     The gap between running and standing is wide on purpose; one threshold
     had the bot twitching back and forth across it. */
  if (dist > 8) {
    i.move = Math.abs(f.x) > 6 ? (f.x > 0 ? -1 : 1) : 0;
    return i;
  }
  if (dist > 6 && f.grounded && Math.abs(foe.vx) < 2) return i;

  // the wall is behind: go over the top of them
  if (behind < 2.8) {
    i.move = toward;
    i.jumpHeld = true;
    if (f.grounded && dist < 4.2 + Math.random()) i.jumpDown = true;
    else if (!f.grounded && f.vy < 1.2 && r.jumpsLeft > 0) i.jumpDown = true;
    if (!f.grounded && r.airDashLeft > 0 && f.y > 1.6) i.dash = toward;
    return i;
  }

  i.move = away;
  if (dist < 2.6 && f.grounded && f.dashCd <= 0 && Math.random() < 0.35) i.dash = away;
  if (Math.random() < 0.006) r.hesitate = 0.18 + Math.random() * 0.3;
  return i;
}

/*
  The body check. Two fighters overlapping is already handled as a pushbox in
  movement.ts; this asks whether the overlap arrived fast enough to count as a
  hit. The faster body wins, scaled by the two weights, so a charging Bronzemaw
  runs through a walking Nocturne and a dashing Nocturne still moves a standing
  one — but only just. In tag it is the tagger's follow-through: the ember
  changes hands on the touch, and the check throws its new carrier clear.
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
