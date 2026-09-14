import { ASSIST_ROSTER, ROSTER, type FighterDef } from '../config/roster';
import { THEMES } from '../config/themes';
import { ASSETS, switchCast, type CastName } from '../assets/models';
import { Sfx } from '../audio/sfx';
import { startMatch } from '../game/match';
import { state } from '../game/state';
import { applyTheme } from '../render/theme';
import { dom, maybeById } from './dom';

/* ── character select: cards, stats, stage picker, cast switch ─────────── */

const cardEls: [HTMLButtonElement[], HTMLButtonElement[]] = [[], []];
const chipEls: [HTMLButtonElement[], HTMLButtonElement[]] = [[], []];

export function buildSelectUI(): void {
  for (const s of [0, 1] as const) {
    const grid = maybeById(`grid${s}`);
    ROSTER.forEach((def, i) => {
      const b = document.createElement('button');
      b.className = 'card';
      b.dataset.index = String(i);
      b.style.setProperty('--acc', def.hex);
      b.innerHTML =
        '<span class="portrait"><span class="glyph"></span></span>' +
        `<span class="cmeta"><span class="cname">${def.name}</span><span class="ctitle">${def.title}</span></span>`;
      b.addEventListener('click', () => {
        const slot = state.sel[s];
        if (slot.fighter === i && !slot.locked) {
          setLock(s, true);
        } else {
          slot.locked = false;
          slot.fighter = i;
          slot.row = 0;
          slot.col = i;
          Sfx.ui();
        }
        updateSelectUI();
      });
      grid?.appendChild(b);
      cardEls[s].push(b);
    });

    const chips = maybeById(`chips${s}`);
    ASSIST_ROSTER.forEach((def, i) => {
      const b = document.createElement('button');
      b.className = 'chip-card';
      b.dataset.index = String(i);
      b.style.setProperty('--acc2', def.hex);
      b.innerHTML = `<b>${def.name.split(' ')[0]}</b><small>${def.pattern === 'leap' ? 'ORB' : 'SLAM'}</small>`;
      b.addEventListener('click', () => {
        const slot = state.sel[s];
        slot.locked = false;
        slot.assist = i;
        slot.row = 1;
        slot.col = i;
        Sfx.ui();
        updateSelectUI();
      });
      chips?.appendChild(b);
      chipEls[s].push(b);
    });
  }
}

/* Normalised against the roster's own spread rather than an absolute ceiling,
   so the bars show how the four compare — which is the only comparison a
   player is actually making. */
type StatKey = 'power' | 'speed' | 'reach' | 'jump';
const STAT_ROWS: ReadonlyArray<{ key: StatKey; label: string }> = [
  { key: 'power', label: 'PWR' },
  { key: 'speed', label: 'SPD' },
  { key: 'reach', label: 'RCH' },
  { key: 'jump', label: 'AIR' },
];

const STAT_RANGE = Object.fromEntries(
  STAT_ROWS.map(({ key }) => {
    const values = ROSTER.map((d) => d[key]);
    return [key, { lo: Math.min(...values), hi: Math.max(...values) }];
  }),
) as Record<StatKey, { lo: number; hi: number }>;

const statBars: [HTMLElement[], HTMLElement[]] = [[], []];

export function buildStats(): void {
  for (const s of [0, 1] as const) {
    const host = maybeById(`statbox${s}`);
    if (!host) continue;
    host.innerHTML = '';
    for (const row of STAT_ROWS) {
      const d = document.createElement('div');
      d.className = 'stat';
      d.innerHTML = `<b>${row.label}</b><i><s></s></i>`;
      host.appendChild(d);
      const bar = d.querySelector('s');
      if (bar instanceof HTMLElement) statBars[s].push(bar);
    }
  }
}

function syncStats(s: 0 | 1, def: FighterDef): void {
  STAT_ROWS.forEach((row, i) => {
    const bar = statBars[s][i];
    if (!bar) return;
    const rg = STAT_RANGE[row.key];
    const v = (def[row.key] - rg.lo) / (rg.hi - rg.lo || 1);
    bar.style.setProperty('--v', (0.20 + v * 0.80).toFixed(3));
  });
}

/* ── stage picker ─────────────────────────────────────────────────────── */

const themeBtns: HTMLButtonElement[] = [];

export function buildThemeUI(): void {
  const host = maybeById('themepick');
  if (!host) return;
  THEMES.forEach((t, i) => {
    const b = document.createElement('button');
    b.style.setProperty('--sw', t.swatch);
    b.title = `${t.name} — ${t.tag}`;
    b.setAttribute('aria-label', t.name);
    b.addEventListener('click', () => applyTheme(i));
    host.appendChild(b);
    themeBtns.push(b);
  });
}

export function syncThemeUI(): void {
  themeBtns.forEach((b, i) => b.classList.toggle('on', i === state.themeIndex));
  const tag = maybeById('themetag');
  if (tag) tag.textContent = `${state.theme.name} · ${state.theme.tag}`;
}

/* The cast switch reloads, so it is styled and worded as a mode, not a
   toggle: picking one is picking which files the next load fetches. */
const CAST_BLURB: Record<CastName, string> = {
  compact: 'KayKit Adventurers — one art style for every fighter and summon, 2 MB (default), reloads the page',
  classic: 'three.js demo models — mixed styles, 3 MB, reloads the page',
  authored: 'The authored cast — 146 MB, reloads the page',
};

export function buildCastUI(): void {
  document.querySelectorAll<HTMLButtonElement>('#castswitch button').forEach((b) => {
    const name = b.dataset.cast as CastName;
    b.classList.toggle('on', name === ASSETS.cast);
    b.title = CAST_BLURB[name] ?? 'reloads the page';
    b.addEventListener('click', () => {
      Sfx.ui();
      switchCast(name);
    });
  });
}

/* ── locking and navigation ───────────────────────────────────────────── */

export function setLock(s: 0 | 1, on: boolean): void {
  state.sel[s].locked = on;
  if (on) Sfx.lock();
}

export function updateSelectUI(): void {
  const sel = state.sel;
  if (state.mode1P) sel[1].locked = true;
  for (const s of [0, 1] as const) {
    const def = ROSTER[sel[s].fighter]!;
    const adef = ASSIST_ROSTER[sel[s].assist]!;
    dom.selSide[s].style.setProperty('--acc', def.hex);
    dom.selPick[s].textContent = def.name;
    dom.selSub[s].textContent = `${def.title} · ${adef.name}`;
    syncStats(s, def);

    cardEls[s].forEach((b, i) => {
      b.classList.toggle('sel', i === sel[s].fighter);
      b.classList.toggle('lock', i === sel[s].fighter && sel[s].locked);
    });
    chipEls[s].forEach((b, i) => b.classList.toggle('sel', i === sel[s].assist));

    dom.lock[s].classList.toggle('done', sel[s].locked);
    dom.lock[s].innerHTML = sel[s].locked
      ? `LOCKED IN — ${adef.name}`
      : `PRESS <kbd>${s === 0 ? 'J' : '1'}</kbd> TO LOCK IN`;
  }
  const ready = sel[0].locked && (state.mode1P || sel[1].locked);
  dom.startBtn.classList.toggle('ready', ready);
  dom.startBtn.textContent = ready
    ? 'PRESS SPACE TO START'
    : !sel[0].locked ? 'PRESS SPACE TO LOCK IN' : 'PLAYER 2 — PRESS SPACE';
}

type SelectAction = 'left' | 'right' | 'up' | 'down' | 'confirm';

const SELECT_KEYS: Readonly<Record<string, readonly [0 | 1, SelectAction]>> = {
  KeyA: [0, 'left'], KeyD: [0, 'right'], KeyW: [0, 'up'], KeyS: [0, 'down'], KeyJ: [0, 'confirm'],
  ArrowLeft: [1, 'left'], ArrowRight: [1, 'right'], ArrowUp: [1, 'up'], ArrowDown: [1, 'down'],
  Numpad1: [1, 'confirm'], Comma: [1, 'confirm'],
};

/** Returns true when the key was consumed by the select screen. */
export function handleSelectKey(code: string): boolean {
  if (code === 'Enter' || code === 'Space') {
    spaceAction();
    return true;
  }
  const mapped = SELECT_KEYS[code];
  if (!mapped) return false;
  const [s, act] = mapped;
  const st = state.sel[s];

  if (act === 'confirm') {
    setLock(s, !st.locked);
    updateSelectUI();
    return true;
  }

  st.locked = false;
  if (act === 'up') { st.row = 0; st.col = st.fighter; }
  if (act === 'down') { st.row = 1; st.col = st.assist; }
  if (act === 'left' || act === 'right') {
    const d = act === 'right' ? 1 : -1;
    const n = st.row === 0 ? ROSTER.length : ASSIST_ROSTER.length;
    st.col = (st.col + d + n) % n;
    if (st.row === 0) st.fighter = st.col;
    else st.assist = st.col;
  }
  Sfx.ui();
  updateSelectUI();
  return true;
}

export function spaceAction(): void {
  const sel = state.sel;
  if (!sel[0].locked) { setLock(0, true); updateSelectUI(); return; }
  if (!state.mode1P && !sel[1].locked) { setLock(1, true); updateSelectUI(); return; }
  startMatch();
}
