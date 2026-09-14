import type { World } from '@dimforge/rapier3d-compat';
import * as THREE from 'three/webgpu';
import { scene } from '../render/stage';

/*
  Collider wireframes from Rapier's own debug renderer, toggled with the hit-
  box view (B). Drawn over everything so a capsule inside a model is visible.

  Buffers grow by doubling and the draw range tracks the live vertex count,
  so the GPU buffer is reallocated a handful of times per session rather than
  every frame. The arrays Rapier returns are views into WASM memory, so they
  are copied before the next step can move them.
*/
export class PhysicsDebugDraw {
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, depthTest: false, depthWrite: false,
  });
  private readonly lines = new THREE.LineSegments(this.geometry, this.material);
  private capacity = 0;
  private enabled = false;

  constructor() {
    this.lines.name = 'physics-debug';
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.lines.visible = on;
  }

  update(world: World): void {
    if (!this.enabled) return;
    const { vertices, colors } = world.debugRender();
    const count = vertices.length / 3;

    if (count > this.capacity) {
      this.capacity = Math.max(count, this.capacity * 2, 1024);
      this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3));
      this.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.capacity * 4), 4));
    }
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    (pos.array as Float32Array).set(vertices);
    (col.array as Float32Array).set(colors);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
  }

  dispose(): void {
    scene.remove(this.lines);
    this.geometry.dispose();
    this.material.dispose();
  }
}
