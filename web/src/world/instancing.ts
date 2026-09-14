import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/*
  Instancing for scenery that was modelled one mesh at a time.

  The stage is built the readable way — a loop that adds a baluster, a frond,
  a blossom cluster — and every one of those used to be its own draw call.
  collapseInstances() runs over a finished subtree afterwards and folds every
  set of meshes sharing a geometry AND a material into one InstancedMesh, with
  each instance's matrix taken relative to the subtree root. The code that
  builds the scenery stays as it reads; the renderer sees one draw per kind.

  The one thing the builder has to do is share geometry: two identical
  `new CylinderGeometry(...)` calls are two geometries and never merge.
  Random sizes are therefore a unit geometry plus mesh.scale.

  Groups are left in place, so an animated group (a palm crown, a swaying
  branch) keeps its instances attached and moving: collapse the animated
  subtree on its own and pass it as `skip` to the pass over its parent.
*/

export interface CollapseOptions {
  /** Subtrees to leave alone — typically animated groups collapsed separately. */
  readonly skip?: ReadonlySet<THREE.Object3D>;
  /** Fewest meshes worth an instanced draw. */
  readonly min?: number;
}

export const INSTANCING = { meshesFolded: 0, instancedDraws: 0, meshesMerged: 0, mergedDraws: 0 };

type Collapsible = THREE.Mesh<THREE.BufferGeometry, THREE.Material>;

function collapsible(node: THREE.Object3D): node is Collapsible {
  const m = node as Collapsible & { isInstancedMesh?: boolean; isSkinnedMesh?: boolean };
  return m.isMesh === true && !m.isInstancedMesh && !m.isSkinnedMesh
    && m.visible && m.children.length === 0 && !Array.isArray(m.material);
}

export function collapseInstances(root: THREE.Object3D, o: CollapseOptions = {}): number {
  const min = o.min ?? 2;
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();

  const buckets = new Map<string, Collapsible[]>();
  const walk = (node: THREE.Object3D): void => {
    for (const child of node.children) {
      if (o.skip?.has(child)) continue;
      if (collapsible(child)) {
        const key = `${child.geometry.uuid}|${child.material.uuid}|${+child.castShadow}${+child.receiveShadow}|${child.renderOrder}`;
        const list = buckets.get(key);
        if (list) list.push(child);
        else buckets.set(key, [child]);
      }
      walk(child);
    }
  };
  walk(root);

  let folded = 0;
  const m = new THREE.Matrix4();
  for (const list of buckets.values()) {
    if (list.length < min) continue;
    const first = list[0]!;
    const im = new THREE.InstancedMesh(first.geometry, first.material, list.length);
    im.name = `${first.name || first.geometry.type}×${list.length}`;
    im.castShadow = first.castShadow;
    im.receiveShadow = first.receiveShadow;
    im.renderOrder = first.renderOrder;
    list.forEach((mesh, i) => {
      im.setMatrixAt(i, m.multiplyMatrices(toRoot, mesh.matrixWorld));
      mesh.removeFromParent();
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    root.add(im);
    folded += list.length;
    INSTANCING.meshesFolded += list.length;
    INSTANCING.instancedDraws++;
  }
  return folded;
}

/*
  The other half: meshes that share a MATERIAL but not a geometry — a
  pavilion's four roof cones and eaves, a statue's body, head and paws. Those
  cannot instance, but their geometry can be baked into the root's space and
  concatenated into one mesh per material. Run it after collapseInstances on
  the same root, so repeated pieces become instances first and only the
  one-offs are merged.

  Merged per root, never across the whole stage: each pavilion stays its own
  object, so frustum culling still drops the ones out of shot. Only position,
  normal and uv are kept, which is all the stage's materials read.
*/
const MERGE_ATTRIBUTES = ['position', 'normal', 'uv'] as const;

export function mergeStatic(root: THREE.Object3D, o: CollapseOptions = {}): number {
  const min = o.min ?? 2;
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();

  const buckets = new Map<string, Collapsible[]>();
  const walk = (node: THREE.Object3D): void => {
    for (const child of node.children) {
      if (o.skip?.has(child)) continue;
      if (collapsible(child)) {
        const key = `${child.material.uuid}|${+child.castShadow}${+child.receiveShadow}|${child.renderOrder}`;
        const list = buckets.get(key);
        if (list) list.push(child);
        else buckets.set(key, [child]);
      }
      walk(child);
    }
  };
  walk(root);

  let merged = 0;
  const m = new THREE.Matrix4();
  for (const list of buckets.values()) {
    if (list.length < min) continue;
    let geos = list.map((mesh) => {
      const g = mesh.geometry.clone();
      g.clearGroups();
      g.morphAttributes = {};
      g.applyMatrix4(m.multiplyMatrices(toRoot, mesh.matrixWorld));
      return g;
    });
    // one layout for all: indexed only if every part is, and only attributes every part has
    if (geos.some((g) => !g.index)) geos = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    const keep = MERGE_ATTRIBUTES.filter((name) => geos.every((g) => g.getAttribute(name)));
    for (const g of geos) {
      for (const name of Object.keys(g.attributes)) if (!(keep as readonly string[]).includes(name)) g.deleteAttribute(name);
    }
    const geometry = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!geometry) continue;

    const first = list[0]!;
    const mesh = new THREE.Mesh(geometry, first.material);
    mesh.name = `merged×${list.length}`;
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.renderOrder = first.renderOrder;
    geometry.computeBoundingSphere();
    for (const part of list) part.removeFromParent();
    root.add(mesh);
    merged += list.length;
    INSTANCING.meshesMerged += list.length;
    INSTANCING.mergedDraws++;
  }
  return merged;
}

export function resetInstancingStats(): void {
  INSTANCING.meshesFolded = INSTANCING.instancedDraws = INSTANCING.meshesMerged = INSTANCING.mergedDraws = 0;
}
