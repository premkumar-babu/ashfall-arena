import * as THREE from 'three/webgpu';
import type { Theme } from '../config/themes';
import { legacyIntensity } from './lights';
import { skyTexture } from './textures';
import { QUALITY_PRESETS, type Quality } from '../config/quality';

/*
  The scene, the camera, the sky and the light rig.

  These are exported as live bindings: they are assigned once by createStage()
  and every module that imports them sees the assigned value. That keeps the
  hundreds of `scene.add(...)` call sites the port inherited exactly as they
  were, while still making construction an explicit, ordered step instead of
  a side effect of importing a file.
*/
export let scene: THREE.Scene;
export let background: THREE.Color;
export let fog: THREE.FogExp2;
export let camera: THREE.PerspectiveCamera;
export let sky: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
export let ambLight: THREE.AmbientLight;
export let hemiLight: THREE.HemisphereLight;
export let key: THREE.DirectionalLight;
export let rim: THREE.DirectionalLight;

/**
 * Per-phase light targets the camera rig damps toward. The select screen sits
 * a little brighter than the fight so courtyard detail reads. Stored already
 * converted out of legacy units, because the rig damps the live intensity
 * toward these directly.
 */
export const LIGHTS = { ambFight: 0, ambSelect: 0, hemiFight: 0, hemiSelect: 0, keyFight: 0, keySelect: 0 };

export function setLightTargets(theme: Theme): void {
  LIGHTS.ambFight = legacyIntensity(theme.amb.f);
  LIGHTS.ambSelect = legacyIntensity(theme.amb.s);
  LIGHTS.hemiFight = legacyIntensity(theme.hemi.f);
  LIGHTS.hemiSelect = legacyIntensity(theme.hemi.s);
  LIGHTS.keyFight = legacyIntensity(theme.key.f);
  LIGHTS.keySelect = legacyIntensity(theme.key.s);
}

let rendererRef: THREE.WebGPURenderer | null = null;

export function createStage(renderer: THREE.WebGPURenderer, theme: Theme, aspect: number): void {
  rendererRef = renderer;
  renderer.toneMappingExposure = theme.exposure;

  scene = new THREE.Scene();
  background = new THREE.Color(theme.bg);
  scene.background = background;
  fog = new THREE.FogExp2(theme.fog, theme.fogD);
  scene.fog = fog;

  sky = new THREE.Mesh(
    new THREE.SphereGeometry(220, 48, 32),
    new THREE.MeshBasicMaterial({ map: skyTexture(theme), side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  scene.add(sky);

  camera = new THREE.PerspectiveCamera(38, aspect, 0.1, 400);
  camera.position.set(0, 3.6, 11.4);

  ambLight = new THREE.AmbientLight(theme.amb.c, legacyIntensity(theme.amb.f));
  hemiLight = new THREE.HemisphereLight(theme.hemi.sky, theme.hemi.gnd, legacyIntensity(theme.hemi.f));
  scene.add(ambLight, hemiLight);
  setLightTargets(theme);

  key = new THREE.DirectionalLight(theme.key.c, legacyIntensity(theme.key.f));
  key.position.set(...theme.key.pos);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 48;
  key.shadow.camera.left = -18;
  key.shadow.camera.right = 18;
  key.shadow.camera.top = 16;
  key.shadow.camera.bottom = -8;
  // VSM wants far less bias than PCF did; the blur is what hides acne
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 5;
  key.shadow.blurSamples = 12;
  scene.add(key, key.target);

  rim = new THREE.DirectionalLight(theme.rim.c, legacyIntensity(theme.rim.i));
  rim.position.set(...theme.rim.pos);
  scene.add(rim);

  refreshModelEnv(theme);
}

/*
  Image-based fill for the loaded fighters only.

  A plain fill light was the obvious fix for models whose shadow side fell to
  black — but three.js has no per-object light filtering, so it bleached the
  cel-shaded stage at the same time. An environment map on the fighters'
  materials lifts them without touching the courtyard: it is assigned per
  material rather than through scene.environment, which would catch the
  arena's standard materials too and wash the floor milky.

  Rebuilt on every theme change so the fighters are lit by the sky actually
  behind them. ENV_MATS is the registry of materials that took the probe.
*/
export const ENV_MATS: THREE.MeshStandardMaterial[] = [];
export let MODEL_ENV: THREE.Texture | null = null;
let envTarget: THREE.RenderTarget | null = null;

function buildModelEnv(theme: Theme): THREE.RenderTarget | null {
  if (!rendererRef) return null;
  try {
    const pmrem = new THREE.PMREMGenerator(rendererRef);
    const source = skyTexture(theme);
    const target = pmrem.fromEquirectangular(source);
    pmrem.dispose();
    source.dispose();
    return target;
  } catch (err) {
    // no IBL: the fighters keep the light rig they had
    if (import.meta.env.DEV) console.warn('[stage] environment probe unavailable', err);
    return null;
  }
}

export function refreshModelEnv(theme: Theme): void {
  const next = buildModelEnv(theme);
  if (!next) return;
  const old = envTarget;
  envTarget = next;
  MODEL_ENV = next.texture;
  for (const m of ENV_MATS) {
    m.envMap = next.texture;
    // each material's own reflectivity (see pbrMat) scaled by the theme's overall probe strength
    m.envMapIntensity = (theme.modelEnv || 0.85) * ((m.userData.envScale as number | undefined) ?? 1);
    m.needsUpdate = true;
  }
  old?.dispose();
}

/* Shadow cost per quality level (config/quality.ts). The map resizes on the
   next render; the blur radius and sample count are uniforms, so switching
   never recompiles. */
export function setShadowQuality(q: Quality): void {
  const s = QUALITY_PRESETS[q].shadow;
  const sh = key.shadow;
  sh.mapSize.set(s.size, s.size);
  sh.radius = s.radius;
  sh.blurSamples = s.blur;
}

/** Releases what the stage owns outside the scene graph. The graph itself is disposed by the game. */
export function disposeStage(): void {
  envTarget?.dispose();
  envTarget = null;
  MODEL_ENV = null;
  ENV_MATS.length = 0;
  rendererRef = null;
}
