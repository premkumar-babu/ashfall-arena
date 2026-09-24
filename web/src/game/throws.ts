import * as THREE from 'three/webgpu';
import { BOUND, JUGGLE, MOVES, PLANE_Z, S } from '../config/constants';
import { Sfx } from '../audio/sfx';
import { clamp } from '../core/math';
import { pool, spray } from '../fx/blood';
import { addTrauma, impact } from '../fx/juice';
import { Burst } from '../fx/particles';
import { spawnRing } from '../fx/vfx';
import { banner } from '../ui/banner';
import { landHit } from './collision';
import type { Fighter } from './fighter';
import { enterState } from './fsm';
import { ACT, type Intent } from './intent';
import { match } from './match';
import { state } from './state';

/*
  Throws: light and heavy together, the genre's oldest answer to someone who
  will not stop blocking. Only up close, and a guard does nothing against it.

  The grab holds for a beat, then the victim goes up and over the thrower's
  shoulder and down on the far side, on their back. The slam lands through
  landHit like anything else — which is also why a throw cannot be blocked:
  the victim is put in hitstun first, so there is no guard left to find.
*/

const THROW = { reach: 2.1, damage: 12, hold: 0.22, flight: 0.34 } as const;

interface Grab {
  att: Fighter;
  def: Fighter;
  t: number;
  from: number;
  to: number;
  landed: boolean;
}

let grab: Grab | null = null;
const _v = new THREE.Vector3();

/** A throw is being carried out: both fighters belong to it until it lands. */
export function throwing(f: Fighter): boolean {
  return !!grab && (grab.att === f || grab.def === f);
}

/** Light and heavy on the same step. Returns true if a throw came out (or whiffed into its own recovery). */
export function tryThrow(f: Fighter, intent: Intent): boolean {
  if (!intent.punchDown || !intent.kickDown || !f.grounded || state.rush || grab) return false;
  intent.consumed |= ACT.PUNCH | ACT.KICK;
  const foe = state.fighters.find((o) => o !== f);
  const gap = foe ? foe.x - f.x : 99;
  enterState(f, S.PUNCH, MOVES.THROW);
  Sfx.whiff(f.x);
  const can = foe && foe.state !== S.KO && foe.grounded && !foe.dazed && Math.abs(gap) < THROW.reach && Math.sign(gap) === f.face;
  if (!can || !foe) return true;                  // a whiffed grab still has to recover
  grab = { att: f, def: foe, t: 0, from: foe.x, to: clamp(f.x - f.face * 1.7, -BOUND + 0.4, BOUND - 0.4), landed: false };
  enterState(foe, S.HITSTUN);
  foe.stunTime = 99;
  foe.vx = f.vx = 0;
  banner(f.slot === 0 ? 0 : 1, 'THROW', 1100);
  Sfx.block(foe.x);
  return true;
}

/** After planMotion: the throw carries the victim over and slams them down. */
export function stepThrows(dt: number): void {
  if (!grab) return;
  const g = grab;
  const { att, def } = g;
  if (match.over || att.state === S.KO) {
    def.stunTime = 0.2;
    grab = null;
    return;
  }
  g.t += dt;
  att.vx = def.vx = 0;
  if (g.t < THROW.hold) return;                   // the grab: a beat of nothing

  const k = clamp((g.t - THROW.hold) / THROW.flight, 0, 1);
  // up and over the shoulder: an arc from where they stood to behind the thrower
  const x = g.from + (g.to - g.from) * k;
  const y = Math.sin(k * Math.PI) * 2.6;
  def.x = x;
  def.y = y;
  def.vy = 0;                                      // the arc is the throw's, not gravity's
  def.grounded = false;
  def.launched = true;                             // tumbling, as far as the pose is concerned
  def.physicsBody?.teleport(x, y);
  if (def.flip === 0) {
    def.flip = 0.001;
    def.flipDir = -1;
    def.flipTime = THROW.flight;
  }

  if (k >= 1 && !g.landed) {
    g.landed = true;
    grab = null;
    def.y = 0;
    def.grounded = true;
    def.physicsBody?.teleport(def.x, 0);
    def.flip = 0;
    def.launched = false;                          // a slam, not a juggle: landHit must not pop them back up
    def.vy = 0;
    const dir = Math.sign(def.x - att.x) || -att.face;
    _v.set(def.x, 0.4, PLANE_Z);
    landHit(def, {
      owner: att, attacker: att, fromX: att.x, dir,
      damage: THROW.damage * att.def.power, knockback: 2.5, hitstun: 0.9,
      shake: 1.2, contact: _v.set(def.x, 0.9, PLANE_Z + 0.2), label: 'THROW',
      burst: 30, burstSpeed: 6,
    });
    // flat on their back, then up — unless it was the blow that left them standing for FINISH THEM
    if (def.state === S.HITSTUN && !def.dazed) {
      def.downT = JUGGLE.knockdown;
      def.stunTime = JUGGLE.knockdown + 0.35;
      def.land = 1;
    }
    spray(_v, dir, 18, 4);
    pool(def.x, 0.7);
    Burst.emit(_v.set(def.x, 0.15, PLANE_Z), 0xC9BCA2, 30, 5, 0.9);
    spawnRing(_v, 0xE8DCC4);
    impact('heavy', { victim: def.slot === 0 ? 0 : 1, scale: 1.2 });
    addTrauma(0.35);
    Sfx.land(1, def.x);
    Sfx.bass(1, def.x);
    // the thrower turns to face where they put them
    att.face = dir;
  }
}

export function resetThrows(): void {
  grab = null;
}
