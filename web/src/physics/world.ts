import RAPIER, { type RigidBody, type World } from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { GRAVITY } from '../config/constants';
import type { Vec3Like } from './port';

/*
  The Rapier world and the bridge from bodies to meshes.

  Stepping: the world's timestep is the simulation rate (1/120 s), and step()
  is only ever called from the fixed simulation step — never from a render
  frame — so physics advances exactly as far as the match does, and a
  hit-stop or a pause freezes the props with everything else.

  Syncing: meshes are NOT written on step. Each bound body keeps its pose
  before and after the last step, and interpolate(alpha) blends between them
  once per displayed frame. On a 144 Hz display running a 120 Hz simulation
  that is the difference between smooth motion and a visible judder.
*/

export interface BodyBinding {
  readonly body: RigidBody;
  readonly object: THREE.Object3D;
  readonly prevP: THREE.Vector3;
  readonly prevQ: THREE.Quaternion;
  readonly currP: THREE.Vector3;
  readonly currQ: THREE.Quaternion;
}

type Hook = () => void;

export function readPose(body: RigidBody, p: THREE.Vector3, q: THREE.Quaternion): void {
  const t = body.translation();
  const r = body.rotation();
  p.set(t.x, t.y, t.z);
  q.set(r.x, r.y, r.z, r.w);
}

export class PhysicsWorld {
  readonly world: World;
  readonly dt: number;

  private readonly bindings: BodyBinding[] = [];
  private readonly dynamics = new Set<RigidBody>();
  private readonly beforeHooks: Hook[] = [];
  private readonly afterHooks: Hook[] = [];
  private readonly scratch = new THREE.Vector3();
  private steps = 0;

  constructor(simHz: number) {
    this.world = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.dt = 1 / simHz;
    this.world.timestep = this.dt;
  }

  get stepCount(): number {
    return this.steps;
  }

  get dynamicCount(): number {
    return this.dynamics.size;
  }

  /** Drive `object` from `body`. The object's transform is owned by physics from here on. */
  bind(body: RigidBody, object: THREE.Object3D): BodyBinding {
    const b: BodyBinding = {
      body, object,
      prevP: new THREE.Vector3(), prevQ: new THREE.Quaternion(),
      currP: new THREE.Vector3(), currQ: new THREE.Quaternion(),
    };
    this.bindings.push(b);
    this.snap(b);
    return b;
  }

  /** Jump a binding to its body's pose with no blend — after a teleport, so it doesn't streak across the stage. */
  snap(b: BodyBinding): void {
    readPose(b.body, b.currP, b.currQ);
    b.prevP.copy(b.currP);
    b.prevQ.copy(b.currQ);
    b.object.position.copy(b.currP);
    b.object.quaternion.copy(b.currQ);
  }

  /** Register a dynamic body as a target for blasts. */
  addDynamic(body: RigidBody): void {
    this.dynamics.add(body);
  }

  onBeforeStep(fn: Hook): void {
    this.beforeHooks.push(fn);
  }

  onAfterStep(fn: Hook): void {
    this.afterHooks.push(fn);
  }

  step(): void {
    this.hold();
    this.world.step();
    this.steps++;
    for (const b of this.bindings) {
      if (!b.body.isSleeping()) readPose(b.body, b.currP, b.currQ);
    }
    for (const fn of this.afterHooks) fn();
  }

  /* Collapse the blend window. Without this, a paused match would keep
     interpolating between its last two poses as the loop's alpha cycles, and
     every prop would visibly shiver in place. */
  hold(): void {
    for (const b of this.bindings) {
      b.prevP.copy(b.currP);
      b.prevQ.copy(b.currQ);
    }
    for (const fn of this.beforeHooks) fn();
  }

  interpolate(alpha: number): void {
    for (const b of this.bindings) {
      b.object.position.lerpVectors(b.prevP, b.currP, alpha);
      b.object.quaternion.slerpQuaternions(b.prevQ, b.currQ, alpha);
    }
  }

  /*
    Every registered dynamic body is tested directly rather than through a
    shape query: there are ~70 of them, most disabled or asleep, and a linear
    pass is cheaper than a broad-phase query at that size. The impulse is
    scaled by mass so an urn and a pebble react to one blast in proportion.
  */
  blast(center: Vec3Like, dirX: number, strength: number, radius: number, lift = 0.45): void {
    const d = this.scratch;
    for (const b of this.dynamics) {
      if (!b.isEnabled()) continue;
      const p = b.translation();
      d.set(p.x - center.x, p.y - center.y, p.z - center.z);
      const dist = d.length();
      if (dist > radius) continue;

      const falloff = (1 - dist / radius) ** 2;
      if (dist > 1e-4) d.divideScalar(dist);
      else d.set(0, 0, 0);
      d.x += dirX * 0.9;
      d.y = Math.max(d.y, 0) + lift;
      d.normalize();

      const k = strength * falloff * b.mass();
      b.applyImpulse({ x: d.x * k, y: d.y * k, z: d.z * k }, true);
      b.applyTorqueImpulse({
        x: (Math.random() - 0.5) * k * 0.3,
        y: (Math.random() - 0.5) * k * 0.3,
        z: -dirX * k * 0.25,
      }, true);
    }
  }

  countAwake(): number {
    let n = 0;
    for (const b of this.dynamics) if (b.isEnabled() && !b.isSleeping()) n++;
    return n;
  }

  dispose(): void {
    this.bindings.length = 0;
    this.dynamics.clear();
    this.beforeHooks.length = 0;
    this.afterHooks.length = 0;
    this.world.free();                               // releases every body, collider and controller in WASM memory
  }
}
