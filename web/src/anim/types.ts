import type * as THREE from 'three/webgpu';
import type { FighterState } from '../config/constants';

export type { BoneRig } from './bones';

/* Locomotion slots sit beside the state machine's: RUN and LAND are not states
   a fighter can be in, they are how IDLE, WALK and JUMP look at a given speed. */
export type LocoSlot = 'RUN' | 'LAND';
/* Moments that are not states either: the throw's own hurl, the recoil of a
   blow caught on the guard, the bash that follows a parry, and the round
   winner's pose. Each is chosen by bodySlot() from what the fighter is doing. */
export type MomentSlot = 'THROW' | 'BLOCK_HIT' | 'RIPOSTE' | 'WIN' | 'INTRO';
export type AnimSlot = FighterState | LocoSlot | MomentSlot;

export type ActionMap = Partial<Record<AnimSlot, THREE.AnimationAction>>;

/** Anything clips can be bound to and played on: fighters and summons alike. */
export interface AnimTarget {
  model: THREE.Object3D | null;
  mixer: THREE.AnimationMixer | null;
  actions: ActionMap | null;
  currentAction: THREE.AnimationAction | null;
  /** Slots filled by a guess rather than a matched clip, which the shared library may replace. */
  standIn: Partial<Record<AnimSlot, boolean>>;
  libBound: boolean;
}
