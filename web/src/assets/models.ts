import * as THREE from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  ClipLib, applyLibraryClips, bindClips, bindLibraryToAll, captureRest, libraryTable, loadCharacterClips,
} from '../anim/animation';
import { buildBoneRig, collectBones, isBone, pickBone } from '../anim/bones';
import type { AnimTarget } from '../anim/types';
import { queryParam, storageGet, storageSet } from '../core/platform';
import type { Assist } from '../game/assist-rig';
import type { Fighter } from '../game/fighter';
import { assistRigs, rigs } from '../game/rigs';
import { state } from '../game/state';
import { ENV_MATS, MODEL_ENV } from '../render/stage';
import { schedulePortraits } from '../ui/portraits';
import { CLIPS, loadClipManifest, loadWithFallback, resetClipManifest, type ModelAsset } from './loader';

/*
  Character art.

  Every fighter ships with a hand-built primitive rig that is always present
  and always correct. A model, if one loads, is layered ON TOP: the primitive
  rig is hidden but keeps being posed, because the hit- and hurtboxes hang off
  its bones — so combat geometry is identical whichever art is showing, and a
  failed or slow fetch costs nothing but the wait.
*/

export type CastName = 'classic' | 'authored' | 'compact';

interface Cast {
  /** Height every model is normalised to. A chibi cast wants less, or its heads come out enormous. */
  readonly fit: number;
  readonly fighters: readonly string[];
  readonly assists: readonly string[];
}

const CASTS: Readonly<Record<CastName, Cast>> = {
  /* Four rigged humanoids from the three.js examples — three Mixamo exports the
     library retargets onto without a special case, and a robot that carries
     its own clips. Nine megabytes, animated on arrival. */
  classic: {
    fit: 3.2,
    fighters: ['assets/models/x1.glb', 'assets/models/x2.glb', 'assets/models/x3.glb', 'assets/models/x4.glb'],
    assists: ['assets/models/x3.glb', 'assets/models/x1.glb'],
  },
  authored: {
    fit: 3.2,
    fighters: ['assets/models/p1.glb', 'assets/models/p2.glb', 'assets/models/p3.glb', 'assets/models/p4.glb'],
    assists: ['assets/models/s1.glb', 'assets/models/s2.glb'],
  },
  compact: {
    fit: 2.55,
    fighters: ['assets/models/k1.glb', 'assets/models/k2.glb', 'assets/models/k3.glb', 'assets/models/k4.glb'],
    assists: ['assets/models/ks1.glb', 'assets/models/ks2.glb'],
  },
};

export function isCastName(name: unknown): name is CastName {
  return name === 'classic' || name === 'authored' || name === 'compact';
}

export const ASSETS = {
  useExternal: true,
  /** Standard Mixamo cm → m normalisation, before the fit. */
  mixamoScale: 0.01,
  fitHeight: 3.2,
  cast: 'classic' as CastName,
  fighters: [] as string[],
  assists: [] as string[],
  cache: new Map<string, ModelAsset>(),
  loaded: 0,
  failed: 0,
  borrowed: 0,
  total: 6,
  stubClips: 0,
  status: 'loading...',
  clips: [] as string[],
};

/* Bumped on reset. Every async continuation checks it, so a load that lands
   after the game was torn down (hot reload, or a cast switch) dresses nothing. */
let generation = 0;

type StatusListener = (status: string, anyLoaded: boolean) => void;
const statusListeners = new Set<StatusListener>();

export function onAssetStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  fn(ASSETS.status, ASSETS.loaded > 0);
  return () => statusListeners.delete(fn);
}

export function reportAssets(): void {
  const done = ASSETS.loaded + ASSETS.failed;
  const lib = ClipLib.count;
  ASSETS.status = !ASSETS.useExternal
    ? 'procedural (off)'
    : ASSETS.loaded
      ? `MODELS ${ASSETS.loaded}/${ASSETS.total}`
        + (ASSETS.borrowed ? ` +${ASSETS.borrowed} stand-in` : '')
        + (CLIPS.added ? ` +${CLIPS.added} clips` : '')
        + (lib ? ` +${lib} lib` : '')
        + (CLIPS.rejected ? ` (${CLIPS.rejected} unbindable)` : '')
        + (ASSETS.stubClips && !CLIPS.added && !lib ? ' (no motion)' : '')
      : done >= ASSETS.total ? 'procedural fallback' : `loading ${done}/${ASSETS.total}`;
  for (const fn of statusListeners) fn(ASSETS.status, ASSETS.loaded > 0);
}

/* ── fitting a model to the rig ─────────────────────────────────────── */

/* The fit height is deliberately the PRIMITIVE RIG's height: the rig carries
   every hurtbox. Normalise the art shorter than the rig and a fighter's head
   can be hit from a foot above it. */
function measureFit(model: THREE.Object3D): { fit: number; lowest: number } {
  model.updateMatrixWorld(true);
  const bones: THREE.Bone[] = [];
  model.traverse((o) => { if (isBone(o)) bones.push(o); });

  let lowest = Infinity;
  let height: number;
  if (bones.length > 2) {
    // a SkinnedMesh's bind-pose geometry can be authored at a wildly different
    // scale from the skeleton driving it, so measure the bones
    let highest = -Infinity;
    const v = new THREE.Vector3();
    for (const b of bones) {
      b.getWorldPosition(v);
      lowest = Math.min(lowest, v.y);
      highest = Math.max(highest, v.y);
    }
    height = (highest - lowest) * 1.16;           // bones stop at the neck joint
  } else {
    const box = new THREE.Box3().setFromObject(model);
    lowest = box.min.y;
    height = box.max.y - box.min.y;
  }
  return { fit: height > 0.0001 ? ASSETS.fitHeight / height : 1, lowest };
}

/* Rigs are built facing +Z. A model authored facing -Z ends up backwards, so
   the facing is measured rather than assumed per format: the toe always sits
   forward of the ankle. */
function detectYaw(model: THREE.Object3D): number {
  const bones = collectBones(model);
  const foot = pickBone(bones, [/^leftfoot$/, /^leftankle$/, /^leftfoot01$/], null);
  const toe = pickBone(bones, [/^lefttoe/, /^leftball$/, /^lefttoebase$/], null);
  if (!foot || !toe) return 0;                    // unknown rig: leave as authored
  model.updateMatrixWorld(true);
  const fw = foot.getWorldPosition(new THREE.Vector3());
  const tw = toe.getWorldPosition(new THREE.Vector3());
  if (Math.abs(tw.z - fw.z) < 1e-4) return 0;
  return tw.z - fw.z < 0 ? Math.PI : 0;
}

function prepModel(model: THREE.Object3D): number {
  const prepped = model.userData.prepped as number | undefined;
  if (prepped) return prepped;                    // normalising twice squares the scale
  model.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false;
    }
  });
  model.rotation.y = detectYaw(model);
  model.scale.setScalar(ASSETS.mixamoScale);
  const m = measureFit(model);
  const k = ASSETS.mixamoScale * m.fit;
  model.scale.setScalar(k);

  /* Ground off the real bounding box when it can be trusted. For a skinned
     mesh it cannot: Box3 walks the bind-pose geometry, which measured this
     cast at 0.028 units tall against an actual 3.2. Those fall back to the
     lowest bone. */
  model.position.y = 0;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const boxH = box.max.y - box.min.y;
  const trust = Number.isFinite(boxH) && boxH > ASSETS.fitHeight * 0.5;
  model.position.y = trust ? -box.min.y : -m.lowest * m.fit;
  model.userData.prepped = k;
  return k;
}

/* ── materials ──────────────────────────────────────────────────────── */

/*
  Re-materialise a loaded model onto the scene's shading. FBX brings Phong and
  glTF brings Standard, so the two formats used to grade completely
  differently under one light rig. One MeshStandardMaterial per source, the
  diffuse map kept and sRGB-tagged, and a tint whose strength depends on
  whether there is a texture to preserve.
*/
function tintModel(model: THREE.Object3D, accent: number): void {
  const tint = new THREE.Color(accent);
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((m) => {
      const src = m as THREE.MeshStandardMaterial;
      const map = src.map ?? null;
      if (map) {
        map.colorSpace = THREE.SRGBColorSpace;
        map.anisotropy = 4;
        map.needsUpdate = true;
      }
      const base = src.color ? src.color.clone() : new THREE.Color(0xbbbbbb);
      // near-black source colour: never authored for a lit scene
      if (base.r + base.g + base.b < 0.12) base.setRGB(0.72, 0.70, 0.68);
      base.lerp(tint, map ? 0.20 : 0.55);
      /* Mixamo textures are authored for a studio three-point setup, and several
         render as silhouettes under one key light. The diffuse multiplier is not
         clamped at 1, so lifting it brightens the map; tone mapping pulls the
         highlights back. */
      base.multiplyScalar(map ? 1.55 : 0.86);

      const std = new THREE.MeshStandardMaterial({
        color: base,
        map,
        normalMap: src.normalMap ?? null,
        transparent: !!src.transparent,
        opacity: src.opacity ?? 1,
        alphaTest: src.alphaTest || 0,
        side: src.side ?? THREE.FrontSide,
        roughness: 0.62,
        metalness: 0.06,
        envMap: MODEL_ENV,
        envMapIntensity: state.theme.modelEnv || 0.85,
        emissive: tint.clone().multiplyScalar(0.10),
        emissiveIntensity: 1,
      });
      std.userData.baseColor = base.clone();
      std.userData.baseEmissive = std.emissive.clone();
      ENV_MATS.push(std);                         // so a theme change can re-probe it
      return std;
    });
    mesh.material = next.length === 1 ? next[0]! : next;
  });
}

/* Metalness 0.8 once turned the cast into bronze statues: a metal surface has
   almost no diffuse response, so the albedo that told the four apart stopped
   contributing. 0.25 keeps a sheen and lets each character's colour through;
   materials that arrived metallic keep their own values. */
const PBR = { roughness: 0.42, metalness: 0.25, emissive: 0x221100, keepAbove: 0.6 } as const;

function applyPBR(model: THREE.Object3D): void {
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of list) {
      const m = mat as THREE.MeshStandardMaterial;
      if (m?.isMeshStandardMaterial !== true) continue;
      const metal = m.metalness >= PBR.keepAbove;
      m.metalness = metal ? m.metalness : PBR.metalness;
      m.roughness = metal ? m.roughness : PBR.roughness;
      m.emissive.setHex(PBR.emissive);
      // applyFlash() restores emissive from this snapshot; without updating it
      // the first hit that landed quietly reverted this pass
      m.userData.baseEmissive = m.emissive.clone();
      m.needsUpdate = true;
    }
  });
}

function collectMats(model: THREE.Object3D): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) if (m?.userData.baseColor) out.push(m as THREE.MeshStandardMaterial);
  });
  return out;
}

/* ── dressing ───────────────────────────────────────────────────────── */

/*
  Move an armed fighter's blade onto the model's hand. The weapon is built on
  the primitive rig's lead fist — hidden the moment a model loads, which once
  left two fighters swinging with no sword in frame while the hitbox tracked an
  invisible blade. The blade-tip anchor carrying the hitbox is a child of the
  weapon, so it comes along. The bone's world scale and local axis are undone
  on the way, the axis read off the hand's own child bone.
*/
function rehomeWeapon(f: Fighter, model: THREE.Object3D, k: number): boolean {
  if (!f.weapon || !f.def.armed) return false;
  const hand = pickBone(collectBones(model), [/^righthand$/, /^rightwrist$/, /^righthand01$/, /^rightpalm$/], null);
  if (!hand) return false;

  const child = hand.children.find((c) => isBone(c) && c.position.lengthSq() > 1e-10);
  const down = child ? child.position.clone().normalize() : new THREE.Vector3(0, 1, 0);

  hand.add(f.weapon);
  f.weapon.scale.setScalar(1 / (k || 1));
  f.weapon.position.set(0, 0, 0);
  f.weapon.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), down);
  f.weaponBone = hand;
  return true;
}

function applyModel(f: Fighter, asset: ModelAsset): void {
  const model = asset.object;
  const scale = prepModel(model);
  f.modelFit = model.scale.x;          // the landing squash multiplies this, not 1
  captureRest(model);                  // before anything poses it
  tintModel(model, f.def.accent);
  applyPBR(model);                     // after the tint, which writes .color
  f.root.add(model);
  f.model = model;
  f.modelMats = collectMats(model);
  f.boneRig = buildBoneRig(model);
  f.body.visible = false;              // primitives keep posing, just unseen
  rehomeWeapon(f, model, scale);
  ASSETS.stubClips += bindClips(f, model, asset.animations);
}

function applyAssistModel(a: Assist, asset: ModelAsset): void {
  const model = asset.object;
  prepModel(model);
  captureRest(model);
  tintModel(model, a.def.color);
  a.baseY = model.position.y;
  a.baseScale = model.scale.x;
  a.baseYaw = model.rotation.y;
  a.group.add(model);
  a.model = model;
  for (const p of a.primParts) p.visible = false;
  ASSETS.stubClips += bindClips(a, model, asset.animations);
}

/* Each cached file is cloned onto both slot copies of a character, so both
   players can pick the same fighter and still get independent skeletons. */
function cloneAsset(asset: ModelAsset): ModelAsset {
  return { object: cloneSkinned(asset.object), animations: asset.animations };
}

function dressFighter(index: number, asset: ModelAsset): void {
  for (const slot of [0, 1] as const) {
    const f = rigs[slot][index];
    if (!f || f.model) continue;
    applyModel(f, cloneAsset(asset));
    applyLibraryClips(f, libraryTable(f.def, false));
  }
  schedulePortraits();                  // the card should show whatever art just arrived
}

function dressAssist(index: number, asset: ModelAsset): void {
  for (const slot of [0, 1] as const) {
    const a = assistRigs[slot][index];
    if (!a || a.model) continue;
    applyAssistModel(a, cloneAsset(asset));
    applyLibraryClips(a, libraryTable(null, true));
  }
}

type Dress = (index: number, asset: ModelAsset) => void;

async function preload(paths: readonly string[], dress: Dress, gen: number): Promise<void> {
  await Promise.all(paths.map(async (path, index) => {
    let asset: ModelAsset;
    try {
      asset = await loadWithFallback(path);
    } catch {
      if (gen !== generation) return;
      ASSETS.failed++;                  // the primitive rig simply stays visible
      reportAssets();
      return;
    }
    if (gen !== generation) return;
    ASSETS.cache.set(path, asset);
    ASSETS.loaded++;
    for (const c of asset.animations) if (!ASSETS.clips.includes(c.name)) ASSETS.clips.push(c.name);
    try {
      dress(index, asset);
    } catch (err) {
      console.error(`[models] dressing ${path} failed`, err);
    }
    reportAssets();
  }));
}

/* Stand-in art for a file that never arrived. Every slot is tinted to its own
   accent anyway, so a sibling's mesh reads as a different character rather
   than a missing asset — and only slots with nothing else to show get one. */
function borrowMissing(paths: readonly string[], dress: Dress, pool: readonly [readonly AnimTarget[], readonly AnimTarget[]]): void {
  const donor = paths.map((p) => ASSETS.cache.get(p)).find((a) => a);
  if (!donor) return;
  paths.forEach((path, j) => {
    if (ASSETS.cache.has(path) || pool[0][j]?.model) return;
    dress(j, donor);
    ASSETS.borrowed++;
  });
  reportAssets();
}

/* ── cast selection ─────────────────────────────────────────────────────
   Chosen before anything is fetched, because changing it means a different
   set of files — so it is a reload, not a live swap. */

function selectCast(name: CastName): CastName {
  ASSETS.cast = name;
  ASSETS.fighters = [...CASTS[name].fighters];
  ASSETS.assists = [...CASTS[name].assists];
  ASSETS.fitHeight = CASTS[name].fit;
  return name;
}

export function restoreCast(): CastName {
  const q = queryParam('cast') ?? storageGet('ashfall.cast');
  return selectCast(isCastName(q) ? q : ASSETS.cast);
}

export function switchCast(name: CastName): void {
  if (name === ASSETS.cast) return;
  storageSet('ashfall.cast', name);
  window.location.reload();
}

export function beginAssetLoad(): void {
  if (!ASSETS.useExternal) {
    reportAssets();
    return;
  }
  const gen = generation;
  ASSETS.total = ASSETS.fighters.length + ASSETS.assists.length;
  reportAssets();

  /* The library and the meshes race; whichever lands second binds. Starting
     the library first means its clips are usually parsed by the time a
     character arrives. */
  ClipLib.load();
  ClipLib.ready(() => {
    if (gen !== generation) return;
    bindLibraryToAll();
    reportAssets();
  });

  // the manifest lands first: it can redirect which file is the model
  void loadClipManifest().then(() => {
    if (gen !== generation) return;
    void preload(ASSETS.fighters, dressFighter, gen).then(() => {
      if (gen !== generation) return;
      borrowMissing(ASSETS.fighters, dressFighter, rigs);
      loadCharacterClips(ASSETS.fighters, rigs, reportAssets);
    });
    void preload(ASSETS.assists, dressAssist, gen).then(() => {
      if (gen !== generation) return;
      borrowMissing(ASSETS.assists, dressAssist, assistRigs);
      loadCharacterClips(ASSETS.assists, assistRigs, reportAssets);
    });
  });
}

export function resetAssets(): void {
  generation++;
  ASSETS.cache.clear();
  ASSETS.loaded = ASSETS.failed = ASSETS.borrowed = ASSETS.stubClips = 0;
  ASSETS.clips.length = 0;
  ASSETS.status = 'loading...';
  statusListeners.clear();
  ClipLib.reset();
  resetClipManifest();
}
