import * as THREE from 'three/webgpu';
import { PAL, PLANE_Z } from '../config/constants';
import { loadTex } from '../assets/texture-loader';
import { addMat } from '../render/materials';
import { camera, scene } from '../render/stage';
import { Flip } from './flipbook';

/*
  Strike VFX: slash arcs, expanding impact rings, the summon portal, slam
  scorch marks, directional shards, the overdrive aura shell and hit-flash
  pops. All additive and unlit, so the bloom pass does the rest.

  Everything is pooled and allocated once. Nothing here creates a mesh or a
  material during a fight — a draw that allocates is a draw that hitches.
*/

type BasicMesh<G extends THREE.BufferGeometry = THREE.BufferGeometry> = THREE.Mesh<G, THREE.MeshBasicMaterial>;

interface Arc { mesh: BasicMesh; life: number; dir: number; spin: number }
interface Ring { mesh: BasicMesh<THREE.RingGeometry>; life: number }
interface Streak { mesh: BasicMesh<THREE.PlaneGeometry>; life: number; vx: number; vy: number }
interface Spark { mesh: BasicMesh<THREE.IcosahedronGeometry>; life: number }

export interface Portal {
  readonly group: THREE.Group;
  readonly disc: BasicMesh<THREE.RingGeometry>;
  readonly inner: BasicMesh<THREE.RingGeometry>;
  readonly column: BasicMesh<THREE.CylinderGeometry>;
  life: number;
}

export interface Scorch {
  readonly mesh: BasicMesh<THREE.CircleGeometry>;
  life: number;
}

const arcs: Arc[] = [];
const rings: Ring[] = [];
const streaks: Streak[] = [];
export const sparks: Spark[] = [];

function additiveBasic(color: number, side: THREE.Side = THREE.DoubleSide): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side,
  });
}

function makeArc(color: number): BasicMesh {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.52, 1.12, 26, 1, -0.5, 1.85), additiveBasic(color));
  m.visible = false;
  scene.add(m);
  return m;
}

function makeRing(color: number): BasicMesh<THREE.RingGeometry> {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.30, 0.44, 30), additiveBasic(color));
  m.visible = false;
  scene.add(m);
  return m;
}

export function initVfx(): void {
  for (let i = 0; i < 5; i++) arcs.push({ mesh: makeArc(0xffffff), life: 0, dir: 1, spin: 0 });

  /* The swing arc starts life as a segment of a ring: the right shape, but a
     flat band with no taper and no edge. A drawn slash has both, so the
     geometry becomes a quad the moment the sprite lands — and stays a ring
     segment if it never does. */
  loadTex('vfx/slash_02.png', (t) => {
    const quad = new THREE.PlaneGeometry(2.6, 2.6);
    for (const a of arcs) {
      a.mesh.geometry.dispose();
      a.mesh.geometry = quad;
      a.mesh.material.map = t;
      a.mesh.material.needsUpdate = true;
    }
  });

  for (let i = 0; i < 7; i++) rings.push({ mesh: makeRing(0xffffff), life: 0 });

  // directional shards thrown out along the line of the blow
  for (let i = 0; i < 14; i++) {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.055), addMat(0xffffff, 0));
    mesh.visible = false;
    scene.add(mesh);
    streaks.push({ mesh, life: 0, vx: 0, vy: 0 });
  }

  // hit flash pops
  for (let i = 0; i < 6; i++) {
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.5, 0),
      new THREE.MeshBasicMaterial({ color: PAL.hot, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    mesh.visible = false;
    scene.add(mesh);
    sparks.push({ mesh, life: 0 });
  }
}

const _arcDummy = new THREE.Vector3();

export function spawnArc(x: number, y: number, dir: number, color: number, scale = 1): void {
  for (const a of arcs) {
    if (a.life > 0) continue;
    a.life = 1;
    a.dir = dir;
    a.spin = -dir * 1.25;
    a.mesh.material.color.setHex(color);
    a.mesh.position.set(x + dir * 0.35, y, PLANE_Z + 0.5);
    a.mesh.scale.setScalar(scale);
    a.mesh.rotation.set(0, dir > 0 ? 0 : Math.PI, a.spin);
    a.mesh.visible = true;
    return;
  }
}

export function spawnRing(at: THREE.Vector3, color: number): void {
  for (const r of rings) {
    if (r.life > 0) continue;
    r.life = 1;
    r.mesh.material.color.setHex(color);
    r.mesh.position.copy(at);
    r.mesh.scale.setScalar(0.4);
    r.mesh.visible = true;
    return;
  }
}

export function updateVfx(dt: number): void {
  Flip.update(dt);
  for (const a of arcs) {
    if (a.life <= 0) continue;
    a.life -= dt * 4.6;
    if (a.life <= 0) {
      a.life = 0;
      a.mesh.visible = false;
      continue;
    }
    a.spin += a.dir * dt * 7.5;
    a.mesh.rotation.z = a.spin;
    a.mesh.material.opacity = Math.min(0.62, a.life * 0.95);
    a.mesh.scale.multiplyScalar(1 + dt * 1.1);
  }
  for (const r of rings) {
    if (r.life <= 0) continue;
    r.life -= dt * 3.4;
    if (r.life <= 0) {
      r.life = 0;
      r.mesh.visible = false;
      continue;
    }
    r.mesh.lookAt(camera.position);
    r.mesh.material.opacity = r.life * 0.40;
    r.mesh.scale.setScalar(0.4 + (1 - r.life) * 3.1);
  }
}

/* ── summon portal: a rune disc and light column that tear open where the
      assist arrives, then collapse as it charges out ────────────────────── */

export function makePortal(color: number): Portal {
  const group = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.55, 30), addMat(color, 0));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.06;
  group.add(disc);
  const inner = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.46, 20), addMat(color, 0));
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.07;
  group.add(inner);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.45, 5.2, 18, 1, true), addMat(color, 0));
  column.position.y = 2.6;
  group.add(column);
  group.visible = false;
  scene.add(group);
  return { group, disc, inner, column, life: 0 };
}

export function firePortal(p: Portal, x: number, z: number, color: number): void {
  p.life = 1;
  p.group.visible = true;
  p.group.position.set(x, 0, z);
  Flip.play('fire', _arcDummy.set(x, 1.35, z + 0.3), 2.3, color, 0, 0.8);
  for (const m of [p.disc, p.inner, p.column]) m.material.color.setHex(color);
}

export function updatePortals(list: readonly Portal[], dt: number): void {
  for (const p of list) {
    if (p.life <= 0) continue;
    p.life -= dt * 1.6;
    if (p.life <= 0) {
      p.life = 0;
      p.group.visible = false;
      continue;
    }
    const k = 1 - p.life;                      // 0 at spawn, 1 at collapse
    p.disc.scale.setScalar(0.5 + k * 1.5);
    p.disc.material.opacity = p.life * 0.45;
    p.disc.rotation.z += dt * 3.2;
    p.inner.scale.setScalar(1.6 - k * 1.1);
    p.inner.material.opacity = p.life * 0.55;
    p.inner.rotation.z -= dt * 5.0;
    p.column.scale.set(1 - k * 0.5, 0.35 + p.life * 0.9, 1 - k * 0.5);
    p.column.material.opacity = p.life * 0.16;
  }
}

/* ── ground scorch left by a slam ─────────────────────────────────────── */

export function makeScorch(): Scorch {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(1.0, 26),
    new THREE.MeshBasicMaterial({ color: 0x120C0A, transparent: true, opacity: 0, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.045;
  mesh.visible = false;
  scene.add(mesh);
  return { mesh, life: 0 };
}

export function fireScorch(s: Scorch, x: number, z: number): void {
  s.life = 1;
  s.mesh.visible = true;
  s.mesh.position.set(x, 0.045, z);
  s.mesh.scale.setScalar(0.5);
}

export function updateScorch(list: readonly Scorch[], dt: number): void {
  for (const s of list) {
    if (s.life <= 0) continue;
    s.life -= dt * 0.55;
    if (s.life <= 0) {
      s.life = 0;
      s.mesh.visible = false;
      continue;
    }
    s.mesh.scale.setScalar(0.5 + (1 - s.life) * 2.6);
    s.mesh.material.opacity = s.life * 0.5;
  }
}

/* ── shards ───────────────────────────────────────────────────────────── */

export function spawnStreaks(at: THREE.Vector3, dir: number, color: number, count: number): void {
  let made = 0;
  for (const s of streaks) {
    if (made >= count) break;
    if (s.life > 0) continue;
    s.life = 1;
    s.mesh.material.color.setHex(color);
    s.mesh.position.copy(at);
    s.mesh.visible = true;
    const spread = (Math.random() - 0.5) * 1.5;
    s.vx = dir * (7 + Math.random() * 11);
    s.vy = spread * 7;
    s.mesh.rotation.z = Math.atan2(s.vy, s.vx);
    s.mesh.scale.set(0.5 + Math.random() * 1.4, 1, 1);
    made++;
  }
}

export function updateStreaks(dt: number): void {
  for (const s of streaks) {
    if (s.life <= 0) continue;
    s.life -= dt * 4.2;
    if (s.life <= 0) {
      s.life = 0;
      s.mesh.visible = false;
      continue;
    }
    s.mesh.position.x += s.vx * dt;
    s.mesh.position.y += s.vy * dt;
    s.mesh.material.opacity = s.life * 0.42;
    s.mesh.scale.x += dt * 6;
  }
}

/* ── overdrive aura and hit flash ─────────────────────────────────────── */

export function makeAura(color: number): BasicMesh<THREE.SphereGeometry> {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1.25, 16, 14), additiveBasic(color, THREE.BackSide));
  m.scale.set(1, 1.55, 1);
  m.position.y = 1.7;
  m.visible = false;
  return m;
}

export function spark(at: THREE.Vector3, color: number): void {
  for (const s of sparks) {
    if (s.life > 0) continue;
    s.life = 1;
    s.mesh.position.copy(at);
    s.mesh.material.color.setHex(color);
    s.mesh.visible = true;
    return;
  }
}

export function resetVfx(): void {
  arcs.length = 0;
  rings.length = 0;
  streaks.length = 0;
  sparks.length = 0;
}
