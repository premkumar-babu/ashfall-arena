import type * as THREE from 'three/webgpu';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { FighterState } from '../config/constants';
import { LOAD_MGR } from './texture-loader';

/*
  Model fetching, normalised to one shape — { object, animations } — whichever
  format arrived. FBXLoader hands back the Object3D directly; GLTFLoader wraps
  it in `.scene`.

  Promise-based. The monolith threaded success and failure callbacks through
  four levels of fallback, and a callback that fired twice (a late load after
  its timeout) was only prevented by a hand-rolled `settled` flag in each one.
*/

export interface ModelAsset {
  readonly object: THREE.Object3D;
  readonly animations: THREE.AnimationClip[];
}

export const MODEL_TIMEOUT_MS = 12_000;

/** Resolve a project-relative asset path against the Vite base, leaving absolute URLs alone. */
export function assetUrl(path: string): string {
  if (/^(https?:|data:|blob:)/i.test(path)) return path;
  return import.meta.env.BASE_URL + path.replace(/^\.?\//, '');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => { window.clearTimeout(id); resolve(v); },
      (e: unknown) => { window.clearTimeout(id); reject(e); },
    );
  });
}

function fromGltf(gltf: GLTF): ModelAsset {
  const object = gltf.scene ?? gltf.scenes?.[0];
  if (!object) throw new Error('empty glTF');
  return { object, animations: gltf.animations ?? [] };
}

/* A glTF binary smuggled through as JSON. Some hosts serve application/json
   and nothing else — the published Artifact refuses model/gltf-binary — so a
   sibling `<name>.glb.json` holding {"b64": "..."} carries the same bytes.
   Tried only after the direct fetch fails. */
async function tryWrapped(url: string): Promise<ModelAsset> {
  const res = await fetch(`${assetUrl(url)}.json`);
  if (!res.ok) throw new Error(`wrapped ${res.status}`);
  const body = (await res.json()) as { b64?: string } | null;
  if (!body?.b64) throw new Error('wrapped: no payload');
  const bin = window.atob(body.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return fromGltf(await new GLTFLoader().parseAsync(bytes.buffer, ''));
}

export function loadModel(url: string): Promise<ModelAsset> {
  const run = async (): Promise<ModelAsset> => {
    if (/\.fbx$/i.test(url)) {
      const group = await new FBXLoader(LOAD_MGR).loadAsync(assetUrl(url));
      return { object: group, animations: group.animations ?? [] };
    }
    try {
      return fromGltf(await new GLTFLoader(LOAD_MGR).loadAsync(assetUrl(url)));
    } catch {
      return tryWrapped(url);
    }
  };
  return withTimeout(run(), MODEL_TIMEOUT_MS);
}

/* ── clips.json: one clip per file ──────────────────────────────────────
   A rigging service returns one animation baked into one GLB, so a move set
   arrives as eight files. `assets/models/clips.json` maps them onto states:

     { "p1": { "model": "p1_rigged.glb",
               "clips": { "IDLE": "p1_idle.glb", "PUNCH": "p1_punch.glb" } } }

   Every key is optional and so is the file; with no manifest nothing changes. */

export interface ClipManifestEntry {
  readonly model?: string;
  readonly clips?: Partial<Record<FighterState, string>>;
}

export const CLIPS = {
  manifest: null as Record<string, ClipManifestEntry> | null,
  added: 0,
  rejected: 0,
  missing: 0,
};

function manifestKey(path: string): string | null {
  const m = String(path).match(/([^/\\]+?)\.(fbx|glb|gltf)$/i);
  return m ? m[1]!.toLowerCase() : null;
}

export function manifestEntry(path: string): ClipManifestEntry | null {
  const k = manifestKey(path);
  return (k && CLIPS.manifest?.[k]) || null;
}

export function clipUrl(name: string): string {
  return /^https?:\/\//i.test(name) || name.includes('/') ? name : `assets/models/${name}`;
}

/** No manifest is the normal case, not an error: every failure resolves. */
export async function loadClipManifest(): Promise<void> {
  try {
    const res = await withTimeout(fetch(assetUrl('assets/models/clips.json')), 4000);
    if (res.ok) CLIPS.manifest = (await res.json()) as Record<string, ClipManifestEntry>;
  } catch {
    CLIPS.manifest = null;
  }
}

export function resetClipManifest(): void {
  CLIPS.manifest = null;
  CLIPS.added = CLIPS.rejected = CLIPS.missing = 0;
}

/* ── fallback spellings ─────────────────────────────────────────────────
   Mixamo exports land as "P2.fbx" as often as "p2.fbx"; Windows hides the
   difference and a Linux host does not. The CLASSIC cast's upstream copies are
   the last resort so a fresh clone without assets/ still fills its roster —
   the local copy always wins, so a release never depends on GitHub. */
const CDN_ROOT = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf/';
const CDN_MODELS: Readonly<Record<string, string>> = {
  'assets/models/x1.glb': 'Xbot.glb',
  'assets/models/x2.glb': 'Michelle.glb',
  'assets/models/x3.glb': 'RobotExpressive/RobotExpressive.glb',
  'assets/models/x4.glb': 'Soldier.glb',
};

export function candidates(path: string): string[] {
  const list: string[] = [];
  const add = (p: string): void => {
    if (!list.includes(p)) list.push(p);
  };
  // a rigged replacement named in clips.json wins over the authored file
  const entry = manifestEntry(path);
  if (entry?.model) add(clipUrl(entry.model));
  add(path);
  for (const p of [...list]) add(p.replace(/\.glb$/i, '.fbx'));
  for (const p of [...list]) {
    add(p.replace(/\/([a-z])(\d+\.(?:fbx|glb))$/i, (_m, letter: string, rest: string) => `/${letter.toUpperCase()}${rest}`));
  }
  const cdn = CDN_MODELS[path];
  if (cdn) add(CDN_ROOT + cdn);
  return list;
}

/** Walk the candidate spellings until one loads. */
export async function loadWithFallback(path: string): Promise<ModelAsset> {
  let last: unknown = new Error('missing');
  for (const url of candidates(path)) {
    try {
      return await loadModel(url);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
