import { storageGetJSON, storageSetJSON } from '../core/platform';

/*
  The live key table. Left hand on movement, right hand on attacks for Player
  1; Player 2 takes the arrow cluster plus the numpad, with , . / ' as a laptop
  fallback. Every action also answers to a gamepad button (see keyboard.ts).

  Remapping writes into this table rather than adding a translation layer in
  front of it, so nothing downstream has to know keys can move.
*/

export type Side = 'p1' | 'p2';
export type ActionId = 'left' | 'right' | 'jump' | 'block' | 'dash' | 'punch' | 'kick' | 'assist' | 'power';

export const KEY_ACTIONS: ReadonlyArray<{ readonly id: ActionId; readonly name: string }> = [
  { id: 'left', name: 'Move left' },
  { id: 'right', name: 'Move right' },
  { id: 'jump', name: 'Jump' },
  { id: 'block', name: 'Block' },
  { id: 'dash', name: 'Dash' },
  { id: 'punch', name: 'Light attack' },
  { id: 'kick', name: 'Heavy attack' },
  { id: 'assist', name: 'Assist' },
  { id: 'power', name: 'Overdrive' },
];

export interface PlayerBindings {
  readonly tag: string;
  readonly pad: 0 | 1;
  readonly keys: Record<ActionId, string[]>;
  /** Display labels for the on-screen legend, derived from `keys`. */
  readonly glyph: Record<ActionId, string>;
}

export const BINDINGS: Record<Side, PlayerBindings> = {
  p1: {
    tag: 'PLAYER 1', pad: 0,
    keys: { left: ['KeyA'], right: ['KeyD'], jump: ['KeyW'], block: ['KeyS'], dash: ['ShiftLeft'], punch: ['KeyJ'], kick: ['KeyK'], assist: ['KeyL', 'KeyR'], power: ['KeyI'] },
    glyph: { left: 'A', right: 'D', jump: 'W', block: 'S', dash: 'L-Shift', punch: 'J', kick: 'K', assist: 'L', power: 'I' },
  },
  p2: {
    tag: 'PLAYER 2', pad: 1,
    keys: {
      left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['ArrowUp'], block: ['ArrowDown'], dash: ['ShiftRight'],
      punch: ['Numpad1', 'Comma'], kick: ['Numpad2', 'Period'], assist: ['Numpad3', 'Slash'], power: ['Numpad0', 'Quote'],
    },
    glyph: { left: '←', right: '→', jump: '↑', block: '↓', dash: 'R-Shift', punch: '1', kick: '2', assist: '3', power: '0' },
  },
};

/** Keys whose browser default (scrolling, quick-find) must not fire during play. */
export const SWALLOW = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Slash', 'Period',
  'Quote', 'Comma', 'Enter', 'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3',
]);

type KeyMap = Record<Side, Record<ActionId, string[]>>;

function snapshot(): KeyMap {
  const out = { p1: {}, p2: {} } as KeyMap;
  for (const side of ['p1', 'p2'] as const) {
    for (const a of KEY_ACTIONS) out[side][a.id] = [...BINDINGS[side].keys[a.id]];
  }
  return out;
}

/* Taken at module load, before any saved map is applied: "restore defaults"
   has to mean the code's defaults, not whatever localStorage held. */
const KEY_DEFAULTS = snapshot();
const KEY_STORE = 'ashfall.keys';

/** A KeyboardEvent.code, as a person would read it off a keycap. */
export function keyLabel(code: string | undefined): string {
  if (!code) return '—';
  return code
    .replace(/^Key/, '')
    .replace(/^Digit/, '')
    .replace(/^Numpad/, 'Num ')
    .replace(/^Arrow/, '')
    .replace(/^Semicolon$/, ';')
    .replace(/^Quote$/, "'")
    .replace(/^Comma$/, ',')
    .replace(/^Period$/, '.')
    .replace(/^Slash$/, '/')
    .replace(/^Backslash$/, '\\')
    .replace(/^Minus$/, '-')
    .replace(/^Equal$/, '=')
    .replace(/^ShiftLeft$/, 'L-Shift')
    .replace(/^ShiftRight$/, 'R-Shift')
    .replace(/^Escape$/, 'Esc');
}

function syncGlyphs(): void {
  for (const side of ['p1', 'p2'] as const) {
    for (const a of KEY_ACTIONS) BINDINGS[side].glyph[a.id] = keyLabel(BINDINGS[side].keys[a.id][0]);
  }
}

function save(): void {
  storageSetJSON(KEY_STORE, snapshot());
}

export function loadKeys(): void {
  const map = storageGetJSON<Partial<KeyMap>>(KEY_STORE);
  if (!map?.p1 || !map.p2) return;
  for (const side of ['p1', 'p2'] as const) {
    for (const a of KEY_ACTIONS) {
      const v = map[side]?.[a.id];
      if (Array.isArray(v) && v.length && v.every((c) => typeof c === 'string')) BINDINGS[side].keys[a.id] = [...v];
    }
  }
  syncGlyphs();
}

/* Assigning a key that is already taken hands it over rather than letting two
   actions answer to it — a duplicate binding is never what anyone meant. */
export function assignKey(side: Side, action: ActionId, code: string): void {
  const prev = BINDINGS[side].keys[action][0] ?? null;
  for (const os of ['p1', 'p2'] as const) {
    for (const a of KEY_ACTIONS) {
      if (os === side && a.id === action) continue;
      const list = BINDINGS[os].keys[a.id];
      const at = list.indexOf(code);
      if (at === -1) continue;
      list.splice(at, 1);
      if (!list.length) BINDINGS[os].keys[a.id] = prev ? [prev] : [];
    }
  }
  BINDINGS[side].keys[action] = [code];
  // a newly bound key needs the same protection or it pages the window mid-match
  SWALLOW.add(code);
  syncGlyphs();
  save();
}

export function clearKey(side: Side, action: ActionId): void {
  BINDINGS[side].keys[action] = [];
  syncGlyphs();
  save();
}

export function resetKeys(): void {
  for (const side of ['p1', 'p2'] as const) {
    for (const a of KEY_ACTIONS) BINDINGS[side].keys[a.id] = [...KEY_DEFAULTS[side][a.id]];
  }
  syncGlyphs();
  save();
}
