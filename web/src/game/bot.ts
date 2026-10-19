import { A, BOT_STATE, METER, MIN_GAP, S } from '../config/constants';
import type { Fighter } from './fighter';
import { attackPhase } from './fsm';
import { blankIntent, type Intent } from './intent';
import { specialReady } from './specials';
import { fatalReady } from './fatalblow';
import { match } from './match';
import { state, type Difficulty } from './state';

/*
  The CPU. A second state machine that only ever produces an Intent — exactly
  what the keyboard produces — so the bot drives its fighter through the
  identical pipeline a human does and cannot cheat on frame data.

  Difficulty scales how fast it thinks, how often it blocks on reaction, how
  willing it is to jump in or dash, and how hard its own blows land.
*/

interface BotTuning {
  reaction: number;
  range: number;
  slop: number;
  lowHealth: number;
  blockChance: number;
  gapMin: number;
  gapMax: number;
  thinkMin: number;
  thinkMax: number;
  hop: number;
  dash: number;
  antiAir: number;
  /** Chance per step of throwing the special from range. */
  special: number;
  shuffle: number;
  strings: number;
  damage: number;
  /** Chance a reaction block is timed late enough to be a parry. */
  parry: number;
  /** Chance per step of punishing a whiffed swing the moment it is in recovery. */
  punish: number;
  /** Chance a landed hit is cancelled into the special. */
  cancel: number;
}

type DifficultyTuning = Omit<BotTuning, 'reaction' | 'range' | 'slop' | 'lowHealth'>;

export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyTuning>> = {
  EASY: { blockChance: 0.08, gapMin: 0.44, gapMax: 1.05, thinkMin: 0.72, thinkMax: 1.70, hop: 0.10, dash: 0.01, antiAir: 0.01, special: 0.0012, shuffle: 0.05, strings: 2, damage: 0.72, parry: 0, punish: 0, cancel: 0 },
  NORMAL: { blockChance: 0.30, gapMin: 0.16, gapMax: 0.44, thinkMin: 0.22, thinkMax: 0.70, hop: 0.35, dash: 0.05, antiAir: 0.05, special: 0.004, shuffle: 0.015, strings: 3, damage: 1.00, parry: 0.06, punish: 0.04, cancel: 0.05 },
  HARD: { blockChance: 0.54, gapMin: 0.10, gapMax: 0.26, thinkMin: 0.13, thinkMax: 0.40, hop: 0.55, dash: 0.13, antiAir: 0.15, special: 0.008, shuffle: 0.01, strings: 4, damage: 1.15, parry: 0.34, punish: 0.2, cancel: 0.3 },
};

const BOT: BotTuning = { reaction: 0.12, range: 2.15, slop: 0.40, lowHealth: 30, ...DIFFICULTY.NORMAL };

/*
  Who the CPU is playing as changes how it plays, on top of the difficulty:
  the range it likes to stand at, how often it jumps, dashes, throws and
  reaches for the special, and how heavy its strings lean. The difficulty
  still decides how well it does all of it.
*/
interface Personality {
  range: number;
  hop: number;
  dash: number;
  special: number;
  throw: number;
  heavy: number;
  strings: number;
}

const PERSONALITY: Readonly<Record<string, Personality>> = {
  // a straight sword and a square stance: the baseline
  cinderward: { range: 2.4, hop: 1, dash: 1, special: 1, throw: 1, heavy: 0.4, strings: 0 },
  // the long sabre: stands off at the tip of the blade and zones with the special
  palevigil: { range: 2.85, hop: 1.1, dash: 0.7, special: 1.8, throw: 0.5, heavy: 0.55, strings: 0 },
  // the brute: walks you down, grabs a guard, leans on the heavy
  bronzemaw: { range: 1.95, hop: 0.45, dash: 1.4, special: 0.8, throw: 3, heavy: 0.5, strings: -1 },
  // the cutthroat: in and out, off the ground, long light strings
  nocturne: { range: 2.0, hop: 1.8, dash: 2.4, special: 1, throw: 1, heavy: 0.25, strings: 1 },
};
const NEUTRAL: Personality = { range: BOT.range, hop: 1, dash: 1, special: 1, throw: 1, heavy: 0.34, strings: 0 };

export function personalityOf(id: string): Personality {
  return PERSONALITY[id] ?? NEUTRAL;
}

export function isDifficulty(name: string | undefined): name is Difficulty {
  return name === 'EASY' || name === 'NORMAL' || name === 'HARD';
}

export function setDifficulty(name: Difficulty): void {
  state.difficulty = name;
  Object.assign(BOT, DIFFICULTY[name]);
}

/** Only the CPU's own blows are scaled — the player's numbers never move, whatever the setting. */
export function damageScale(att: Fighter): number {
  return state.mode1P && att === state.P2 ? BOT.damage : 1;
}

export function botIntent(f: Fighter, foe: Fighter, dt: number): Intent {
  const b = f.brain;
  const i = blankIntent();
  i.jumpHeld = true;                    // the CPU always commits to a full jump
  if (match.over || f.state === S.KO || f.state === S.HITSTUN) {
    b.state = BOT_STATE.STUNNED;
    b.lastFoeState = foe.state;
    return i;
  }

  b.t += dt;
  const P = personalityOf(f.def.id);
  const range = P.range;
  const dist = Math.abs(foe.x - f.x);
  const dir = foe.x > f.x ? 1 : -1;

  // reaction block, rolled once the moment the opponent commits to a swing
  const foeSwinging = foe.state === S.PUNCH || foe.state === S.KICK;
  if (foeSwinging && foe.state !== b.lastFoeState && dist < range + 1.3) {
    if (Math.random() < BOT.blockChance) {
      // a parry is a guard raised just before the blow connects; most reactions are early and plain
      const lead = foe.move ? foe.move.startup - foe.stateTime : 0.1;
      b.blockDelay = Math.random() < BOT.parry ? Math.max(0, lead - 0.045) : 0;
      b.blockFor = 0.40 + b.blockDelay;
      b.queue.length = 0;
    }
  }
  b.lastFoeState = foe.state;

  if (b.blockFor > 0) {
    b.state = BOT_STATE.GUARD;
    b.blockFor -= dt;
    if (b.blockDelay > 0) b.blockDelay -= dt;
    else i.block = true;
    return i;
  }

  // a swing that missed leaves its owner open: punish it before they recover
  if (foeSwinging && !foe.hitLanded && f.grounded && foe.move && attackPhase(foe) === 'recovery'
    && dist < range + 0.4 && Math.random() < BOT.punish) {
    b.state = BOT_STATE.PRESSURE;
    i.kickDown = true;
    return i;
  }

  // a landed hit can go straight into the special
  if (f.hitLanded && (f.state === S.PUNCH || f.state === S.KICK) && f.grounded && specialReady(f) && Math.random() < BOT.cancel * 0.06) {
    b.state = BOT_STATE.PRESSURE;
    i.specialDown = true;
    return i;
  }

  // a turtle gets thrown
  if (foe.state === S.BLOCK && f.grounded && dist < 2.0 && Math.random() < 0.05 * P.throw) {
    b.state = BOT_STATE.PRESSURE;
    i.punchDown = i.kickDown = true;
    return i;
  }

  // a fatal blow, when it is there and they are in reach
  // per 120 Hz step: about one try in two seconds while in range, not the instant it could
  if (fatalReady(f) && f.grounded && dist < 2.4 && Math.random() < 0.004) {
    b.state = BOT_STATE.PRESSURE;
    i.powerDown = true;
    return i;
  }

  // summon the moment the gauge tops out
  if (f.meter >= METER.max && f.assistCd <= 0 && f.assist?.state === A.DORMANT) {
    b.state = BOT_STATE.ASSIST;
    i.assistDown = true;
    return i;
  }

  // hurt: make space
  if (f.hp <= BOT.lowHealth && dist < 4.4) {
    b.state = BOT_STATE.RETREAT;
    i.move = -dir;
    if (dist < 2.2) i.block = true;
    return i;
  }

  // run a queued string
  if (b.queue.length) {
    if (b.gap > 0) {
      b.gap -= dt;
      return i;
    }
    if (dist > range + 0.6) {
      b.queue.length = 0;
    } else {
      b.state = BOT_STATE.PRESSURE;
      const next = b.queue.shift();
      if (next === 'P' || next === 'U') i.punchDown = true;
      else i.kickDown = true;
      if (next === 'U' || next === 'S') i.block = true;   // held guard: uppercut and sweep
      b.gap = BOT.gapMin + Math.random() * (BOT.gapMax - BOT.gapMin);
      return i;
    }
  }

  // punish a jump-in on the way down, or hop in itself
  // a jump-in, or a fighter still in the air from a launch, eats an uppercut
  if (!foe.grounded && dist < 3.2 && f.grounded && Math.random() < BOT.antiAir) {
    b.state = BOT_STATE.ANTIAIR;
    i.punchDown = true;
    i.block = true;
    return i;
  }
  if (f.grounded && dist > 4.6 && dist < 8.5 && b.t > b.nextHop && Math.random() < BOT.hop * P.hop) {
    b.nextHop = b.t + 2.4 + Math.random() * 3;
    i.jumpDown = true;
    i.move = dir;
    b.queue.push('P');                              // land into a swing
    return i;
  }
  if (!f.grounded && dist < 3.2 && Math.random() < 0.12) {
    i.punchDown = true;
    return i;
  }

  // from range, the special: a bolt, a spear, a charge or a step behind them
  if (f.grounded && dist > 3.6 && dist < 9.5 && specialReady(f) && Math.random() < BOT.special * P.special) {
    b.state = BOT_STATE.APPROACH;
    i.specialDown = true;
    return i;
  }

  // spacing
  if (dist > range + BOT.slop) {
    b.state = BOT_STATE.APPROACH;
    i.move = dir;
    // close a big gap with a dash rather than a slow walk
    if (dist > 5.2 && f.dashCd <= 0 && Math.random() < BOT.dash * P.dash) i.dash = dir;
  } else if (dist < MIN_GAP + 0.2) {
    b.state = BOT_STATE.RETREAT;
    i.move = -dir;
    // the light ones get out the quick way
    if (f.dashCd <= 0 && f.grounded && Math.random() < 0.02 * Math.max(0, P.dash - 1)) i.dash = -dir;
  } else if (b.t > b.nextThink) {
    b.state = BOT_STATE.SPACING;
    b.nextThink = b.t + BOT.thinkMin + Math.random() * (BOT.thinkMax - BOT.thinkMin);
    const n = Math.max(1, 1 + Math.floor(Math.random() * (BOT.strings + P.strings)));
    for (let k = 0; k < n; k++) b.queue.push(Math.random() < 1 - P.heavy ? 'P' : 'K');
    // strings end on a launcher or a sweep now and then
    const end = Math.random();
    if (end < 0.28) b.queue.push('U');
    else if (end < 0.42) b.queue.push('S');
  } else if (Math.random() < BOT.shuffle) {
    i.move = Math.random() < 0.5 ? 1 : -1;        // idle shuffle
  }
  return i;
}
