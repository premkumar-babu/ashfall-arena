import { A, BOT_STATE, METER, MIN_GAP, S } from '../config/constants';
import type { Fighter } from './fighter';
import { blankIntent, type Intent } from './intent';
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
  shuffle: number;
  strings: number;
  damage: number;
}

type DifficultyTuning = Omit<BotTuning, 'reaction' | 'range' | 'slop' | 'lowHealth'>;

export const DIFFICULTY: Readonly<Record<Difficulty, DifficultyTuning>> = {
  EASY: { blockChance: 0.08, gapMin: 0.44, gapMax: 1.05, thinkMin: 0.72, thinkMax: 1.70, hop: 0.10, dash: 0.01, antiAir: 0.01, shuffle: 0.05, strings: 2, damage: 0.72 },
  NORMAL: { blockChance: 0.30, gapMin: 0.16, gapMax: 0.44, thinkMin: 0.22, thinkMax: 0.70, hop: 0.35, dash: 0.05, antiAir: 0.05, shuffle: 0.015, strings: 3, damage: 1.00 },
  HARD: { blockChance: 0.54, gapMin: 0.10, gapMax: 0.26, thinkMin: 0.13, thinkMax: 0.40, hop: 0.55, dash: 0.13, antiAir: 0.15, shuffle: 0.01, strings: 4, damage: 1.15 },
};

const BOT: BotTuning = { reaction: 0.12, range: 2.15, slop: 0.40, lowHealth: 30, ...DIFFICULTY.NORMAL };

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
  const dist = Math.abs(foe.x - f.x);
  const dir = foe.x > f.x ? 1 : -1;

  // reaction block, rolled once the moment the opponent commits to a swing
  const foeSwinging = foe.state === S.PUNCH || foe.state === S.KICK;
  if (foeSwinging && foe.state !== b.lastFoeState && dist < BOT.range + 1.3) {
    if (Math.random() < BOT.blockChance) {
      b.blockFor = 0.40;
      b.queue.length = 0;
    }
  }
  b.lastFoeState = foe.state;

  if (b.blockFor > 0) {
    b.state = BOT_STATE.GUARD;
    b.blockFor -= dt;
    i.block = true;
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
    if (dist > BOT.range + 0.6) {
      b.queue.length = 0;
    } else {
      b.state = BOT_STATE.PRESSURE;
      if (b.queue.shift() === 'P') i.punchDown = true;
      else i.kickDown = true;
      b.gap = BOT.gapMin + Math.random() * (BOT.gapMax - BOT.gapMin);
      return i;
    }
  }

  // punish a jump-in on the way down, or hop in itself
  if (!foe.grounded && dist < 3.6 && f.grounded && Math.random() < BOT.antiAir) {
    b.state = BOT_STATE.ANTIAIR;
    i.kickDown = true;
    return i;
  }
  if (f.grounded && dist > 4.6 && dist < 8.5 && b.t > b.nextHop && Math.random() < BOT.hop) {
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

  // spacing
  if (dist > BOT.range + BOT.slop) {
    b.state = BOT_STATE.APPROACH;
    i.move = dir;
    // close a big gap with a dash rather than a slow walk
    if (dist > 5.2 && f.dashCd <= 0 && Math.random() < BOT.dash) i.dash = dir;
  } else if (dist < MIN_GAP + 0.2) {
    b.state = BOT_STATE.RETREAT;
    i.move = -dir;
  } else if (b.t > b.nextThink) {
    b.state = BOT_STATE.SPACING;
    b.nextThink = b.t + BOT.thinkMin + Math.random() * (BOT.thinkMax - BOT.thinkMin);
    const n = 1 + Math.floor(Math.random() * BOT.strings);
    for (let k = 0; k < n; k++) b.queue.push(Math.random() < 0.66 ? 'P' : 'K');
  } else if (Math.random() < BOT.shuffle) {
    i.move = Math.random() < 0.5 ? 1 : -1;        // idle shuffle
  }
  return i;
}
