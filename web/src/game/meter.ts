import * as THREE from 'three/webgpu';
import { A, METER, PLANE_Z, S } from '../config/constants';
import { Sfx } from '../audio/sfx';
import { clamp } from '../core/math';
import { Flip } from '../fx/flipbook';
import { Burst } from '../fx/particles';
import { announce } from '../ui/announcer';
import { launchAssist } from './assist';
import type { Fighter } from './fighter';
import { ACT, type Intent } from './intent';
import { match } from './match';

/*
  One meter, two ways to spend it. Half buys a summon with a six-second
  lockout; all of it buys eight seconds of Overdrive at double speed. While
  Overdrive runs, the meter is fuel draining away, not currency — so it can
  neither gain nor pay for a summon.
*/

const _v = new THREE.Vector3();

export function gainMeter(f: Fighter, amount: number): void {
  if (f.powered) return;
  f.meter = clamp(f.meter + amount, 0, METER.max);
}

export function stepMeter(f: Fighter, intent: Intent, foe: Fighter, dt: number): void {
  if (f.assistCd > 0) f.assistCd = Math.max(0, f.assistCd - dt);
  if (f.powered) {
    f.meter -= METER.powerDrain * dt;
    if (f.meter <= 0) {
      f.meter = 0;
      f.powered = false;
      f.powerLight.intensity = 0;
    }
  } else if (!match.over && f.state !== S.KO) {
    gainMeter(f, METER.regen * dt);
  }
  if (match.over || f.state === S.KO) return;
  // a buffered summon pressed a moment before the meter filled still comes out
  if (intent.assistDown && tryAssist(f, foe)) intent.consumed |= ACT.ASSIST;
  if (intent.powerDown && tryPower(f)) intent.consumed |= ACT.POWER;
}

function tryAssist(f: Fighter, foe: Fighter): boolean {
  if (f.powered) return false;
  if (f.meter < METER.assistCost || f.assistCd > 0) return false;
  const a = f.assist;
  if (!a || a.state !== A.DORMANT) return false;
  f.meter -= METER.assistCost;
  f.assistCd = METER.assistCooldown;
  launchAssist(a, foe);
  announce(a.def.name, 900, 'toast');
  Sfx.call();
  return true;
}

function tryPower(f: Fighter): boolean {
  if (f.powered || f.meter < METER.powerCost) return false;
  f.powered = true;
  announce('OVERDRIVE', 1000, 'toast');
  Sfx.power();
  Burst.emit(_v.set(f.x, 1.4, PLANE_Z), f.def.accent, 46, 6.5, 0.4);
  Flip.play('charge', _v.set(f.x, 1.7, PLANE_Z - 0.2), 3.4, f.def.accent, 0, 0.85);
  match.shake = 0.5;
  return true;
}
