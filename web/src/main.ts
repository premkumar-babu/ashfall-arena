import './styles/game.css';
import './styles/touch.css';
import './styles/screens.css';

import { beginAssetLoad, resetAssets, restoreCast } from './assets/models';
import { Assets } from './assets/pipeline';
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
import { Ambience } from './audio/ambience';
import { Flip } from './fx/flipbook';
import { bindFeelLoop, resetFeel } from './fx/juice';
import { initParticles, resetParticles } from './fx/particles';
import { initBlood } from './fx/blood';
import { bindWarmup } from './render/warmup';
import { resetSwingRibbons } from './fx/ribbon';
import { initStrikeLights, resetStrikeLights } from './fx/strike-lights';
import { initVfx, resetVfx } from './fx/vfx';
import { present, simulate } from './game/game';
import { applyIdentity, cancelMatchTimers, match, renderStocks } from './game/match';
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
import { loadSettings, settings } from './ui/settings';
import { PHASE } from './config/constants';
import { detectQuality, isQualityChoice, QUALITY_PRESETS } from './config/quality';
import { Governor } from './core/frame-governor';
import { buildArena } from './world/arena';
import { resetInstancingStats } from './world/instancing';
import { buildLandscape, disposeLandscape, loadLandscapeProps } from './world/landscape';
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

    /* Before anything asks for a file: the pipeline reads the optimised-asset
       manifest, and KTX2 needs the device to say which compressed formats it
       samples. Disposed just before the renderer, after everything using it. */
    await Assets.init(renderer);
    disposer.defer(() => Assets.dispose());

    createStage(renderer, state.theme, host.clientWidth / Math.max(1, host.clientHeight));
    disposer.defer(() => {
      disposeObject(scene);
      disposeStage();
      disposeSharedMaterials();
    });

    // quality before anything is sized: AUTO starts from what the device looks capable of
    const stored = loadSettings();
    if (isQualityChoice(stored.quality)) settings.quality = stored.quality;
    settings.level = settings.quality === 'auto' ? detectQuality(backend) : settings.quality;
    const viewport = disposer.track(new Viewport(host, renderer, camera, QUALITY_PRESETS[settings.level].pixelRatio));

    // the world: stage set, effect pools, fighters
    buildArena(state.theme);
    buildLandscape(state.theme);                   // terrain and walls now; props stream in below
    initParticles();
    initVfx();
    initBlood();
    Flip.load();
    initStrikeLights();
    loadSurfaces();
    void loadLandscapeProps();
    buildRigs();
    disposer.defer(() => {
      disposeLandscape();
      resetInstancingStats();
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

    createPost(renderer, scene, camera, settings.level);
    disposer.defer(disposePost);
    bindThemeRenderer(renderer);
    disposer.defer(() => bindThemeRenderer(null));
    initPortraits(renderer);
    bindWarmup(renderer, scene, camera);
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
      resetFeel();
      Ambience.stop();
      Music.dispose();
      Sfx.dispose();
    });

    const loop = new FixedStepLoop({
      update: simulate,
      render: (alpha, frameDt) => {
        // decides whether this frame reaches the GPU, and watches frame time for AUTO quality
        Governor.begin(frameDt, {
          paused: state.phase === PHASE.FIGHT && match.paused,
          measuring: state.phase === PHASE.FIGHT || state.phase === PHASE.SELECT,
        });
        present(alpha, frameDt);
        Boot.tick();                               // curtain on the title, streaming pill after it
        if (Governor.draw) perf.update();
      },
    }, SIM_HZ);
    bindFeelLoop(loop);                            // KO slow motion drives the loop's time scale
    loop.start(renderer);
    disposer.defer(() => {                         // registered last, so it runs first
      loop.stop();
      bindFeelLoop(null);
    });

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
