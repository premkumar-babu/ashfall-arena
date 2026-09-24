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
export const SPAWN_X = [-2.7, 2.7] as const;

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
/* Framed the way the genre's current games frame a fight: in close and at
   chest height, so at footsie range two fighters fill well over half the
   height of the screen and the stage behind them falls into soft focus. The
   rig still pulls back as they separate. (C cycles to a WIDE view for anyone
   who wants the stage.) */
export const RIG = {
  zMin: 7.8, zMax: 18, zBase: 6.7, zPerGap: 0.55,
  yBase: 2.25, yPerGap: 0.06, xPull: 0.92,
  lambdaX: 4.2, lambdaZ: 3.0, lambdaY: 3.4, lambdaLook: 5.0,
} as const;

/* ── meter ────────────────────────────────────────────────────────────── */
/* Paced so a summon is a moment rather than a rhythm: none at the bell, and
   a long lockout after each, the way the genre spaces its assist characters.
   Summons every few seconds made them most of the damage in a round. */
export const METER = {
  max: 100, start: 25, regen: 2.2,
  perDamageDealt: 0.9, perDamageTaken: 0.5, perBlock: 5,
  assistCost: 50, assistCooldown: 14.0,
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
  readonly name: 'PUNCH' | 'KICK' | 'UPPERCUT' | 'SWEEP' | 'SPECIAL' | 'FATAL' | 'THROW';
  readonly limb: 'fist' | 'foot';
  readonly startup: number;
  readonly active: number;
  readonly recovery: number;
  readonly damage: number;
  readonly knockback: number;
  readonly hitstun: number;
  readonly shake: number;
  /** Upward speed given to a grounded victim: the move launches or trips. */
  readonly launch?: number;
  /** The fighter's special: no limb hitbox, the move's effect is game/specials.ts. */
  readonly special?: boolean;
  /** startup + active + recovery */
  readonly total: number;
}

function move(m: Omit<Move, 'total'>): Move {
  return { ...m, total: m.startup + m.active + m.recovery };
}

export const MOVES = {
  PUNCH: move({ name: 'PUNCH', limb: 'fist', startup: 0.09, active: 0.07, recovery: 0.15, damage: 7, knockback: 2.2, hitstun: 0.34, shake: 0.55 }),
  KICK: move({ name: 'KICK', limb: 'foot', startup: 0.15, active: 0.10, recovery: 0.29, damage: 12, knockback: 9.4, hitstun: 0.38, shake: 0.95 }),
  /* Hold guard and press punch: the uppercut. Slow to come out and badly
     punished on a whiff, but it launches, and a launched fighter can be hit
     again on the way down. It is also the answer to a jump-in. */
  UPPERCUT: move({ name: 'UPPERCUT', limb: 'fist', startup: 0.13, active: 0.09, recovery: 0.42, damage: 14, knockback: 1.8, hitstun: 1.2, shake: 1.25, launch: 14.5 }),
  /* Hold guard and press kick: the sweep. Low and quick, and it takes their
     feet: a short trip that ends with them on the floor. */
  SWEEP: move({ name: 'SWEEP', limb: 'foot', startup: 0.12, active: 0.10, recovery: 0.36, damage: 9, knockback: 3.4, hitstun: 0.9, shake: 0.9, launch: 6.0 }),
  /* Back, forward + light: each fighter's special (game/specials.ts). The
     timing is shared; what comes out on the active frame is theirs. */
  /* OVERDRIVE below 30% health: the fatal blow (game/fatalblow.ts). Like a
     special it has no limb hitbox; the lunge and the cinematic are its own. */
  /* Light and heavy together, up close: the throw (game/throws.ts). No hitbox —
     the grab is a range check, and it goes straight through a guard. */
  THROW: move({ name: 'THROW', limb: 'fist', startup: 0.1, active: 0.2, recovery: 0.45, damage: 0, knockback: 0, hitstun: 0, shake: 0, special: true }),
  FATAL: move({ name: 'FATAL', limb: 'fist', startup: 0.28, active: 0.16, recovery: 0.7, damage: 0, knockback: 0, hitstun: 0, shake: 0, special: true }),
  SPECIAL: move({ name: 'SPECIAL', limb: 'fist', startup: 0.2, active: 0.08, recovery: 0.4, damage: 0, knockback: 0, hitstun: 0, shake: 0, special: true }),
} as const;

/** Juggles: how high an airborne victim is popped by a follow-up, and how many follow-ups before gravity wins. */
export const JUGGLE = { pop: 7.2, maxHits: 3, damage: 0.8, knockdown: 0.55 } as const;

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
