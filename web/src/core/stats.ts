import Stats from 'stats-gl';
import type { WebGPURenderer } from 'three/webgpu';

/*
  Performance overlay: FPS, CPU and GPU frame time.

  stats-gl rather than stats.js. stats.js times the JavaScript side of a frame,
  which on WebGPU says very little — draw work is submitted to the GPU and
  finishes after the JS returns, so a frame can read "2 ms" and still drop. stats-gl
  reads GPU timestamp queries where the device exposes them, on both backends.

  Hidden by default; `?stats` shows it at load, and it is toggled at runtime
  from the dev panel key.
*/
export class PerfMonitor {
  private readonly stats: Stats;
  private shown: boolean;

  constructor(parent: HTMLElement, shown: boolean) {
    this.stats = new Stats({
      trackGPU: true,
      trackHz: false,
      logsPerSecond: 4,
      graphsPerSecond: 30,
      samplesLog: 40,
      samplesGraph: 10,
      precision: 2,
      horizontal: true,
      minimal: false,
    });
    const dom = this.stats.dom;
    dom.classList.add('perf');
    dom.style.zIndex = '12';
    parent.appendChild(dom);
    this.shown = shown;
    this.apply();
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Hooks the renderer so GPU time is measured around its own render calls. */
  async attach(renderer: WebGPURenderer): Promise<void> {
    await this.stats.init(renderer);
  }

  /** Call once per displayed frame, after rendering. */
  update(): void {
    if (this.shown) this.stats.update();
  }

  toggle(force?: boolean): void {
    this.shown = force ?? !this.shown;
    this.apply();
  }

  private apply(): void {
    this.stats.dom.style.display = this.shown ? '' : 'none';
  }

  dispose(): void {
    this.stats.dom.remove();
  }
}
