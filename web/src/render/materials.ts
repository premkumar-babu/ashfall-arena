import * as THREE from 'three/webgpu';
import { ENV_MATS, MODEL_ENV } from './stage';
import { toonRamp } from './textures';

export interface ToonOptions {
  map?: THREE.Texture | null;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  side?: THREE.Side;
  transparent?: boolean;
  opacity?: number;
}

/* One ramp and one outline material, shared by everything that asks. Both are
   created on first use and released by disposeSharedMaterials(). */
let ramp: THREE.CanvasTexture | null = null;
let ink: THREE.MeshBasicMaterial | null = null;

/** Cel-shaded material on the shared four-band ramp. Kept for the primitive fighter rigs and foliage. */
export function toonMat(color: THREE.ColorRepresentation, o: ToonOptions = {}): THREE.MeshToonMaterial {
  ramp ??= toonRamp(4);
  return new THREE.MeshToonMaterial({
    color,
    gradientMap: ramp,
    map: o.map ?? null,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.emissiveIntensity ?? 1,
    side: o.side ?? THREE.FrontSide,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
  });
}

/*
  Physically based surfaces for the stage and props.

  Each preset is a roughness / metalness pair plus how much of the sky
  environment the surface reflects. Environment lighting is applied per
  material rather than through scene.environment: a global environment
  washed the courtyard floor milky, whereas per-material scales let wet stone
  catch a little sky, gilded trim catch a lot, and cloth almost none.
*/
export type PbrPreset = 'stone' | 'timber' | 'tile' | 'metal' | 'cloth' | 'clay' | 'rough';

const PBR_PRESETS: Readonly<Record<PbrPreset, { roughness: number; metalness: number; env: number }>> = {
  stone: { roughness: 0.82, metalness: 0.0, env: 0.35 },
  timber: { roughness: 0.72, metalness: 0.0, env: 0.25 },
  tile: { roughness: 0.46, metalness: 0.05, env: 0.6 },
  metal: { roughness: 0.32, metalness: 0.85, env: 1.1 },
  cloth: { roughness: 0.94, metalness: 0.0, env: 0.18 },
  clay: { roughness: 0.76, metalness: 0.0, env: 0.3 },
  rough: { roughness: 1.0, metalness: 0.0, env: 0.15 },
};

/** Give a standard material the stage's sky reflection at `scale`, and keep it updated on theme changes. */
export function useEnv(m: THREE.MeshStandardMaterial, scale: number): THREE.MeshStandardMaterial {
  m.envMap = MODEL_ENV;
  m.envMapIntensity = scale;
  m.userData.envScale = scale;
  ENV_MATS.push(m);
  return m;
}

/** Stop a disposed material from being re-probed on the next theme change. */
export function releaseEnv(m: THREE.Material): void {
  const i = ENV_MATS.indexOf(m as THREE.MeshStandardMaterial);
  if (i >= 0) ENV_MATS.splice(i, 1);
}

export function pbrMat(color: THREE.ColorRepresentation, preset: PbrPreset, o: ToonOptions = {}): THREE.MeshStandardMaterial {
  const p = PBR_PRESETS[preset];
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: p.roughness,
    metalness: p.metalness,
    map: o.map ?? null,
    emissive: o.emissive ?? 0x000000,
    emissiveIntensity: o.emissiveIntensity ?? 1,
    side: o.side ?? THREE.FrontSide,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
  });
  return useEnv(m, p.env);
}

/**
 * Inverted-hull outline: a slightly fattened back-facing copy of the mesh
 * drawn in near-black reads as an ink line at fighting-game distance.
 * Shares the parent's geometry, so it costs a draw call and no memory.
 */
export function inkOutline(mesh: THREE.Mesh, k = 0.10): THREE.Mesh {
  ink ??= new THREE.MeshBasicMaterial({ color: 0x120A14, side: THREE.BackSide, fog: false });
  const outline = new THREE.Mesh(mesh.geometry, ink);
  outline.scale.setScalar(1 + k);
  outline.castShadow = false;
  outline.receiveShadow = false;
  mesh.add(outline);
  return outline;
}

/** Unlit additive material for glows, rings and light columns. */
export function addMat(color: THREE.ColorRepresentation, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function disposeSharedMaterials(): void {
  ramp?.dispose();
  ink?.dispose();
  ramp = null;
  ink = null;
}
