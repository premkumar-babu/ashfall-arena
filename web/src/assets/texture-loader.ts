import * as THREE from 'three/webgpu';
import { ASSET_ROOT, Assets, type LoadGroup } from './pipeline';

/*
  Every downloaded texture is optional by construction. It is fetched after the
  scene is already running and only swapped in when it arrives, so a missing
  file, a blocked request or an offline first run costs the improvement and
  nothing else — the procedural stand-in it would have replaced stays put.

  Fetching goes through the asset pipeline: a surface with a KTX2 copy in the
  manifest arrives Basis-compressed and stays compressed on the GPU (BC7, ASTC
  or ETC2, whichever the device samples), anything else loads as the image it
  always was. The pipeline's LoadingManager is the one every loader shares.
*/

export const TEXROOT = ASSET_ROOT;

export const LOAD_MGR = Assets.manager;

export interface ArtStats {
  want: number;
  got: number;
  failed: number;
}

export const TEXSTAT: ArtStats = { want: 0, got: 0, failed: 0 };

type ArtListener = (stats: Readonly<ArtStats>) => void;
const listeners = new Set<ArtListener>();

/** Subscribe to texture progress (the dev panel's ART row). Returns an unsubscribe. */
export function onArtProgress(fn: ArtListener): () => void {
  listeners.add(fn);
  fn(TEXSTAT);
  return () => {
    listeners.delete(fn);
  };
}

function report(): void {
  for (const fn of listeners) fn(TEXSTAT);
}

export interface TexOptions {
  repeat?: readonly [number, number];
  aniso?: number;
  /**
   * Normal and roughness maps are DATA, not colour, and must not be
   * sRGB-decoded. Gamma-decoding a normal map bends every vector toward the
   * surface, so the lighting goes soft in a way that is easy to misread as a
   * bad normal scale.
   */
  linear?: boolean;
  /** Which loading-screen stage this counts toward. Defaults by folder. */
  group?: LoadGroup;
}

export function loadTex(path: string, apply: (texture: THREE.Texture) => void, o: TexOptions = {}): void {
  TEXSTAT.want++;
  const job = Assets.job(`assets/${path}`, o.group ?? (path.startsWith('vfx/') ? 'effects' : 'surfaces'));
  Assets.loadTexture(path, job.progress).then(
    (t) => {
      job.done();
      t.colorSpace = o.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      if (o.repeat) {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(o.repeat[0], o.repeat[1]);
      }
      t.anisotropy = o.aniso ?? 4;
      t.needsUpdate = true;
      TEXSTAT.got++;
      try {
        apply(t);
      } catch (err) {
        // one sprite is never worth a crash — but it is worth knowing about
        if (import.meta.env.DEV) console.warn(`[art] applying ${path} failed`, err);
      }
      report();
    },
    () => {
      job.fail();
      TEXSTAT.failed++;
      report();
    },
  );
}

export function resetArtStats(): void {
  TEXSTAT.want = TEXSTAT.got = TEXSTAT.failed = 0;
  listeners.clear();
}
