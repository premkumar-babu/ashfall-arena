import type * as THREE from 'three/webgpu';

/*
  Pipeline warm-up.

  A WebGPU pipeline is built the first time something using it is drawn, and
  building one can take a second or more. The fight camera never looks at
  most of the stage, and most of the cast is hidden until picked, so the first
  cinematic cut or the first match with a new fighter used to freeze the game
  for up to three seconds while it compiled whatever had just come into view.

  So the whole scene is compiled up front — on the title once the cast has
  loaded, and again as each match starts. For the pass, frustum culling is
  lifted and everything hidden is shown, so the fighters nobody has picked yet
  and the stage behind the camera are compiled too. Both are put back straight
  after the call: the renderer gathers what to compile synchronously, and only
  the compiling itself is asynchronous.
*/

let ref: { renderer: THREE.WebGPURenderer; scene: THREE.Scene; camera: THREE.Camera } | null = null;
let busy = false;

export function bindWarmup(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera): void {
  ref = { renderer, scene, camera };
}

export function warmPipelines(): void {
  if (!ref || busy) return;
  busy = true;
  const { renderer, scene, camera } = ref;
  const culled: THREE.Object3D[] = [];
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (o.frustumCulled) {
      culled.push(o);
      o.frustumCulled = false;
    }
    if (!o.visible) {
      hidden.push(o);
      o.visible = true;
    }
  });
  let pending: Promise<void>;
  try {
    pending = renderer.compileAsync(scene, camera);
  } finally {
    for (const o of hidden) o.visible = false;
    for (const o of culled) o.frustumCulled = true;
  }
  const done = (): void => {
    busy = false;
  };
  pending.then(done, done);
}
