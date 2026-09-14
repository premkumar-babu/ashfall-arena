#!/usr/bin/env node
/*
  Ashfall Arena — offline asset pipeline.            npm run assets [-- models|textures|props]

  Source art in ../assets stays the source of truth and is never modified.
  This writes optimised copies under ../assets/opt/ plus a manifest the game
  reads at boot (src/assets/pipeline.ts). Anything missing from the manifest
  simply loads from its source file, so running this is an optimisation, not a
  requirement.

  models    every GLB the game loads (casts + animation library):
            dedup → prune → resample → weld → textures to KTX2 → Draco
  textures  the surface JPEGs to KTX2 (Basis Universal): ETC1S for colour and
            data maps, UASTC + Zstandard for normal maps. Mipmapped, POT, and
            pre-flipped so they line up with the JPEGs they replace.
  props     scenery generated here (rocks, stone lanterns, grass), each at up
            to three levels of detail, Draco-compressed into one GLB. Rocks
            are simplified from the full mesh with meshoptimizer; the lantern
            is re-modelled per level, because a simplifier makes a mess of
            hard-surface shapes.
*/
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRTextureBasisu } from '@gltf-transform/extensions';
import { dedup, draco, listTextureSlots, prune, resample, weld } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import { encodeToKTX2 } from 'ktx2-encoder';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '../../assets');
const OUT = path.join(ASSETS, 'opt');
const only = process.argv[2] ?? 'all';

const MODELS = [
  'models/x1.glb', 'models/x2.glb', 'models/x3.glb', 'models/x4.glb',
  'models/k1.glb', 'models/k2.glb', 'models/k3.glb', 'models/k4.glb',
  'models/ks1.glb', 'models/ks2.glb', 'models/p1.glb',
  'anim/Rig_Medium_General.glb', 'anim/Rig_Medium_MovementBasic.glb', 'anim/Rig_Medium_CombatMelee.glb',
];

/** kind: colour (sRGB ETC1S) · data (linear ETC1S) · normal (linear UASTC). */
const TEXTURES = [
  { file: 'textures/stone_tile.jpg', kind: 'colour', max: 1024 },
  { file: 'textures/slate_diff.jpg', kind: 'colour', max: 2048 },
  { file: 'textures/slate_nor.jpg', kind: 'normal', max: 1024 },
  { file: 'textures/slate_rough.jpg', kind: 'data', max: 1024 },
  { file: 'textures/timber.jpg', kind: 'colour', max: 1024 },
  { file: 'textures/rock.jpg', kind: 'colour', max: 1024 },
  { file: 'textures/brick.jpg', kind: 'colour', max: 1024 },
  /* Effect flipbooks. As PNGs they decode to full RGBA — big_hit alone was
     47 MB of GPU memory at 3342×2765. The frame grid is a fraction of the
     sheet, so a non-uniform resize to a power of two leaves every frame where
     it was, and the same pre-flip keeps row 0 at the top. */
  { file: 'vfx/big_hit_6x5.png', kind: 'colour', max: 2048 },
  { file: 'vfx/fire_ring_6x5.png', kind: 'colour', max: 2048 },
  { file: 'vfx/charge_7x6.png', kind: 'colour', max: 2048 },
  { file: 'vfx/impact_white_6x4.png', kind: 'colour', max: 2048 },
  { file: 'vfx/electric_ring_6x5.png', kind: 'colour', max: 2048 },
  { file: 'vfx/star_explosion_6x5.png', kind: 'colour', max: 1024 },
  { file: 'vfx/spark_05.png', kind: 'colour', max: 512 },
  { file: 'vfx/slash_02.png', kind: 'colour', max: 512 },
  { file: 'vfx/circle_05.png', kind: 'colour', max: 512 },
  { file: 'vfx/light_01.png', kind: 'colour', max: 512 },
];

const PROPS_FILE = 'props/courtyard-props.glb';

const kb = (n) => `${(n / 1024).toFixed(0).padStart(6)} KB`;
const rel = (p) => `assets/${p.replace(/\\/g, '/')}`;

/* ── shared ─────────────────────────────────────────────────────────── */

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });

const DRACO = {
  method: 'edgebreaker', encodeSpeed: 5, decodeSpeed: 5,
  quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8, quantizeGeneric: 12,
};

const nearestPot = (n, max) => Math.min(max, 2 ** Math.max(2, Math.round(Math.log2(n))));

/**
 * Encode one image to KTX2. Always power-of-two: WebGPU refuses a block-
 * compressed texture whose size is not a multiple of the block, and a POT
 * size keeps every mip level a multiple too.
 */
async function toKtx2(input, { kind, max, flipY }) {
  let img = sharp(input);
  const meta = await img.metadata();
  const w = nearestPot(meta.width, max);
  const h = nearestPot(meta.height, max);
  img = img.resize(w, h, { fit: 'fill', kernel: 'lanczos3' });
  if (flipY) img = img.flip();
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = new Uint8Array(data);
  const common = { generateMipmap: true, isKTX2File: true, imageDecoder: async () => ({ data: raw, width: info.width, height: info.height }) };
  const opts = kind === 'normal'
    /* UASTC for normals: ETC1S's shared endpoints smear the X/Y pairs into
       visible blocking. Rate-distortion optimisation trades a little quality
       for runs Zstandard can find, which is most of the size. */
    ? { isUASTC: true, isNormalMap: true, isPerceptual: false, isSetKTX2SRGBTransferFunc: false, needSupercompression: true, uastcLDRQualityLevel: 1, enableRDO: true, rdoQualityLevel: 4.0 }
    : kind === 'data'
      ? { isUASTC: false, qualityLevel: 150, compressionLevel: 3, isPerceptual: false, isSetKTX2SRGBTransferFunc: false }
      : { isUASTC: false, qualityLevel: 170, compressionLevel: 3, isPerceptual: true, isSetKTX2SRGBTransferFunc: true };
  const out = await encodeToKTX2(raw, { ...common, ...opts });
  return { bytes: out, width: w, height: h, source: `${meta.width}×${meta.height}` };
}

async function writeFile(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
  return bytes.byteLength;
}

/* ── models ─────────────────────────────────────────────────────────── */

const COLOUR_SLOTS = new Set(['baseColorTexture', 'emissiveTexture', 'diffuseTexture', 'specularGlossinessTexture']);

async function textureToKtx2(doc) {
  const textures = doc.getRoot().listTextures();
  let n = 0;
  for (const tex of textures) {
    const image = tex.getImage();
    if (!image || tex.getMimeType() === 'image/ktx2') continue;
    const slots = listTextureSlots(tex);
    const kind = slots.includes('normalTexture') ? 'normal' : slots.some((s) => COLOUR_SLOTS.has(s)) ? 'colour' : 'data';
    // glTF images are already top-left origin, the same as KTX2: no flip. A character's
    // normal map is never more than a few hundred pixels tall on screen, so 512 is plenty.
    const { bytes } = await toKtx2(Buffer.from(image), { kind, max: kind === 'normal' ? 512 : 1024, flipY: false });
    tex.setImage(bytes).setMimeType('image/ktx2');
    if (tex.getURI()) tex.setURI(tex.getURI().replace(/\.\w+$/, '.ktx2'));
    n++;
  }
  if (n) doc.createExtension(KHRTextureBasisu).setRequired(true);
  return n;
}

async function buildModels(manifest) {
  console.log('\nmodels');
  for (const file of MODELS) {
    const src = path.join(ASSETS, file);
    const srcBytes = (await fs.stat(src).catch(() => null))?.size;
    if (!srcBytes) {
      console.log(`  skip ${file} (missing)`);
      continue;
    }
    const doc = await io.read(src);
    // keepLeaves: end-effector bones (toe tips, finger ends) carry no mesh, but the game
    // reads them to detect a model's facing and to orient a re-homed weapon
    await doc.transform(dedup(), prune({ keepLeaves: true }), resample(), weld());
    const ktx2 = await textureToKtx2(doc);
    const morphs = doc.getRoot().listMeshes().some((m) => m.listPrimitives().some((p) => p.listTargets().length));
    let dracoOk = true;
    try {
      await doc.transform(draco(DRACO));
    } catch (err) {
      dracoOk = false;
      console.warn(`  ${file}: Draco skipped (${err.message})`);
    }
    const bytes = await io.writeBinary(doc);
    const outRel = path.join('opt', file);
    await writeFile(path.join(ASSETS, outRel), bytes);
    manifest.models[rel(file)] = { url: rel(outRel), bytes: bytes.byteLength, sourceBytes: srcBytes, draco: dracoOk, ktx2 };
    console.log(`  ${file.padEnd(36)} ${kb(srcBytes)} → ${kb(bytes.byteLength)}  ${ktx2 ? `ktx2×${ktx2} ` : ''}${morphs ? '(morph targets stay uncompressed)' : ''}`);
  }
}

/* ── textures ───────────────────────────────────────────────────────── */

async function buildTextures(manifest) {
  console.log('\ntextures');
  for (const t of TEXTURES) {
    const src = path.join(ASSETS, t.file);
    const input = await fs.readFile(src).catch(() => null);
    if (!input) {
      console.log(`  skip ${t.file} (missing)`);
      continue;
    }
    // the JPEGs load with flipY = true and KTX2 never flips, so flip once here
    const { bytes, width, height, source } = await toKtx2(input, { kind: t.kind, max: t.max, flipY: true });
    const outRel = path.join('opt', t.file.replace(/\.\w+$/, '.ktx2'));
    await writeFile(path.join(ASSETS, outRel), bytes);
    manifest.textures[rel(t.file)] = { url: rel(outRel), bytes: bytes.byteLength, sourceBytes: input.byteLength, kind: t.kind, size: `${width}×${height}` };
    console.log(`  ${t.file.padEnd(36)} ${kb(input.byteLength)} → ${kb(bytes.byteLength)}  ${t.kind} ${source} → ${width}×${height}`);
  }
}

/* ── props: procedural scenery with LODs ────────────────────────────── */

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => smooth(Math.min(1, Math.max(0, (x - a) / (b - a))));

function valueNoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = smooth(x - xi), v = smooth(y - yi), w = smooth(z - zi);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

function fbm(x, y, z, octaves) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, z * f) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

function setColour(geo, fn) {
  const p = geo.attributes.position;
  const n = geo.attributes.normal;
  const col = new Float32Array(p.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    fn(c, p.getX(i), p.getY(i), p.getZ(i), n ? n.getY(i) : 1);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** Keep only the vertices an index list still uses. */
function compact(geo, indices) {
  const remap = new Map();
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    let k = remap.get(indices[i]);
    if (k === undefined) {
      k = remap.size;
      remap.set(indices[i], k);
    }
    out[i] = k;
  }
  const res = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    const arr = new Float32Array(remap.size * attr.itemSize);
    for (const [from, to] of remap) for (let j = 0; j < attr.itemSize; j++) arr[to * attr.itemSize + j] = attr.array[from * attr.itemSize + j];
    res.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize));
  }
  res.setIndex(new THREE.BufferAttribute(out, 1));
  return res;
}

function simplifyTo(geo, ratio, error) {
  const index = new Uint32Array(geo.index.array);
  const target = Math.max(12, Math.floor((index.length * ratio) / 3) * 3);
  const [simplified] = MeshoptSimplifier.simplify(index, new Float32Array(geo.attributes.position.array), 3, target, error, ['ErrorAbsolute']);
  const res = compact(geo, simplified);
  res.computeVertexNormals();
  return res;
}

function rock(seed, shape) {
  let g = new THREE.IcosahedronGeometry(1, 5);
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  g = mergeVertices(g);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // broad lumps, then sharper chips on top of them
    const lump = fbm(v.x * 1.1 + seed, v.y * 1.1, v.z * 1.1, 3);
    const chip = fbm(v.x * 3.7, v.y * 3.7 + seed, v.z * 3.7, 3);
    v.multiplyScalar(0.62 + lump * 0.62 + (chip - 0.5) * 0.16);
    v.set(v.x * shape[0], v.y * shape[1], v.z * shape[2]);
    const floor = -0.28 * shape[1];
    if (v.y < floor) v.y = floor + (v.y - floor) * 0.2;   // a flat underside that sits into the ground
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  const top = shape[1];
  return setColour(g, (c, x, y, z, ny) => {
    const n = fbm(x * 2.3, y * 2.3, z * 2.3 + seed, 3);
    const grey = 0.52 + n * 0.22;
    c.setRGB(grey, grey * 0.97, grey * 0.93);
    // moss and lichen on the up-facing surfaces, damp and dark at the base
    const moss = smoothstep(0.55, 0.92, ny) * smoothstep(0.35, 0.7, n);
    c.lerp(new THREE.Color(0.30, 0.36, 0.20), moss * 0.75);
    c.multiplyScalar(0.55 + 0.45 * smoothstep(-0.3 * top, 0.5 * top, y));
  });
}

function stoneTone(geo, base) {
  return setColour(geo, (c, x, y) => {
    const ao = 0.62 + 0.38 * smoothstep(0, 2.1, y);
    const n = 0.9 + hash3(Math.round(x * 40), Math.round(y * 40), Math.round(z0(x, y) * 40)) * 0.1;
    c.setRGB(base * ao * n, base * ao * n * 0.98, base * ao * n * 0.94);
  });
}
const z0 = (x, y) => x * 0.7 + y * 1.3;

function part(geo, x, y, z, ry = 0) {
  const g = geo.index ? geo : mergeVertices(geo);
  g.deleteAttribute('uv');
  g.rotateY(ry);
  g.translate(x, y, z);
  return g;
}

/**
 * A tōrō: hexagonal stone lantern, 2.2 m. Level 0 is round-shouldered with a
 * framed light box and a finial; level 1 is six-sided and plainer; level 2 is
 * a stack of boxes that only has to hold its silhouette.
 */
function lantern(level) {
  const s = [16, 6, 4][level];
  const parts = [
    part(new THREE.CylinderGeometry(0.44, 0.54, 0.24, s), 0, 0.12, 0),
    part(new THREE.CylinderGeometry(0.16, 0.21, 0.82, s), 0, 0.65, 0),
    part(new THREE.CylinderGeometry(0.50, 0.30, 0.20, s), 0, 1.15, 0),
    part(new THREE.CylinderGeometry(0.70, 0.62, 0.07, s), 0, 1.66, 0),
    part(new THREE.ConeGeometry(0.64, 0.40, s), 0, 1.89, 0),
  ];
  if (level < 2) {
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      parts.push(part(new THREE.BoxGeometry(0.08, 0.40, 0.08), Math.cos(a) * 0.27, 1.45, Math.sin(a) * 0.27, -a));
    }
  }
  if (level === 0) {
    parts.push(part(new THREE.CylinderGeometry(0.36, 0.36, 0.05, s), 0, 1.27, 0));
    parts.push(part(new THREE.SphereGeometry(0.10, 10, 8), 0, 2.16, 0));
    parts.push(part(new THREE.CylinderGeometry(0.035, 0.07, 0.14, 8), 0, 2.04, 0));
  }
  const body = stoneTone(mergeGeometries(parts.map((g) => { g.computeVertexNormals(); return g; })), 0.78);
  body.computeVertexNormals();
  const glow = part(new THREE.BoxGeometry(0.40, 0.34, 0.40, 1, 1, 1), 0, 1.45, 0);
  glow.computeVertexNormals();
  setColour(glow, (c) => c.setRGB(1, 1, 1));
  return { body, glow };
}

/** A grass tuft: curved tapering blades, uv.y running root → tip for the wind shader. */
function grass(level, seed) {
  const rand = mulberry(seed);
  const blades = level === 0 ? 14 : 6;
  const segs = level === 0 ? 4 : 1;
  const pos = [], nor = [], uv = [], col = [], idx = [];
  const root = new THREE.Color(0.16, 0.20, 0.09);
  const tipA = new THREE.Color(0.58, 0.66, 0.32);
  const tipB = new THREE.Color(0.70, 0.66, 0.36);
  for (let b = 0; b < blades; b++) {
    const a = rand() * Math.PI * 2;
    const off = rand() * 0.22;
    const ox = Math.cos(a) * off, oz = Math.sin(a) * off;
    const h = 0.38 + rand() * 0.34;
    const w = 0.035 + rand() * 0.025;
    const lean = 0.18 + rand() * 0.35;
    const face = rand() * Math.PI * 2;
    const dx = Math.cos(a), dz = Math.sin(a);
    const sx = Math.cos(face), sz = Math.sin(face);
    const tip = tipA.clone().lerp(tipB, rand());
    const base = pos.length / 3;
    for (let r = 0; r <= segs; r++) {
      const t = r / segs;
      const bend = lean * t * t;
      const y = h * t * (1 - bend * 0.25);
      const cx = ox + dx * bend * h, cz = oz + dz * bend * h;
      const half = w * (1 - t * 0.92);
      pos.push(cx - sx * half, y, cz - sz * half, cx + sx * half, y, cz + sz * half);
      // bias the normal upward so a tuft lights like a soft mass rather than flat cards
      const n = new THREE.Vector3(-sz, 1.6, sx).normalize();
      nor.push(n.x, n.y, n.z, n.x, n.y, n.z);
      uv.push(0, t, 1, t);
      const c = root.clone().lerp(tip, Math.pow(t, 0.8));
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    for (let r = 0; r < segs; r++) {
      const i = base + r * 2;
      idx.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function addGeometry(doc, scene, buffer, name, geo, material) {
  const acc = (attr, type, ArrayType = Float32Array) => doc.createAccessor().setType(type).setArray(new ArrayType(attr.array)).setBuffer(buffer);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc(geo.attributes.position, 'VEC3'))
    .setAttribute('NORMAL', acc(geo.attributes.normal, 'VEC3'))
    .setMaterial(material);
  if (geo.attributes.color) prim.setAttribute('COLOR_0', acc(geo.attributes.color, 'VEC3'));
  if (geo.attributes.uv) prim.setAttribute('TEXCOORD_0', acc(geo.attributes.uv, 'VEC2'));
  const count = geo.attributes.position.count;
  prim.setIndices(acc(geo.index, 'SCALAR', count < 65536 ? Uint16Array : Uint32Array));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  scene.addChild(doc.createNode(name).setMesh(mesh));
  return geo.index.count / 3;
}

async function buildProps(manifest) {
  console.log('\nprops');
  await MeshoptSimplifier.ready;
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('props');
  doc.getRoot().setDefaultScene(scene);
  const stone = doc.createMaterial('stone').setRoughnessFactor(0.9).setMetallicFactor(0);
  const glow = doc.createMaterial('lantern_glow').setEmissiveFactor([1, 0.62, 0.3]).setBaseColorFactor([1, 0.8, 0.55, 1]);
  const blades = doc.createMaterial('grass').setDoubleSided(true).setRoughnessFactor(0.85).setMetallicFactor(0);

  const report = [];
  const add = (name, geo, mat) => report.push(`${name} ${addGeometry(doc, scene, buffer, name, geo, mat)}`);

  // rocks: a rounded boulder and a flat slab; lower levels are simplifications of level 0
  for (const [name, seed, shape] of [['rock_a', 3.7, [1.0, 0.78, 0.9]], ['rock_b', 11.2, [1.35, 0.42, 1.05]]]) {
    const lod0 = rock(seed, shape);
    add(`${name}_lod0`, lod0, stone);
    add(`${name}_lod1`, simplifyTo(lod0, 0.22, 0.02), stone);
    add(`${name}_lod2`, simplifyTo(lod0, 0.05, 0.08), stone);
  }
  for (let l = 0; l < 3; l++) {
    const { body, glow: light } = lantern(l);
    add(`lantern_lod${l}`, body, stone);
    add(`lantern_glow_lod${l}`, light, glow);
  }
  add('grass_lod0', grass(0, 7), blades);
  add('grass_lod1', grass(1, 7), blades);

  await doc.transform(draco(DRACO));
  const bytes = await io.writeBinary(doc);
  const outRel = path.join('opt', PROPS_FILE);
  await writeFile(path.join(ASSETS, outRel), bytes);
  manifest.props[rel(PROPS_FILE)] = { url: rel(outRel), bytes: bytes.byteLength, meshes: report.length };
  console.log(`  ${PROPS_FILE.padEnd(36)} ${kb(bytes.byteLength)}  triangles: ${report.join(' · ')}`);
}

/* ── main ───────────────────────────────────────────────────────────── */

const manifestPath = path.join(OUT, 'manifest.json');
const previous = JSON.parse(await fs.readFile(manifestPath, 'utf8').catch(() => 'null'));
const manifest = {
  version: 1,
  generator: 'web/scripts/build-assets.mjs',
  models: only === 'all' || only === 'models' ? {} : previous?.models ?? {},
  textures: only === 'all' || only === 'textures' ? {} : previous?.textures ?? {},
  props: only === 'all' || only === 'props' ? {} : previous?.props ?? {},
};

const t0 = Date.now();
if (only === 'all' || only === 'textures') await buildTextures(manifest);
if (only === 'all' || only === 'props') await buildProps(manifest);
if (only === 'all' || only === 'models') await buildModels(manifest);

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const sum = (table, key) => Object.values(table).reduce((n, e) => n + (e[key] ?? 0), 0);
const src = sum(manifest.models, 'sourceBytes') + sum(manifest.textures, 'sourceBytes');
const opt = sum(manifest.models, 'bytes') + sum(manifest.textures, 'bytes');
console.log(`\nmanifest → ${path.relative(process.cwd(), manifestPath)}`);
console.log(`models + textures: ${kb(src)} → ${kb(opt)}  (${((1 - opt / Math.max(1, src)) * 100).toFixed(0)}% smaller) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
