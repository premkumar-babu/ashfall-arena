import { Sfx } from '../audio/sfx';
import type { Disposer } from '../core/disposal';

/*
  One focus model for every menu: the title menu, the modal (settings,
  controls, help, remap), the pause card, results and the goodbye card.

  The menus were mouse-first. The keyboard could start and resume but not
  pick a button, and a gamepad could not reach half of them. Here focus is the
  cursor: arrow keys or the d-pad move it through whatever is focusable in the
  overlay that is currently on top, Enter or A presses it, and left/right
  nudge a focused slider. A mouse moving over a button takes focus too, so
  there is only ever one highlighted control.

  Pure DOM, no game state: front-end.ts and match.ts decide when a menu opens
  and which control it should start on.
*/

/** Overlays in stacking order, top first: the modal can sit over the pause card. */
const MENUS: ReadonlyArray<readonly [bodyClass: string, selector: string]> = [
  ['modal', '#modal .mbox'],
  ['results', '#results .rbox'],
  ['bye', '#bye'],
  ['paused', '#pause'],
  ['titling', '#title .tmenu'],
];

const FOCUSABLE = 'button:not([disabled]), input[type="range"]:not([disabled])';

export function activeMenu(): HTMLElement | null {
  const body = document.body.classList;
  for (const [cls, sel] of MENUS) if (body.contains(cls)) return document.querySelector<HTMLElement>(sel);
  return null;
}

/** Visible, enabled controls in document order. tabindex="-1" opts a control out (inactive settings tabs). */
export function focusables(root: HTMLElement | null = activeMenu()): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.tabIndex >= 0 && !el.closest('[hidden]') && el.getClientRects().length > 0);
}

function focusEl(el: HTMLElement, ring: boolean): void {
  el.focus({ preventScroll: true, focusVisible: ring } as FocusOptions);
}

let pending = 0;

/**
 * Put focus on `target` (an id or element) once the overlay is showing, or on
 * its first control. Deferred a tick: the class change that reveals an overlay
 * has to land first, and a visibility:hidden element refuses focus.
 */
export function focusMenu(target?: string | HTMLElement | null): void {
  window.clearTimeout(pending);
  pending = window.setTimeout(() => {
    const list = focusables();
    const want = typeof target === 'string' ? document.getElementById(target) : target ?? null;
    const el = want && list.includes(want) ? want : list[0];
    if (el) focusEl(el, true);
  }, 0);
}

/** Drop focus from an overlay control, so Space in the fight never presses a button left focused. */
export function releaseFocus(): void {
  window.clearTimeout(pending);
  const el = document.activeElement;
  if (el instanceof HTMLElement && el.closest('#title, #modal, #pause, #results, #bye, #hud')) el.blur();
}

export function focusedInMenu(): HTMLElement | null {
  const root = activeMenu();
  const el = document.activeElement;
  return root && el instanceof HTMLElement && root.contains(el) ? el : null;
}

export function moveFocus(step: 1 | -1): boolean {
  const list = focusables();
  if (!list.length) return false;
  const i = list.indexOf(document.activeElement as HTMLElement);
  const next = list[i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length]!;
  focusEl(next, true);
  Sfx.uiMove();
  return true;
}

/** Press the focused button. False when nothing in the active menu has focus, so the caller can fall back. */
export function activateFocused(): boolean {
  const el = focusedInMenu();
  if (!(el instanceof HTMLButtonElement)) return false;
  el.click();
  return true;
}

/** Left/right on a focused slider: five steps, firing the same events a drag would. */
export function nudgeFocusedRange(step: 1 | -1): boolean {
  const el = focusedInMenu();
  if (!(el instanceof HTMLInputElement) || el.type !== 'range') return false;
  const unit = Number(el.step) > 0 ? Number(el.step) : 1;
  const next = Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + step * unit * 5));
  if (String(next) !== el.value) {
    el.value = String(next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}

export function isRangeFocused(): boolean {
  const el = focusedInMenu();
  return el instanceof HTMLInputElement && el.type === 'range';
}

/** A mouse over a menu control takes focus, without the keyboard ring. */
export function wireMenuPointer(disposer: Disposer): void {
  disposer.listen(document, 'pointerover', (ev) => {
    if (ev.pointerType !== 'mouse') return;
    const root = activeMenu();
    const el = (ev.target instanceof Element ? ev.target.closest(FOCUSABLE) : null) as HTMLElement | null;
    if (!root || !el || !root.contains(el) || el === document.activeElement || el.tabIndex < 0) return;
    focusEl(el, false);
  });
}
