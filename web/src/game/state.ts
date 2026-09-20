import { PHASE, type Phase } from '../config/constants';
import { THEMES, restoreThemeIndex, type Theme } from '../config/themes';
import type { Fighter } from './fighter';

export type Difficulty = 'EASY' | 'NORMAL' | 'HARD';

export interface SelectSlot {
  fighter: number;
  assist: number;
  locked: boolean;
  row: number;
  col: number;
}

/*
  Shared, mutable game state.

  The monolith was one closure, so any section could reassign any variable.
  Parsing it found 22 bindings reassigned from outside the section that
  declared them. An ES module export cannot be reassigned by the module that
  imports it, so each of those went one of two ways:

    - owned by one module, with a function to change it — held keys belong
      to input, the camera tween to the camera, the composer to the post
      pipeline, the pixel size to the viewport;
    - genuinely cross-cutting, and so here, as properties of one object
      every module shares.

  Only the second kind lives in this file.
*/
class GameState {
  phase: Phase = PHASE.TITLE;
  themeIndex: number = restoreThemeIndex();
  mode1P = true;
  /** RUSH: the movement-only mode, where the only weapon is your own momentum (game/rush.ts). */
  rush = false;
  difficulty: Difficulty = 'NORMAL';
  postOn = false;

  /** Presentation seconds since boot. Drives ambient motion, never gameplay. */
  elapsed = 0;

  /** Assigned by buildRigs() before anything reads them. */
  P1!: Fighter;
  P2!: Fighter;
  /** Always [P1, P2]. Stored rather than derived because it is walked every simulation step. */
  fighters!: [Fighter, Fighter];

  readonly sel: [SelectSlot, SelectSlot] = [
    { fighter: 0, assist: 0, locked: false, row: 0, col: 0 },
    { fighter: 1, assist: 1, locked: false, row: 0, col: 1 },
  ];

  get theme(): Theme {
    return THEMES[this.themeIndex]!;
  }

  setFighters(p1: Fighter, p2: Fighter): void {
    this.P1 = p1;
    this.P2 = p2;
    this.fighters = [p1, p2];
  }
}

export const state = new GameState();
