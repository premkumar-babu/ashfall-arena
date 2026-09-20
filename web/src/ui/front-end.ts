import { REVISION } from 'three/webgpu';
import { ASSETS } from '../assets/models';
import { Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { cycleCamView, requestCamTween, stopCamTween } from '../camera/camera-rig';
import { PHASE } from '../config/constants';
import type { Disposer } from '../core/disposal';
import { queryFlag } from '../core/platform';
import type { Viewport } from '../core/resize';
import type { PerfMonitor } from '../core/stats';
import { isDifficulty, setDifficulty } from '../game/bot';
import { hideResults, match, returnToSelect, startMatch } from '../game/match';
import { state, type Difficulty } from '../game/state';
import { debugBoxesOn, setDebugBoxes } from '../game/volumes';
import { startAmbience } from '../fx/juice';
import {
  assignKey, BINDINGS, clearKey, KEY_ACTIONS, keyLabel, resetKeys, SWALLOW, type ActionId, type Side,
} from '../input/bindings';
import { gamepads, input, keyboard, mouse, resetInput, type MenuAction } from '../input/controller';
import { TouchControls } from '../input/devices/touch-controls';
import { haptics } from '../input/feedback';
import { physics } from '../physics/port';
import { post } from '../render/post';
import { setShadowQuality } from '../render/stage';
import { cycleTheme } from '../render/theme';
import { Boot } from './boot-curtain';
import { maybeById } from './dom';
import { devText } from './hud';
import {
  activateFocused, focusedInMenu, focusMenu, isRangeFocused, moveFocus, nudgeFocusedRange, releaseFocus, wireMenuPointer,
} from './menu-nav';
import {
  detectQuality, isQualityChoice, lowerQuality, QUALITY_PRESETS, type Quality, type QualityChoice,
} from '../config/quality';
import { Governor } from '../core/frame-governor';
import { setLandscapeQuality } from '../world/landscape';
import { announce } from './announcer';
import { handleSelectKey, spaceAction, updateSelectUI } from './select';
import { DEFAULTS, loadSettings, settings, writeSettings, type ModalBack } from './settings';

/*
  Everything in front of the fight: the attract screen and menu, the modal
  that serves CONTROLS / SETTINGS / HELP / REMAP KEYS to both the title and the
  pause card, the pause card itself, results navigation, the 1P/2P and
  difficulty switches, and every keyboard shortcut.

  All of it drives functions that already exist rather than duplicating them,
  so a keyboard shortcut and its menu toggle are one switch seen from two
  places. Menu focus (arrow keys, d-pad, hover) is menu-nav.ts; this file only
  says which control a screen opens on. Every listener is registered through
  the Disposer, so tearing the game down leaves nothing attached to the window.
*/

let viewportRef: Viewport | null = null;
let perfRef: PerfMonitor | null = null;

/** `?dev` or `?stats` in the URL. Without it, H does nothing and no timing overlay can appear. */
const DEV_TOOLS = queryFlag('dev') || queryFlag('stats');

/* ── pause ──────────────────────────────────────────────────────────── */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.textContent = text;
  return n;
}

/* The pause card says where the match stands: score, round, clock. */
function fillPauseContext(): void {
  const box = maybeById('pctx');
  if (!box) return;
  const { P1, P2 } = state;
  const secs = Math.max(0, Math.ceil(match.time));
  box.replaceChildren(
    el('span', P1.def.name), el('b', `${P1.rounds} – ${P2.rounds}`), el('span', P2.def.name),
    el('i'), el('span', `ROUND ${match.round}`), el('i'), el('span', `${secs}s LEFT`),
  );
}

/* Esc pauses rather than abandoning: losing a match to a stray keypress with
   no way back was a bad trade for one keystroke saved. */
export function setPaused(on: boolean): void {
  if (state.phase !== PHASE.FIGHT || match.over) on = false;
  if (match.paused === on) return;
  match.paused = on;
  document.body.classList.toggle('paused', on);
  resetInput();                                   // never resume into a stuck key
  if (on) {
    fillPauseContext();
    focusMenu('presume');
    Sfx.ui();
  } else {
    releaseFocus();
    Sfx.uiBack();
  }
}

/* ── mode, difficulty, gamepads, debug ──────────────────────────────── */

function syncBotLabel(): void {
  devText('bot', state.mode1P ? `CPU ${state.difficulty}` : 'HUMAN');
}

/* RUSH is a different axis to 1P/2P: it changes what the match IS, not who
   plays it, so it gets its own switch rather than a third player button. */
function setRush(on: boolean): void {
  state.rush = on;
  maybeById('mrush')?.classList.toggle('on', on);
  maybeById('mduel')?.classList.toggle('on', !on);
  document.body.classList.toggle('rush', on);
  updateSelectUI();                                // the cards describe movement in RUSH, titles in DUEL
}

function setMode(one: boolean): void {
  state.mode1P = one;
  maybeById('m1p')?.classList.toggle('on', one);
  maybeById('m2p')?.classList.toggle('on', !one);
  document.body.classList.toggle('versus', !one);
  const tag = maybeById('tag1');
  if (tag) tag.textContent = one ? 'CPU' : 'P2';
  syncBotLabel();
  if (!one) state.sel[1].locked = false;
  updateSelectUI();
}

function syncDifficulty(name: Difficulty): void {
  setDifficulty(name);
  document.querySelectorAll<HTMLButtonElement>('#diffswitch button').forEach((b) => {
    b.classList.toggle('on', b.dataset.diff === name);
  });
  syncBotLabel();
}

export function refreshPads(): void {
  const n = gamepads.connectedCount;
  const txt = n
    ? `${n} GAMEPAD${n > 1 ? 'S' : ''} CONNECTED · D-PAD TO PICK · START TO FIGHT`
    : input.touch?.active ? 'TAP A CARD TO PICK' : 'CLICK A CARD OR STEER WITH A / D';
  const hint = maybeById('selhint');
  if (hint && hint.textContent !== txt) hint.textContent = txt;
}

function toggleDebug(): void {
  const on = !debugBoxesOn();
  setDebugBoxes(on);
  physics?.setDebugDraw(on);                      // collider wireframes ride with the hitboxes
  devText('dbg', on ? 'ON' : 'OFF', on ? 'on' : '');
}

/* ── render settings ────────────────────────────────────────────────── */

function syncPostLabel(): void {
  devText('post', post ? post.label() : 'UNAVAILABLE', post?.enabled ? 'gold' : '');
}

function setPost(on: boolean): void {
  post?.setEnabled(on && !!post);
  document.body.classList.toggle('nopost', !post?.enabled);
  syncPostLabel();
}

function setBloom(on: boolean): void {
  settings.bloomOn = on;
  post?.setBloomOn(on);
  syncPostLabel();
}

/* ── quality ────────────────────────────────────────────────────────────
   One preset (config/quality.ts) drives render scale, the post chain,
   shadows and scenery detail. AUTO starts from a device guess and the frame
   governor steps it down if frames run long; picking a preset turns that off. */

function currentBackend(): 'webgpu' | 'webgl2' {
  return document.querySelector<HTMLCanvasElement>('#stage canvas')?.dataset.backend === 'webgl2' ? 'webgl2' : 'webgpu';
}

function syncQualityUI(): void {
  const seg = maybeById('segQ');
  if (!seg) return;
  for (const b of Array.from(seg.children) as HTMLElement[]) {
    b.classList.toggle('on', b.dataset.q === settings.quality);
    if (b.dataset.q === 'auto') {
      b.textContent = settings.quality === 'auto' ? `AUTO · ${QUALITY_PRESETS[settings.level].label}` : 'AUTO';
    }
  }
}

function applyLevel(level: Quality): void {
  settings.level = level;
  const p = QUALITY_PRESETS[level];
  viewportRef?.setMaxPixelRatio(p.pixelRatio);
  post?.setQuality(level);
  setShadowQuality(level);
  setLandscapeQuality(p);
  Governor.settleFor();                            // the rebuild compiles shaders: do not judge those frames
  syncPostLabel();
  syncQualityUI();
}

/** AUTO only: frames have run long for several seconds. */
function stepDownAuto(): void {
  const next = lowerQuality(settings.level);
  if (!next || settings.quality !== 'auto') return;
  applyLevel(next);
  announce(`QUALITY ${QUALITY_PRESETS[next].label}`, 1100, 'toast');
}

function setQuality(choice: QualityChoice): void {
  settings.quality = choice;
  Governor.setAdaptive(choice === 'auto', stepDownAuto);
  applyLevel(choice === 'auto' ? detectQuality(currentBackend()) : choice);
}

function saveSettings(): void {
  writeSettings({
    sfx: Sfx.on, music: Music.playing, post: post?.enabled ?? false,
    quality: settings.quality, shake: settings.shakeOn, bloom: settings.bloomOn,
    volMaster: Sfx.masterVol, volSfx: Sfx.sfxVol, volMusic: Music.vol, volAmb: Sfx.ambVol, haptics: haptics.on,
  });
}

/* A range input gives CSS nothing to size, so the filled part of the track is
   a gradient whose stop is written here. */
function paintSlider(range: HTMLInputElement, out: HTMLElement | null): void {
  const min = Number(range.min);
  const max = Number(range.max);
  const pct = ((Number(range.value) - min) / (max - min)) * 100;
  range.style.setProperty('--pct', `${pct.toFixed(1)}%`);
  if (out) out.textContent = range.value;
}

function setSwitch(id: string, on: boolean): void {
  const b = maybeById(id);
  if (!b) return;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  const s = b.querySelector('span');
  if (s) s.textContent = on ? 'ON' : 'OFF';
}

function syncSlider(id: string, value: number): void {
  const range = maybeById<HTMLInputElement>(id);
  if (!range) return;
  range.value = String(Math.round(value * 100));
  paintSlider(range, maybeById(`${id}V`));
}

function syncSettingsUI(): void {
  setSwitch('swSfx', Sfx.on);
  setSwitch('swMusic', Music.playing);
  setSwitch('swPost', post?.enabled ?? false);
  setSwitch('swBloom', settings.bloomOn);
  setSwitch('swShake', settings.shakeOn);
  setSwitch('swHaptic', haptics.on);
  syncSlider('volMaster', Sfx.masterVol);
  syncSlider('volSfx', Sfx.sfxVol);
  syncSlider('volMusic', Music.vol);
  syncSlider('volAmb', Sfx.ambVol);
  syncQualityUI();
}

function resetSettings(): void {
  Sfx.init();                                     // a click is a gesture; sound comes back on with the reset
  if (!Sfx.on) Sfx.toggle();
  Sfx.setMaster(DEFAULTS.volMaster);
  Sfx.setSfx(DEFAULTS.volSfx);
  Music.setVolume(DEFAULTS.volMusic);
  Sfx.setAmbience(DEFAULTS.volAmb);
  setQuality(DEFAULTS.quality);
  setPost(DEFAULTS.post);
  setBloom(DEFAULTS.bloom);
  settings.shakeOn = DEFAULTS.shake;
  haptics.on = DEFAULTS.haptics;
  syncSettingsUI();
  saveSettings();
  Sfx.ui();
}

/* ── settings tabs ──────────────────────────────────────────────────── */

type SettingsTab = 'audio' | 'video' | 'controls';
const TABS: readonly SettingsTab[] = ['audio', 'video', 'controls'];
let settingsTab: SettingsTab = 'audio';

const isTab = (t: unknown): t is SettingsTab => TABS.includes(t as SettingsTab);

/* A roving tabindex: only the selected tab is in the focus order, so ↓ from
   it walks into its page rather than onto the next tab. ← / → change tab. */
function showSettingsTab(tab: SettingsTab): HTMLButtonElement | null {
  settingsTab = tab;
  let active: HTMLButtonElement | null = null;
  document.querySelectorAll<HTMLButtonElement>('#pane-settings .stab').forEach((b) => {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    if (on) active = b;
  });
  document.querySelectorAll<HTMLElement>('#pane-settings .spage').forEach((page) => {
    page.hidden = page.dataset.page !== tab;
  });
  return active;
}

/** ← / → while a settings tab has focus. */
function stepTab(step: 1 | -1): boolean {
  const focused = focusedInMenu();
  if (!focused?.classList.contains('stab')) return false;
  const next = TABS[(TABS.indexOf(settingsTab) + step + TABS.length) % TABS.length]!;
  const btn = showSettingsTab(next);
  btn?.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
  Sfx.ui();
  return true;
}

/* ── key remapping ──────────────────────────────────────────────────── */

let keyListening: { side: Side; action: ActionId; btn: HTMLButtonElement } | null = null;

function stopListening(): void {
  keyListening?.btn.classList.remove('listening');
  keyListening = null;
}

function buildKeyUI(): void {
  const body = maybeById('kbody');
  if (!body) return;
  body.replaceChildren();
  for (const a of KEY_ACTIONS) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = a.name;
    tr.appendChild(name);
    for (const side of ['p1', 'p2'] as const) {
      const td = document.createElement('td');
      const b = document.createElement('button');
      b.className = 'kbtn';
      b.type = 'button';
      b.textContent = keyLabel(BINDINGS[side].keys[a.id][0]);
      b.addEventListener('click', () => {
        if (keyListening?.btn === b) {
          stopListening();
          buildKeyUI();
          return;
        }
        stopListening();
        keyListening = { side, action: a.id, btn: b };
        b.classList.add('listening');
        b.textContent = 'press a key';
        Sfx.ui();
      });
      td.appendChild(b);
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

/* ── modal ──────────────────────────────────────────────────────────── */

type Pane = 'controls' | 'settings' | 'help' | 'keys';
const PANE_TITLE: Readonly<Record<Pane, string>> = { controls: 'CONTROLS', settings: 'SETTINGS', help: 'HELP', keys: 'REMAP KEYS' };

/** The control that opened the modal, so closing it puts the cursor back where it was. */
let modalOpener: HTMLElement | null = null;

function openModal(which: Pane, back?: ModalBack): void {
  if (!modalOpen()) modalOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  settings.modalBack = back ?? (state.phase === PHASE.FIGHT ? 'pause' : 'title');
  const title = maybeById('mtitle');
  if (title) title.textContent = PANE_TITLE[which];
  for (const p of Object.keys(PANE_TITLE) as Pane[]) {
    const pane = maybeById(`pane-${p}`);
    if (pane) pane.hidden = p !== which;
  }
  let start: HTMLElement | null = null;
  if (which === 'settings') {
    syncSettingsUI();
    start = showSettingsTab(settingsTab);
  }
  if (which === 'keys') {
    buildKeyUI();
    start = maybeById('kbody')?.querySelector<HTMLElement>('.kbtn') ?? null;
  }
  document.body.classList.add('modal');
  focusMenu(start);
  Sfx.ui();
}

function closeModal(): void {
  stopListening();
  document.body.classList.remove('modal');
  Sfx.uiBack();
  if (settings.modalBack === 'pause') setPaused(true);
  focusMenu(modalOpener);                         // back onto SETTINGS / CONTROLS, or the first control
  modalOpener = null;
}

const modalOpen = (): boolean => document.body.classList.contains('modal');

/* ── title ──────────────────────────────────────────────────────────── */

const TITLE_CLASSES = ['attract', 'titling', 'selecting', 'paused', 'modal', 'bye'] as const;

function toTitle(cls: 'attract' | 'titling' | 'bye'): void {
  stopCamTween();
  hideResults();
  state.phase = PHASE.TITLE;
  match.paused = false;
  document.body.classList.remove(...TITLE_CLASSES);
  document.body.classList.add(cls);
}

/* A tab cannot close itself unless script opened it, so QUIT says so gracefully. */
function showBye(): void {
  toTitle('bye');
  focusMenu('byeback');
  Sfx.ui();
}

function showAttract(): void {
  releaseFocus();
  toTitle('attract');
}

function showMenu(): void {
  toTitle('titling');
  const c = maybeById('tcast');
  if (c) c.textContent = `${ASSETS.cast.toUpperCase()} CAST`;
  focusMenu('mplay');
}

let audioStarted = false;

/* The first gesture that reaches the game starts everything that makes a
   sound: effects, the score (on unless the player turned it off last time)
   and the positional ambience. Once only; after that the switches own it. */
function startAudio(): void {
  Sfx.init();
  if (audioStarted || !Sfx.context) return;
  audioStarted = true;
  if (settings.wantSfx === false && Sfx.on) Sfx.toggle();
  if (settings.wantMusic !== false && !Music.playing) Music.start();
  settings.wantSfx = settings.wantMusic = undefined;
  startAmbience();
}

function leaveTitle(): void {
  releaseFocus();
  document.body.classList.remove('attract', 'titling', 'bye');
  state.phase = PHASE.SELECT;
  document.body.classList.add('selecting');

  /* Audio first and the tween last. Creating the AudioContext has to happen
     inside the gesture, and it blocks long enough to swallow the start of a
     time-based move. */
  startAudio();
  Sfx.ui();
  requestCamTween();
}

/** Back to the menu from a live match: unwind the match first so the select screen behind the title is clean. */
function toMainMenu(): void {
  if (state.phase === PHASE.FIGHT) returnToSelect();
  showMenu();
}

function restartMatch(): void {
  setPaused(false);
  startMatch();
  Sfx.ui();
}

function leaveResultsToSelect(): void {
  Sfx.ui();
  hideResults();
  returnToSelect();
}

/* ── keyboard ───────────────────────────────────────────────────────── */

function onGameKey(ev: KeyboardEvent): void {
  if (SWALLOW.has(ev.code)) ev.preventDefault();
  Sfx.init();
  if (!ev.repeat) {
    switch (ev.code) {
      case 'KeyB': toggleDebug(); break;
      case 'KeyM': Sfx.toggle(); break;
      case 'KeyP': setPost(!post?.enabled); break;
      case 'KeyC': announce('CAMERA · ' + cycleCamView(), 900, 'toast'); break;
      case 'KeyN': Music.toggle(); break;
      case 'KeyH':
        // developer overlays (frame data, CPU/GPU timings) are opt-in by URL, never a stray keypress
        if (DEV_TOOLS) {
          const on = document.body.classList.toggle('dev');
          perfRef?.toggle(on);
        }
        break;
      case 'KeyT':
        // stage themes cycle from anywhere, including mid-round
        cycleTheme(ev.shiftKey ? -1 : 1);
        return;
    }
  }
  if (state.phase === PHASE.FIGHT) {
    if (ev.code === 'Escape' && !ev.repeat) {
      setPaused(!match.paused);
      return;
    }
    if (match.paused) return;                      // the pause card's own keys are handled in capture
  }
  if (state.phase === PHASE.SELECT) {
    if (!ev.repeat) handleSelectKey(ev.code);
    return;
  }
  keyboard.down(ev.code);
}

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Space', 'Escape']);

/* Arrow keys through a menu. Returns true when the key was a navigation key it used. */
function navKey(ev: KeyboardEvent): boolean {
  switch (ev.code) {
    case 'ArrowUp': return moveFocus(-1);
    case 'ArrowDown': return moveFocus(1);
    case 'ArrowLeft': return stepTab(-1) || moveFocus(-1);
    case 'ArrowRight': return stepTab(1) || moveFocus(1);
    default: return false;
  }
}

function swallow(ev: KeyboardEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
}

/* Capture phase, so the title, the modal, pause, results and the remap
   listener answer before the match input does. Only navigation keys are
   taken; shortcuts like T and M still reach the game handler. */
function onOverlayKey(ev: KeyboardEvent): void {
  if (keyListening) {
    swallow(ev);
    const k = keyListening;
    stopListening();
    if (ev.code === 'Backspace') clearKey(k.side, k.action);
    else if (ev.code !== 'Escape') {
      assignKey(k.side, k.action, ev.code);
      Sfx.ui();
    }
    buildKeyUI();
    return;
  }

  const body = document.body.classList;

  if (modalOpen()) {
    if (!NAV_KEYS.has(ev.code)) return;
    ev.stopPropagation();                          // Space must not reach the game's preventDefault
    if (ev.code === 'Escape') {
      ev.preventDefault();
      closeModal();
      return;
    }
    // a focused slider keeps its native ← / →; Enter and Space press buttons natively
    if ((ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') && isRangeFocused()) return;
    if (ev.code === 'Enter' || ev.code === 'Space') return;
    if (navKey(ev)) ev.preventDefault();
    return;
  }

  if (body.contains('results')) {
    if (!NAV_KEYS.has(ev.code)) return;
    swallow(ev);
    if (ev.code === 'Escape') leaveResultsToSelect();
    else if (ev.code === 'Enter' || ev.code === 'Space') {
      if (!ev.repeat && !activateFocused()) leaveResultsToSelect();
    } else navKey(ev);
    return;
  }

  if (state.phase === PHASE.FIGHT && match.paused) {
    if (!NAV_KEYS.has(ev.code)) return;
    swallow(ev);
    if (ev.repeat) return;
    if (ev.code === 'Escape') setPaused(false);
    else if (ev.code === 'Enter' || ev.code === 'Space') {
      if (!activateFocused()) setPaused(false);
    } else navKey(ev);
    return;
  }

  if (state.phase !== PHASE.TITLE) return;

  ev.stopPropagation();
  if (body.contains('attract')) {
    if (ev.code === 'Escape') return;
    ev.preventDefault();
    startAudio();
    showMenu();
    return;
  }
  if (navKey(ev)) {
    ev.preventDefault();
    return;
  }
  switch (ev.code) {
    case 'Enter': case 'Space':
      ev.preventDefault();
      if (!ev.repeat && !activateFocused()) leaveTitle();
      break;
    case 'KeyC': ev.preventDefault(); openModal('controls', 'title'); break;
    case 'KeyS': ev.preventDefault(); openModal('settings', 'title'); break;
    case 'KeyH': ev.preventDefault(); openModal('help', 'title'); break;
    case 'Escape': ev.preventDefault(); showAttract(); break;
  }
}

/* ── gamepad menus ──────────────────────────────────────────────────────
   The same destinations the keyboard and mouse reach, from a pad: the d-pad
   moves the menu cursor, A presses, B backs out, Start starts or pauses, and
   on the select screen the d-pad moves whichever player's cursor it is. */

const SELECT_CODES: Readonly<Record<0 | 1, Partial<Record<MenuAction, string>>>> = {
  0: { left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', confirm: 'KeyJ' },
  1: { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', confirm: 'Numpad1' },
};

/** d-pad through the active menu; left/right adjust a focused slider or change settings tab first. */
function padNav(action: MenuAction): boolean {
  switch (action) {
    case 'up': return moveFocus(-1);
    case 'down': return moveFocus(1);
    case 'left': return nudgeFocusedRange(-1) || stepTab(-1) || moveFocus(-1);
    case 'right': return nudgeFocusedRange(1) || stepTab(1) || moveFocus(1);
    default: return false;
  }
}

export function padMenuAction(slot: 0 | 1, action: MenuAction): void {
  if (keyListening) return;
  if (modalOpen()) {
    if (action === 'back' || action === 'start') closeModal();
    else if (action === 'confirm') activateFocused();
    else padNav(action);
    return;
  }
  if (document.body.classList.contains('results')) {
    if (action === 'back') leaveResultsToSelect();
    else if (action === 'confirm' || action === 'start') {
      if (!activateFocused()) leaveResultsToSelect();
    } else padNav(action);
    return;
  }

  switch (state.phase) {
    case PHASE.TITLE: {
      const body = document.body.classList;
      if (body.contains('attract')) {
        showMenu();
        return;
      }
      if (action === 'confirm' || action === 'start') {
        if (!activateFocused()) leaveTitle();
      } else if (action === 'back') {
        if (body.contains('bye')) showMenu();
        else showAttract();
      } else padNav(action);
      return;
    }
    case PHASE.SELECT: {
      if (action === 'start') {
        spaceAction();
        return;
      }
      if (action === 'back') {
        // B unlocks a locked pick first; only an unlocked side backs out to the menu
        if (state.sel[slot].locked) handleSelectKey(SELECT_CODES[slot].confirm!);
        else toMainMenu();
        return;
      }
      const code = SELECT_CODES[slot][action];
      if (code) handleSelectKey(code);
      return;
    }
    case PHASE.FIGHT:
      if (!match.paused) {
        if (action === 'start') setPaused(true);
        return;
      }
      if (action === 'start' || action === 'back') setPaused(false);
      else if (action === 'confirm') {
        if (!activateFocused()) setPaused(false);
      } else padNav(action);
      return;
  }
}

/* ── wiring ─────────────────────────────────────────────────────────── */

export interface FrontEndContext {
  readonly disposer: Disposer;
  readonly viewport: Viewport;
  readonly perf: PerfMonitor;
}

export function wireFrontEnd({ disposer, viewport, perf }: FrontEndContext): void {
  viewportRef = viewport;
  perfRef = perf;
  disposer.defer(() => {
    viewportRef = null;
    perfRef = null;
    keyListening = null;
    modalOpener = null;
    audioStarted = false;
  });

  const stored = loadSettings();
  if (isQualityChoice(stored.quality)) settings.quality = stored.quality;
  if (typeof stored.shake === 'boolean') settings.shakeOn = stored.shake;
  if (typeof stored.volMaster === 'number') Sfx.setMaster(stored.volMaster);
  if (typeof stored.volSfx === 'number') Sfx.setSfx(stored.volSfx);
  if (typeof stored.volMusic === 'number') Music.setVolume(stored.volMusic);
  if (typeof stored.volAmb === 'number') Sfx.setAmbience(stored.volAmb);
  if (typeof stored.haptics === 'boolean') haptics.on = stored.haptics;
  setQuality(settings.quality);
  setPost(typeof stored.post === 'boolean' ? stored.post : true);
  setBloom(typeof stored.bloom === 'boolean' ? stored.bloom : true);
  // audio needs a gesture, so a remembered mute or track is held until PLAY provides one
  settings.wantSfx = stored.sfx;
  settings.wantMusic = stored.music;
  syncDifficulty(state.difficulty);

  const ver = maybeById('tver');
  if (ver) {
    const backend = document.querySelector<HTMLCanvasElement>('#stage canvas')?.dataset.backend;
    ver.textContent = `THREE.JS r${REVISION}${backend ? ` · ${backend.toUpperCase()}` : ''}`;
  }

  const click = (id: string, fn: () => void): void => {
    const node = maybeById(id);
    if (node) disposer.listen(node, 'click', fn);
  };

  // select screen
  click('m1p', () => { Sfx.ui(); setMode(true); });
  click('m2p', () => { Sfx.ui(); setMode(false); });
  click('mduel', () => { Sfx.ui(); setRush(false); });
  click('mrush', () => { Sfx.ui(); setRush(true); });
  document.querySelectorAll<HTMLButtonElement>('#diffswitch button').forEach((b) => {
    disposer.listen(b, 'click', () => {
      Sfx.ui();
      if (isDifficulty(b.dataset.diff)) syncDifficulty(b.dataset.diff);
    });
  });
  // walks the same steps the spacebar does, so a mouse-only player is never stuck
  click('startbtn', spaceAction);

  // title and modal
  click('mplay', leaveTitle);
  click('mctrl', () => openModal('controls', 'title'));
  click('mset', () => openModal('settings', 'title'));
  click('mhelp', () => openModal('help', 'title'));
  click('openKeys', () => openModal('keys', settings.modalBack));
  click('openCtrl', () => openModal('controls', settings.modalBack));
  click('kreset', () => { resetKeys(); buildKeyUI(); Sfx.ui(); });
  click('mquit', showBye);
  click('byeback', () => { Sfx.ui(); showMenu(); });
  click('mclose', closeModal);
  const modal = maybeById('modal');
  if (modal) disposer.listen(modal, 'click', (ev) => { if (ev.target === modal) closeModal(); });

  // results
  click('ragain', () => { Sfx.ui(); hideResults(); startMatch(); });
  click('rselect', leaveResultsToSelect);
  click('rmenu', () => { Sfx.ui(); hideResults(); toMainMenu(); });

  // pause card — the modal sits above it, so the match stays paused underneath
  click('hpause', () => setPaused(true));
  click('presume', () => setPaused(false));
  click('pquit', () => { setPaused(false); returnToSelect(); });
  click('prestart', restartMatch);
  click('pctrl', () => openModal('controls', 'pause'));
  click('pset', () => openModal('settings', 'pause'));
  click('phelp', () => openModal('help', 'pause'));
  click('pmenu', () => { Sfx.ui(); toMainMenu(); });

  // settings
  document.querySelectorAll<HTMLButtonElement>('#pane-settings .stab').forEach((b) => {
    disposer.listen(b, 'click', () => {
      if (!isTab(b.dataset.tab) || b.dataset.tab === settingsTab) return;
      showSettingsTab(b.dataset.tab);
      Sfx.ui();
    });
  });
  click('swSfx', () => { Sfx.toggle(); setSwitch('swSfx', Sfx.on); Sfx.ui(); saveSettings(); });
  click('swMusic', () => { Music.toggle(); setSwitch('swMusic', Music.playing); Sfx.ui(); saveSettings(); });
  click('swPost', () => { setPost(!post?.enabled); setSwitch('swPost', post?.enabled ?? false); Sfx.ui(); saveSettings(); });
  click('swShake', () => { settings.shakeOn = !settings.shakeOn; setSwitch('swShake', settings.shakeOn); Sfx.ui(); saveSettings(); });
  click('swBloom', () => { setBloom(!settings.bloomOn); setSwitch('swBloom', settings.bloomOn); Sfx.ui(); saveSettings(); });
  click('swHaptic', () => {
    haptics.on = !haptics.on;
    setSwitch('swHaptic', haptics.on);
    // a short confirm on the pad, so turning it on proves it works
    if (haptics.on) gamepads.rumble(0, 0.3, 0.6, 90);
    Sfx.ui();
    saveSettings();
  });
  click('sreset', resetSettings);

  /* `input` updates the sound live as the thumb moves; `change` is where the
     write happens, so dragging does not hammer localStorage. */
  const slider = (id: string, set: (v: number) => void): void => {
    const range = maybeById<HTMLInputElement>(id);
    if (!range) return;
    const out = maybeById(`${id}V`);
    disposer.listen(range, 'input', () => { set(Number(range.value) / 100); paintSlider(range, out); });
    disposer.listen(range, 'change', () => { Sfx.ui(); saveSettings(); });
    paintSlider(range, out);
  };
  slider('volMaster', (v) => Sfx.setMaster(v));
  slider('volSfx', (v) => Sfx.setSfx(v));
  slider('volMusic', (v) => Music.setVolume(v));
  slider('volAmb', (v) => Sfx.setAmbience(v));
  const seg = maybeById('segQ');
  if (seg) {
    for (const b of Array.from(seg.children) as HTMLElement[]) {
      disposer.listen(b, 'click', () => {
        if (isQualityChoice(b.dataset.q)) setQuality(b.dataset.q);
        Sfx.ui();
        saveSettings();
      });
    }
  }

  // nobody should have to watch a loading bar they are done with
  click('boot', () => Boot.skip());
  // a click anywhere on the attract screen is as good as a key
  click('title', () => {
    if (document.body.classList.contains('attract')) { startAudio(); showMenu(); }
  });

  // input
  wireMenuPointer(disposer);
  disposer.listen(window, 'keydown', onOverlayKey, true);
  disposer.listen(window, 'keydown', onGameKey);
  disposer.listen(window, 'keyup', (ev) => keyboard.up(ev.code));
  disposer.listen(window, 'blur', () => {
    resetInput();
    // alt-tabbing mid-round should cost you the tab, not the round
    if (state.phase === PHASE.FIGHT && !match.over) setPaused(true);
  });
  /* An AudioContext needs a gesture and a click is one. Hanging this off
     keydown alone once meant a mouse-only player fought in silence. */
  disposer.listen(window, 'pointerdown', () => { Sfx.init(); Sfx.resume(); }, { passive: true });
  /* A phone switching apps may never fire blur. Hidden means paused, and the
     audio clock stops, so a backgrounded tab costs neither the round nor battery. */
  disposer.listen(document, 'visibilitychange', () => {
    if (document.hidden) {
      if (state.phase === PHASE.FIGHT && !match.over) setPaused(true);
      Sfx.suspend();
    } else {
      Sfx.resume();
    }
  });
  disposer.listen(window, 'gamepadconnected', refreshPads);
  disposer.listen(window, 'gamepaddisconnected', refreshPads);

  // mouse buttons attack, and the touch overlay drives Player 1, only while a fight is live
  const fighting = (): boolean =>
    state.phase === PHASE.FIGHT && !match.paused && !document.body.classList.contains('results');
  mouse.attach(disposer, fighting);
  input.touch = new TouchControls(disposer, () => setPaused(true));
  disposer.defer(() => {
    input.touch = null;
  });
}
