import * as THREE from 'three/webgpu';
import { A, BOUND, GRAVITY, PLANE_Z, S } from '../config/constants';
import { ASSIST_COMMON as AC } from '../config/roster';
import { Sfx } from '../audio/sfx';
import { impact } from '../fx/juice';
import { clamp, damp } from '../core/math';
import { Burst } from '../fx/particles';
import { fireScorch, firePortal, spawnArc, spawnRing } from '../fx/vfx';
import { physics } from '../physics/port';
import { legacyIntensity } from '../render/lights';
import type { Assist } from './assist-rig';
import type { Fighter } from './fighter';
import { match } from './match';

/*
  A summon's life: DORMANT off-stage → RUSH in along the floor → STRIKE → RETREAT
  back out along the floor → DORMANT.

  Rush and retreat stay on the ground plane. Earlier builds had the idol cruise
  in at head height, bob on a sine and retreat hovering, which is what read as
  a summon flying rather than arriving. The vertical drama — the wraith's leap
  arc, the idol's rise before its slam — belongs to STRIKE, where it is the move.
*/

const _v = new THREE.Vector3();
const STRIKE_GLOW = legacyIntensity(1.8);
const IDLE_GLOW = legacyIntensity(0.7);

export function launchAssist(a: Assist, foe: Fighter): void {
  const owner = a.owner!;
  a.dir = foe.x >= owner.x ? 1 : -1;
  a.x = owner.x - a.dir * AC.spawnBack;
  a.y = 0;
  a.vy = 0;
  a.t = 0;
  a.hitLanded = false;
  a.quaked = false;
  a.orbT = -1;                          // no orb thrown yet this call; fireOrb sets it to 0
  a.state = A.RUSH;
  a.group.visible = true;
  firePortal(a.portal, a.x, AC.z, a.def.color);
  a.orb.visible = false;
  a.orbActive = false;
  a.wave.visible = false;
}

export function retireAssist(a: Assist | null): void {
  if (!a) return;
  a.state = A.DORMANT;
  a.group.visible = false;
  a.group.position.set(a.slot === 0 ? -60 : 60, -40, AC.z);
  a.group.scale.setScalar(1);
  // the select preview shrinks it; restore the procedural parts for the match
  if (!a.model) for (const p of a.primParts) p.visible = true;
  a.orb.visible = false;
  a.orbActive = false;
  a.wave.visible = false;
  a.parts.lamp.intensity = 0;
  a.hitbox.helper.visible = false;
  a.orbBox.helper.visible = false;
}

export function stepAssist(a: Assist | null, foe: Fighter, dt: number, t: number): void {
  if (!a) return;
  if (a.state === A.DORMANT) {
    stepOrb(a, dt);
    stepWave(a, dt);
    return;
  }
  // a summon whose caller is down, or one mid-attack when the round ends, must
  // break off rather than keep swinging at a corpse
  if (a.state !== A.RETREAT && (match.over || a.owner?.state === S.KO)) {
    a.state = A.RETREAT;
    a.t = 0;
  }
  const d = a.def;
  a.t += dt;

  switch (a.state) {
    case A.RUSH:
      a.x += a.dir * d.rushSpeed * dt;
      a.y = 0;
      if (Math.abs(a.x - foe.x) < d.strikeRange || a.t > AC.rushTimeout) {
        a.state = A.STRIKE;
        a.t = 0;
        if (d.pattern === 'leap') {
          a.vy = 8.6;
          spawnArc(a.x, a.y + 1.7, a.dir, d.color, 1.5);
        }
        Sfx.arrive(a.x);
      }
      break;

    case A.STRIKE:
      if (d.pattern === 'leap') {
        a.vy += GRAVITY * dt;
        a.y = Math.max(0, a.y + a.vy * dt);
        a.x += a.dir * 6.2 * dt;
        /* One orb per call. The check used to be "no orb in flight", so the
           moment an orb hit and was spent a fresh one was thrown — a single
           summon could land its orb two or three times. */
        if (d.orb && a.orbT < 0 && !a.hitLanded && a.t >= (d.orbAt ?? 0)) fireOrb(a);
        if (a.t > 0.62 || (a.y <= 0 && a.t > 0.3)) {
          a.state = A.RETREAT;
          a.t = 0;
        }
      } else {
        // the idol rises from the floor to 1.9 and commits quickly; the slam is the move
        if (a.t < 0.18) a.y = damp(a.y, 1.9, 16, dt);
        else a.y = Math.max(0, a.y - 26 * dt);

        if (!a.quaked && a.y <= 0.02 && a.t > 0.24) {
          a.quaked = true;
          a.wave.visible = true;
          a.wave.material.opacity = 0.95;
          a.wave.scale.setScalar(0.6);
          a.wave.position.set(a.x, 0.06, AC.z);
          Burst.emit(_v.set(a.x, 0.4, PLANE_Z), d.color, 54, 8.5, 0.9);
          impact('quake');
          fireScorch(a.scorch, a.x, AC.z);
          // the slam is the biggest blow in the game: everything loose on the stage jumps
          physics?.blast(_v.set(a.x, 0.1, PLANE_Z), 0, 11, 7.5, 1.0);
          physics?.spawnDebris(_v, 0, 16, 1.3, d.color);
          spawnArc(a.x, 0.9, a.dir, d.color, 1.9);
          spawnRing(_v.set(a.x, 0.5, PLANE_Z), d.color);
          Sfx.quake(a.x);
        }
        if (a.t > 0.9) {
          a.state = A.RETREAT;
          a.t = 0;
        }
      }
      break;

    case A.RETREAT:
      a.x -= a.dir * AC.retreatSpeed * dt;
      a.y = damp(a.y, 0, 9, dt);
      if (Math.abs(a.x - a.owner!.x) > AC.despawnBack || Math.abs(a.x) > BOUND + AC.despawnBack) retireAssist(a);
      break;
  }

  if (a.y < 0) a.y = 0;              // never intersect the arena floor
  a.group.position.set(a.x, a.y, AC.z);
  if (a.state === A.RUSH || a.state === A.STRIKE) a.trail.push(a.x, a.y, AC.z);
  a.trail.fade(dt);
  a.group.rotation.y = damp(a.group.rotation.y, a.dir * Math.PI / 2, 14, dt);
  a.group.rotation.z = a.state === A.STRIKE && d.pattern === 'leap' ? -a.dir * 0.34 : -a.dir * 0.14;

  a.parts.core.rotation.y += dt * 5;
  a.parts.core.scale.setScalar(1 + Math.sin(t * 14) * 0.14);

  // the lamp doubles as the summon's strike light: it rides the live hitbox
  // through the strike and flares when the blow connects
  if (a.state === A.STRIKE) a.hitbox.box.getCenter(a.parts.lamp.position);
  else a.parts.lamp.position.set(a.x, a.y + 1.6, AC.z);
  a.parts.lamp.intensity = damp(a.parts.lamp.intensity, a.state === A.STRIKE ? STRIKE_GLOW : IDLE_GLOW, 6, dt);

  if (d.build === 'wraith') {
    a.parts.blades.forEach((bl, i) => {
      const open = a.state === A.STRIKE ? 1 : 0;
      bl.rotation.x = damp(bl.rotation.x, 1.15 - open * 1.9, 16, dt);
      bl.rotation.z = damp(bl.rotation.z, (i ? 1 : -1) * (0.35 + open * 0.5), 16, dt);
    });
    a.parts.tatters.forEach((tt, i) => {
      tt.rotation.x = Math.sin(t * 7 + i) * 0.35 - 0.5;
    });
  } else {
    a.parts.blades.forEach((arm, i) => {
      const s = i % 2 ? 1 : -1;
      arm.rotation.z = damp(arm.rotation.z, s * (a.state === A.STRIKE ? -0.9 : -0.35), 14, dt);
    });
  }

  // the shockwave's hitbox grows outward along X while it is active
  if (d.pattern === 'slam' && a.quaked) {
    const k = clamp((a.t - d.activeFrom) / (d.activeTo - d.activeFrom), 0, 1);
    a.hitbox.size.set(2.0 + k * 5.4, 1.1, 1.2);
  }

  stepOrb(a, dt);
  stepWave(a, dt);
}

function fireOrb(a: Assist): void {
  a.orbActive = true;
  a.orbT = 0;
  a.orbX = a.x + a.dir * 0.6;
  a.orbY = a.y + 1.5;
  a.orb.visible = true;
  Sfx.whiff(a.x);
}

function stepOrb(a: Assist, dt: number): void {
  if (!a.orbActive) return;
  const d = a.def;
  a.orbT += dt;
  a.orbX += a.dir * (d.orbSpeed ?? 0) * dt;
  a.orbY += Math.sin(a.orbT * 16) * 0.012;
  a.orb.position.set(a.orbX, a.orbY, AC.z * 0.5);
  a.orbCore.rotation.set(a.orbT * 8, a.orbT * 6, 0);
  a.orbHalo.scale.setScalar(1 + Math.sin(a.orbT * 20) * 0.16);
  if (Math.random() < 0.6) Burst.emit(a.orb.position, d.color, 1, 1.1, 0);
  if (a.orbT > (d.orbLife ?? 0) || Math.abs(a.orbX) > BOUND + 3) {
    a.orbActive = false;
    a.orb.visible = false;
    a.orbBox.helper.visible = false;
  }
}

function stepWave(a: Assist, dt: number): void {
  if (!a.wave.visible) return;
  const s = a.wave.scale.x + dt * 13;
  a.wave.scale.x = a.wave.scale.y = s;
  a.wave.material.opacity -= dt * 1.9;
  if (a.wave.material.opacity <= 0) a.wave.visible = false;
}
