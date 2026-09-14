import type * as THREE from 'three/webgpu';
import type { FighterState } from '../config/constants';

export type { BoneRig } from './bones';

export type ActionMap = Partial<Record<FighterState, THREE.AnimationAction>>;

/** Anything clips can be bound to and played on: fighters and summons alike. */
export interface AnimTarget {
  model: THREE.Object3D | null;
  mixer: THREE.AnimationMixer | null;
  actions: ActionMap | null;
  currentAction: THREE.AnimationAction | null;
  /** Slots filled by a guess rather than a matched clip, which the shared library may replace. */
  standIn: Partial<Record<FighterState, boolean>>;
  libBound: boolean;
}
