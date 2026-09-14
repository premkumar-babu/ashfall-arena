import { rigs } from '../game/rigs';
import { state } from '../game/state';

/*
  The physics port: everything the game is allowed to know about physics.

  Game code (movement, collision, rounds, the front end) imports this file and
  nothing under it. The Rapier implementation lives behind it in
  rapier-physics.ts and is loaded with a dynamic import, which does two things:

  - Rapier's WASM (~2 MB, embedded) lands in its own chunk instead of
    delaying the first paint of the title screen.
  - If it cannot load — a blocked WASM policy, an old browser — `physics`
    stays null, and every call site degrades to the original kinematic
    movement. The game is still fully playable; only the props and debris
    are missing.
*/

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The result of one character-controller move, in game units (feet position). */
export interface MoveResult {
  x: number;
  /** Feet height above the floor. */
  y: number;
  /** Standing on something after this move. */
  grounded: boolean;
  /** Vertical distance actually travelled — less than asked when something was in the way. */
  movedY: number;
}

/** A fighter's physical body: a capsule moved by a character controller. */
export interface CharacterBody {
  /** Place the body without sweeping — round starts, returning to select. */
  teleport(x: number, feetY: number): void;
  /** Sweep the capsule by (dx, dy), sliding along and stopping at whatever it hits. */
  move(dx: number, dy: number): MoveResult;
}

export interface PhysicsStats {
  readonly steps: number;
  readonly dynamic: number;
  readonly awake: number;
}

export interface PhysicsPort {
  /** One body per player slot, attached to whichever fighter holds that slot. */
  readonly fighters: readonly [CharacterBody, CharacterBody];
  /** Advance the world one fixed step. Called from the simulation step only. */
  step(): void;
  /** A simulation step passed without stepping physics (pause, hit-stop, menus). */
  hold(): void;
  /** Copy body poses onto meshes, blended between the last two steps. Once per displayed frame. */
  interpolate(alpha: number): void;
  /** Radial impulse on every dynamic body near `center`, biased along `dirX`. */
  blast(center: Vec3Like, dirX: number, strength: number, radius: number, lift?: number): void;
  /** Stone chips thrown up from `at`. */
  spawnDebris(at: Vec3Like, dirX: number, count: number, speed?: number, tint?: number): void;
  resetProps(): void;
  clearDebris(): void;
  setDebugDraw(on: boolean): void;
  stats(): PhysicsStats;
  dispose(): void;
}

export let physics: PhysicsPort | null = null;

export function setPhysics(port: PhysicsPort | null): void {
  physics = port;
}

function detachAll(): void {
  for (const side of rigs) for (const f of side) f.physicsBody = null;
}

/** Hand the two slot bodies to the fighters currently in P1 and P2, and place them where the fighters stand. */
export function attachFighterBodies(): void {
  detachAll();
  if (!physics) return;
  const [b1, b2] = physics.fighters;
  state.P1.physicsBody = b1;
  state.P2.physicsBody = b2;
  b1.teleport(state.P1.x, state.P1.y);
  b2.teleport(state.P2.x, state.P2.y);
}

export function disposePhysics(): void {
  detachAll();
  physics?.dispose();
  physics = null;
}
