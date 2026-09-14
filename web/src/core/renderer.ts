import * as THREE from 'three/webgpu';
import { queryFlag } from './platform';

export type BackendKind = 'webgpu' | 'webgl2';

export interface RendererHandle {
  renderer: THREE.WebGPURenderer;
  backend: BackendKind;
}

/*
  WebGPURenderer first, WebGL2 underneath it.

  This is one renderer, not two code paths. WebGPURenderer picks its backend
  at init(): WebGPU where navigator.gpu exists and hands out a device, and its
  own WebGL2 backend otherwise. Materials, the render pipeline and every
  effect in the game are written once against the node system and run on
  either. `?webgl` in the URL forces the fallback, so it can be tested on a
  machine that would otherwise never exercise it.

  The one thing that genuinely differs is timing queries, which is why the
  performance overlay asks for timestamps here rather than assuming them.
*/
export async function createRenderer(host: HTMLElement, opts: { trackTimestamps?: boolean } = {}): Promise<RendererHandle> {
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: 'high-performance',
    forceWebGL: queryFlag('webgl'),
    trackTimestamp: opts.trackTimestamps ?? false,
  });

  // init() is where the backend is chosen and the device is requested; it
  // rejects only when neither WebGPU nor WebGL2 is available at all
  await renderer.init();

  const backend: BackendKind =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true ? 'webgpu' : 'webgl2';

  renderer.shadowMap.enabled = true;
  /* Variance shadow maps: the soft option the node renderer supports on both
     backends (PCFSoftShadowMap was removed). The shadow map is blurred once
     per light, so the penumbra costs a fixed amount however many fragments
     sample it — unlike widening PCF, which multiplies per-fragment taps. */
  renderer.shadowMap.type = THREE.VSMShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  renderer.domElement.dataset.backend = backend;
  host.appendChild(renderer.domElement);

  return { renderer, backend };
}
