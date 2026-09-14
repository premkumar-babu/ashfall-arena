import * as THREE from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { attribute, positionLocal, sin, time, uv, vec3 } from 'three/tsl';
import { Assets } from '../assets/pipeline';
import type { QualityPreset } from '../config/quality';
import type { Theme } from '../config/themes';
import { pbrMat, releaseEnv } from '../render/materials';
import { camera, scene } from '../render/stage';
import { arena, tintStone } from './arena';
import { InstancedLOD, type LodInstance, type LodLevel, type LodPart } from './instanced-lod';

/*
  The land around the courtyard.

  Until now the courtyard was a square of flagstone floating on an infinite
  sheet of water, with four cones for a far shore. This adds:

    · terrain — a polar heightfield from the courtyard walls to the horizon.
      A moat round the walls, a lake kept open straight behind the duel (the
      sun's path and the reflection shots need it), banks rising either side
      into hills, and islands under the far pavilions and the distant tower.
      Coloured per vertex by height and slope: wet stone at the waterline,
      sand, soil, grass, bare rock on the steep faces.
    · a retaining wall and coping round the floor, where the flagstones used
      to end in a hard edge over the water. Two instanced draws for 320 blocks.
    · scattered props from the generated props GLB (build-assets.mjs): rocks,
      stone lanterns and wind-blown grass, each an InstancedLOD.

  The terrain and walls are procedural and exist from the first frame. The
  props stream in when their file lands; until then — or if it never does —
  the stage is simply barer. Nothing here has a collider: all of it is
  outside the fighters' bounds.
*/

export const PROPS_PATH = 'assets/props/courtyard-props.glb';
const WATER_Y = -1.15;
const COURT = 32;               // half-width of the flagstone floor
const TAU = Math.PI * 2;

/* ── noise ──────────────────────────────────────────────────────────── */

function hash2(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const smoothstep = (a: number, b: number, x: number): number => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));

function noise2(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm2(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * f + i * 17.1, y * f - i * 9.3) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.02;
  }
  return sum / norm;
}

/** Deterministic, so the layout is the same on every load and every machine. */
function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── terrain ────────────────────────────────────────────────────────── */

interface Pad { readonly x: number; readonly z: number; readonly r: number; readonly y: number }

/* Ground that has to be flat. The two back pavilions overhang the floor
   (kept below it, or the terrain would poke through the flagstones), and the
   distant tower gets an island instead of standing in the lake. */
const PADS: readonly Pad[] = [
  { x: -30, z: -30, r: 10, y: -0.4 },
  { x: 31, z: -31, r: 10, y: -0.4 },
  { x: -46, z: -120, r: 12, y: 0.0 },
];

function nearPad(x: number, z: number, margin: number): boolean {
  return PADS.some((p) => Math.hypot(x - p.x, z - p.z) < p.r + margin);
}

export function terrainHeight(x: number, z: number): number {
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const r = Math.hypot(x, z);
  const detail = fbm2(x * 0.021 + 17.3, z * 0.021 - 4.1, 5);
  const broad = fbm2(x * 0.0065 + 3.1, z * 0.0065 + 9.7, 3);

  // the open lake behind the duel, widening with distance until the far shore closes it
  const back = -z;
  const half = 24 + Math.max(0, back) * 0.45;
  const corridor = back > 0 ? 1 - smoothstep(half - 8, half + 10, Math.abs(x)) : 0;
  const lake = corridor * (1 - smoothstep(135, 175, back));

  // a moat round the walls (square, like the floor), then the banks
  const bank = smoothstep(COURT + 4, COURT + 18, edge);
  let h = WATER_Y - 1.4 + bank * (0.9 + detail * 4.6 + broad * 3.5) * (1 - lake);
  h += smoothstep(120, 200, r) * broad * 20 * (1 - lake * 0.5);

  for (const p of PADS) {
    const k = 1 - smoothstep(p.r, p.r + 8, Math.hypot(x - p.x, z - p.z));
    h += (p.y - h) * k;
  }
  return h;
}

function buildTerrain(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  /* Polar, so resolution falls off with distance the way the camera needs it
     to: rings bunch up near the walls and spread toward the horizon. */
  const RINGS = 110;
  const SEGS = 160;
  const R0 = 30;
  const R1 = 205;
  const cols = SEGS + 1;
  const pos = new Float32Array((RINGS + 1) * cols * 3);
  let k = 0;
  for (let i = 0; i <= RINGS; i++) {
    const r = R0 + (R1 - R0) * Math.pow(i / RINGS, 1.7);
    for (let j = 0; j <= SEGS; j++) {
      const a = (j / SEGS) * TAU;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      pos[k++] = x;
      pos[k++] = terrainHeight(x, z);
      pos[k++] = z;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEGS; j++) {
      const a = i * cols + j;
      const b = a + cols;
      // wound so the faces point up: radial × tangential points down in this layout
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();

  const nor = geo.getAttribute('normal');
  const col = new Float32Array(pos.length);
  const c = new THREE.Color();
  const WET = new THREE.Color(0.15, 0.14, 0.12);
  const SAND = new THREE.Color(0.58, 0.52, 0.41);
  const SOIL = new THREE.Color(0.34, 0.29, 0.22);
  const GRASS = new THREE.Color(0.29, 0.36, 0.18);
  const ROCK = new THREE.Color(0.44, 0.43, 0.41);
  const HIGH = new THREE.Color(0.55, 0.55, 0.53);
  for (let v = 0; v < pos.length / 3; v++) {
    const x = pos[v * 3]!;
    const y = pos[v * 3 + 1]!;
    const z = pos[v * 3 + 2]!;
    const rel = y - WATER_Y;
    c.copy(WET)
      .lerp(SAND, smoothstep(-0.35, 0.1, rel))
      .lerp(SOIL, smoothstep(0.3, 0.9, rel))
      .lerp(GRASS, smoothstep(0.4, 1.4, rel) * (0.5 + 0.5 * noise2(x * 0.08, z * 0.08)))
      .lerp(ROCK, 1 - smoothstep(0.68, 0.9, nor.getY(v)))
      .lerp(HIGH, smoothstep(9, 20, y) * 0.7);
    c.toArray(col, v * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

  const mat = pbrMat(0xffffff, 'rough');
  mat.vertexColors = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain';
  mesh.receiveShadow = true;
  return mesh;
}

/* ── the courtyard wall ─────────────────────────────────────────────── */

function buildCoping(geo: THREE.BoxGeometry, mat: THREE.MeshStandardMaterial): THREE.InstancedMesh[] {
  const BLOCK = 1.6;
  const perSide = Math.round((COURT * 2) / BLOCK);
  const rand = mulberry(91);
  const blocks = new THREE.InstancedMesh(geo, mat, perSide * 4);
  const caps = new THREE.InstancedMesh(geo, mat, perSide * 4);
  blocks.name = 'courtyard-wall';
  caps.name = 'courtyard-coping';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  // a point `along` the edge, `inset` in from it, on side `yaw` (rotation about +Y)
  const place = (along: number, inset: number, y: number, yaw: number): THREE.Vector3 => {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    return p.set(along * cos - inset * sin, y, -along * sin - inset * cos);
  };
  let i = 0;
  for (let side = 0; side < 4; side++) {
    const yaw = (side * Math.PI) / 2;
    for (let b = 0; b < perSide; b++) {
      const along = -COURT + BLOCK * (b + 0.5);
      q.setFromAxisAngle(up, yaw + (rand() - 0.5) * 0.03);
      place(along, COURT - 0.42, -0.66 + (rand() - 0.5) * 0.05, yaw);
      blocks.setMatrixAt(i, m.compose(p, q, s.set(BLOCK * 0.96, 1.46, 0.84)));
      blocks.setColorAt(i, c.setScalar(0.8 + rand() * 0.22));
      q.setFromAxisAngle(up, yaw + (rand() - 0.5) * 0.02);
      place(along, COURT - 0.5, 0.08, yaw);
      caps.setMatrixAt(i, m.compose(p, q, s.set(BLOCK * 0.985, 0.16, 1.1)));
      caps.setColorAt(i, c.setScalar(0.9 + rand() * 0.18));
      i++;
    }
  }
  for (const im of [blocks, caps]) {
    im.receiveShadow = true;
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
  }
  return [blocks, caps];
}

/* ── props ──────────────────────────────────────────────────────────── */

const UP = new THREE.Vector3(0, 1, 0);

function scatterRocks(rand: () => number): [LodInstance[], LodInstance[]] {
  const a: LodInstance[] = [];
  const b: LodInstance[] = [];
  const e = new THREE.Euler();
  for (let tries = 0; a.length + b.length < 170 && tries < 5000; tries++) {
    const ang = rand() * TAU;
    const r = 38 + Math.pow(rand(), 0.8) * 150;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (Math.max(Math.abs(x), Math.abs(z)) < COURT + 3 || nearPad(x, z, 2)) continue;
    const h = terrainHeight(x, z);
    if (h < WATER_Y - 0.7 || h > 18) continue;
    const size = (0.45 + Math.pow(rand(), 2.2) * 2.6) * (1 + r / 160);
    e.set((rand() - 0.5) * 0.35, rand() * TAU, (rand() - 0.5) * 0.35);
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, h - size * 0.18, z),
      new THREE.Quaternion().setFromEuler(e),
      new THREE.Vector3(size, size * (0.85 + rand() * 0.3), size),
    );
    (rand() < 0.6 ? a : b).push({ matrix, color: new THREE.Color().setScalar(0.82 + rand() * 0.34) });
  }
  return [a, b];
}

function placeLanterns(rand: () => number): LodInstance[] {
  const out: LodInstance[] = [];
  const put = (x: number, y: number, z: number, yaw: number): void => {
    out.push({
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1)),
      color: new THREE.Color().setScalar(0.9 + rand() * 0.2),
    });
  };
  // on the coping, clear of the pavilions that overhang the back corners
  const top = 0.16;
  const edge = COURT - 0.5;
  for (const x of [-15, -5, 5, 15]) put(x, top, -edge, 0);
  for (const z of [-14, 2, 16]) {
    put(-edge, top, z, Math.PI / 2);
    put(edge, top, z, Math.PI / 2);
  }
  // and a few down on the shore
  let shore = 0;
  for (let tries = 0; shore < 8 && tries < 4000; tries++) {
    const ang = rand() * TAU;
    const r = 44 + rand() * 80;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (nearPad(x, z, 3)) continue;
    const h = terrainHeight(x, z);
    if (h < WATER_Y + 0.35 || h > WATER_Y + 2.2) continue;
    if (Math.abs(terrainHeight(x + 1, z) - terrainHeight(x - 1, z)) > 0.5) continue;
    put(x, h - 0.05, z, rand() * TAU);
    shore++;
  }
  return out;
}

function scatterGrass(rand: () => number): LodInstance[] {
  const out: LodInstance[] = [];
  const e = new THREE.Euler();
  for (let tries = 0; out.length < 1400 && tries < 24000; tries++) {
    const ang = rand() * TAU;
    const r = 36 + Math.pow(rand(), 1.3) * 110;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    if (Math.max(Math.abs(x), Math.abs(z)) < COURT + 2.5) continue;
    const h = terrainHeight(x, z);
    const rel = h - WATER_Y;
    if (rel < 0.3 || rel > 9) continue;
    if (fbm2(x * 0.045 + 40, z * 0.045, 3) < 0.46) continue;           // patches, not a lawn
    const slope = Math.abs(terrainHeight(x + 0.8, z) - terrainHeight(x - 0.8, z))
      + Math.abs(terrainHeight(x, z + 0.8) - terrainHeight(x, z - 0.8));
    if (slope > 1.1) continue;
    const size = 0.8 + rand() * 0.9;
    e.set(0, rand() * TAU, 0);
    out.push({
      matrix: new THREE.Matrix4().compose(
        new THREE.Vector3(x, h - 0.04, z),
        new THREE.Quaternion().setFromEuler(e),
        new THREE.Vector3(size, size * (0.8 + rand() * 0.5), size),
      ),
      color: new THREE.Color(0.85 + rand() * 0.25, 0.9 + rand() * 0.2, 0.8 + rand() * 0.2),
      // spatially coherent, so gusts roll across a patch instead of every tuft twitching on its own
      phase: x * 0.35 + z * 0.21,
    });
  }
  return out;
}

/** Grass that bends from the root: tips follow two summed sines, phased per tuft. */
function windGrassMaterial(): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  m.vertexColors = true;
  const phase = attribute('lodPhase', 'float');
  const sway = sin(time.mul(1.4).add(phase)).mul(0.6).add(sin(time.mul(3.1).add(phase.mul(1.9))).mul(0.4));
  const bend = uv().y.mul(uv().y);
  m.positionNode = positionLocal.add(vec3(sway.mul(0.085), 0, sway.mul(0.045)).mul(bend));
  return m;
}

/* ── lifetime ───────────────────────────────────────────────────────── */

interface Landscape {
  readonly group: THREE.Group;
  readonly terrain: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  readonly coping: THREE.InstancedMesh[];
  readonly copingGeo: THREE.BoxGeometry;
  readonly copingMat: THREE.MeshStandardMaterial;
  readonly rockMat: THREE.MeshStandardMaterial;
  readonly glowMat: THREE.MeshBasicMaterial;
  readonly grassMat: THREE.MeshStandardNodeMaterial;
  readonly lods: InstancedLOD[];
  holdsProps: boolean;
}

let land: Landscape | null = null;
let generation = 0;
/* The quality preset's scenery columns, kept so props that stream in after a change still honour it. */
let lodBias = 1;
let grassOn = true;

function applyQualityTo(lod: InstancedLOD): void {
  lod.setBias(lodBias, camera);
  if (lod.name === 'grass') lod.visible = grassOn;
}

export function setLandscapeQuality(p: QualityPreset): void {
  lodBias = p.lodBias;
  grassOn = p.grass;
  if (land) for (const lod of land.lods) applyQualityTo(lod);
}

export function buildLandscape(theme: Theme): void {
  const group = new THREE.Group();
  group.name = 'landscape';
  scene.add(group);

  const terrain = buildTerrain();
  group.add(terrain);

  // the wall is masonry like the rest of the courtyard: theme tint and rock texture come with the stone tones
  const copingMat = pbrMat(0xffffff, 'stone');
  copingMat.userData.tone = 0.95;
  tintStone(copingMat, theme.stone, 0.95);
  arena.stoneTones.push(copingMat);
  const copingGeo = new THREE.BoxGeometry(1, 1, 1);
  const coping = buildCoping(copingGeo, copingMat);
  group.add(...coping);

  // props carry no UVs, so they get their own stone rather than the textured stone tones
  const rockMat = pbrMat(0xffffff, 'stone');
  rockMat.vertexColors = true;

  land = {
    group, terrain, coping, copingGeo, copingMat, rockMat,
    glowMat: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.35, 0.6) }),   // HDR: blooms
    grassMat: windGrassMaterial(),
    lods: [],
    holdsProps: false,
  };
  applyLandscapeTheme(theme);
}

function lodLevels(gltf: GLTF, spec: ReadonlyArray<readonly [number, ReadonlyArray<readonly [string, THREE.Material]>]>): LodLevel[] | null {
  const levels: LodLevel[] = [];
  for (const [minSize, parts] of spec) {
    const list: LodPart[] = [];
    for (const [name, material] of parts) {
      const mesh = gltf.scene.getObjectByName(name) as THREE.Mesh | undefined;
      if (!mesh?.isMesh) return null;
      list.push({ geometry: mesh.geometry, material });
    }
    levels.push({ minSize, parts: list });
  }
  return levels;
}

/** Fetch the props file and scatter it. Safe to call before or after the curtain lifts. */
export async function loadLandscapeProps(): Promise<void> {
  if (!land) return;
  const token = ++generation;
  const job = Assets.job(PROPS_PATH, 'arena');
  let gltf: GLTF;
  try {
    gltf = await Assets.loadGLTF(PROPS_PATH, job.progress);
  } catch (err) {
    job.fail();
    if (import.meta.env.DEV) console.warn('[landscape] props unavailable; run `npm run assets`', err);
    return;
  }
  job.done();
  if (token !== generation || !land) {
    Assets.release(PROPS_PATH);
    return;
  }
  const L = land;
  L.holdsProps = true;

  const rand = mulberry(1337);
  const [rocksA, rocksB] = scatterRocks(rand);
  const add = (name: string, levels: LodLevel[] | null, instances: LodInstance[]): void => {
    if (!levels || !instances.length) return;
    const lod = new InstancedLOD(name, levels, instances);
    L.lods.push(lod);
    L.group.add(lod);
    lod.update(camera, true);
    applyQualityTo(lod);
  };
  /* Thresholds are on-screen size (radius ÷ half the view height). A boulder
     keeps its full mesh until it is under a tenth of the screen; grass is
     dropped entirely once a tuft would be a couple of pixels. */
  add('rocks.boulder', lodLevels(gltf, [
    [0.09, [['rock_a_lod0', L.rockMat]]],
    [0.025, [['rock_a_lod1', L.rockMat]]],
    [0.004, [['rock_a_lod2', L.rockMat]]],
  ]), rocksA);
  add('rocks.slab', lodLevels(gltf, [
    [0.09, [['rock_b_lod0', L.rockMat]]],
    [0.025, [['rock_b_lod1', L.rockMat]]],
    [0.004, [['rock_b_lod2', L.rockMat]]],
  ]), rocksB);
  add('lanterns', lodLevels(gltf, [
    [0.07, [['lantern_lod0', L.rockMat], ['lantern_glow_lod0', L.glowMat]]],
    [0.02, [['lantern_lod1', L.rockMat], ['lantern_glow_lod1', L.glowMat]]],
    [0.004, [['lantern_lod2', L.rockMat], ['lantern_glow_lod2', L.glowMat]]],
  ]), placeLanterns(rand));
  add('grass', lodLevels(gltf, [
    [0.03, [['grass_lod0', L.grassMat]]],
    [0.008, [['grass_lod1', L.grassMat]]],
  ]), scatterGrass(rand));
}

/** Once per displayed frame. Cheap when the camera is still. */
export function updateLandscape(): void {
  if (!land) return;
  for (const lod of land.lods) if (lod.visible) lod.update(camera);
}

export function applyLandscapeTheme(T: Theme): void {
  if (!land) return;
  land.terrain.material.color.set(0xffffff).lerp(new THREE.Color(T.ridge ?? 0x8fa6b4), 0.5);
  tintStone(land.rockMat, T.stone, 1.9);
  land.grassMat.color.set(0xffffff).lerp(new THREE.Color(T.hemi.gnd), 0.3);
}

export function landscapeStats(): Record<string, unknown> {
  if (!land) return { built: false };
  return {
    built: true,
    props: land.holdsProps,
    terrainTriangles: (land.terrain.geometry.index?.count ?? 0) / 3,
    lods: Object.fromEntries(land.lods.map((l) => [l.name, [...l.counts]])),
  };
}

export function disposeLandscape(): void {
  generation++;
  if (!land) return;
  const L = land;
  land = null;
  for (const lod of L.lods) lod.dispose();
  for (const im of L.coping) im.dispose();
  L.copingGeo.dispose();
  L.terrain.geometry.dispose();
  for (const m of [L.terrain.material, L.copingMat, L.rockMat]) {
    releaseEnv(m);
    m.dispose();
  }
  L.glowMat.dispose();
  L.grassMat.dispose();
  const i = arena?.stoneTones.indexOf(L.copingMat) ?? -1;
  if (i >= 0) arena.stoneTones.splice(i, 1);
  L.group.removeFromParent();
  if (L.holdsProps) Assets.release(PROPS_PATH);
}
