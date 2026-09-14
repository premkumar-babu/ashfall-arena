import { gamepads, type MenuAction } from '../input/controller';
import { padMenuAction } from './front-end';

/*
  Gamepad navigation for everything outside the fight: title, menus, the
  select screen, pause and results. Without it a pad player had to reach for
  the keyboard to get into a match. Runs every simulation step after polling.
*/

const ACTIONS: readonly MenuAction[] = ['up', 'down', 'left', 'right', 'confirm', 'back', 'start'];

export function stepPadMenu(): void {
  for (const slot of [0, 1] as const) {
    const pad = gamepads.forSlot(slot);
    if (!pad) continue;
    for (const a of ACTIONS) if (pad.menu(a)) padMenuAction(slot, a);
  }
}
