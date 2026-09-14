import * as THREE from 'three/webgpu';
import { LEGACY_LIGHT_SCALE } from '../config/constants';

/** Convert an intensity tuned under three.js's legacy (pre-r155) light units. */
export function legacyIntensity(value: number): number {
  return value * LEGACY_LIGHT_SCALE;
}

/*
  Point lights changed more than their units between r128 and r186.

  Legacy mode faded a point light as pow(1 - d/distance, decay): a soft ramp to
  zero at `distance`, never brighter than full intensity. Physical mode uses
  inverse-square — 1/d², clamped at 100× — windowed to zero at `distance`. The
  same numbers under the new formula make every lantern, strike light and
  assist glow blow out within a unit of its centre.

  decay 0 turns the inverse-square term off and keeps only the distance window,
  which is the closest the physical model gets to the old behaviour. Every
  point light in the game is made here so that choice is made once.
*/
export function pointLight(color: THREE.ColorRepresentation, intensity: number, distance: number): THREE.PointLight {
  return new THREE.PointLight(color, legacyIntensity(intensity), distance, 0);
}
