import { ASSIST_ROSTER, ROSTER } from '../config/roster';
import { createAssist, type Assist } from './assist-rig';
import { createFighter, type Fighter } from './fighter';
import { state } from './state';

/*
  Every rig is built up front: two independent sets, one per side, so a mirror
  match is possible. Picking a fighter only changes which rig is visible —
  nothing is constructed or compiled when the player changes their mind on the
  select screen.
*/
export const rigs: [Fighter[], Fighter[]] = [[], []];
export const assistRigs: [Assist[], Assist[]] = [[], []];

export function buildRigs(): void {
  for (const slot of [0, 1] as const) {
    for (const def of ROSTER) rigs[slot].push(createFighter(def, slot));
    for (const def of ASSIST_ROSTER) assistRigs[slot].push(createAssist(def, slot));
  }

  // the defaults the select screen opens on: P1 Cinderward + Emberwraith,
  // P2 Pale Vigil + Carrion Idol
  state.setFighters(rigs[0][0]!, rigs[1][1]!);
  bindAssist(state.P1, assistRigs[0][0]!);
  bindAssist(state.P2, assistRigs[1][1]!);
}

export function bindAssist(fighter: Fighter, assist: Assist): void {
  fighter.assist = assist;
  assist.owner = fighter;
}

export function resetRigs(): void {
  rigs[0].length = 0;
  rigs[1].length = 0;
  assistRigs[0].length = 0;
  assistRigs[1].length = 0;
}
