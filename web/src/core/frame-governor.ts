/*
  The frame governor: two ways of not spending frames that do nothing.

  Demand rendering. Simulation and presentation logic still run every frame
  (input, timers, audio and the menus all need them), but the GPU draw is
  skipped when it would only repeat the last image. A paused match redraws at
  10 fps — enough for a resize or a theme change behind the pause card to show.

  Adaptive quality. While a fight or the select screen is live, frame time is
  smoothed; if it stays over budget for a few seconds, onSlow fires and the
  front end drops one preset. It only ever steps down by itself: on a display
  capped at 60 Hz a comfortable frame and a strained one both measure 16.7 ms,
  so there is no honest signal for stepping back up. That stays the player's
  choice. Frames right after a start, a resume or a quality change are ignored,
  because they include shader compilation.
*/

const PAUSED_FPS = 10;
/** Sustained frame time above this counts as slow: about 48 fps. */
const SLOW_FRAME = 1 / 48;
/** Seconds of slow frames before stepping down. */
const SLOW_WINDOW = 4;
/** Seconds ignored after a change, while shaders compile and the new preset settles. */
const SETTLE = 3;

export interface GovernorFrame {
  /** A paused match: redraw rarely. */
  readonly paused: boolean;
  /** Whether this frame is representative of gameplay cost. */
  readonly measuring: boolean;
}

class FrameGovernor {
  /** Read by the presentation code: draw this frame or skip the GPU work. */
  draw = true;

  private sinceDraw = 0;
  private avg = 1 / 60;
  private slowFor = 0;
  private settle = SETTLE;
  private adaptive = false;
  private onSlow: (() => void) | null = null;
  private skipped = 0;
  private downgrades = 0;

  setAdaptive(on: boolean, onSlow: (() => void) | null): void {
    this.adaptive = on;
    this.onSlow = onSlow;
    this.slowFor = 0;
    this.settle = SETTLE;
  }

  /** After a quality change or anything else that will hitch. */
  settleFor(seconds = SETTLE): void {
    this.settle = Math.max(this.settle, seconds);
    this.slowFor = 0;
  }

  /** Once per displayed frame, before presenting. */
  begin(frameDt: number, f: GovernorFrame): void {
    /* No document.hidden check: a hidden tab gets no animation frames at all,
       so there is nothing to skip — and some embeds report hidden while the
       game is on screen, which would have drawn a black frame. */
    if (f.paused) {
      this.sinceDraw += frameDt;
      this.draw = this.sinceDraw >= 1 / PAUSED_FPS;
      if (this.draw) this.sinceDraw = 0;
      else this.skipped++;
      this.settle = SETTLE;                        // resuming is not a measurement
      return;
    }
    this.draw = true;
    this.sinceDraw = 0;

    if (!this.adaptive || !f.measuring || frameDt <= 0) {
      this.slowFor = 0;
      return;
    }
    if (this.settle > 0) {
      this.settle -= frameDt;
      this.avg = 1 / 60;
      return;
    }
    this.avg += (frameDt - this.avg) * 0.08;
    this.slowFor = this.avg > SLOW_FRAME ? this.slowFor + frameDt : Math.max(0, this.slowFor - frameDt * 2);
    if (this.slowFor >= SLOW_WINDOW) {
      this.slowFor = 0;
      this.settle = SETTLE * 2;
      this.downgrades++;
      this.onSlow?.();
    }
  }

  stats(): { adaptive: boolean; avgMs: number; slowFor: number; skipped: number; downgrades: number } {
    return {
      adaptive: this.adaptive,
      avgMs: +(this.avg * 1000).toFixed(1),
      slowFor: +this.slowFor.toFixed(2),
      skipped: this.skipped,
      downgrades: this.downgrades,
    };
  }
}

export const Governor = new FrameGovernor();
