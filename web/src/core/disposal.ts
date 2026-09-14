import type { BufferGeometry, Material, Object3D, Skeleton, Texture } from 'three/webgpu';

/*
  GPU resources are not garbage-collected. A geometry, texture or render
  target that falls out of reach in JavaScript keeps its buffers on the GPU
  until dispose() is called. The old single-file build never had to care —
  it built everything once and lived until the tab closed. A Vite build with
  hot module replacement tears the game down and rebuilds it on every save,
  and without real disposal each save would leak a scene's worth of buffers
  (and, on WebGPU, a device).

  disposeObject / disposeMaterial free what a subtree owns.
  Disposer collects everything a subsystem owns — GPU resources, DOM
  listeners, observers, arbitrary cleanups — so one call undoes all of it.
*/

type Keep = ReadonlySet<object>;

interface HasGeometryAndMaterial {
  geometry?: BufferGeometry;
  material?: Material | Material[];
  skeleton?: Skeleton;
}

function isTexture(value: unknown): value is Texture {
  return typeof value === 'object' && value !== null
    && (value as { isTexture?: boolean }).isTexture === true;
}

/** Dispose a material and every texture it references, except anything in `keep`. */
export function disposeMaterial(material: Material, keep?: Keep, seen = new Set<object>()): void {
  if (keep?.has(material) || seen.has(material)) return;
  seen.add(material);
  for (const value of Object.values(material)) {
    if (isTexture(value) && !keep?.has(value) && !seen.has(value)) {
      seen.add(value);
      value.dispose();
    }
  }
  material.dispose();
}

/**
 * Dispose everything a subtree owns and detach it from its parent.
 *
 * Resources shared with objects that stay alive — a cached texture, one
 * material used across the whole roster — must be passed in `keep`, or they
 * are freed out from under whatever still uses them.
 */
export function disposeObject(root: Object3D, keep?: Keep): void {
  const seen = new Set<object>();
  root.traverse((node) => {
    const n = node as Object3D & HasGeometryAndMaterial;
    if (n.geometry && !keep?.has(n.geometry) && !seen.has(n.geometry)) {
      seen.add(n.geometry);
      n.geometry.dispose();
    }
    if (n.material) {
      const list = Array.isArray(n.material) ? n.material : [n.material];
      for (const m of list) disposeMaterial(m, keep, seen);
    }
    // an instanced mesh owns its instance matrix and colour buffers
    const instanced = node as Object3D & { isInstancedMesh?: boolean; dispose?: () => void };
    if (instanced.isInstancedMesh && !seen.has(instanced)) {
      seen.add(instanced);
      instanced.dispose?.();
    }
    // a skinned mesh's bone matrices live in a texture of their own
    if (n.skeleton && !seen.has(n.skeleton)) {
      seen.add(n.skeleton);
      n.skeleton.dispose();
    }
    // and a shadow-casting light owns its shadow map
    const light = node as Object3D & { isLight?: boolean; dispose?: () => void };
    if (light.isLight && typeof light.dispose === 'function' && !seen.has(light)) {
      seen.add(light);
      light.dispose();
    }
  });
  root.removeFromParent();
}

export interface Disposable {
  dispose(): void;
}

export class Disposer implements Disposable {
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Track anything with a dispose() method. Returns it, so construction and tracking are one expression. */
  track<T extends Disposable>(resource: T): T {
    this.cleanups.push(() => resource.dispose());
    return resource;
  }

  /** Run `fn` when this disposer is disposed. */
  defer(fn: () => void): void {
    this.cleanups.push(fn);
  }

  /** addEventListener that removes itself on dispose. */
  listen<K extends keyof WindowEventMap>(target: Window, type: K,
    fn: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions | boolean): void;
  listen<K extends keyof DocumentEventMap>(target: Document, type: K,
    fn: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions | boolean): void;
  listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K,
    fn: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions | boolean): void;
  listen(target: EventTarget, type: string, fn: (event: Event) => void,
    options?: AddEventListenerOptions | boolean): void {
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  /**
   * Undo everything, newest first: a later resource may depend on an earlier
   * one (a render pipeline on its renderer), so it has to go before it. One
   * failing cleanup is logged and does not stop the rest from running.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (let i = this.cleanups.length - 1; i >= 0; i--) {
      try {
        this.cleanups[i]!();
      } catch (err) {
        console.error('[dispose]', err);
      }
    }
    this.cleanups.length = 0;
  }
}
