import * as THREE from 'three/webgpu';
import { attachClips, ClipLib } from './anim/animation';
import { collectBones, normBone } from './anim/bones';
import { ASSETS } from './assets/models';
import { CLIPS } from './assets/loader';
import { Assets } from './assets/pipeline';
import { Governor } from './core/frame-governor';
import { feelDebug } from './fx/juice';
import { INSTANCING } from './world/instancing';
import { landscapeStats } from './world/landscape';
import { THEMES } from './config/themes';
import type { BackendKind } from './core/renderer';
import type { FixedStepLoop } from './core/loop';
import type { Fighter } from './game/fighter';
import { match } from './game/match';
import { physics } from './physics/port';
import { assistRigs, rigs } from './game/rigs';
import { state } from './game/state';
import { applyTheme } from './render/theme';
import { camera, scene } from './render/stage';

/*
  Console handles for picking a running match apart. `__ASH` is the read-only
  snapshot the monolith exposed (tests drive it); `__ash` is the inspection kit.
  Installed by main.ts and removed on dispose, so a hot reload never leaves a
  handle pointing at a torn-down scene.
*/

declare global {
  interface Window {
    __ASH?: unknown;
    __ash?: unknown;
  }
}

interface DebugContext {
  readonly renderer: THREE.WebGPURenderer;
  readonly backend: BackendKind;
  readonly loop: FixedStepLoop;
}

function fighterSnapshot(x: Fighter): Record<string, unknown> {
  return {
    name: x.def.name, state: x.state, hp: Math.round(x.hp), x: +x.x.toFixed(2),
    y: +x.y.toFixed(2), face: x.face, lockFace: x.lockFace, meter: Math.round(x.meter),
    model: !!x.model, bones: !!x.boneRig, mats: x.modelMats?.length ?? 0,
    grounded: x.grounded, dash: +x.dashTime.toFixed(2),
  };
}

export function installDebugHooks({ renderer, backend, loop }: DebugContext): void {
  window.__ASH = {
    get p1() { return state.P1; },
    get p2() { return state.P2; },
    get match() { return match; },
    get phase() { return state.phase; },
    get camera() { return camera; },
    get scene() { return scene; },
    get assets() { return ASSETS; },
    backend,
    snapshot: () => ({
      phase: state.phase, round: match.round, time: +match.time.toFixed(1),
      camZ: +camera.position.z.toFixed(2), fov: +camera.fov.toFixed(1),
      p1: fighterSnapshot(state.P1), p2: fighterSnapshot(state.P2), assets: ASSETS.status,
      backend, steps: loop.steps, shed: +loop.shed.toFixed(3),
      physics: physics?.stats() ?? null,
    }),
    /* Dispatched on <body>, not window, so it travels capture → bubble like a
       real keypress. Fired at window, both window listeners run at-target and
       the overlay's stopPropagation cannot shield the game handler. */
    press: (code: string, up?: boolean) => {
      document.body.dispatchEvent(new KeyboardEvent(up ? 'keyup' : 'keydown', { code, key: code, bubbles: true }));
    },
    // clip plumbing, so a bought clip that refuses to bind can be diagnosed instead of just looking frozen
    clips: CLIPS,
    normBone,
    attachClips,
    bonesOf: (m: THREE.Object3D) => collectBones(m).map((b) => `${b.node.name} -> ${b.key}`),
  };

  window.__ash = {
    scene, camera, renderer, rigs, assistRigs, lib: ClipLib, assets: ASSETS, themes: THEMES,
    // the asset pipeline: cache, counters, per-stage progress; instancing and prop LOD buckets
    pipeline: Assets,
    loading: () => Assets.snapshot(),
    assetStats: () => Assets.stats(),
    instancing: INSTANCING,
    feel: feelDebug,
    governor: () => Governor.stats(),
    landscape: landscapeStats,
    draws: () => ({ ...renderer.info.render, ...renderer.info.memory }),
    theme: () => state.theme,
    setTheme: (i: number) => applyTheme(i),
    pick: (nx: number, ny: number) => {
      const rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
      return rc.intersectObjects(scene.children, true).slice(0, 6).map((h) => {
        const m = (h.object as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        return {
          name: h.object.name || h.object.type, dist: +h.distance.toFixed(2),
          mat: m?.type, col: m?.color ? `#${m.color.getHexString()}` : null, op: m?.opacity ?? null,
        };
      });
    },
  };
}

export function removeDebugHooks(): void {
  delete window.__ASH;
  delete window.__ash;
}
