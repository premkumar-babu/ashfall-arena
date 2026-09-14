import RAPIER, { type RigidBody } from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { pbrMat, releaseEnv } from '../render/materials';
import { scene } from '../render/stage';
import { PROP_BODY } from './groups';
import type { BodyBinding, PhysicsWorld } from './world';

/*
  Loose props at the edges of the duel: clay urns and timber crates, as
  dynamic rigid bodies.

  They sit just off the fighters' line (z = 0), close enough that a capsule
  walking past grazes them and a knockback slide ploughs through them, and
  far enough that they never get between two fighters. Heavy blows, summons
  and K.O.s blast them (see blast() in world.ts). Every round puts them back.
*/

type PropKind = 'urn' | 'crate';

interface PropSpec {
  readonly kind: PropKind;
  readonly x: number;
  readonly z: number;
  /** Stack level for crates: 0 on the floor, 1 on top of another. */
  readonly level?: number;
  readonly yaw: number;
}

const LAYOUT: readonly PropSpec[] = [
  { kind: 'urn', x: -6.3, z: 0.72, yaw: 0.3 },
  { kind: 'crate', x: -8.3, z: -0.92, yaw: 0.25 },
  { kind: 'urn', x: -9.8, z: 0.8, yaw: 1.1 },
  { kind: 'urn', x: 6.5, z: -0.74, yaw: 2.0 },
  { kind: 'crate', x: 8.4, z: 0.94, yaw: -0.2 },
  { kind: 'crate', x: 8.4, z: 0.94, level: 1, yaw: 0.35 },
];

const URN = { halfHeight: 0.45, radius: 0.34 } as const;
const CRATE = 0.42;

interface Prop {
  readonly body: RigidBody;
  readonly binding: BodyBinding;
  readonly home: { x: number; y: number; z: number };
  readonly homeQ: THREE.Quaternion;
}

function urnGeometry(): THREE.LatheGeometry {
  const h = URN.halfHeight * 2;
  const profile = [
    [0.00, 0.00], [0.22, 0.00], [0.30, 0.08], [0.36, 0.34], [0.33, 0.58],
    [0.20, 0.76], [0.15, 0.82], [0.20, h], [0.00, h],
  ].map(([r, y]) => new THREE.Vector2(r, y! - URN.halfHeight));
  return new THREE.LatheGeometry(profile, 18);
}

export class PropSet {
  private readonly root = new THREE.Group();
  private readonly props: Prop[] = [];
  private readonly urnGeo = urnGeometry();
  private readonly crateGeo = new THREE.BoxGeometry(CRATE * 2, CRATE * 2, CRATE * 2);
  private readonly urnMat = pbrMat(0x9a5634, 'clay');
  private readonly crateMat = pbrMat(0x6e4b2c, 'timber');

  constructor(private readonly pw: PhysicsWorld) {
    this.root.name = 'physics-props';
    scene.add(this.root);
    const up = new THREE.Vector3(0, 1, 0);

    for (const spec of LAYOUT) {
      const isUrn = spec.kind === 'urn';
      const y = isUrn ? URN.halfHeight : CRATE + (spec.level ?? 0) * CRATE * 2;
      const q = new THREE.Quaternion().setFromAxisAngle(up, spec.yaw);

      const body = pw.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(spec.x, y, spec.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setLinearDamping(0.15)
          .setAngularDamping(0.5),
      );
      const shape = isUrn
        ? RAPIER.ColliderDesc.cylinder(URN.halfHeight, URN.radius).setDensity(1.6).setRestitution(0.1)
        : RAPIER.ColliderDesc.cuboid(CRATE, CRATE, CRATE).setDensity(0.9).setRestitution(0.05);
      pw.world.createCollider(shape.setFriction(0.7).setCollisionGroups(PROP_BODY), body);

      const mesh = new THREE.Mesh(isUrn ? this.urnGeo : this.crateGeo, isUrn ? this.urnMat : this.crateMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);

      pw.addDynamic(body);
      this.props.push({ body, binding: pw.bind(body, mesh), home: { x: spec.x, y, z: spec.z }, homeQ: q });
    }
  }

  /** Back to the layout, at rest. Sleeping them keeps a stacked crate from jittering as it settles. */
  reset(): void {
    for (const p of this.props) {
      p.body.setTranslation(p.home, false);
      p.body.setRotation({ x: p.homeQ.x, y: p.homeQ.y, z: p.homeQ.z, w: p.homeQ.w }, false);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      p.body.sleep();
      this.pw.snap(p.binding);
    }
  }

  dispose(): void {
    scene.remove(this.root);
    this.urnGeo.dispose();
    this.crateGeo.dispose();
    releaseEnv(this.urnMat);
    releaseEnv(this.crateMat);
    this.urnMat.dispose();
    this.crateMat.dispose();
  }
}
