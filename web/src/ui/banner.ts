import type { Fighter } from '../game/fighter';

/*
  Side banners: a short label that slides in under the attacker's health bar
  for a moment — FIRST HIT, and whatever else earns one. Two, one per side,
  so both players' moments can be on screen at once.
*/

const els: [HTMLElement | null, HTMLElement | null] = [null, null];
const timers = [0, 0];

export function banner(side: 0 | 1, text: string, ms = 1500): void {
  let el = els[side];
  if (!el) {
    el = document.createElement('div');
    el.className = `sidebanner s${side}`;
    el.setAttribute('aria-hidden', 'true');
    document.getElementById('hud')?.appendChild(el);
    els[side] = el;
  }
  el.textContent = text;
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
  window.clearTimeout(timers[side]);
  timers[side] = window.setTimeout(() => el?.classList.remove('on'), ms);
}

export function firstHit(f: Fighter): void {
  banner(f.slot === 0 ? 0 : 1, 'FIRST HIT');
}

export function clearBanners(): void {
  for (const el of els) el?.classList.remove('on');
}
