/*
  Control feel, in one place and in human units.

  Movement rates are written as TIMES rather than accelerations: "0.075 s from
  standstill to a full walk" can be reasoned about and tuned by feel, and it
  scales automatically with each fighter's own top speed and with Overdrive's
  doubled speed. The acceleration used is topSpeed / time.
*/

export const MOVEMENT = {
  /** Standstill → full walk. Short enough to read as instant, long enough not to look teleported. */
  accelTime: 0.075,
  /** Full walk → standstill when the stick is released. */
  stopTime: 0.055,
  /** Full walk one way → full walk the other. Faster than a stop: a turn-around is a deliberate input. */
  turnTime: 0.045,

  /** Fraction of walk speed the stick can steer in the air. */
  airControl: 0.45,
  /** Air steering toward the air-control speed. */
  airAccelTime: 0.16,
  /** How long a running jump's extra momentum takes to bleed off. Long, so jump-ins actually travel. */
  airDragTime: 0.9,

  /** Releasing jump while rising caps upward speed at this fraction of the launch speed. */
  jumpCut: 0.45,
  /** Gravity multiplier while holding down in the air, once past the rise. */
  fastFall: 1.65,
  /** Near the apex (|vy| below this) with jump held, gravity eases off... */
  apexHangVy: 1.8,
  /** ...to this fraction. A touch of hang time makes the arc readable without floating. */
  apexHang: 0.72,
  /** A jump pressed this soon after leaving the ground still counts. */
  coyoteTime: 0.08,
} as const;

export const INPUT = {
  /** A press stays live this long, so an attack pressed just before recovery ends still comes out. */
  buffer: 0.10,
  dashBuffer: 0.08,
  /** The second tap of a double-tap dash has to land inside this window. */
  dashTap: 0.26,

  /** Radial stick deadzone, rescaled so movement starts smoothly at its edge. */
  stickDeadzone: 0.24,
  /** Horizontal engage / release thresholds. The gap stops a stick resting near the edge from chattering. */
  stickOn: 0.50,
  stickOff: 0.32,
  /** Vertical (jump / block) engage / release thresholds. */
  stickUpOn: 0.62,
  stickUpOff: 0.42,
  /** Analog trigger travel that counts as a press. */
  trigger: 0.30,

  /** On-screen stick travel in CSS pixels. */
  touchRadius: 56,
  touchDeadzone: 0.28,
} as const;
