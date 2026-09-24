import { ROSTER } from '../config/roster';
import { Sfx } from '../audio/sfx';
import type { Fighter } from '../game/fighter';
import { RUSH_KITS } from '../game/rush';
import { state } from '../game/state';

/*
  The versus screen.

  Two fighters, their colours split down a slash, and VS between them, held
  for a couple of seconds before the round is called. It is the beat that
  tells you who you are about to fight, and in this genre it is as much a part
  of a match as the round call.

  The faces are the select screen's own portraits, read off the cards, so
  there is nothing to render here and the art always matches the fighter.
*/

let el: HTMLElement | null = null;
let outTimer = 0;
let offTimer = 0;

function portraitOf(slot: 0 | 1, id: string): string {
  const i = ROSTER.findIndex((d) => d.id === id);
  const node = document.querySelector<HTMLElement>(`#grid${slot} .card[data-index="${i}"] .portrait`);
  return node?.style.backgroundImage ?? '';
}

function side(f: Fighter, s: 0 | 1): string {
  const sub = state.rush ? (RUSH_KITS[f.def.id]?.blurb ?? f.def.title) : f.def.title;
  const face = portraitOf(s, f.def.id);
  return `<div class="vs-side s${s}" style="--acc:${f.def.hex};--lite:${f.def.lite};--dim:${f.def.dim}">` +
    `<div class="vs-face"${face ? ` style="background-image:${face.replace(/"/g, "'")}"` : ''}></div>` +
    `<div class="vs-plate"><b>${f.def.name}</b><span>${sub.toUpperCase()}</span></div></div>`;
}

export function showVersus(a: Fighter, b: Fighter, ms: number): void {
  if (!el) {
    el = document.createElement('div');
    el.id = 'versus';
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
  }
  el.innerHTML = `${side(a, 0)}<div class="vs-mark">VS</div>${side(b, 1)}`;
  el.classList.remove('on', 'out');
  void el.offsetWidth;                  // restart the keyframes
  el.classList.add('on');
  Sfx.whoosh();
  window.setTimeout(() => Sfx.bass(0.8), 380);
  window.clearTimeout(outTimer);
  window.clearTimeout(offTimer);
  outTimer = window.setTimeout(() => el?.classList.add('out'), Math.max(0, ms - 380));
  offTimer = window.setTimeout(() => el?.classList.remove('on', 'out'), ms);
}

export function hideVersus(): void {
  window.clearTimeout(outTimer);
  window.clearTimeout(offTimer);
  el?.classList.remove('on', 'out');
}
