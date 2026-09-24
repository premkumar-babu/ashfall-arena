import { BOT_STATE, type BotState, type FighterState } from '../config/constants';

/** Punch, kick, and the two held-guard moves: uppercut and sweep. */
export type QueuedAttack = 'P' | 'K' | 'U' | 'S';

/** Per-fighter memory for the CPU. Every fighter carries one; only the CPU side reads it. */
export interface Brain {
  queue: QueuedAttack[];
  gap: number;
  blockFor: number;
  nextThink: number;
  nextHop: number;
  t: number;
  lastFoeState: FighterState | null;
  state: BotState;
}

export function createBrain(): Brain {
  return {
    queue: [], gap: 0, blockFor: 0, nextThink: 0, nextHop: 1.5, t: 0,
    lastFoeState: null, state: BOT_STATE.SPACING,
  };
}
