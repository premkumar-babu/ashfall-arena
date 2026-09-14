import * as THREE from 'three/webgpu';
import { scene } from '../render/stage';

/*
  Hit and hurt volumes. Each is an axis-aligned box that follows an anchor
  object on the primitive rig. The rig is invisible once a model loads, but it
  keeps posing underneath — and these boxes are the reason it has to: every
  collision in the game is resolved against them, not against the model.
*/

export interface Volume {
  readonly anchor: THREE.Object3D;
  readonly size: THREE.Vector3;
  readonly box: THREE.Box3;
  readonly helper: THREE.Box3Helper;
}

const helpers: THREE.Box3Helper[] = [];
let showBoxes = false;
const _wp = new THREE.Vector3();

export function makeVolume(anchor: THREE.Object3D, sx: number, sy: number, sz: number, color: number): Volume {
  const box = new THREE.Box3();
  const helper = new THREE.Box3Helper(box, color);
  const mat = helper.material as THREE.LineBasicMaterial;
  mat.depthTest = false;
  mat.transparent = true;
  mat.opacity = 0.9;
  helper.renderOrder = 999;
  helper.visible = showBoxes;
  scene.add(helper);
  helpers.push(helper);
  return { anchor, size: new THREE.Vector3(sx, sy, sz), box, helper };
}

/** Recentre a volume on its anchor's current world position. */
export function syncVolume(vol: Volume): void {
  vol.anchor.getWorldPosition(_wp);
  vol.box.setFromCenterAndSize(_wp, vol.size);
}

export function debugBoxesOn(): boolean {
  return showBoxes;
}

export function setDebugBoxes(on: boolean): void {
  showBoxes = on;
  for (const h of helpers) h.visible = on;
}

export function resetVolumes(): void {
  helpers.length = 0;
  showBoxes = false;
}
