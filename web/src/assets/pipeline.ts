import * as THREE from 'three/webgpu';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { disposeObject } from '../core/disposal';

/*
  The asset pipeline, run-time half.

  `npm run assets` (scripts/build-assets.mjs) writes optimised copies of the
  source art under assets/opt/ — Draco-compressed meshes, KTX2/Basis textures
  that stay compressed on the GPU, the generated scenery props with their LOD
  levels — and a manifest mapping every source path to its optimised file.

  This module is the only thing that reads that manifest. Game code keeps
  asking for the source path ('assets/models/x1.glb', 'textures/slate_nor.jpg');
  the pipeline serves the optimised file when there is one and the device can
  decode it, and falls back to the source file when there is not. A checkout
  that never ran the build, or a browser without a transcoder, loads exactly
  what it loaded before.

  One LoadingManager sits behind every loader, including the decoders' own
  fetches. Loads are cached per path with a reference count, so a texture two
  materials ask for is fetched once and freed when the last user releases it;
  dispose() frees everything still cached along with the decoder workers.

  Progress is tracked per JOB — one logical asset, however many URLs it took —
  in bytes where the server reports them, grouped by what they are for, so a
  loading screen can say something truer than "item 14 of 23".
*/

export const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/`;
const MANIFEST_PATH = 'assets/opt/manifest.json';
const MANIFEST_TIMEOUT_MS = 3000;
/** Weight given to a job whose size nobody knows yet, so it still moves the bar. */
const UNKNOWN_BYTES = 256_000;

/** Resolve a project-relative asset path against the Vite base, leaving absolute URLs alone. */
export function assetUrl(path: string): string {
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return import.meta.env.BASE_URL + path.replace(/^\.?\//, '');
}

export type LoadGroup = 'arena' | 'surfaces' | 'fighters' | 'motion' | 'effects';
export const LOAD_GROUPS: readonly LoadGroup[] = ['arena', 'surfaces', 'fighters', 'motion', 'effects'];

interface OptEntry {
  readonly url: string;
  readonly bytes: number;
  readonly sourceBytes?: number;
  /** Textures inside a glTF that need the KTX2 transcoder. */
  readonly ktx2?: number;
}

export interface AssetManifest {
  readonly version: number;
  readonly models: Readonly<Record<string, OptEntry>>;
  readonly textures: Readonly<Record<string, OptEntry>>;
  readonly props: Readonly<Record<string, OptEntry>>;
}

export interface GroupProgress {
  count: number;
  settled: number;
  failed: number;
  loaded: number;
  total: number;
}

export interface LoadSnapshot {
  readonly groups: Readonly<Record<LoadGroup, Readonly<GroupProgress>>>;
  readonly loaded: number;
  readonly total: number;
  readonly pending: number;
  /** Byte-weighted, 0..1. */
  readonly ratio: number;
  /** The job that most recently reported progress. */
  readonly current: { readonly key: string; readonly group: LoadGroup } | null;
}

export interface JobHandle {
  progress(loaded: number, total: number): void;
  done(): void;
  fail(): void;
}

type JobState = 'queued' | 'loading' | 'done' | 'failed';

interface Job {
  readonly key: string;
  readonly group: LoadGroup;
  loaded: number;
  total: number;
  estimate: number;
  state: JobState;
  touched: number;
}

interface Cached<T> {
  promise: Promise<T>;
  value: T | null;
  refs: number;
}

export type ProgressFn = (loaded: number, total: number) => void;

async function fetchJson<T>(url: string, ms: number): Promise<T | null> {
  const ctl = new AbortController();
  const id = window.setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(id);
  }
}

function toProgress(fn?: ProgressFn): ((e: ProgressEvent) => void) | undefined {
  return fn ? (e) => fn(e.loaded, e.lengthComputable ? e.total : 0) : undefined;
}

/** Bytes a texture occupies on the GPU, mip chain included. */
export function textureBytes(t: THREE.Texture): number {
  const c = t as THREE.CompressedTexture;
  if (c.isCompressedTexture) {
    let n = 0;
    for (const m of c.mipmaps ?? []) n += (m as { data?: ArrayBufferView }).data?.byteLength ?? 0;
    return n;
  }
  const img = t.image as { width?: number; height?: number } | null;
  return img?.width && img.height ? Math.round(img.width * img.height * 4 * (t.generateMipmaps ? 4 / 3 : 1)) : 0;
}

class AssetPipeline {
  readonly manager = new THREE.LoadingManager();
  readonly counters = { draco: 0, ktx2: 0, fallbacks: 0, released: 0 };

  private draco: DRACOLoader | null = null;
  private ktx2: KTX2Loader | null = null;
  private gltf: GLTFLoader | null = null;
  private readonly images = new THREE.TextureLoader(this.manager);
  private ktx2Ok = false;
  private manifest: AssetManifest | null = null;
  private readonly jobs = new Map<string, Job>();
  private readonly models = new Map<string, Cached<GLTF>>();
  private readonly textures = new Map<string, Cached<THREE.Texture>>();
  private clock = 0;

  get hasManifest(): boolean {
    return this.manifest !== null;
  }

  get compressedTexturesSupported(): boolean {
    return this.ktx2Ok;
  }

  /**
   * After the renderer has initialised: the KTX2 loader has to ask the device
   * which compressed formats it can sample before it can transcode anything.
   */
  async init(renderer: THREE.WebGPURenderer): Promise<void> {
    /* No decoder paths: both loaders resolve their WebAssembly relative to
       their own module (new URL(…, import.meta.url)), which the bundler
       rewrites to the emitted, version-matched files. */
    this.draco = new DRACOLoader(this.manager);
    this.ktx2 = new KTX2Loader(this.manager);
    try {
      this.ktx2.detectSupport(renderer);
      this.ktx2Ok = true;
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[assets] no KTX2 support; source textures will be used', err);
    }
    this.gltf = new GLTFLoader(this.manager)
      .setDRACOLoader(this.draco)
      .setKTX2Loader(this.ktx2)
      .setMeshoptDecoder(MeshoptDecoder);

    this.manifest = await fetchJson<AssetManifest>(assetUrl(MANIFEST_PATH), MANIFEST_TIMEOUT_MS);
    // with optimised meshes on the way, start the decoder download now rather than on the first model
    if (this.manifest) this.draco.preload();
  }

  /* ── progress ────────────────────────────────────────────────────── */

  /** Register a load before it starts, so the bar knows the whole job list up front. */
  expect(key: string, group: LoadGroup, estimate?: number): void {
    if (this.jobs.has(key)) return;
    this.jobs.set(key, {
      key, group, loaded: 0, total: 0,
      estimate: estimate ?? this.sizeOf(key), state: 'queued', touched: 0,
    });
  }

  job(key: string, group: LoadGroup): JobHandle {
    this.expect(key, group);
    const j = this.jobs.get(key)!;
    if (j.state !== 'done') j.state = 'loading';
    j.touched = ++this.clock;
    return {
      progress: (loaded, total) => {
        j.loaded = loaded;
        if (total > 0) j.total = total;
        j.touched = ++this.clock;
      },
      done: () => {
        j.state = 'done';
        j.total ||= j.estimate;
        j.loaded = j.total;
      },
      fail: () => {
        if (j.state === 'done') return;
        j.state = 'failed';
        j.total ||= j.estimate;
        j.loaded = j.total;
      },
    };
  }

  snapshot(): LoadSnapshot {
    const groups = {} as Record<LoadGroup, GroupProgress>;
    for (const g of LOAD_GROUPS) groups[g] = { count: 0, settled: 0, failed: 0, loaded: 0, total: 0 };
    let loaded = 0;
    let total = 0;
    let pending = 0;
    let current: Job | null = null;
    for (const j of this.jobs.values()) {
      const g = groups[j.group];
      const size = Math.max(j.total || j.estimate, 1);
      const settled = j.state === 'done' || j.state === 'failed';
      // never report a running job as finished: the last bytes are the parse
      const got = settled ? size : Math.min(j.loaded, size * 0.96);
      g.count++;
      g.total += size;
      g.loaded += got;
      loaded += got;
      total += size;
      if (settled) {
        g.settled++;
        if (j.state === 'failed') g.failed++;
      } else {
        pending++;
        if (j.state === 'loading' && (!current || j.touched > current.touched)) current = j;
      }
    }
    return {
      groups, loaded, total, pending,
      ratio: total > 0 ? loaded / total : 1,
      current: current ? { key: current.key, group: current.group } : null,
    };
  }

  private sizeOf(key: string): number {
    const m = this.manifest;
    const e = m?.models[key] ?? m?.textures[key] ?? m?.props[key];
    return e?.bytes ?? UNKNOWN_BYTES;
  }

  /* ── glTF ────────────────────────────────────────────────────────── */

  /** Load (or share) a glTF by project path. Pair every call with release() when the caller is done with it. */
  loadGLTF(path: string, onProgress?: ProgressFn): Promise<GLTF> {
    const hit = this.models.get(path);
    if (hit) {
      hit.refs++;
      return hit.promise;
    }
    const entry: Cached<GLTF> = { promise: Promise.resolve(null as unknown as GLTF), value: null, refs: 1 };
    entry.promise = this.fetchGltf(path, onProgress).then((g) => {
      entry.value = g;
      return g;
    });
    // a failure is not cached: the next request is allowed to try again
    entry.promise.catch(() => {
      if (this.models.get(path) === entry) this.models.delete(path);
    });
    this.models.set(path, entry);
    return entry.promise;
  }

  /** Parse an in-memory GLB with the same decoders a fetched one gets. */
  parseGLTF(buffer: ArrayBuffer): Promise<GLTF> {
    return (this.gltf ?? new GLTFLoader(this.manager)).parseAsync(buffer, '');
  }

  private async fetchGltf(path: string, onProgress?: ProgressFn): Promise<GLTF> {
    const loader = this.gltf ?? new GLTFLoader(this.manager);
    const opt = this.manifest?.models[path] ?? this.manifest?.props[path];
    // an optimised file whose textures this device cannot transcode would arrive untextured
    if (opt && (this.ktx2Ok || !opt.ktx2)) {
      try {
        return this.count(await loader.loadAsync(assetUrl(opt.url), toProgress(onProgress)));
      } catch (err) {
        this.counters.fallbacks++;
        if (import.meta.env.DEV) console.warn(`[assets] ${opt.url} failed; loading the source file`, err);
      }
    }
    return this.count(await loader.loadAsync(assetUrl(path), toProgress(onProgress)));
  }

  private count(g: GLTF): GLTF {
    const used = (g.parser.json as { extensionsUsed?: string[] }).extensionsUsed ?? [];
    if (used.includes('KHR_draco_mesh_compression')) this.counters.draco++;
    if (used.includes('KHR_texture_basisu')) this.counters.ktx2++;
    return g;
  }

  /* ── textures ────────────────────────────────────────────────────── */

  /**
   * Load (or share) a texture by path relative to assets/. One path is one
   * texture object: callers asking for different sampling should clone.
   */
  loadTexture(path: string, onProgress?: ProgressFn): Promise<THREE.Texture> {
    const hit = this.textures.get(path);
    if (hit) {
      hit.refs++;
      return hit.promise;
    }
    const entry: Cached<THREE.Texture> = { promise: Promise.resolve(null as unknown as THREE.Texture), value: null, refs: 1 };
    entry.promise = this.fetchTexture(path, onProgress).then((t) => {
      entry.value = t;
      return t;
    });
    entry.promise.catch(() => {
      if (this.textures.get(path) === entry) this.textures.delete(path);
    });
    this.textures.set(path, entry);
    return entry.promise;
  }

  private async fetchTexture(path: string, onProgress?: ProgressFn): Promise<THREE.Texture> {
    const opt = this.manifest?.textures[`assets/${path}`];
    if (opt && this.ktx2Ok && this.ktx2) {
      try {
        const t = await this.ktx2.loadAsync(assetUrl(opt.url), toProgress(onProgress));
        this.counters.ktx2++;
        return t;
      } catch (err) {
        this.counters.fallbacks++;
        if (import.meta.env.DEV) console.warn(`[assets] ${opt.url} failed; loading the source image`, err);
      }
    }
    return this.images.loadAsync(`${ASSET_ROOT}${path}`);
  }

  /* ── lifetime ────────────────────────────────────────────────────── */

  /** Drop one reference. The last one frees the GPU resources behind it. */
  release(path: string): void {
    const model = this.models.get(path);
    if (model && --model.refs <= 0) {
      this.models.delete(path);
      if (model.value) disposeGltf(model.value);
      this.counters.released++;
    }
    const tex = this.textures.get(path);
    if (tex && --tex.refs <= 0) {
      this.textures.delete(path);
      tex.value?.dispose();
      this.counters.released++;
    }
  }

  stats(): Record<string, number | boolean> {
    let texBytes = 0;
    for (const c of this.textures.values()) if (c.value) texBytes += textureBytes(c.value);
    return {
      manifest: this.hasManifest,
      ktx2Supported: this.ktx2Ok,
      models: this.models.size,
      textures: this.textures.size,
      textureMB: +(texBytes / 1048576).toFixed(1),
      ...this.counters,
    };
  }

  dispose(): void {
    for (const c of this.models.values()) if (c.value) disposeGltf(c.value);
    for (const c of this.textures.values()) c.value?.dispose();
    this.models.clear();
    this.textures.clear();
    this.jobs.clear();
    this.draco?.dispose();
    this.ktx2?.dispose();
    this.draco = this.ktx2 = this.gltf = null;
    this.manifest = null;
    this.ktx2Ok = false;
    this.counters.draco = this.counters.ktx2 = this.counters.fallbacks = this.counters.released = 0;
    this.manager.onStart = this.manager.onProgress = this.manager.onError = () => {};
    this.manager.onLoad = () => {};
  }
}

function disposeGltf(g: GLTF): void {
  for (const s of g.scenes.length ? g.scenes : [g.scene]) disposeObject(s);
}

export const Assets = new AssetPipeline();
