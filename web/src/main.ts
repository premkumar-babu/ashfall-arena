import './styles/game.css';
import './styles/touch.css';

import { beginAssetLoad, resetAssets, restoreCast } from './assets/models';
import { resetArtStats } from './assets/texture-loader';
import { Music } from './audio/music';
import { Sfx } from './audio/sfx';
import { resetCameraRig } from './camera/camera-rig';
import { disposeObject, Disposer } from './core/disposal';
import { FixedStepLoop } from './core/loop';
import { queryFlag } from './core/platform';
import { createRenderer } from './core/renderer';
import { Viewport } from './core/resize';
import { PerfMonitor } from './core/stats';
import { installDebugHooks, removeDebugHooks } from './debug';
import { Flip } from './fx/flipbook';
import { initParticles, resetParticles } from './fx/particles';
import { resetSwingRibbons } from './fx/ribbon';
import { initStrikeLights, resetStrikeLights } from './fx/strike-lights';
import { initVfx, resetVfx } from './fx/vfx';
import { present, simulate } from './game/game';
import { applyIdentity, cancelMatchTimers, renderStocks } from './game/match';
import { buildRigs, resetRigs } from './game/rigs';
import { state } from './game/state';
import { resetVolumes } from './game/volumes';
import { loadKeys } from './input/bindings';
import { attachFighterBodies, disposePhysics, setPhysics } from './physics/port';
import { disposeSharedMaterials } from './render/materials';
import { createPost, disposePost } from './render/post';
import { camera, createStage, disposeStage, scene } from './render/stage';
import { applyTheme, bindThemeRenderer } from './render/theme';
import { clearAnnounce } from './ui/announcer';
import { Boot } from './ui/boot-curtain';
import { bindDom } from './ui/dom';
import { wireFrontEnd } from './ui/front-end';
import { bindHud } from './ui/hud';
import { disposePortraits, initPortraits, refreshPortraits } from './ui/portraits';
import { buildCastUI, buildSelectUI, buildStats, buildThemeUI, updateSelectUI } from './ui/select';
import { isQuality, loadSettings, QUALITY, settings } from './ui/settings';
import { buildArena } from './world/arena';
import { loadSurfaces, resetSurfaces } from './world/surfaces';

/*
  Boot. Construction order is explicit here instead of being whatever order
  10,000 lines of one file happened to run in at load.

  Everything created is registered with one Disposer as it is created, so
  teardown is the exact reverse of construction: the loop stops first, the
  renderer goes last. Vite's hot reload calls it, which is what keeps a dev
  session from stacking a second WebGPU device, a second set of window
  listeners and a second animation loop onto the first.
*/

/** Simulation rate. Double a 60 Hz display, so an attack's shortest active window is never under 8 steps. */
const SIM_HZ = 120;

async function boot(): Promise<() => void> {
  const host = document.getElementById('stage');
  if (!host) throw new Error('#stage is missing from index.html');

  const disposer = new Disposer();
  try {
    bindDom();

    const { renderer, backend } = await createRenderer(host, { trackTimestamps: queryFlag('stats') });
    disposer.defer(() => {
      renderer.dispose();
      renderer.domElement.remove();
    });

    createStage(renderer, state.theme, host.clientWidth / Math.max(1, host.clientHeight));
    disposer.defer(() => {
      disposeObject(scene);
      disposeStage();
      disposeSharedMaterials();
    });

    const stored = loadSettings();
    if (isQuality(stored.quality)) settings.quality = stored.quality;
    const viewport = disposer.track(new Viewport(host, renderer, camera, QUALITY[settings.quality]));

    // the world: stage set, effect pools, fighters
    buildArena(state.theme);
    initParticles();
    initVfx();
    Flip.load();
    initStrikeLights();
    loadSurfaces();
    buildRigs();
    disposer.defer(() => {
      resetRigs();
      resetVolumes();
      resetVfx();
      resetParticles();
      resetStrikeLights();
      resetSurfaces();
      resetArtStats();
      resetSwingRibbons();
      Flip.reset();
    });

    /* Physics. Rapier is a separate chunk (see physics/port.ts); if it cannot
       load, the fighters keep their built-in movement and the match still runs. */
    try {
      const { createPhysics } = await import('./physics/rapier-physics');
      setPhysics(await createPhysics(SIM_HZ));
      attachFighterBodies();
    } catch (err) {
      console.warn('[physics] Rapier unavailable; using built-in movement', err);
    }
    disposer.defer(disposePhysics);

    createPost(renderer, scene, camera, settings.quality);
    disposer.defer(disposePost);
    bindThemeRenderer(renderer);
    disposer.defer(() => bindThemeRenderer(null));
    initPortraits(renderer);
    disposer.defer(disposePortraits);

    const perf = disposer.track(new PerfMonitor(document.body, queryFlag('stats')));
    void perf.attach(renderer);

    // front end
    loadKeys();
    Boot.start();                                  // before the first model request goes out
    disposer.track(Boot);
    restoreCast();
    buildSelectUI();
    buildStats();
    buildThemeUI();
    buildCastUI();
    bindHud(disposer);
    updateSelectUI();
    applyIdentity();
    renderStocks();
    document.body.classList.add('attract');
    applyTheme(state.themeIndex, true);           // after the post stack, so the grade lands too
    wireFrontEnd({ disposer, viewport, perf });
    void refreshPortraits();                       // primitive rigs now; re-shot as models land
    beginAssetLoad();
    disposer.defer(resetAssets);
    disposer.defer(() => {
      cancelMatchTimers();
      clearAnnounce();
      resetCameraRig();
      Music.dispose();
      Sfx.dispose();
    });

    const loop = new FixedStepLoop({
      update: simulate,
      render: (alpha, frameDt) => {
        present(alpha, frameDt);
        perf.update();
      },
    }, SIM_HZ);
    loop.start(renderer);
    disposer.defer(() => loop.stop());             // registered last, so it runs first

    installDebugHooks({ renderer, backend, loop });
    disposer.defer(removeDebugHooks);

    if (import.meta.env.DEV) console.info(`[ashfall] rendering with the ${backend} backend`);
    return () => disposer.dispose();
  } catch (err) {
    disposer.dispose();
    throw err;
  }
}

/* A device that cannot give us WebGPU or WebGL2 gets a sentence, not a blank page. */
function showFatal(err: unknown): void {
  console.error('[ashfall] boot failed', err);
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:2rem;'
    + 'background:#0b0809;color:#ede3d2;font:16px/1.5 system-ui,sans-serif;text-align:center;z-index:100';
  const msg = document.createElement('p');
  msg.textContent = 'Ashfall Arena could not start: this browser did not provide WebGPU or WebGL2. '
    + (err instanceof Error ? `(${err.message})` : '');
  box.appendChild(msg);
  document.body.appendChild(box);
}

const teardown = boot().catch((err: unknown) => {
  showFatal(err);
  return () => {};
});

if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    (await teardown)();
  });
}
