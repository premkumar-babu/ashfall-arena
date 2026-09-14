/*
  A critically damped spring (the SmoothDamp integrator from Game Programming
  Gems 4, as popularised by Unity).

  Exponential damping — `damp()` — snaps its velocity the instant its target
  moves, which reads as a camera being yanked. A critically damped spring
  carries velocity, so it eases into a new target and settles with no
  overshoot. `smoothTime` is roughly how long it takes to cover most of the
  distance.
*/
export class Spring {
  velocity = 0;

  step(current: number, target: number, smoothTime: number, dt: number, maxSpeed = Infinity): number {
    if (dt <= 0) return current;
    const st = Math.max(0.0001, smoothTime);
    const omega = 2 / st;
    const x = omega * dt;
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);

    const maxChange = maxSpeed * st;
    const change = Math.max(-maxChange, Math.min(maxChange, current - target));
    const clampedTarget = current - change;

    const temp = (this.velocity + omega * change) * dt;
    this.velocity = (this.velocity - omega * temp) * decay;
    let out = clampedTarget + (change + temp) * decay;

    // never overshoot the real target
    if ((target - current > 0) === (out > target)) {
      out = target;
      this.velocity = (out - target) / dt;
    }
    return out;
  }

  reset(): void {
    this.velocity = 0;
  }
}
