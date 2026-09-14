import * as THREE from 'three/webgpu';

export const PAL = {
  voidc: 0x0b0809, bone: 0xede3d2,
  ember: 0xe2612b, hot: 0xffb454, spectre: 0x5bc8d8,
  strike: 0xff3b24, hurtbox: 0x4be08a, gold: 0xf0c24b,
} as const;

/* ── stage geometry and physics ───────────────────────────────────────── */
export const PLANE_Z = 0;
export const BOUND = 11.0;
export const MIN_GAP = 1.55;
export const GRAVITY = -26.0;
export const GROUND = 0.0;
export const ROUNDS_TO_WIN = 2;
export const SPAWN_X = [-3.4, 3.4] as const;

/* ── phases and state enums ───────────────────────────────────────────── */
export const PHASE = { TITLE: 'TITLE', SELECT: 'SELECT', FIGHT: 'FIGHT' } as const;
export type Phase = (typeof PHASE)[keyof typeof PHASE];

export const S = {
  IDLE: 'IDLE', WALK: 'WALK', JUMP: 'JUMP', PUNCH: 'PUNCH',
  KICK: 'KICK', BLOCK: 'BLOCK', HITSTUN: 'HITSTUN', KO: 'KO',
} as const;
export type FighterState = (typeof S)[keyof typeof S];

export const A = { DORMANT: 'DORMANT', RUSH: 'RUSH', STRIKE: 'STRIKE', RETREAT: 'RETREAT' } as const;
export type AssistState = (typeof A)[keyof typeof A];

/*
  The bot's behaviour was already spacing, strings, reaction-block and assist,
  but expressed as one priority cascade: you could not ask it what it was doing.
  These name the branch that won. Every threshold is unchanged.
*/
export const BOT_STATE = {
  STUNNED: 'STUNNED',    // hit, downed or the set is over: no input
  GUARD: 'GUARD',        // reacting to a committed swing
  ASSIST: 'ASSIST',      // meter is full and the summon is off cooldown
  RETREAT: 'RETREAT',    // low on health and too close
  PRESSURE: 'PRESSURE',  // running a queued attack string
  ANTIAIR: 'ANTIAIR',    // punishing a jump-in
  APPROACH: 'APPROACH',  // out of range, walking or dashing in
  SPACING: 'SPACING',    // in range, choosing when to commit
} as const;
export type BotState = (typeof BOT_STATE)[keyof typeof BOT_STATE];

/* ── camera framing ───────────────────────────────────────────────────── */
/* Fight camera distance. Pulled back from zBase 7.5 / zMin 7.6 / yBase 2.42:
   with the shorter KayKit cast the fight read too close, the fighters
   crowding the frame and the stage lost behind them. */
export const RIG = {
  zMin: 9.8, zMax: 22, zBase: 9.6, zPerGap: 0.94,
  yBase: 2.75, yPerGap: 0.085, xPull: 0.88,
  lambdaX: 4.2, lambdaZ: 3.0, lambdaY: 3.4, lambdaLook: 5.0,
} as const;

/* ── meter ────────────────────────────────────────────────────────────── */
export const METER = {
  max: 100, start: 50, regen: 3.0,
  perDamageDealt: 1.2, perDamageTaken: 0.6, perBlock: 6,
  assistCost: 50, assistCooldown: 6.0,
  powerCost: 100, powerDrain: 100 / 8, powerSpeedMul: 2.0,
} as const;

/* ── combat feel ──────────────────────────────────────────────────────────
   Hit-stop, trauma and lens kicks per kind of impact live in fx/juice.ts.
   This is only the shake's size: world units of travel and radians of roll
   at full trauma. */
export const SHAKE = { amount: 0.34, roll: 0.022 } as const;
/* Blown-out white after the hit-stop, counted in 120 Hz simulation steps: four
   steps is the two 60 Hz frames it was tuned as. */
export const FLASH_FRAMES = 4;
export const COMBO_WINDOW = 1.15;   // seconds of grace before a string is dropped

/* ── moves ────────────────────────────────────────────────────────────── */
export interface Move {
  readonly name: 'PUNCH' | 'KICK';
  readonly limb: 'fist' | 'foot';
  readonly startup: number;
  readonly active: number;
  readonly recovery: number;
  readonly damage: number;
  readonly knockback: number;
  readonly hitstun: number;
  readonly shake: number;
  /** startup + active + recovery */
  readonly total: number;
}

function move(m: Omit<Move, 'total'>): Move {
  return { ...m, total: m.startup + m.active + m.recovery };
}

export const MOVES = {
  PUNCH: move({ name: 'PUNCH', limb: 'fist', startup: 0.09, active: 0.07, recovery: 0.15, damage: 7, knockback: 2.2, hitstun: 0.34, shake: 0.55 }),
  KICK: move({ name: 'KICK', limb: 'foot', startup: 0.15, active: 0.10, recovery: 0.29, damage: 12, knockback: 9.4, hitstun: 0.38, shake: 0.95 }),
} as const;

export const HIT_RED = new THREE.Color(PAL.strike);
export const BLOCK_BLUE = new THREE.Color(PAL.spectre);

/*
  Light units. three.js r155 removed "legacy" lighting: punctual, ambient and
  hemisphere intensities used to be scaled by π inside the shaders, and now
  they are not. Every intensity in the theme table was tuned under the old
  convention, so it is multiplied by this once, where lights are written,
  instead of re-tuning seven stages' worth of numbers by eye.

  It is the documented conversion, not a perfect match: shadow softness,
  tone mapping and the bloom threshold also moved between r128 and r186, so
  the stages need a visual pass after the port.
*/
export const LEGACY_LIGHT_SCALE = Math.PI;
