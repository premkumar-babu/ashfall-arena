import * as THREE from 'three/webgpu';
import { A, FLASH_FRAMES, JUGGLE, METER, MOVES, PAL, PLANE_Z, S } from '../config/constants';
import { MOVEMENT } from '../config/controls';
import { Sfx } from '../audio/sfx';
import { clamp } from '../core/math';
import { pool, spray } from '../fx/blood';
import { Flip } from '../fx/flipbook';
import { impact, knockout } from '../fx/juice';
import { Burst } from '../fx/particles';
import { strikeLights } from '../fx/strike-lights';
import { spark, spawnRing, spawnRingLater, spawnStreaks } from '../fx/vfx';
import { legacyIntensity } from '../render/lights';
import { hitFeedback } from '../input/feedback';
import { physics } from '../physics/port';
import type { Assist } from './assist-rig';
import { damageScale } from './bot';
import type { BodyPart, Fighter } from './fighter';
import { beginFinish, decides, endFinish, finishing, finishVictim, inFatality } from './finish';
import { maybeToasty } from '../ui/toasty';
import { fatalArmored, inFatalBlow } from './fatalblow';
import { firstHit } from '../ui/banner';
import { enterState, type Limb } from './fsm';
import { bumpCombo, clearCombo, endRound, match } from './match';
import { gainMeter } from './meter';
import { applyFlash } from './pose';
import { state } from './state';
import { debugBoxesOn, syncVolume } from './volumes';

/*
  Hits are resolved box-against-box: a live hitbox on the primitive rig against
  the other fighter's hurtboxes. The overlap of the two boxes IS the contact
  point, which is where the spark, the ring and the impact art are drawn.

  Runs in the fixed simulation step, so an active window is the same number of
  checks on every display.
*/

const _center = new THREE.Vector3();
const _contactBox = new THREE.Box3();
const _contact = new THREE.Vector3();
const _feet = new THREE.Vector3();

const BLOCK_FLARE = legacyIntensity(0.9);
const HIT_FLARE = legacyIntensity(1.8);

export interface HitOptions {
  owner: Fighter | null;
  attacker: Fighter | null;
  fromX: number;
  dir: number;
  damage: number;
  mult?: number;
  knockback: number;
  hitstun: number;
  shake: number;
  contact?: THREE.Vector3 | null;
  height?: number;
  label: string;
  part?: BodyPart;
  lightSource?: THREE.PointLight | null;
  sparkColor?: number;
  burst?: number;
  burstSpeed?: number;
  extraRings?: number;
  /** Upward speed for a grounded victim: a launcher or a trip. */
  launch?: number;
}

export function syncBoxes(f: Fighter): void {
  f.root.updateMatrixWorld(true);
  for (const h of f.hurtboxes) syncVolume(h.vol);
  syncVolume(f.hitboxes.fist);
  syncVolume(f.hitboxes.foot);
  if (f.def.armed) syncVolume(f.hitboxes.blade);
  if (!debugBoxesOn()) return;

  for (const h of f.hurtboxes) h.vol.helper.visible = true;
  const live = f.activeHitbox;
  const limbs: Limb[] = f.def.armed ? ['fist', 'foot', 'blade'] : ['fist', 'foot'];
  for (const k of limbs) {
    const vol = f.hitboxes[k];
    vol.helper.visible = true;
    const mat = vol.helper.material as THREE.LineBasicMaterial;
    const isLive = live === vol;
    mat.color.setHex(isLive ? PAL.strike : 0x5a4038);
    mat.opacity = isLive ? 1 : 0.28;
  }
}

export function assistStriking(a: Assist | null): boolean {
  if (!a || a.state !== A.STRIKE || a.hitLanded) return false;
  if (a.def.pattern === 'slam' && !a.quaked) return false;
  return a.t >= a.def.activeFrom && a.t <= a.def.activeTo;
}

export function syncAssistBoxes(a: Assist | null): void {
  if (!a) return;
  if (a.state !== A.DORMANT) {
    a.group.updateMatrixWorld(true);
    syncVolume(a.hitbox);
  }
  if (a.orbActive) {
    a.orb.updateMatrixWorld(true);
    syncVolume(a.orbBox);
  }
  if (!debugBoxesOn()) return;
  a.hitbox.helper.visible = a.state !== A.DORMANT;
  (a.hitbox.helper.material as THREE.LineBasicMaterial).opacity = assistStriking(a) ? 1 : 0.25;
  a.orbBox.helper.visible = a.orbActive;
}

export function landHit(def: Fighter, o: HitOptions): boolean {
  // nothing else lands while a fatality or a fatal blow owns the screen
  if (def.state === S.KO || match.over || inFatality() || inFatalBlow()) return false;
  // a fatal blow's startup is armoured: the blow glances off
  if (fatalArmored(def)) {
    spark(_center.set(def.x, 1.8, PLANE_Z + 0.3), 0xFFE2A8);
    Sfx.block(def.x);
    return false;
  }

  const facingAttacker = (o.fromX - def.x) * def.face > 0;
  const blocked = def.state === S.BLOCK && facingAttacker;
  // follow-ups on a launched fighter are scaled, so a juggle is a reward, not a kill from full
  const juggling = !def.grounded && def.launched;
  const dmg = blocked ? o.damage * 0.22 : o.damage * (o.mult ?? 1) * (juggling ? JUGGLE.damage : 1);

  const before = def.hp;
  def.hp = Math.max(0, def.hp - dmg);
  // tallied off the real drop, so chip on a guard counts once and an overkill
  // does not bank damage the fighter never had
  if (o.owner) {
    o.owner.dealt += before - def.hp;
    gainMeter(o.owner, dmg * METER.perDamageDealt);
  }
  gainMeter(def, blocked ? METER.perBlock : dmg * METER.perDamageTaken);

  if (o.contact) _center.copy(o.contact);
  else _center.set((o.fromX + def.x) / 2, o.height ?? 1.9, PLANE_Z + 0.3);

  if (o.lightSource) {
    o.lightSource.position.copy(_center);
    o.lightSource.color.setHex(blocked ? PAL.spectre : (o.sparkColor ?? PAL.hot));
    o.lightSource.intensity = blocked ? BLOCK_FLARE : HIT_FLARE;
  }

  if (blocked) {
    def.vx = 0;
    def.blockFlash = 1;
    if (o.attacker) o.attacker.vx -= o.dir * 3.4;
    impact('block', { victim: def.slot === 0 ? 0 : 1 });
    spark(_center, PAL.spectre);
    spawnRing(_center, 0x9FE8FF);
    // a guard reads as a flat flash, not a burst
    Flip.play('clash', _center, 1.35, 0x9FE8FF, Math.random() * 6.28);
    Burst.emit(_center, PAL.spectre, 14, 4.5, 0.2);
    physics?.blast(_center, o.dir, 1.4, 2.2);
    Sfx.block(_center.x);
    hitFeedback(o.owner?.slot ?? null, def.slot, 'block');
    // a guard breaks the string
    if (o.owner && o.owner.combo) {
      o.owner.combo = 0;
      o.owner.comboTimer = 0;
      clearCombo(o.owner);
    }
    match.lastTrade = `${o.label} → BLOCKED`;
  } else {
    def.vx = o.dir * o.knockback;
    def.flash = 1;
    def.white = FLASH_FRAMES;          // blown-out white for the freeze + 2 frames
    applyFlash(def);                   // apply now: the freeze renders before the next pose
    // a blow on someone already down cannot stand them back up early
    def.stunTime = def.downT > 0 ? Math.max(o.hitstun, def.downT + 0.25) : o.hitstun;
    def.hitDir = o.dir;
    enterState(def, S.HITSTUN);
    if (o.attacker) o.attacker.vx -= o.dir * 1.2;
    if (o.owner) bumpCombo(o.owner, dmg);
    // the first clean blow of the round gets its own banner
    if (o.owner && !match.firstHit) {
      match.firstHit = true;
      firstHit(o.owner);
    }
    if (def.combo) {
      def.combo = 0;
      def.comboTimer = 0;
      clearCombo(def);
    }
    // drawn art at the point of contact; heavier blows get the big sheet
    const heavy = o.damage >= 10;
    // summons hit hardest of all; a move's own shake value scales its row
    impact(o.attacker === null ? 'assist' : heavy ? 'heavy' : 'light', {
      victim: def.slot === 0 ? 0 : 1,
      scale: clamp(o.shake / (heavy ? 0.8 : 0.45), 0.7, 1.3),
    });
    spark(_center, o.sparkColor ?? PAL.hot);
    spawnRing(_center, o.sparkColor ?? 0xFFF2C0);
    Flip.play(heavy ? 'hit' : 'clash', _center, (heavy ? 2.4 : 1.5) + o.damage * 0.045, o.sparkColor ?? 0xFFE2A8, Math.random() * 6.28);
    spawnStreaks(_center, o.dir, o.sparkColor ?? 0xFFF2C0, heavy ? 9 : 5);
    // pooled and on the effect clock, so the echoes wait out a pause or a hit-stop
    for (let n = 0; n < (o.extraRings ?? 0); n++) spawnRingLater(_center, 0xFFF6DC, 0.07 + n * 0.08);
    Burst.emit(_center, o.sparkColor ?? PAL.hot, o.burst ?? 26, o.burstSpeed ?? 6.5, 0.25);
    // the blow carries into the world: nearby props take the shock, heavy hits chip the flagstones underfoot
    physics?.blast(_center, o.dir, heavy ? 6 : 3, heavy ? 4.2 : 2.8);
    if (heavy) physics?.spawnDebris(_feet.set(def.x, 0.15, PLANE_Z), o.dir, 5, 0.8);
    Sfx.hit(clamp(o.damage / 10, 0.4, 1.3), _center.x);
    hitFeedback(o.owner?.slot ?? null, def.slot, heavy ? 'heavy' : 'light');
    if (heavy) Sfx.bass(clamp(o.damage / 14, 0.5, 1.2), _center.x);
    match.lastTrade = `${o.label} → ${o.part ?? 'HIT'}`;

    /* Launchers and juggles. A launch throws a grounded fighter into the air,
       tumbling; a blow on someone already up there pops them again, a few
       times, and then gravity wins. A jump knocked out of the air comes down
       on its back too. The knockdown on landing is fsm.ts. */
    if (juggling) {
      def.juggles++;
      if (def.juggles <= JUGGLE.maxHits) def.vy = Math.max(def.vy, JUGGLE.pop);
      def.vx = o.dir * Math.min(o.knockback, 3.2);
    } else if (o.launch && def.grounded) {
      def.vy = o.launch;
      def.grounded = false;
      def.airTime = MOVEMENT.coyoteTime;
      def.launched = true;
      def.juggles = 0;
      if (o.launch > 10) {
        def.flip = 0.001;                  // a backward tumble over the whole flight
        def.flipDir = -1;
        def.flipTime = 1.0;
      }
    } else if (!def.grounded) {
      def.launched = true;
      def.vy = Math.max(def.vy, 3.5);
    }

    // the blood: more for heavier blows, most of all for a launcher
    const bleed = dmg * (heavy ? 2.3 : 1.5) * (o.launch && o.launch > 10 ? 1.7 : 1);
    spray(_center, o.dir, bleed, heavy ? 7.5 : 5.5);
    if (heavy) {
      Sfx.gore(clamp(o.damage / 14, 0.5, 1.1), _center.x);
      if (o.launch || o.damage >= 13) Sfx.crunch(_center.x);
    }
    if (o.launch && o.launch > 10) maybeToasty();
  }

  /* The round end is NOT called here. Resolving it inside the hit meant the
     first collision of the step closed the round, so a genuine simultaneous KO
     awarded the win to whichever hitbox happened to be tested first.
     settleKO() runs once both fighters have been resolved. */
  if (def.hp <= 0) {
    // the blow that would decide the match leaves them standing: FINISH THEM
    if (!blocked && decides(def)) {
      beginFinish(def);
      return true;
    }
    // the finishing blow on a fighter left standing is an ordinary K.O.
    if (finishVictim() === def) endFinish();
    def.dazed = false;
    def.vx = o.dir * o.knockback * 0.8;
    enterState(def, S.KO);
    spray(_center, o.dir, 70, 9);
    pool(def.x + o.dir * 0.9, 1.0);
    Sfx.gore(1.3, _center.x);
    Burst.emit(_center, PAL.strike, 60, 9, 0.5);
    Flip.play('burst', _center, 4.2, 0xFFD8A0, 0, 0.9);
    physics?.blast(_center, o.dir, 9, 6, 0.8);
    physics?.spawnDebris(_feet.set(def.x, 0.15, PLANE_Z), o.dir, 14, 1.2);
    hitFeedback(o.owner?.slot ?? null, def.slot, 'ko');
    // slow motion, a desaturated frame, the camera leaning in and the score muffled
    knockout(def);
  }
  return true;
}

/** Both fighters down on the same step reads as a double KO, not a win for whoever was tested first. */
export function settleKO(): void {
  if (match.over || finishing()) return;
  const { P1, P2 } = state;
  const d1 = P1.hp <= 0;
  const d2 = P2.hp <= 0;
  if (!d1 && !d2) return;
  if (d1 && d2) {
    endRound(null, 'DOUBLE K.O.');
    return;
  }
  const win = d1 ? P2 : P1;
  endRound(win, win.hp >= 100 ? 'FLAWLESS VICTORY' : 'K.O.');
}

export function resolveCombat(att: Fighter, def: Fighter): void {
  if (!att.activeHitbox || att.hitLanded || !att.move) return;
  if (def.state === S.KO || match.over) return;
  const hb = att.activeHitbox.box;
  for (const hurt of def.hurtboxes) {
    if (!hb.intersectsBox(hurt.vol.box)) continue;
    att.hitLanded = true;
    att.activeHitbox = null;
    _contactBox.copy(hb).intersect(hurt.vol.box);
    _contactBox.getCenter(_contact);
    const heavy = att.move === MOVES.KICK;
    landHit(def, {
      owner: att, attacker: att, fromX: att.x, dir: att.face,
      damage: att.move.damage * att.def.power * (heavy ? att.def.heavyMul : 1) * damageScale(att),
      mult: hurt.mult,
      knockback: att.move.knockback, hitstun: att.move.hitstun,
      shake: att.move.shake, contact: _contact, launch: att.move.launch,
      label: heavy ? att.def.heavy : att.move.name, part: hurt.part,
      lightSource: strikeLights[att.slot] ?? null,
    });
    return;
  }
}

export function resolveAssist(a: Assist | null, def: Fighter): void {
  if (!a || def.state === S.KO || match.over) return;
  const d = a.def;

  if (assistStriking(a)) {
    for (const hurt of def.hurtboxes) {
      if (!a.hitbox.box.intersectsBox(hurt.vol.box)) continue;
      a.hitLanded = true;
      _contactBox.copy(a.hitbox.box).intersect(hurt.vol.box);
      _contactBox.getCenter(_contact);
      landHit(def, {
        owner: a.owner, attacker: null, fromX: a.x, dir: a.dir,
        // summons ignore hit zones: a head or leg contact must not turn 10 into 13 or 8
        damage: d.damage, mult: 1,
        knockback: d.knockback, hitstun: d.hitstun,
        shake: 1.0, contact: _contact,
        label: d.name, part: hurt.part,
        sparkColor: d.color, burst: 58, burstSpeed: 9.5,
        lightSource: a.parts.lamp, extraRings: 2,
      });
      return;
    }
  }

  if (a.orbActive) {
    for (const hurt of def.hurtboxes) {
      if (!a.orbBox.box.intersectsBox(hurt.vol.box)) continue;
      _contactBox.copy(a.orbBox.box).intersect(hurt.vol.box);
      _contactBox.getCenter(_contact);
      // spend the orb only if the blow actually resolves, so a target that is
      // already down does not eat it
      const landed = landHit(def, {
        owner: a.owner, attacker: null, fromX: a.orbX, dir: a.dir,
        damage: d.orbDamage ?? 0, mult: 1,
        knockback: d.orbKnockback ?? 0, hitstun: d.orbHitstun ?? 0,
        shake: 0.8, contact: _contact,
        label: 'CINDER ORB', part: hurt.part,
        sparkColor: d.color, burst: 52, burstSpeed: 8.5,
        lightSource: a.parts.lamp,
      });
      if (!landed) return;
      a.orbActive = false;
      a.orb.visible = false;
      a.orbBox.helper.visible = false;
      return;
    }
  }
}
