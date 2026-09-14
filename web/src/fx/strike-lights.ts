import type * as THREE from 'three/webgpu';
import { PLANE_Z } from '../config/constants';
import { damp } from '../core/math';
import { state } from '../game/state';
import { legacyIntensity, pointLight } from '../render/lights';
import { scene } from '../render/stage';

/*
  One point light per fighter that rides whichever attack hitbox is live,
  lighting the ground and both bodies, and flares white-hot on contact.

  Both are kept in the scene permanently at intensity 0 rather than added on
  demand: the light count is compiled into every lit shader, so a light that
  appears mid-fight recompiles every material on screen on the frame it
  arrives. On WebGPU that is a visible hitch, on the very frame a hit lands.
*/
export const strikeLights: THREE.PointLight[] = [];

const _lp = { x: 0, y: 0, z: 0 };
const ARMED = legacyIntensity(0.9);

export function initStrikeLights(): void {
  for (let i = 0; i < 2; i++) {
    const L = pointLight(0xffffff, 0, 9);
    L.position.set(0, 2, PLANE_Z);
    scene.add(L);
    strikeLights.push(L);
  }
}

export function updateStrikeLights(dt: number): void {
  const fighters = state.fighters;
  for (let i = 0; i < 2; i++) {
    const f = fighters[i]!;
    const L = strikeLights[i]!;
    let base = 0;
    if (f.activeHitbox) {
      const c = f.activeHitbox.box.getCenter(L.position);
      _lp.x = c.x; _lp.y = c.y; _lp.z = c.z;
      L.color.setHex(f.def.accent);
      base = ARMED;
    }
    L.intensity = damp(L.intensity, base, 7, dt);
  }
}

export function resetStrikeLights(): void {
  strikeLights.length = 0;
}
