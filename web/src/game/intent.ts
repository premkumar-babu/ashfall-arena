/*
  What a fighter wants to do this step, independent of who decided it. The
  keyboard, mouse, gamepad, touch screen and the CPU all produce one of these,
  and the state machine only ever reads this — which is why a human and the
  bot are guaranteed to be playing the same game.

  `move` and `dash` are -1 / 0 / 1. The *Down fields are buffered presses: true
  from the moment the button goes down until the state machine acts on it or
  the buffer window expires. Whatever the game acts on it marks in `consumed`,
  so one press can never fire twice.
*/

export const ACT = {
  JUMP: 1 << 0,
  PUNCH: 1 << 1,
  KICK: 1 << 2,
  ASSIST: 1 << 3,
  POWER: 1 << 4,
  DASH: 1 << 5,
} as const;

export interface Intent {
  move: number;
  dash: number;
  block: boolean;
  /** Jump is being held — longer hold, higher jump. */
  jumpHeld: boolean;
  jumpDown: boolean;
  punchDown: boolean;
  kickDown: boolean;
  assistDown: boolean;
  powerDown: boolean;
  /** ACT flags the game acted on this step. */
  consumed: number;
}

export function blankIntent(): Intent {
  return {
    move: 0, dash: 0, block: false, jumpHeld: false,
    jumpDown: false, punchDown: false, kickDown: false, assistDown: false, powerDown: false,
    consumed: 0,
  };
}
