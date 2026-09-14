import RAPIER, { type Collider, type KinematicCharacterController, type RigidBody } from '@dimforge/rapier3d-compat';
import { GROUND, PLANE_Z, SPAWN_X } from '../config/constants';
import { FIGHTER_BODY, FIGHTER_QUERY } from './groups';
import type { CharacterBody, MoveResult } from './port';
import type { PhysicsWorld } from './world';

/*
  A fighter's body: a kinematic capsule moved by Rapier's character controller.

  Kinematic, not dynamic, on purpose. A fighting game's movement is authored:
  walk speed, dash distance, jump arc and knockback are tuned numbers, and a
  dynamic body would let friction, mass and solver softness bend every one of
  them. So the game still decides where a fighter *wants* to go each step
  (movement.ts), and the controller decides how far it actually *can* go —
  sweeping the capsule against scenery, sliding along it, snapping to the
  floor and reporting whether it ended up standing on anything.

  Being kinematic also means a fighter pushes props with effectively infinite
  mass: its velocity is inferred from the move, so a knockback slide shoves an
  urn out of the way while the fighter's own motion stays exactly as tuned.
*/

/* Sized to the primitive rig (3.2 tall). The radius is also what keeps the
   fighter's root exactly at BOUND against the arena walls, which are placed
   from it in arena-colliders.ts. */
export const CAPSULE = { radius: 0.45, halfHeight: 1.15, skin: 0.01 } as const;

/** Body centre above the feet: the controller holds `skin` of clearance under the capsule. */
const CENTER_Y = CAPSULE.halfHeight + CAPSULE.radius + CAPSULE.skin;

export class FighterBody implements CharacterBody {
  private readonly body: RigidBody;
  private readonly collider: Collider;
  private readonly controller: KinematicCharacterController;
  private readonly flags = RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
  private readonly out: MoveResult = { x: 0, y: GROUND, grounded: true, movedY: 0 };

  constructor(private readonly pw: PhysicsWorld, slot: 0 | 1) {
    const w = pw.world;
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(SPAWN_X[slot], GROUND + CENTER_Y, PLANE_Z),
    );
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.capsule(CAPSULE.halfHeight, CAPSULE.radius)
        .setCollisionGroups(FIGHTER_BODY)
        .setFriction(0.3),
      this.body,
    );

    const c = w.createCharacterController(CAPSULE.skin);
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setSlideEnabled(true);
    // keeps a walking fighter glued to the floor instead of skipping off tiny seams
    c.enableSnapToGround(0.3);
    // steps up a curb-height ledge rather than stopping dead against it
    c.enableAutostep(0.25, 0.2, false);
    c.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    // props are pushed by the kinematic body in the solver, not by the controller
    c.setApplyImpulsesToDynamicBodies(false);
    this.controller = c;
  }

  teleport(x: number, feetY: number): void {
    const t = { x, y: feetY + CENTER_Y, z: PLANE_Z };
    this.body.setTranslation(t, true);
    // matching next pose, so the solver doesn't infer a huge velocity from the jump and fling props
    this.body.setNextKinematicTranslation(t);
  }

  move(dx: number, dy: number): MoveResult {
    const t = this.body.translation();
    this.controller.computeColliderMovement(this.collider, { x: dx, y: dy, z: 0 }, this.flags, FIGHTER_QUERY);
    const m = this.controller.computedMovement();

    const nx = t.x + m.x;
    const ny = t.y + m.y;
    // fighters live on the duel plane; any sideways slide off a curved collider is discarded
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: PLANE_Z });

    const out = this.out;
    out.x = nx;
    out.y = Math.max(GROUND, ny - CENTER_Y);
    out.grounded = this.controller.computedGrounded();
    out.movedY = m.y;
    return out;
  }

  dispose(): void {
    this.pw.world.removeCharacterController(this.controller);
  }
}
