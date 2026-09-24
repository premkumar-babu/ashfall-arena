import * as THREE from 'three/webgpu';
import { GRAVITY, PLANE_Z } from '../config/constants';
import { scene } from '../render/stage';
import { settings } from '../ui/settings';

/*
  Blood.

  Two instanced meshes and nothing else: droplets that fly on the blow's
  direction and fall under gravity, and pools that spread where they land and
  stay on the flagstones for the rest of the round. A fighting game in this
  mould reads damage off the floor as much as off the health bar — by the last
  round the stage is a record of the fight.

  Droplets are lit, not additive: the impact sparks already glow, and blood
  that glowed would read as fire. Each one is stretched along its velocity, so
  a spray reads as streaks in flight and beads as it slows.

  All of it is behind the BLOOD setting; with it off, every call returns early
  and the stage stays clean.
*/

const DROPS = 480;
const POOLS = 180;
const FLOOR = 0.018;

const dPos = new Float32Array(DROPS * 3);
const dVel = new Float32Array(DROPS * 3);
const dSize = new Float32Array(DROPS);
const dLive = new Uint8Array(DROPS);

const pPos = new Float32Array(POOLS * 2);   // x, z
const pRad = new Float32Array(POOLS);       // current radius
const pTarget = new Float32Array(POOLS);    // the radius it spreads to
const pRot = new Float32Array(POOLS);
const pSquash = new Float32Array(POOLS);

/* Chunks: what is left of a fighter after the worst fatalities. Boxes, tinted
   per instance with the fighter's own colours, thrown out, tumbling, and left
   lying where they stop for the rest of the round. */
const GIBS = 72;
const gPos = new Float32Array(GIBS * 3);
const gVel = new Float32Array(GIBS * 3);
const gRot = new Float32Array(GIBS * 3);
const gSpin = new Float32Array(GIBS * 3);
const gSize = new Float32Array(GIBS * 3);
const gUsed = new Uint8Array(GIBS);
let gibMesh: THREE.InstancedMesh | null = null;
let gHead = 0;
const _e = new THREE.Euler();
const _c = new THREE.Color();

let drops: THREE.InstancedMesh | null = null;
let pools: THREE.InstancedMesh | null = null;
let dHead = 0;
let pHead = 0;
let liveDrops = 0;
let dirtyPools = false;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

export function initBlood(): void {
  const dropMat = new THREE.MeshStandardMaterial({ color: 0x9a0606, roughness: 0.22, metalness: 0.05, emissive: 0x220000 });
  drops = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), dropMat, DROPS);
  drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  drops.frustumCulled = false;
  drops.castShadow = false;

  const poolGeo = new THREE.CircleGeometry(1, 20);
  poolGeo.rotateX(-Math.PI / 2);
  const poolMat = new THREE.MeshStandardMaterial({
    color: 0x5a0303, roughness: 0.08, metalness: 0.15,
    transparent: true, opacity: 0.94, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  pools = new THREE.InstancedMesh(poolGeo, poolMat, POOLS);
  pools.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pools.frustumCulled = false;
  pools.receiveShadow = true;
  pools.renderOrder = 1;

  for (let i = 0; i < DROPS; i++) drops.setMatrixAt(i, HIDDEN);
  for (let i = 0; i < POOLS; i++) pools.setMatrixAt(i, HIDDEN);

  gibMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.1 }), GIBS);
  gibMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  gibMesh.frustumCulled = false;
  gibMesh.castShadow = true;
  for (let i = 0; i < GIBS; i++) {
    gibMesh.setMatrixAt(i, HIDDEN);
    gibMesh.setColorAt(i, _c.setHex(0x7a0a0a));     // the colour attribute has to exist before the first draw
  }
  scene.add(drops, pools, gibMesh);
}

/** Pieces of a fighter, flung from `at`: tinted from `colors`, mostly the way `dir` points. */
export function gib(at: { readonly x: number; readonly y: number }, dir: number, colors: readonly number[], count: number, power = 7): void {
  if (!gibMesh || !settings.goreOn) return;
  for (let n = 0; n < count; n++) {
    const k = gHead;
    gHead = (gHead + 1) % GIBS;
    gUsed[k] = 1;
    gPos[k * 3] = at.x + (Math.random() - 0.5) * 0.6;
    gPos[k * 3 + 1] = at.y + (Math.random() - 0.3) * 1.4;
    gPos[k * 3 + 2] = PLANE_Z + (Math.random() - 0.5) * 0.4;
    const s = power * (0.4 + Math.random() * 0.8);
    gVel[k * 3] = (Math.random() < 0.7 ? dir : -dir) * s * (0.4 + Math.random());
    gVel[k * 3 + 1] = power * (0.5 + Math.random() * 0.9);
    gVel[k * 3 + 2] = (Math.random() - 0.5) * power * 0.7;
    for (let a = 0; a < 3; a++) {
      gRot[k * 3 + a] = Math.random() * Math.PI * 2;
      gSpin[k * 3 + a] = (Math.random() - 0.5) * 18;
    }
    const base = 0.12 + Math.random() * 0.2;
    gSize[k * 3] = base * (0.7 + Math.random() * 0.8);
    gSize[k * 3 + 1] = base * (0.7 + Math.random() * 0.8);
    gSize[k * 3 + 2] = base * (0.7 + Math.random() * 0.8);
    gibMesh.setColorAt(k, _c.setHex(colors[n % colors.length] ?? 0x7a0a0a));
  }
  if (gibMesh.instanceColor) gibMesh.instanceColor.needsUpdate = true;
}

/**
 * A spray from a wound. `dir` is the way the blow travelled; most of the blood
 * goes with it, some kicks back toward the attacker, and all of it arcs.
 */
export function spray(at: { readonly x: number; readonly y: number; readonly z?: number }, dir: number, amount: number, power = 6): void {
  if (!drops || !settings.goreOn) return;
  const n = Math.min(Math.round(amount), 140);
  for (let i = 0; i < n; i++) {
    const k = dHead;
    dHead = (dHead + 1) % DROPS;
    dLive[k] = 1;
    dPos[k * 3] = at.x + (Math.random() - 0.5) * 0.25;
    dPos[k * 3 + 1] = at.y + (Math.random() - 0.5) * 0.25;
    dPos[k * 3 + 2] = (at.z ?? PLANE_Z) + (Math.random() - 0.5) * 0.3;
    const back = Math.random() < 0.18 ? -0.45 : 1;
    const s = power * (0.35 + Math.random() * 0.8);
    dVel[k * 3] = dir * s * back + (Math.random() - 0.5) * 2.2;
    dVel[k * 3 + 1] = power * (0.15 + Math.random() * 0.85);
    dVel[k * 3 + 2] = (Math.random() - 0.5) * power * 0.55;
    dSize[k] = 0.028 + Math.random() * 0.05;
  }
}

/** A pool straight onto the floor: a body that fell, or what is left after a fatality. */
export function pool(x: number, radius: number, z = PLANE_Z): void {
  if (!pools || !settings.goreOn) return;
  const k = pHead;
  pHead = (pHead + 1) % POOLS;
  pPos[k * 2] = x;
  pPos[k * 2 + 1] = z;
  pRad[k] = radius * 0.15;
  pTarget[k] = radius;
  pRot[k] = Math.random() * Math.PI;
  pSquash[k] = 0.55 + Math.random() * 0.4;
  dirtyPools = true;
}

export function bloodLive(): number {
  return liveDrops;
}

export function updateBlood(dt: number): void {
  if (!drops || !pools) return;
  let live = 0;
  for (let i = 0; i < DROPS; i++) {
    if (!dLive[i]) continue;
    const j = i * 3;
    dVel[j + 1]! += GRAVITY * dt;
    dPos[j]! += dVel[j]! * dt;
    dPos[j + 1]! += dVel[j + 1]! * dt;
    dPos[j + 2]! += dVel[j + 2]! * dt;
    if (dPos[j + 1]! <= FLOOR) {
      dLive[i] = 0;
      drops.setMatrixAt(i, HIDDEN);
      // most drops leave a mark; a big one leaves a splat
      if (Math.random() < 0.7) pool(dPos[j]!, dSize[i]! * (2.2 + Math.random() * 3.2), dPos[j + 2]!);
      continue;
    }
    live++;
    _v.set(dVel[j]!, dVel[j + 1]!, dVel[j + 2]!);
    const speed = _v.length();
    if (speed > 1e-3) _q.setFromUnitVectors(_up, _v.multiplyScalar(1 / speed));
    const r = dSize[i]!;
    _s.set(r, r * (1 + Math.min(speed * 0.09, 2.2)), r);
    _p.set(dPos[j]!, dPos[j + 1]!, dPos[j + 2]!);
    drops.setMatrixAt(i, _m.compose(_p, _q, _s));
  }
  liveDrops = live;
  drops.instanceMatrix.needsUpdate = true;

  // pools spread out to their size over a few tenths of a second
  let spreading = false;
  for (let i = 0; i < POOLS; i++) {
    if (pTarget[i]! <= 0) continue;
    if (pRad[i]! < pTarget[i]!) {
      pRad[i] = Math.min(pTarget[i]!, pRad[i]! + (pTarget[i]! * 2.6 + 0.2) * dt);
      spreading = true;
    } else if (!dirtyPools) {
      continue;
    }
    const r = pRad[i]!;
    _q.setFromAxisAngle(_up, pRot[i]!);
    _s.set(r, 1, r * pSquash[i]!);
    _p.set(pPos[i * 2]!, FLOOR - 0.006 + (i % 7) * 0.0006, pPos[i * 2 + 1]!);
    pools.setMatrixAt(i, _m.compose(_p, _q, _s));
  }
  if (spreading || dirtyPools) pools.instanceMatrix.needsUpdate = true;
  dirtyPools = false;

  if (!gibMesh) return;
  let moved = false;
  for (let i = 0; i < GIBS; i++) {
    if (!gUsed[i]) continue;
    const j = i * 3;
    const half = gSize[j + 1]! * 0.5;
    const resting = gPos[j + 1]! <= half + 0.001 && Math.abs(gVel[j + 1]!) < 0.4 && Math.abs(gVel[j]!) < 0.3;
    if (!resting) {
      moved = true;
      gVel[j + 1]! += GRAVITY * dt;
      gPos[j]! += gVel[j]! * dt;
      gPos[j + 1]! += gVel[j + 1]! * dt;
      gPos[j + 2]! += gVel[j + 2]! * dt;
      for (let a = 0; a < 3; a++) gRot[j + a]! += gSpin[j + a]! * dt;
      if (gPos[j + 1]! < half) {
        // hit the stones: a wet thud, a bounce that dies fast, and a smear where it lands
        gPos[j + 1] = half;
        if (gVel[j + 1]! < -2.5 && Math.random() < 0.6) pool(gPos[j]!, 0.18 + Math.random() * 0.25, gPos[j + 2]!);
        gVel[j + 1] = -gVel[j + 1]! * 0.28;
        gVel[j]! *= 0.55;
        gVel[j + 2]! *= 0.55;
        for (let a = 0; a < 3; a++) gSpin[j + a]! *= 0.5;
      }
    } else {
      gVel[j] = gVel[j + 1] = gVel[j + 2] = 0;
    }
    _e.set(gRot[j]!, gRot[j + 1]!, gRot[j + 2]!);
    _q.setFromEuler(_e);
    _p.set(gPos[j]!, gPos[j + 1]!, gPos[j + 2]!);
    _s.set(gSize[j]!, gSize[j + 1]!, gSize[j + 2]!);
    gibMesh.setMatrixAt(i, _m.compose(_p, _q, _s));
  }
  if (moved) gibMesh.instanceMatrix.needsUpdate = true;
}

/** A fresh round starts on clean stones. */
export function resetBlood(): void {
  if (!drops || !pools) return;
  dLive.fill(0);
  pTarget.fill(0);
  pRad.fill(0);
  for (let i = 0; i < DROPS; i++) drops.setMatrixAt(i, HIDDEN);
  for (let i = 0; i < POOLS; i++) pools.setMatrixAt(i, HIDDEN);
  drops.instanceMatrix.needsUpdate = true;
  pools.instanceMatrix.needsUpdate = true;
  dHead = pHead = 0;
  liveDrops = 0;
  if (gibMesh) {
    gUsed.fill(0);
    for (let i = 0; i < GIBS; i++) gibMesh.setMatrixAt(i, HIDDEN);
    gibMesh.instanceMatrix.needsUpdate = true;
    gHead = 0;
  }
}
