import RAPIER, { type ColliderDesc } from '@dimforge/rapier3d-compat';
import { SCENERY } from './groups';
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

  /* No side walls. The duel used to be fenced in at ±BOUND so a cornered
     fighter was held; playtesting asked for the opposite — a hard blow should
     carry someone out of the arena entirely. The edge is now a losing line
     (RINGOUT.x), checked in collision.ts, not a collider. */
}
