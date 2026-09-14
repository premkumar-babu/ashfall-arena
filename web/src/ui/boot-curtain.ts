import { ASSETS } from '../assets/models';
import { LOAD_MGR } from '../assets/texture-loader';
import { clamp } from '../core/math';

/*
  The boot curtain: a progress bar over a game designed never to need one.
  The scene renders underneath from the first frame and every asset degrades
  to something playable, so this is a curtain, not a gate — it hides a cold
  start and lifts on a deadline whether or not the last byte landed.
*/

const LABEL: Readonly<Record<string, string>> = {
  glb: 'loading fighters', fbx: 'loading fighters', json: 'loading fighters',
  jpg: 'loading surfaces', png: 'loading effects',
};

const DEADLINE_MS = 12_000;

class BootCurtain {
  private fill: HTMLElement | null = null;
  private pct: HTMLElement | null = null;
  private what: HTMLElement | null = null;
  private done = false;
  private shown = 0;
  private deadline = 0;
  private reqTotal = 0;
  private reqLoaded = 0;
  private liftTimer = 0;

  start(): void {
    this.fill = document.getElementById('bfill');
    this.pct = document.getElementById('bpct');
    this.what = document.getElementById('bwhat');
    this.done = false;
    this.shown = 0;
    this.deadline = performance.now() + DEADLINE_MS;

    const track = (url: string, loaded: number, total: number): void => {
      this.reqLoaded = loaded;
      this.reqTotal = total;
      if (this.what) this.what.textContent = this.label(url);
    };
    LOAD_MGR.onStart = track;
    LOAD_MGR.onProgress = (url, loaded, total) => {
      track(url, loaded, total);
      this.paint(this.ratio());
    };
    // onLoad fires whenever the queue empties — between waves too — so it reports, it does not decide
    LOAD_MGR.onLoad = () => this.paint(this.ratio());
    LOAD_MGR.onError = () => this.paint(this.ratio());
  }

  /** Every presentation frame on the title. The cast being complete ends it; so does the deadline. */
  tick(): void {
    if (this.done) return;
    this.paint(this.ratio());
    const got = ASSETS.loaded + ASSETS.failed + ASSETS.borrowed;
    if ((ASSETS.total > 0 && got >= ASSETS.total) || performance.now() > this.deadline) this.skip();
  }

  skip(): void {
    if (this.done) return;
    this.done = true;
    this.paint(1);
    if (this.what) this.what.textContent = 'ready';
    // let the bar read 100 for a beat before the curtain lifts
    this.liftTimer = window.setTimeout(() => document.body.classList.add('booted'), 260);
  }

  dispose(): void {
    window.clearTimeout(this.liftTimer);
    LOAD_MGR.onStart = LOAD_MGR.onProgress = LOAD_MGR.onError = () => {};
    LOAD_MGR.onLoad = () => {};
  }

  private label(url: string): string {
    const m = /\.(\w+)(?:\?|$)/.exec(url);
    return (m && LABEL[m[1]!.toLowerCase()]) || 'loading';
  }

  /* The manager's raw ratio snaps to 100% between waves of requests, so it is
     blended with the model tally, which knows how many are still to come. */
  private ratio(): number {
    const byReq = this.reqTotal > 0 ? this.reqLoaded / this.reqTotal : 0;
    const got = ASSETS.loaded + ASSETS.failed + ASSETS.borrowed;
    const byCast = clamp(got / (ASSETS.total || 1), 0, 1);
    return clamp(byCast * 0.7 + byReq * 0.3, 0, 1);
  }

  private paint(r: number): void {
    if (!this.fill) return;
    this.shown = Math.max(this.shown, r);          // a loading bar never rewinds
    this.fill.style.transform = `scaleX(${this.shown.toFixed(3)})`;
    if (this.pct) this.pct.textContent = `${Math.round(this.shown * 100)}%`;
  }
}

export const Boot = new BootCurtain();
