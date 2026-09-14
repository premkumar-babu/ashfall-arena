import * as THREE from 'three/webgpu';
import { attribute, uniform } from 'three/tsl';
import { scene } from '../render/stage';
import type { Fighter } from '../game/fighter';
import type { Limb } from '../game/fsm';

/*
  Swing ribbons: a short, fading sheet of light swept out by whatever is
  striking — the blade from hilt to tip, or the forearm / shin for a punch or
  kick.

  The point trails already in the game mark where a limb has been; a ribbon
  shows the arc it cut, which is what makes a slash read as a slash at a
  glance. Samples are taken in the fixed simulation step (120 Hz), so the
  sheet is smooth whatever the display rate.

  One ribbon per fighter rig, created the first time that fighter swings.
  Additive and HDR-bright, so bloom gives it its glow.
*/

const POINTS = 24;
const LIFE = 0.14;           // seconds a sample stays visible
const HDR = 2.2;             // above bloom's threshold

const _tip = new THREE.Vector3();
const _base = new THREE.Vector3();

class Ribbon {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicNodeMaterial>;
  private readonly tips = new Float32Array(POINTS * 3);
  private readonly bases = new Float32Array(POINTS * 3);
  private readonly ages = new Float32Array(POINTS).fill(Infinity);
  private readonly pos: THREE.BufferAttribute;
  private readonly alpha: THREE.BufferAttribute;
  private head = 0;

  constructor(accent: number) {
    const geometry = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(POINTS * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.alpha = new THREE.BufferAttribute(new Float32Array(POINTS * 2), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.pos);
    geometry.setAttribute('ribbonAlpha', this.alpha);

    const index: number[] = [];
    for (let q = 0; q < POINTS - 1; q++) {
      const a = q * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    geometry.setDrawRange(0, 0);

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });
    material.colorNode = uniform(new THREE.Color(accent).lerp(new THREE.Color(0xffffff), 0.35).multiplyScalar(HDR));
    material.opacityNode = attribute('ribbonAlpha', 'float');

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  push(tip: THREE.Vector3, base: THREE.Vector3): void {
    this.head = (this.head + 1) % POINTS;
    const i = this.head;
    tip.toArray(this.tips, i * 3);
    base.toArray(this.bases, i * 3);
    this.ages[i] = 0;
  }

  age(dt: number): void {
    for (let i = 0; i < POINTS; i++) this.ages[i]! += dt;

    // newest sample first; stop at the first one that has expired
    const p = this.pos.array as Float32Array;
    const a = this.alpha.array as Float32Array;
    let count = 0;
    for (let k = 0; k < POINTS; k++) {
      const i = (this.head - k + POINTS) % POINTS;
      const age = this.ages[i]!;
      if (age > LIFE) break;
      const fade = (1 - age / LIFE) ** 2 * (1 - k / (POINTS - 1));
      p.set(this.bases.subarray(i * 3, i * 3 + 3), k * 6);
      p.set(this.tips.subarray(i * 3, i * 3 + 3), k * 6 + 3);
      a[k * 2] = fade * 0.35;          // the hilt / elbow edge stays faint
      a[k * 2 + 1] = fade;
      count++;
    }

    this.mesh.visible = count > 1;
    this.mesh.geometry.setDrawRange(0, Math.max(0, count - 1) * 6);
    if (count > 1) {
      this.pos.needsUpdate = true;
      this.alpha.needsUpdate = true;
    }
  }

  dispose(): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const ribbons = new Map<Fighter, Ribbon>();

/* Where the sheet runs from and to, per striking limb. Blade: palm to tip, so
   the whole blade sweeps. Fist and foot: from partway up the forearm or shin,
   so a punch leaves a narrow streak rather than a fan the size of an arm. */
function endpoints(f: Fighter, limb: Limb): void {
  if (limb === 'blade' && f.bladeTip && f.weapon) {
    f.bladeTip.getWorldPosition(_tip);
    f.weapon.getWorldPosition(_base);
    _base.lerp(_tip, 0.15);
    return;
  }
  const hit = limb === 'fist' ? f.hitboxes.fist : f.hitboxes.foot;
  hit.anchor.getWorldPosition(_tip);
  (limb === 'fist' ? f.armF.elbow : f.legF.knee).getWorldPosition(_base);
  _base.lerp(_tip, 0.5);
}

export function pushSwingRibbon(f: Fighter, limb: Limb): void {
  let r = ribbons.get(f);
  if (!r) {
    r = new Ribbon(f.def.accent);
    ribbons.set(f, r);
  }
  endpoints(f, limb);
  r.push(_tip, _base);
}

export function ageSwingRibbon(f: Fighter, dt: number): void {
  ribbons.get(f)?.age(dt);
}

export function resetSwingRibbons(): void {
  for (const r of ribbons.values()) r.dispose();
  ribbons.clear();
}
