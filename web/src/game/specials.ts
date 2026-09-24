import * as THREE from 'three/webgpu';
import { BOUND, MOVES, PLANE_Z, S } from '../config/constants';
import { Sfx } from '../audio/sfx';
import { clamp } from '../core/math';
import { addTrauma } from '../fx/juice';
import { Burst } from '../fx/particles';
import { spawnRing, spawnStreaks } from '../fx/vfx';
import { scene } from '../render/stage';
import { landHit } from './collision';
import type { Fighter } from './fighter';
import { attackPhase, enterState } from './fsm';
import { ACT, type Intent } from './intent';
import { match } from './match';
import { state } from './state';

/*
  Special moves: one per fighter, on one input.

  Back, then forward, then light — the motion every game in this genre is
  built on — and each fighter answers it differently:

    CINDERWARD   EMBER BOLT      a fireball down the stage
    PALE VIGIL   SPECTRAL SPEAR  a spear on a chain: it drags them in
    BRONZEMAW    IRON CHARGE     a shoulder charge that launches
    NOCTURNE     SHADE STEP      gone, and back behind them into a kick

  Every hit resolves through landHit, so blocking, blood, juggles, the finish
  and the fatality all work on a special exactly as they do on a punch. The
  fighter's own limb hitbox is off for the move (fsm.ts): what lands is the
  bolt, the spear, the charging body, or the kick that follows the step.
*/

export type SpecialKind = 'bolt' | 'spear' | 'charge' | 'shade';

export const SPECIALS: Readonly<Record<string, { readonly kind: SpecialKind; readonly name: string }>> = {
  cinderward: { kind: 'bolt', name: 'EMBER BOLT' },
  palevigil: { kind: 'spear', name: 'SPECTRAL SPEAR' },
  bronzemaw: { kind: 'charge', name: 'IRON CHARGE' },
  nocturne: { kind: 'shade', name: 'SHADE STEP' },
};

/** Seconds between specials, so a fireball is a decision rather than a wall. */
const COOLDOWN = 1.15;

const BOLT = { speed: 13.5, life: 1.6, damage: 10, knockback: 6.5, hitstun: 0.5, radius: 0.34 } as const;
const SPEAR = { speed: 26, reach: 9.5, back: 30, damage: 7, pull: 12.5, hitstun: 0.95 } as const;
const CHARGE = { speed: 18, time: 0.42, damage: 11, knockback: 9, launch: 8.5, hitstun: 1.0 } as const;
const SHADE = { behind: 1.5 } as const;

interface Shot {
  kind: 'bolt' | 'spear';
  live: boolean;
  x: number;
  y: number;
  dir: number;
  t: number;
  travelled: number;
  retract: boolean;
  readonly group: THREE.Group;
  readonly head: THREE.Mesh;
  readonly chain: THREE.Mesh | null;
}

interface Runtime {
  cd: number;
  fired: boolean;
  charge: number;
  chargeHit: boolean;
  /** Shade Step has taken the body out of sight. */
  hidden: boolean;
  shot: Shot | null;
}

const runtime = new WeakMap<Fighter, Runtime>();
const _v = new THREE.Vector3();
const _hand = new THREE.Vector3();

function rt(f: Fighter): Runtime {
  let r = runtime.get(f);
  if (!r) {
    r = { cd: 0, fired: false, charge: 0, chargeHit: false, hidden: false, shot: null };
    runtime.set(f, r);
  }
  return r;
}

export function specialOf(f: Fighter): { readonly kind: SpecialKind; readonly name: string } {
  return SPECIALS[f.def.id] ?? SPECIALS.cinderward!;
}

/** Off cooldown, and nothing of theirs still in flight. */
export function specialReady(f: Fighter): boolean {
  const r = rt(f);
  return r.cd <= 0 && !(r.shot && r.shot.live);
}

/* ── projectile art, built on first use ────────────────────────────────── */

function makeShot(f: Fighter, kind: 'bolt' | 'spear'): Shot {
  const group = new THREE.Group();
  const hot = new THREE.Color(f.def.accent).multiplyScalar(2.2);   // above the bloom threshold
  let head: THREE.Mesh;
  let chain: THREE.Mesh | null = null;
  if (kind === 'bolt') {
    head = new THREE.Mesh(
      new THREE.IcosahedronGeometry(BOLT.radius, 2),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.3, 0.45), toneMapped: false }),
    );
    const shell = new THREE.Mesh(
      new THREE.IcosahedronGeometry(BOLT.radius * 1.7, 1),
      new THREE.MeshBasicMaterial({ color: hot, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    head.add(shell);
  } else {
    head = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.7, 8),
      new THREE.MeshStandardMaterial({ color: 0xDDEEF4, emissive: hot, emissiveIntensity: 0.8, metalness: 0.8, roughness: 0.25 }),
    );
    head.rotation.z = -Math.PI / 2;
    chain = new THREE.Mesh(
      new THREE.BoxGeometry(1, 0.05, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x9FB4BC, emissive: hot, emissiveIntensity: 0.35, metalness: 0.9, roughness: 0.3 }),
    );
    scene.add(chain);
  }
  /* No light of its own. A light that comes and goes changes the scene's
     light count, and every lit material recompiles: each throw froze the game
     for most of a second. The glow is the bloom on an HDR core. */
  group.add(head);
  scene.add(group);
  group.visible = false;
  if (chain) chain.visible = false;
  return { kind, live: false, x: 0, y: 0, dir: 1, t: 0, travelled: 0, retract: false, group, head, chain };
}

function handOf(f: Fighter): THREE.Vector3 {
  return _hand.set(f.x + f.face * 0.75, f.y + 1.95, PLANE_Z + 0.2);
}

/* ── starting one ──────────────────────────────────────────────────────── */

/**
 * Called by the state machine on a SPECIAL press. Returns false if it cannot
 * go (cooling down, one already out), and the press falls back to a punch.
 */
export function trySpecial(f: Fighter, intent: Intent): boolean {
  if (!intent.specialDown) return false;
  intent.consumed |= ACT.SPECIAL;
  if (!specialReady(f) || !f.grounded) return false;
  const r = rt(f);
  r.cd = COOLDOWN;
  r.fired = false;
  enterState(f, S.PUNCH, MOVES.SPECIAL);
  Sfx.whiff(f.x);
  // the wind-up: the fighter's colour gathers at the hand
  Burst.emit(handOf(f), f.def.accent, 14, 2.6, 0.3);
  return true;
}

function fire(f: Fighter, foe: Fighter): void {
  const r = rt(f);
  r.fired = true;
  const kind = specialOf(f).kind;

  if (kind === 'bolt' || kind === 'spear') {
    let s = r.shot;
    if (!s || s.kind !== kind) s = r.shot = makeShot(f, kind);
    const h = handOf(f);
    s.live = true;
    s.x = h.x;
    s.y = h.y;
    s.dir = f.face;
    s.t = 0;
    s.travelled = 0;
    s.retract = false;
    s.group.visible = true;
    if (s.chain) s.chain.visible = true;
    spawnRing(h, f.def.accent);
    if (kind === 'bolt') {
      Sfx.dash(f.x);
      Sfx.whoosh(f.x);
    } else {
      Sfx.swish(1, f.x);
    }
    return;
  }

  if (kind === 'charge') {
    r.charge = CHARGE.time;
    r.chargeHit = false;
    f.vx = f.face * CHARGE.speed;
    Burst.emit(_v.set(f.x - f.face * 0.4, 0.3, PLANE_Z), 0xD8CBB0, 18, 4.5, 0.7);
    spawnRing(_v.set(f.x, 1.3, PLANE_Z), f.def.accent);
    Sfx.dash(f.x);
    Sfx.bass(0.6, f.x);
    return;
  }

  // shade: out of sight here, and in behind them
  const side = Math.sign(foe.x - f.x) || f.face;
  let nx = foe.x + side * SHADE.behind;
  if (Math.abs(nx) > BOUND - 0.3) nx = foe.x - side * SHADE.behind;   // the wall is there: come back in front
  Burst.emit(_v.set(f.x, f.y + 1.4, PLANE_Z), f.def.accent, 34, 4.5, 0.6);
  f.x = clamp(nx, -BOUND, BOUND);
  f.physicsBody?.teleport(f.x, f.y);
  f.face = Math.sign(foe.x - f.x) || -side;
  f.lean.visible = true;
  rt(f).hidden = false;
  Burst.emit(_v.set(f.x, f.y + 1.4, PLANE_Z), f.def.accent, 34, 4.5, 0.6);
  spawnRing(_v, f.def.accent);
  Sfx.whoosh(f.x);
  enterState(f, S.KICK, MOVES.KICK);
}

/* ── every step ────────────────────────────────────────────────────────── */

function hitsFoe(x: number, y: number, foe: Fighter, reach: number): boolean {
  return foe.state !== S.KO && Math.abs(x - foe.x) < reach && y > foe.y + 0.2 && y < foe.y + 3.3;
}

function stepShot(f: Fighter, foe: Fighter, s: Shot, dt: number): void {
  s.t += dt;
  if (s.kind === 'bolt') {
    s.x += s.dir * BOLT.speed * dt;
    s.y += Math.sin(s.t * 18) * 0.004;
    if (Math.random() < 0.8) Burst.emit(_v.set(s.x - s.dir * 0.2, s.y, PLANE_Z), Math.random() < 0.4 ? 0xFFD27A : f.def.accent, 1, 1.4, 0.2);
    if (hitsFoe(s.x, s.y, foe, BOLT.radius + 0.45)) {
      landHit(foe, {
        owner: f, attacker: f, fromX: s.x - s.dir, dir: s.dir,
        damage: BOLT.damage * f.def.power, knockback: BOLT.knockback, hitstun: BOLT.hitstun,
        shake: 0.9, contact: _v.set(s.x, s.y, PLANE_Z + 0.2), label: specialOf(f).name,
        sparkColor: f.def.accent, burst: 40, burstSpeed: 8,
      });
      kill(s, true);
      return;
    }
    if (s.t > BOLT.life || Math.abs(s.x) > BOUND + 3) kill(s, true);
  } else {
    const h = handOf(f);
    if (!s.retract) {
      s.x += s.dir * SPEAR.speed * dt;
      s.travelled += SPEAR.speed * dt;
      if (hitsFoe(s.x, s.y, foe, 0.6)) {
        const landed = landHit(foe, {
          owner: f, attacker: f, fromX: s.x - s.dir, dir: s.dir,
          damage: SPEAR.damage * f.def.power, knockback: 0, hitstun: SPEAR.hitstun,
          shake: 0.8, contact: _v.set(s.x, s.y, PLANE_Z + 0.2), label: specialOf(f).name,
          sparkColor: f.def.accent, burst: 24, burstSpeed: 6,
        });
        // it bit: drag them back along the chain, off their feet
        if (landed && foe.state === S.HITSTUN) {
          foe.vx = -s.dir * SPEAR.pull;
          foe.vy = Math.max(foe.vy, 3.2);
          foe.grounded = false;
          addTrauma(0.2);
        }
        s.retract = true;
      } else if (s.travelled > SPEAR.reach || Math.abs(s.x) > BOUND + 2) {
        s.retract = true;
      }
    } else {
      s.x += Math.sign(h.x - s.x) * SPEAR.back * dt;
      if (Math.abs(h.x - s.x) < 0.5) kill(s, false);
    }
    s.y = h.y;
    // the chain runs from the hand to the head
    if (s.chain) {
      const len = Math.max(0.05, Math.abs(s.x - h.x));
      s.chain.position.set((s.x + h.x) / 2, h.y, PLANE_Z + 0.2);
      s.chain.scale.set(len, 1, 1);
    }
  }
  s.group.position.set(s.x, s.y, PLANE_Z + 0.2);
  s.head.rotation.y = s.kind === 'spear' ? (s.dir > 0 ? 0 : Math.PI) : s.head.rotation.y + dt * 9;
}

function kill(s: Shot, burst: boolean): void {
  if (burst) {
    Burst.emit(_v.set(s.x, s.y, PLANE_Z), 0xFF8A2A, 22, 5, 0.5);
    spawnStreaks(_v, -s.dir, 0xFFD27A, 4);
  }
  s.live = false;
  s.group.visible = false;
  if (s.chain) s.chain.visible = false;
}

/**
 * After planMotion, before bodies move: projectiles fly and hit, a charge keeps
 * its speed and checks for contact, and a special reaching its active frames
 * fires.
 */
export function stepSpecials(dt: number): void {
  const { P1, P2 } = state;
  for (const [f, foe] of [[P1, P2], [P2, P1]] as const) {
    const r = rt(f);
    if (r.cd > 0) r.cd = Math.max(0, r.cd - dt);

    const winding = f.state === S.PUNCH && f.move === MOVES.SPECIAL && !r.fired;
    // Shade Step: gone a moment into the wind-up, so the reappearance is the surprise
    if (winding && specialOf(f).kind === 'shade' && f.stateTime > 0.07 && !r.hidden) {
      r.hidden = true;
      f.lean.visible = false;
      Burst.emit(_v.set(f.x, f.y + 1.4, PLANE_Z), f.def.accent, 26, 3.5, 0.6);
    }
    // interrupted mid-vanish: back into sight
    if (r.hidden && !winding) {
      r.hidden = false;
      f.lean.visible = true;
    }
    if (winding && attackPhase(f) === 'active' && !match.over) fire(f, foe);

    if (r.charge > 0) {
      r.charge -= dt;
      if (f.state === S.KO || f.state === S.HITSTUN) r.charge = 0;
      else {
        f.vx = f.face * CHARGE.speed;
        if (Math.random() < 0.6) Burst.emit(_v.set(f.x - f.face * 0.5, 0.25, PLANE_Z), 0xC9BCA2, 2, 2.5, 0.6);
        const gap = foe.x - f.x;
        if (!r.chargeHit && Math.sign(gap) === f.face && Math.abs(gap) < 1.9 && Math.abs(foe.y - f.y) < 1.8) {
          r.chargeHit = true;
          r.charge = 0;
          landHit(foe, {
            owner: f, attacker: f, fromX: f.x, dir: f.face,
            damage: CHARGE.damage * f.def.power, knockback: CHARGE.knockback, hitstun: CHARGE.hitstun,
            shake: 1.1, contact: _v.set((f.x + foe.x) / 2, 1.5, PLANE_Z + 0.2), label: specialOf(f).name,
            sparkColor: f.def.accent, burst: 44, burstSpeed: 9, launch: CHARGE.launch,
          });
          f.vx = -f.face * 3;
        }
      }
    }

    if (r.shot?.live) stepShot(f, foe, r.shot, dt);
  }
}

/** A new round or the select screen: nothing in flight, nothing cooling. */
export function resetSpecials(): void {
  for (const f of state.fighters ?? []) {
    const r = rt(f);
    r.cd = 0;
    r.charge = 0;
    r.fired = false;
    r.hidden = false;
    if (r.shot?.live) kill(r.shot, false);
  }
}
