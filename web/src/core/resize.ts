import type { PerspectiveCamera } from 'three/webgpu';

export interface SizedRenderer {
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
}

export type ResizeListener = (width: number, height: number, pixelRatio: number) => void;

/*
  Keeps the renderer and camera matched to their host element.

  The old build listened for window `resize`. That misses every case where the
  element changes size and the window does not — which is the normal case on
  itch.io, where the game runs inside an iframe that the page resizes, and in
  any flex layout. A ResizeObserver on the host sees all of them.

  It also misses the device pixel ratio changing, which happens when a window
  is dragged between a 1x and a 2x monitor and changes nothing about CSS size.
  That is watched separately with a resolution media query.

  Updates are coalesced to one per animation frame: a drag-resize fires the
  observer far faster than it is worth reallocating render targets.
*/
export class Viewport {
  width = 0;
  height = 0;
  pixelRatio = 0;

  private maxPixelRatio: number;
  private readonly listeners = new Set<ResizeListener>();
  private readonly observer: ResizeObserver;
  private pending = 0;
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => {
    this.watchDpr();
    this.schedule();
  };

  constructor(
    private readonly host: HTMLElement,
    private readonly renderer: SizedRenderer,
    private readonly camera: PerspectiveCamera,
    maxPixelRatio = 2,
  ) {
    this.maxPixelRatio = maxPixelRatio;
    this.observer = new ResizeObserver(() => this.schedule());
    this.observer.observe(host);
    this.watchDpr();
    this.apply();
  }

  /** Cap on the render scale. The LOW / MEDIUM / HIGH quality settings are 0.7 / 1 / 2. */
  setMaxPixelRatio(value: number): void {
    this.maxPixelRatio = value;
    this.apply(true);
  }

  /** Subscribe to size changes. Fires immediately with the current size. Returns an unsubscribe. */
  onResize(fn: ResizeListener): () => void {
    this.listeners.add(fn);
    fn(this.width, this.height, this.pixelRatio);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    // a resolution query only matches the ratio it was written for, so it is
    // re-armed at the new ratio every time it fires
    this.dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.dprQuery.addEventListener('change', this.onDprChange);
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0;
      this.apply();
    });
  }

  private apply(force = false): void {
    const width = Math.max(1, Math.floor(this.host.clientWidth));
    const height = Math.max(1, Math.floor(this.host.clientHeight));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    if (!force && width === this.width && height === this.height && pixelRatio === this.pixelRatio) return;

    this.width = width;
    this.height = height;
    this.pixelRatio = pixelRatio;

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);   // CSS owns the element's displayed size
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    for (const fn of this.listeners) fn(width, height, pixelRatio);
  }

  dispose(): void {
    this.observer.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDprChange);
    if (this.pending) cancelAnimationFrame(this.pending);
    this.pending = 0;
    this.listeners.clear();
  }
}
