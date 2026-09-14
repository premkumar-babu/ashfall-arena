/*
  Fixed-timestep loop with interpolated presentation.

  The single-file build stepped everything once per displayed frame with a
  variable dt capped at 50 ms. That made combat depend on the monitor: an
  attack's 0.07 s active window was four frames at 60 Hz and seventeen at
  240 Hz, and one slow frame could carry a hitbox straight past a hurtbox
  without the two ever overlapping on a sampled frame.

  Now the simulation — movement, attack phases, posing (the hitboxes hang off
  the posed rig), collision, the bot, hit-stop, assists — advances in fixed
  steps regardless of display rate. The same input produces the same match
  everywhere.

  Presentation — the camera, ambient and impact particles, the HUD, the draw —
  runs once per displayed frame on real elapsed time, and receives `alpha`,
  how far the clock sits between the last two simulation steps, for anything
  that wants to blend a simulated value rather than step at the sim rate.
*/

export interface LoopHandlers {
  /** One fixed simulation step. `dt` is always `loop.dt`. */
  update(dt: number): void;
  /**
   * One displayed frame. `alpha` in [0, 1) is the fraction of a simulation
   * step elapsed since the last update; `frameDt` is real seconds since the
   * previous frame, clamped to `maxFrame`.
   */
  render(alpha: number, frameDt: number): void;
}

/** Anything that owns the frame clock. WebGPURenderer does, and must: it schedules frames against its own device. */
export interface AnimationLoopHost {
  setAnimationLoop(callback: ((time: number) => void) | null): unknown;
}

export class FixedStepLoop {
  /** Seconds per simulation step. */
  readonly dt: number;

  /**
   * The longest real frame the loop will account for. A tab that was in the
   * background for a minute resumes with one clamped frame, rather than trying
   * to simulate the whole minute before it draws again.
   */
  maxFrame = 0.25;

  /**
   * The most simulation steps in one displayed frame. When a device cannot
   * keep up, the loop sheds the backlog instead of spiralling: each late frame
   * would otherwise schedule more work for the next, which is later still.
   */
  maxSteps = 10;

  /** Scales simulated time; 0 freezes the simulation while frames keep drawing. */
  timeScale = 1;

  private accumulator = 0;
  private last: number | null = null;
  private host: AnimationLoopHost | null = null;
  private stepCount = 0;
  private droppedTime = 0;

  constructor(private readonly handlers: LoopHandlers, hz = 120) {
    if (!(hz > 0) || !Number.isFinite(hz)) throw new RangeError(`hz must be a positive number, got ${hz}`);
    this.dt = 1 / hz;
  }

  get running(): boolean {
    return this.host !== null;
  }

  /** Total simulation steps taken since construction. */
  get steps(): number {
    return this.stepCount;
  }

  /** Simulated seconds discarded because frames fell further behind than `maxSteps` could absorb. */
  get shed(): number {
    return this.droppedTime;
  }

  start(host: AnimationLoopHost): void {
    if (this.host) return;
    this.host = host;
    this.last = null;
    this.accumulator = 0;
    host.setAnimationLoop(this.frame);
  }

  stop(): void {
    if (!this.host) return;
    this.host.setAnimationLoop(null);
    this.host = null;
  }

  private readonly frame = (timeMs: number): void => {
    const now = timeMs / 1000;
    const frameDt = this.last === null ? 0 : Math.min(Math.max(now - this.last, 0), this.maxFrame);
    this.last = now;

    this.accumulator += frameDt * this.timeScale;

    let n = 0;
    while (this.accumulator >= this.dt && n < this.maxSteps) {
      this.handlers.update(this.dt);
      this.accumulator -= this.dt;
      n++;
      this.stepCount++;
    }
    if (n === this.maxSteps && this.accumulator >= this.dt) {
      const keep = this.accumulator % this.dt;
      this.droppedTime += this.accumulator - keep;
      this.accumulator = keep;
    }

    this.handlers.render(this.accumulator / this.dt, frameDt);
  };
}
