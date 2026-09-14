import * as THREE from 'three/webgpu';

/*
  Every downloaded texture is optional by construction. It is fetched after the
  scene is already running and only swapped in when it arrives, so a missing
  file, a blocked request or an offline first run costs the improvement and
  nothing else — the procedural stand-in it would have replaced stays put.

  One LoadingManager sits behind every loader in the game, so the boot
  curtain measures real requests rather than a count maintained by hand.
*/

export const TEXROOT = `${import.meta.env.BASE_URL}assets/`;

export const LOAD_MGR = new THREE.LoadingManager();
const texLoader = new THREE.TextureLoader(LOAD_MGR);

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
}

export function loadTex(path: string, apply: (texture: THREE.Texture) => void, o: TexOptions = {}): void {
  TEXSTAT.want++;
  texLoader.load(
    TEXROOT + path,
    (t) => {
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
    undefined,
    () => {
      TEXSTAT.failed++;
      report();
    },
  );
}

export function resetArtStats(): void {
  TEXSTAT.want = TEXSTAT.got = TEXSTAT.failed = 0;
  listeners.clear();
}
