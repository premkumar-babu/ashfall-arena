import { state } from '../game/state';
import { gamepads, input } from './controller';

/*
  Haptics: gamepad rumble and phone vibration on contact. The player who got
  hit feels it most; the player who landed it feels a lighter confirm. Only
  human-controlled slots buzz — the CPU's pad, if one is plugged in as P2,
  stays quiet in 1P mode.
*/

export type HitKind = 'light' | 'heavy' | 'block' | 'ko';

const RUMBLE: Readonly<Record<HitKind, { strong: number; weak: number; ms: number }>> = {
  light: { strong: 0.15, weak: 0.45, ms: 70 },
  heavy: { strong: 0.55, weak: 0.75, ms: 120 },
  block: { strong: 0.05, weak: 0.35, ms: 50 },
  ko: { strong: 1.0, weak: 0.8, ms: 320 },
};

const isHuman = (slot: number): boolean => slot === 0 || (slot === 1 && !state.mode1P);

/** The VIBRATION setting. Checked at the moment of contact, so switching it off mid-match is immediate. */
export const haptics = { on: true };

function buzz(slot: number, strong: number, weak: number, ms: number): void {
  if (!haptics.on) return;
  gamepads.rumble(slot, strong, weak, ms);
  // browsers refuse (and log) vibration before the page has had a real tap
  if (slot === 0 && input.touch?.active && navigator.userActivation?.hasBeenActive) {
    navigator.vibrate?.(Math.round(ms * 0.5));
  }
}

export function hitFeedback(attacker: number | null, defender: number, kind: HitKind): void {
  const r = RUMBLE[kind];
  if (isHuman(defender)) buzz(defender, r.strong, r.weak, r.ms);
  if (attacker !== null && attacker !== defender && isHuman(attacker)) {
    buzz(attacker, r.strong * 0.4, r.weak * 0.6, Math.round(r.ms * 0.7));
  }
}
