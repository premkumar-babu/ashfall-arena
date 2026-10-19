import { METER, S } from '../config/constants';
import type { Fighter } from './fighter';
import { attackPhase, attackRate } from './fsm';
import { blankIntent, type Intent } from './intent';
import { match } from './match';
import { state } from './state';

/*
  TRAINING: P2 is a dummy you can set to stand, guard, or fight back; both
  health bars refill, the clock is stopped and the meter is always full. A
  panel shows the inputs P1 is pressing and the frame data of the last move,
  in 60 Hz frames (the unit the genre quotes), including the advantage on hit.
*/

export type Dummy = 'STAND' | 'GUARD' | 'CPU';
const DUMMIES: readonly Dummy[] = ['STAND', 'GUARD', 'CPU'];
const FPS = 60;
const LOG_LEN = 9;

interface InputToken { sym: string; frames: number }
interface FrameData {
  name: string;
  startup: number;
  active: number;
  recovery: number;
  damage: number;
  result: string;
}

export const training = {
  dummy: 'STAND' as Dummy,
  /** Last step's refill: health returns a moment after the last blow, never mid-string. */
  idle: 0,
};

let log: InputToken[] = [];
let last: FrameData | null = null;
let armed = false;
let panel: HTMLElement | null = null;
let inputsEl: HTMLElement | null = null;
let dataEl: HTMLElement | null = null;
let dummyEl: HTMLElement | null = null;
let paint = 0;

export function cycleDummy(): Dummy {
  training.dummy = DUMMIES[(DUMMIES.indexOf(training.dummy) + 1) % DUMMIES.length]!;
  return training.dummy;
}

/** What P2 does when it is not the CPU. */
export function dummyIntent(): Intent {
  const i = blankIntent();
  if (training.dummy === 'GUARD') i.block = true;
  return i;
}

function ensurePanel(): void {
  if (panel) return;
  panel = document.createElement('div');
  panel.id = 'training';
  panel.innerHTML = '<div class="tr-head">TRAINING <span id="tr-dummy"></span><em>V: DUMMY</em></div>'
    + '<div id="tr-inputs" class="tr-inputs"></div><div id="tr-data" class="tr-data"></div>';
  document.body.appendChild(panel);
  inputsEl = panel.querySelector('#tr-inputs');
  dataEl = panel.querySelector('#tr-data');
  dummyEl = panel.querySelector('#tr-dummy');
}

export function resetTraining(): void {
  log = [];
  last = null;
  armed = false;
  training.idle = 0;
  ensurePanel();
}

export function hideTraining(): void {
  panel?.classList.remove('on');
}

function arrow(move: number, face: number, block: boolean, jump: boolean): string {
  // relative to the fighter: forward is toward the opponent, whichever side they stand
  const h = move === 0 ? 0 : move * face;
  const v = block ? 'd' : jump ? 'u' : '';
  const sym: Record<string, string> = { '0': '', '1': '→', '-1': '←' };
  const hs = sym[String(h)]!;
  if (v === 'd') return h === 0 ? '↓' : h > 0 ? '↘' : '↙';
  if (v === 'u') return h === 0 ? '↑' : h > 0 ? '↗' : '↖';
  return hs || '·';
}

function pushInput(sym: string): void {
  const top = log[0];
  if (top && top.sym === sym) top.frames += 1;
  else {
    log.unshift({ sym, frames: 1 });
    if (log.length > LOG_LEN) log.pop();
  }
}

function resultText(att: Fighter, vic: Fighter): string {
  const m = att.move;
  if (!m) return '';
  const atkLeft = Math.max(0, m.total - att.stateTime) / attackRate(att, m);
  if (vic.state === S.BLOCK) return `BLOCKED · attacker recovers ${Math.round(atkLeft * FPS)}f`;
  const stun = Math.max(0, vic.stunTime - vic.stateTime);
  const adv = Math.round((stun - atkLeft) * FPS);
  return `HIT · ${adv >= 0 ? '+' : ''}${adv} on hit${vic.launched ? ' · LAUNCH' : ''}`;
}

/** Once per simulation step, after combat has resolved. */
export function stepTraining(P1: Fighter, P2: Fighter, i1: Intent): void {
  ensurePanel();
  panel!.classList.add('on');
  match.time = 99;

  for (const f of state.fighters) {
    f.meter = METER.max;
    f.assistCd = 0;
  }
  // refill a moment after the last blow so a string can be seen to the end; never let a blow kill
  const hurt = P1.state === S.HITSTUN || P2.state === S.HITSTUN || P1.combo > 0 || P2.combo > 0;
  training.idle = hurt ? 0 : training.idle + 1 / 120;
  for (const f of state.fighters) {
    if (f.hp < 45 || (training.idle > 1.2 && f.hp < 100)) f.hp = 100;
  }

  const held = arrow(i1.move, P1.face, i1.block, i1.jumpHeld);
  const btn = (i1.punchDown ? 'L' : '') + (i1.kickDown ? 'H' : '') + (i1.dash ? 'D' : '') + (i1.specialDown ? 'S' : '');
  pushInput(btn ? `${held}+${btn}` : held);

  // frame data of whatever P1 last committed to
  if ((P1.state === S.PUNCH || P1.state === S.KICK) && P1.move && !P1.move.special) {
    if (!armed || P1.stateTime < 1 / 120 + 1e-6) {
      const m = P1.move;
      const heavy = m.name === 'KICK';
      const rate = attackRate(P1, m);
      last = {
        name: heavy ? P1.def.heavy : m.name,
        startup: Math.round((m.startup / rate) * FPS), active: Math.round((m.active / rate) * FPS), recovery: Math.round((m.recovery / rate) * FPS),
        damage: Math.round(m.damage * P1.def.power * (heavy ? P1.def.heavyMul : 1)),
        result: 'WHIFF',
      };
      armed = true;
    }
    if (last && P1.hitLanded && last.result === 'WHIFF') last.result = resultText(P1, P2);
  } else if (P1.state !== S.PUNCH && P1.state !== S.KICK) {
    armed = false;
  }
  if (last && attackPhase(P1) === null) { /* keep showing the last move */ }

  if (++paint % 6 !== 0) return;
  if (dummyEl) dummyEl.textContent = training.dummy;
  if (inputsEl) {
    inputsEl.innerHTML = log.map((t) => `<div><b>${t.sym}</b><i>${t.frames > 99 ? '99+' : Math.ceil(t.frames / 2)}</i></div>`).join('');
  }
  if (dataEl) {
    dataEl.innerHTML = last
      ? `<b>${last.name}</b> ${last.damage} dmg<br>startup ${last.startup}f · active ${last.active}f · recovery ${last.recovery}f<br>${last.result}`
      : 'Land a move to see its frame data';
  }
}
