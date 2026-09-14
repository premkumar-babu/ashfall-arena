import RAPIER, { type RigidBody } from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { clamp } from '../core/math';
import { pbrMat, releaseEnv } from '../render/materials';
import { scene } from '../render/stage';
import { DEBRIS_BODY } from './groups';
import type { Vec3Like } from './port';
import { readPose, type PhysicsWorld } from './world';

/*
  Stone chips kicked out of the flagstones by heavy blows, K.O.s and the
  idol's slam.

  A fixed pool: every chip's body and collider is created once at boot and
  toggled with setEnabled, so a spawn allocates nothing and the WASM heap
  never churns mid-match. All chips draw as one InstancedMesh — one draw call
  however many are flying.

  A chip lives a couple of seconds, and a chip that has come to rest (Rapier
  put it to sleep) skips straight to its fade: resting bodies cost nothing to
  simulate, but a floor slowly carpeted in them would.
*/

const N = 64;
const LIFE = 2.6;
const FADE = 0.4;
const STONE = 0x74727e;

export class DebrisField {
  private readonly mesh: THREE.InstancedMesh;
  private readonly bodies: RigidBody[] = [];
  private readonly size = new Float32Array(N);
  private readonly life = new Float32Array(N);
  private readonly prevP = Array.from({ length: N }, () => new THREE.Vector3());
  private readonly currP = Array.from({ length: N }, () => new THREE.Vector3());
  private readonly prevQ = Array.from({ length: N }, () => new THREE.Quaternion());
  private readonly currQ = Array.from({ length: N }, () => new THREE.Quaternion());
  private readonly m = new THREE.Matrix4();
  private readonly p = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly c = new THREE.Color();
  private readonly tint = new THREE.Color();
  private head = 0;

  constructor(private readonly pw: PhysicsWorld) {
    this.mesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), pbrMat(0xffffff, 'stone'), N);
    this.mesh.name = 'physics-debris';
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.c.setHex(STONE);
    this.m.makeScale(0, 0, 0);

    for (let i = 0; i < N; i++) {
      const s = 0.07 + Math.random() * 0.11;
      this.size[i] = s;
      const body = pw.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setEnabled(false)
          // chips are small and fast: continuous collision stops them tunnelling through the floor
          .setCcdEnabled(true)
          .setLinearDamping(0.08)
          .setAngularDamping(0.6),
      );
      pw.world.createCollider(
        RAPIER.ColliderDesc.cuboid(s * 0.75, s * 0.75, s * 0.75)
          .setDensity(2.4).setFriction(0.9).setRestitution(0.3)
          .setCollisionGroups(DEBRIS_BODY),
        body,
      );
      pw.addDynamic(body);
      this.bodies.push(body);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.c);
    }
    scene.add(this.mesh);

    pw.onBeforeStep(() => {
      for (let i = 0; i < N; i++) {
        if (this.life[i]! <= 0) continue;
        this.prevP[i]!.copy(this.currP[i]!);
        this.prevQ[i]!.copy(this.currQ[i]!);
      }
    });
    pw.onAfterStep(() => this.afterStep());
  }

  spawn(at: Vec3Like, dirX: number, count: number, speed = 1, tint?: number): void {
    if (tint !== undefined) this.tint.setHex(tint);
    for (let k = 0; k < count; k++) {
      const i = this.head;
      this.head = (this.head + 1) % N;
      const body = this.bodies[i]!;
      const s = this.size[i]!;

      body.setEnabled(true);
      body.setTranslation({
        x: at.x + (Math.random() - 0.5) * 0.4,
        y: Math.max(at.y, s + 0.02),
        z: at.z + (Math.random() - 0.5) * 0.4,
      }, true);
      this.q.setFromEuler(new THREE.Euler(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28));
      body.setRotation({ x: this.q.x, y: this.q.y, z: this.q.z, w: this.q.w }, true);
      body.setLinvel({
        x: dirX * (1.5 + Math.random() * 4.5) * speed + (Math.random() - 0.5) * 3,
        y: (2.5 + Math.random() * 5) * speed,
        z: (Math.random() - 0.5) * 4 * speed,
      }, true);
      body.setAngvel({ x: (Math.random() - 0.5) * 24, y: (Math.random() - 0.5) * 24, z: (Math.random() - 0.5) * 24 }, true);

      this.life[i] = LIFE * (0.8 + Math.random() * 0.4);
      readPose(body, this.currP[i]!, this.currQ[i]!);
      this.prevP[i]!.copy(this.currP[i]!);
      this.prevQ[i]!.copy(this.currQ[i]!);

      this.c.setHex(STONE);
      if (tint !== undefined) this.c.lerp(this.tint, 0.3);
      this.mesh.setColorAt(i, this.c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private afterStep(): void {
    const dt = this.pw.dt;
    for (let i = 0; i < N; i++) {
      if (this.life[i]! <= 0) continue;
      const body = this.bodies[i]!;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.life[i] = 0;
        body.setEnabled(false);
        continue;
      }
      if (body.isSleeping() && this.life[i]! > FADE) this.life[i] = FADE;
      readPose(body, this.currP[i]!, this.currQ[i]!);
    }
  }

  present(alpha: number): void {
    for (let i = 0; i < N; i++) {
      const life = this.life[i]!;
      if (life <= 0) {
        this.m.makeScale(0, 0, 0);
      } else {
        this.p.lerpVectors(this.prevP[i]!, this.currP[i]!, alpha);
        this.q.slerpQuaternions(this.prevQ[i]!, this.currQ[i]!, alpha);
        this.s.setScalar(this.size[i]! * clamp(life / FADE, 0, 1));
        this.m.compose(this.p, this.q, this.s);
      }
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < N; i++) {
      if (this.life[i]! > 0) this.bodies[i]!.setEnabled(false);
      this.life[i] = 0;
    }
  }

  dispose(): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    releaseEnv(this.mesh.material as THREE.Material);
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
