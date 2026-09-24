import RAPIER, { type ColliderDesc } from '@dimforge/rapier3d-compat';
import { BOUND } from '../config/constants';
import { CAPSULE } from './character';
import { BOUNDS, SCENERY } from './groups';
import type { PhysicsWorld } from './world';

/*
  Static colliders for the courtyard.

  Simple primitives rather than trimeshes built from the render geometry: the
  arena is thousands of triangles of roof tiles and balusters that nothing
  ever touches, and a cuboid per solid thing is both cheaper to query and
  better behaved for sliding contacts. Coordinates mirror world/arena.ts —
  move a statue there and move its collider here.
*/
export function buildArenaColliders(pw: PhysicsWorld): void {
  const w = pw.world;
  const fixed = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const add = (desc: ColliderDesc, x: number, y: number, z: number, groups = SCENERY): void => {
    w.createCollider(desc.setTranslation(x, y, z).setCollisionGroups(groups).setFriction(0.8), fixed);
  };

  // courtyard floor: top face at y = 0, a little wider than the dais
  add(RAPIER.ColliderDesc.cuboid(34, 0.5, 34), 0, -0.5, 0);

  // stone balustrade behind the duel (arena.ts: 28 wide at z = -6.4)
  add(RAPIER.ColliderDesc.cuboid(14, 0.52, 0.33), 0, 0.52, -6.4);

  // guardian lions: pedestal plus the seated body
  for (const x of [-9.2, 9.2]) {
    add(RAPIER.ColliderDesc.cuboid(0.86, 0.66, 0.86), x, 0.66, -4.6);
    add(RAPIER.ColliderDesc.cuboid(0.40, 0.62, 0.62), x, 1.95, -4.6);
  }

  // lantern posts
  for (const [px, pz] of [[-13.5, -11.5], [-8.6, -8.2], [8.6, -8.2], [13.5, -11.5]] as const) {
    add(RAPIER.ColliderDesc.cylinder(3.6, 0.26), px, 3.6, pz);
  }

  /* The duel's bounds. The old movement code clamped the root at ±BOUND; these
     walls stand one capsule radius further out, so the controller stops the
     root at exactly the same place — but now a knockback slide into the wall
     is a real contact, and the pushbox can no longer shove a cornered fighter
     through it. Fighter-only (see groups.ts). */
  const wallX = BOUND + CAPSULE.radius + CAPSULE.skin + 0.5;
  for (const side of [-1, 1]) {
    add(RAPIER.ColliderDesc.cuboid(0.5, 12, 4), side * wallX, 12, 0, BOUNDS);
  }
}
