import * as THREE from 'three/webgpu';

/*
  Level of detail for instanced scenery.

  THREE.LOD swaps whole objects, which is the right tool for one statue and
  the wrong one for nine hundred grass tufts: it would mean nine hundred
  objects and nine hundred draw calls before a single level had been chosen.
  Here every level is ONE InstancedMesh per part, and each instance is bucketed
  into the level its on-screen size calls for, then written into that level's
  instance buffer.

  Size is measured on screen, not in metres: bounding radius over distance,
  scaled by the lens. The fight camera narrows its field of view to frame the
  fighters, and a distance threshold would drop detail exactly when the zoom
  makes it most visible.

  Rebucketing is cheap but uploading instance buffers is not free, so it runs
  only when the camera has moved or zoomed, and buffers are rewritten only if
  some instance actually changed level. A band of hysteresis stops an instance
  sitting on a threshold from flickering under camera shake.
*/

export interface LodPart {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly castShadow?: boolean;
}

export interface LodLevel {
  readonly parts: readonly LodPart[];
  /** Smallest on-screen size this level is still used at: bounding radius ÷ half the view height at that distance. */
  readonly minSize: number;
}

export interface LodInstance {
  readonly matrix: THREE.Matrix4;
  readonly color?: THREE.ColorRepresentation;
  /** Per-instance scalar exposed to shaders as the `lodPhase` attribute (wind phase, flicker seed). */
  readonly phase?: number;
}

const HYSTERESIS = 0.15;
const MOVE_EPS_SQ = 0.05 * 0.05;

export class InstancedLOD extends THREE.Group {
  readonly levels: readonly LodLevel[];
  /** Instances drawn at each level after the last update; the final slot counts culled ones. */
  readonly counts: number[];

  private readonly meshes: THREE.InstancedMesh[][];
  private readonly matrices: Float32Array;
  private readonly colors: Float32Array | null;
  private readonly phases: Float32Array | null;
  private readonly centers: Float32Array;
  private readonly radii: Float32Array;
  private readonly level: Int8Array;
  private readonly lastCam = new THREE.Vector3(Infinity, Infinity, Infinity);
  private lastFov = 0;
  private bias = 1;
  private readonly owned: THREE.BufferGeometry[] = [];

  constructor(name: string, levels: readonly LodLevel[], instances: readonly LodInstance[]) {
    super();
    this.name = name;
    this.levels = levels;
    const n = instances.length;
    this.counts = new Array<number>(levels.length + 1).fill(0);

    this.matrices = new Float32Array(n * 16);
    this.centers = new Float32Array(n * 3);
    this.radii = new Float32Array(n);
    this.level = new Int8Array(n).fill(-2);                 // -2: never bucketed, -1: culled
    this.colors = instances.some((i) => i.color !== undefined) ? new Float32Array(n * 3) : null;
    this.phases = instances.some((i) => i.phase !== undefined) ? new Float32Array(n) : null;

    const base = levels[0]!.parts[0]!.geometry;
    base.computeBoundingSphere();
    const baseRadius = base.boundingSphere?.radius ?? 1;
    const c = new THREE.Color();
    const v = new THREE.Vector3();
    instances.forEach((inst, i) => {
      inst.matrix.toArray(this.matrices, i * 16);
      v.setFromMatrixPosition(inst.matrix);
      v.toArray(this.centers, i * 3);
      this.radii[i] = baseRadius * inst.matrix.getMaxScaleOnAxis();
      if (this.colors) c.set(inst.color ?? 0xffffff).toArray(this.colors, i * 3);
      if (this.phases) this.phases[i] = inst.phase ?? 0;
    });

    this.meshes = levels.map((lvl, li) => lvl.parts.map((p, pi) => {
      let geometry = p.geometry;
      if (this.phases) {
        // the per-instance attribute has to live on a geometry this level owns alone
        geometry = p.geometry.clone();
        geometry.setAttribute('lodPhase', new THREE.InstancedBufferAttribute(new Float32Array(n), 1));
        this.owned.push(geometry);
      }
      const im = new THREE.InstancedMesh(geometry, p.material, n);
      im.name = `${name}.lod${li}.${pi}`;
      im.count = 0;
      im.visible = false;
      im.castShadow = p.castShadow ?? false;
      im.receiveShadow = true;
      if (this.colors) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      this.add(im);
      return im;
    }));
  }

  /** Quality scaling: every threshold is multiplied by `bias`, so 2 drops detail at twice the size. */
  setBias(bias: number, camera: THREE.PerspectiveCamera): void {
    if (bias === this.bias) return;
    this.bias = bias;
    this.update(camera, true);
  }

  /** Re-pick levels for `camera`. Returns true when any instance buffer was rewritten. */
  update(camera: THREE.PerspectiveCamera, force = false): boolean {
    const cam = camera.getWorldPosition(new THREE.Vector3());
    if (!force && cam.distanceToSquared(this.lastCam) < MOVE_EPS_SQ && Math.abs(camera.fov - this.lastFov) < 0.2) return false;
    this.lastCam.copy(cam);
    this.lastFov = camera.fov;

    const lens = 1 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const levels = this.levels;
    let changed = force;
    for (let i = 0; i < this.radii.length; i++) {
      const dx = this.centers[i * 3]! - cam.x;
      const dy = this.centers[i * 3 + 1]! - cam.y;
      const dz = this.centers[i * 3 + 2]! - cam.z;
      const size = (this.radii[i]! * lens) / Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 1e-3);
      const prev = this.level[i]!;
      let next = -1;
      for (let l = 0; l < levels.length; l++) {
        // moving to a finer level has to clear the threshold by a margin; staying only has to hold it
        const k = prev === -2 ? 1 : prev === -1 || l < prev ? 1 + HYSTERESIS : l === prev ? 1 - HYSTERESIS : 1;
        if (size >= levels[l]!.minSize * this.bias * k) {
          next = l;
          break;
        }
      }
      if (next !== prev) {
        this.level[i] = next;
        changed = true;
      }
    }
    if (changed) this.rebuild();
    return changed;
  }

  private rebuild(): void {
    const counts = this.counts.fill(0);
    for (let i = 0; i < this.level.length; i++) {
      const l = this.level[i]!;
      if (l < 0) {
        counts[counts.length - 1]!++;
        continue;
      }
      const slot = counts[l]!++;
      for (const im of this.meshes[l]!) {
        (im.instanceMatrix.array as Float32Array).set(this.matrices.subarray(i * 16, i * 16 + 16), slot * 16);
        if (this.colors && im.instanceColor) {
          (im.instanceColor.array as Float32Array).set(this.colors.subarray(i * 3, i * 3 + 3), slot * 3);
        }
        if (this.phases) {
          (im.geometry.getAttribute('lodPhase').array as Float32Array)[slot] = this.phases[i]!;
        }
      }
    }
    this.meshes.forEach((parts, l) => {
      for (const im of parts) {
        im.count = counts[l]!;
        im.visible = im.count > 0;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (this.phases) im.geometry.getAttribute('lodPhase').needsUpdate = true;
        if (im.count > 0) im.computeBoundingSphere();
      }
    });
  }

  /** Frees the instance buffers and any geometry this object cloned. Shared geometry and materials belong to the caller. */
  override dispose(): void {
    for (const parts of this.meshes) for (const im of parts) im.dispose();
    for (const g of this.owned) g.dispose();
    this.removeFromParent();
  }
}
