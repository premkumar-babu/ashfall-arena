/*
  How each fighter moves, in the duel. One profile per fighter id, read by
  movement.ts (the numbers), fsm.ts (jump and dash launch) and pose.ts (the
  body language). RUSH keeps its own kits and ignores these.

  The four are tuned to be told apart by silhouette and rhythm alone:

    CINDERWARD  the baseline. Square, even footfalls, an honest arc.
    PALE VIGIL  a glide. Slow to start and slow to stop, long floaty jumps,
                a dash that carries. Tall and upright, with a slow stride.
    BRONZEMAW   a stomp. Heavy to start, hard to turn, hits the ground with a
                thud and is slow to get moving again. Low and wide.
    NOCTURNE    a weave. Instant starts, a quick fast cadence with a rolling
                drunken sway, a snappy hop and a very short dash.

  Attack speed is part of it too: Nocturne's blows come out a quarter faster,
  Pale Vigil's sabre takes longer to wind up as the price of its reach, and
  Bronzemaw is a touch slow on everything.
*/

export interface Gait {
  /** Ground start / stop / turn times in seconds, replacing MOVEMENT's for this fighter. */
  accelTime: number;
  stopTime: number;
  turnTime: number;
  /** Multiplier on gravity while airborne. Below 1 floats, above 1 drops. */
  gravity: number;
  /** Multiplier on jump launch speed, on top of DUEL_FEEL.jump. */
  jump: number;
  /** Gravity multiplier near the apex while jump is held. Lower hangs longer. */
  apexHang: number;
  /** Air steering as a fraction of walk speed in the duel. */
  airControl: number;
  /** Duel dash: speed, duration and cooldown in seconds. */
  dashSpeed: number;
  dashTime: number;
  dashCd: number;
  /** Seconds of slowed walking after a hard landing, scaled by fall speed. */
  landLag: number;
  /** Walk speed fraction while in landing lag. */
  landSlow: number;
  /** Camera trauma added on a landing, in addition to the shared one. */
  landThump: number;

  /** Stride cadence in radians per second, and how far the legs swing. */
  cadence: number;
  stride: number;
  /** How hard each footfall bobs the body. */
  bob: number;
  /** Side to side roll while moving, and while standing. */
  sway: number;
  idleSway: number;
  /** Breathing rate and depth while standing. */
  idleRate: number;
  idleDepth: number;
  /** How low the body sits at rest (units dropped, before scale). */
  stance: number;
  /** Extra splay of the legs, in radians, at rest. */
  splay: number;
  /** Forward lean while running, in radians at full speed. */
  runLean: number;
  /** Multiplier on the lean from accelerating and braking. */
  leanGain: number;
  /** Extra tilt when a jump leaves the ground, in radians. */
  jumpTuck: number;
  /** How fast this fighter's light and heavy play out, as a multiplier on the shared frame data. */
  lightSpeed: number;
  heavySpeed: number;
  /** How many further normals a landed hit can be cancelled into, in a row. The last one of the string ends it with a launch. */
  chainMax: number;
}

const BASE: Gait = {
  accelTime: 0.075, stopTime: 0.055, turnTime: 0.045,
  gravity: 1, jump: 1, apexHang: 0.72, airControl: 0.2,
  dashSpeed: 15.5, dashTime: 0.17, dashCd: 0.42,
  landLag: 0.05, landSlow: 0.5, landThump: 0,
  cadence: 10.5, stride: 0.85, bob: 0.10, sway: 0.028, idleSway: 0.18,
  idleRate: 2.1, idleDepth: 0.05, stance: 0, splay: 0, runLean: 0.07, leanGain: 1, jumpTuck: 0, chainMax: 2, lightSpeed: 1, heavySpeed: 1,
};

const GAITS: Record<string, Gait> = {
  cinderward: BASE,

  palevigil: {
    ...BASE,
    accelTime: 0.13, stopTime: 0.12, turnTime: 0.09,
    gravity: 0.9, jump: 1.02, apexHang: 0.5, airControl: 0.3,
    dashSpeed: 17.5, dashTime: 0.21, dashCd: 0.5,
    landLag: 0.03, landSlow: 0.7, landThump: 0,
    cadence: 8.2, stride: 0.7, bob: 0.05, sway: 0.012, idleSway: 0.08,
    idleRate: 1.5, idleDepth: 0.035, stance: -0.04, splay: -0.03, runLean: 0.12, leanGain: 1.3, jumpTuck: 0.05, chainMax: 3, lightSpeed: 1, heavySpeed: 0.8,
  },

  bronzemaw: {
    ...BASE,
    accelTime: 0.15, stopTime: 0.035, turnTime: 0.11,
    gravity: 1.12, jump: 1.08, apexHang: 0.9, airControl: 0.12,
    dashSpeed: 15, dashTime: 0.15, dashCd: 0.42,
    landLag: 0.16, landSlow: 0.2, landThump: 0.1,
    cadence: 7.0, stride: 1.0, bob: 0.2, sway: 0.05, idleSway: 0.26,
    idleRate: 1.6, idleDepth: 0.085, stance: 0.14, splay: 0.12, runLean: 0.1, leanGain: 0.7, jumpTuck: -0.04, chainMax: 1, lightSpeed: 0.95, heavySpeed: 0.9,
  },

  nocturne: {
    ...BASE,
    accelTime: 0.035, stopTime: 0.03, turnTime: 0.025,
    gravity: 1.1, jump: 1.04, apexHang: 0.6, airControl: 0.4,
    dashSpeed: 19.5, dashTime: 0.14, dashCd: 0.3,
    landLag: 0.02, landSlow: 0.8, landThump: 0,
    cadence: 13.5, stride: 0.95, bob: 0.13, sway: 0.075, idleSway: 0.42,
    idleRate: 3.1, idleDepth: 0.06, stance: 0.08, splay: 0.06, runLean: 0.15, leanGain: 1.6, jumpTuck: 0.1, chainMax: 4, lightSpeed: 1.28, heavySpeed: 1.18,
  },
};

export function gaitOf(id: string): Gait {
  return GAITS[id] ?? BASE;
}
