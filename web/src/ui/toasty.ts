import { say } from '../audio/voice';
import { settings } from './settings';

/*
  TOASTY!

  The second game in the series this one is chasing had someone pop up in the
  corner of the screen after an uppercut and shout it. In a game called
  Ashfall the one who pops up is a little ember. Rare on purpose — a joke that
  happens every time stops being one.
*/

const CHANCE = 1 / 7;
let el: HTMLElement | null = null;
let timer = 0;
let last = -1e9;

export function maybeToasty(): void {
  if (Math.random() > CHANCE) return;
  const now = performance.now();
  if (now - last < 20000) return;                 // never twice in a row
  last = now;
  if (!el) {
    el = document.createElement('div');
    el.id = 'toasty';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<i class="ember"><i></i><i></i><i></i></i><b>TOASTY!</b>';
    document.body.appendChild(el);
  }
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
  if (settings.voiceOn) say('Toasty!', 1.9, 1.15);
  window.clearTimeout(timer);
  timer = window.setTimeout(() => el?.classList.remove('on'), 1300);
}
