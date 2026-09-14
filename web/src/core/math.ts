/** Clamp `v` into [lo, hi]. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Frame-rate independent approach: moves `cur` toward `goal` so the remaining
 * gap shrinks by e^(−lambda·dt). A fixed `lerp(cur, goal, k)` per frame moves
 * twice as far per second at 120 Hz as at 60 Hz; this does not, which is why
 * every camera, light and HUD ease in the game is written with it.
 */
export function damp(cur: number, goal: number, lambda: number, dt: number): number {
  return goal + (cur - goal) * Math.exp(-lambda * dt);
}

export function easeOut(x: number): number {
  return 1 - (1 - x) * (1 - x);
}
