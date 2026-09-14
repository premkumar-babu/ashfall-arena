import type * as THREE from 'three/webgpu';
import { saveTheme, THEMES } from '../config/themes';
import { Sfx } from '../audio/sfx';
import { state } from '../game/state';
import { announce } from '../ui/announcer';
import { maybeById } from '../ui/dom';
import { syncThemeUI } from '../ui/select';
import { arena, tintStone } from '../world/arena';
import { syncFloorTex } from '../world/surfaces';
import { legacyIntensity } from './lights';
import { post } from './post';
import {
  ambLight, background, fog, hemiLight, key, LIGHTS, refreshModelEnv, rim, setLightTargets, sky,
} from './stage';
import { skyTexture } from './textures';

/*
  Everything the look depends on, repointed at one row of THEMES. Light
  intensities go into LIGHTS rather than onto the lights, because the camera
  rig damps toward that table every frame and would drag a direct write
  straight back.
*/

let rendererRef: THREE.WebGPURenderer | null = null;

export function bindThemeRenderer(renderer: THREE.WebGPURenderer | null): void {
  rendererRef = renderer;
}

export function applyTheme(idx: number, quiet = false): void {
  state.themeIndex = ((idx % THEMES.length) + THEMES.length) % THEMES.length;
  const T = state.theme;

  if (rendererRef) rendererRef.toneMappingExposure = T.exposure;
  background.set(T.bg);
  fog.color.set(T.fog);
  fog.density = T.fogD;

  sky.material.map?.dispose();
  sky.material.map = skyTexture(T);
  sky.material.needsUpdate = true;

  ambLight.color.set(T.amb.c);
  hemiLight.color.set(T.hemi.sky);
  hemiLight.groundColor.set(T.hemi.gnd);
  key.color.set(T.key.c);
  key.position.set(...T.key.pos);
  rim.color.set(T.rim.c);
  rim.intensity = legacyIntensity(T.rim.i);
  rim.position.set(...T.rim.pos);

  setLightTargets(T);
  if (quiet) {
    // first call: no cross-fade
    ambLight.intensity = LIGHTS.ambSelect;
    hemiLight.intensity = LIGHTS.hemiSelect;
    key.intensity = LIGHTS.keySelect;
  }

  const a = arena;
  a.floor.material.color.set(T.floor);
  a.dais.material.color.set(T.dais);
  a.water.material.color.set(T.water);
  a.water.material.roughness = T.wRough;
  a.water.material.metalness = T.wMetal;
  a.water.material.opacity = T.wOp;
  a.timberMat.color.set(T.timber);
  a.tileMat.color.set(T.tile);
  for (const m of a.stoneTones) tintStone(m, T.stone, m.userData.tone as number);
  a.trimMat.color.set(T.trim);
  a.cloudMat.color.set(T.cloud);
  a.cloudMat.opacity = T.cloudOp;
  a.birdMat.color.set(T.bird);
  a.barkMat.color.set(T.bark);
  a.petalMat.color.set(T.petal);
  a.petalMat2.color.set(T.petal2);
  a.ridgeMat.color.set(T.ridge ?? 0x8fa6b4);

  // the guardians belong to the courtyard, not to a dock at sunset
  for (const g of a.guardians) g.visible = T.statues !== false;
  a.palmMat.color.set(T.bark);
  for (const p of a.palms) p.g.visible = !!T.palms;
  for (const b of a.branches) b.visible = !T.palms && !T.bare;
  a.sunPath.material.opacity = T.glint ?? 0;
  a.sunPath.visible = !!T.glint;
  syncFloorTex();

  a.embers.setColor(T.motes.color);
  a.embers.setSize(T.motes.size);
  a.embers.setOpacity(T.motes.op);
  a.dust.setColor(T.dust.color);
  a.dust.setOpacity(T.dust.op);
  for (const h of a.hazeLayers) {
    h.mesh.material.color.set(T.haze.color);
    h.mesh.material.opacity = T.haze.op * h.base;
  }

  post?.applyTheme(T);

  const r = document.documentElement.style;
  r.setProperty('--ember', T.css.acc);
  r.setProperty('--ember-hot', T.css.acc2);
  r.setProperty('--gold', T.css.acc2);
  r.setProperty('--void', T.css.ink);
  r.setProperty('--ash', T.css.panel);
  r.setProperty('--char', T.css.panel);
  r.setProperty('--smoke', T.css.line);
  r.setProperty('--bone', T.css.text);
  r.setProperty('--dust', T.css.dim);

  refreshModelEnv(T);
  syncThemeUI();
  const tStage = maybeById('t-stage');
  if (tStage) {
    tStage.textContent = T.name;
    tStage.className = 'gold';
  }
  saveTheme(T);
  if (!quiet) announce(T.name, 900, 'toast');
}

export function cycleTheme(step = 1): void {
  applyTheme(state.themeIndex + step);
  Sfx.ui();
}
