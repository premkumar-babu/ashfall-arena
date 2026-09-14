import { ASSETS } from '../assets/models';
import { Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { requestCamTween, stopCamTween } from '../camera/camera-rig';
import { PHASE } from '../config/constants';
import type { Disposer } from '../core/disposal';
import type { Viewport } from '../core/resize';
import type { PerfMonitor } from '../core/stats';
import { isDifficulty, setDifficulty } from '../game/bot';
import { hideResults, match, returnToSelect, startMatch } from '../game/match';
import { state, type Difficulty } from '../game/state';
import { debugBoxesOn, setDebugBoxes } from '../game/volumes';
import {
  assignKey, BINDINGS, clearKey, KEY_ACTIONS, keyLabel, resetKeys, SWALLOW, type ActionId, type Side,
} from '../input/bindings';
import { gamepads, input, keyboard, mouse, resetInput, type MenuAction } from '../input/controller';
import { TouchControls } from '../input/devices/touch-controls';
import { physics } from '../physics/port';
import { post } from '../render/post';
import { setShadowQuality } from '../render/stage';
import { cycleTheme } from '../render/theme';
import { Boot } from './boot-curtain';
import { maybeById } from './dom';
import { devText } from './hud';
import { handleSelectKey, spaceAction, updateSelectUI } from './select';
import { isQuality, loadSettings, QUALITY, settings, writeSettings, type ModalBack, type Quality } from './settings';

/*
  Everything in front of the fight: the attract screen and menu, the modal
  that serves CONTROLS / SETTINGS / HELP / REMAP KEYS to both the title and the
  pause card, the pause card itself, the 1P/2P and difficulty switches, and
  every keyboard shortcut.

  All of it drives functions that already exist rather than duplicating them,
  so a keyboard shortcut and its menu toggle are one switch seen from two
  places. Every listener is registered through the Disposer, so tearing the
  game down leaves nothing attached to the window.
*/

let viewportRef: Viewport | null = null;
let perfRef: PerfMonitor | null = null;

/* ── pause ──────────────────────────────────────────────────────────── */

/* Esc pauses rather than abandoning: losing a match to a stray keypress with
   no way back was a bad trade for one keystroke saved. */
export function setPaused(on: boolean): void {
  if (state.phase !== PHASE.FIGHT || match.over) on = false;
  if (match.paused === on) return;
  match.paused = on;
  document.body.classList.toggle('paused', on);
  resetInput();                                   // never resume into a stuck key
  if (on) Sfx.ui();
}

/* ── mode, difficulty, gamepads, debug ──────────────────────────────── */

function syncBotLabel(): void {
  devText('bot', state.mode1P ? `CPU ${state.difficulty}` : 'HUMAN');
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

/** Render scale, applied as a device-pixel-ratio cap through the viewport, which resizes everything that depends on it. */
function setQuality(q: Quality): void {
  settings.quality = q;
  viewportRef?.setMaxPixelRatio(QUALITY[q]);
  // quality also picks the post chain (AO, AA, depth of field) and the shadow budget
  post?.setQuality(q);
  setShadowQuality(q);
  syncPostLabel();
  const seg = maybeById('segQ');
  if (seg) for (const b of Array.from(seg.children) as HTMLElement[]) b.classList.toggle('on', b.dataset.q === q);
}

function saveSettings(): void {
  writeSettings({
    sfx: Sfx.on, music: Music.playing, post: post?.enabled ?? false,
    quality: settings.quality, shake: settings.shakeOn, bloom: settings.bloomOn,
    volMaster: Sfx.masterVol, volSfx: Sfx.sfxVol,
  });
}

/* A range input gives CSS nothing to size, so the filled part of the track is
   a gradient whose stop is written here. */
function paintSlider(input: HTMLInputElement, out: HTMLElement | null): void {
  const min = Number(input.min);
  const max = Number(input.max);
  const pct = ((Number(input.value) - min) / (max - min)) * 100;
  input.style.setProperty('--pct', `${pct.toFixed(1)}%`);
  if (out) out.textContent = input.value;
}

function setSwitch(id: string, on: boolean): void {
  const b = maybeById(id);
  if (!b) return;
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  const s = b.querySelector('span');
  if (s) s.textContent = on ? 'ON' : 'OFF';
}

function syncSettingsUI(): void {
  setSwitch('swSfx', Sfx.on);
  setSwitch('swMusic', Music.playing);
  setSwitch('swPost', post?.enabled ?? false);
  setSwitch('swBloom', settings.bloomOn);
  setSwitch('swShake', settings.shakeOn);
  const vm = maybeById<HTMLInputElement>('volMaster');
  const vs = maybeById<HTMLInputElement>('volSfx');
  if (vm) { vm.value = String(Math.round(Sfx.masterVol * 100)); paintSlider(vm, maybeById('volMasterV')); }
  if (vs) { vs.value = String(Math.round(Sfx.sfxVol * 100)); paintSlider(vs, maybeById('volSfxV')); }
  setQuality(settings.quality);
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

function openModal(which: Pane, back?: ModalBack): void {
  settings.modalBack = back ?? (state.phase === PHASE.FIGHT ? 'pause' : 'title');
  const title = maybeById('mtitle');
  if (title) title.textContent = PANE_TITLE[which];
  for (const p of Object.keys(PANE_TITLE) as Pane[]) {
    const pane = maybeById(`pane-${p}`);
    if (pane) pane.hidden = p !== which;
  }
  if (which === 'settings') syncSettingsUI();
  if (which === 'keys') buildKeyUI();
  document.body.classList.add('modal');
  Sfx.ui();
}

function closeModal(): void {
  document.body.classList.remove('modal');
  Sfx.ui();
  if (settings.modalBack === 'pause') setPaused(true);
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
  Sfx.ui();
}

function showAttract(): void {
  toTitle('attract');
}

function showMenu(): void {
  toTitle('titling');
  const c = maybeById('tcast');
  if (c) c.textContent = `${ASSETS.cast.toUpperCase()} CAST`;
}

function leaveTitle(): void {
  document.body.classList.remove('attract', 'titling', 'bye');
  state.phase = PHASE.SELECT;
  document.body.classList.add('selecting');

  /* Audio first and the tween last. Creating the AudioContext has to happen
     inside the gesture, and it blocks long enough to swallow the start of a
     time-based move. */
  Sfx.init();
  if (settings.wantSfx === false && Sfx.on) Sfx.toggle();
  settings.wantSfx = undefined;                    // applied once; the switch owns it now
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

/* ── keyboard ───────────────────────────────────────────────────────── */

function onGameKey(ev: KeyboardEvent): void {
  if (SWALLOW.has(ev.code)) ev.preventDefault();
  Sfx.init();
  if (!ev.repeat) {
    switch (ev.code) {
      case 'KeyB': toggleDebug(); break;
      case 'KeyM': Sfx.toggle(); break;
      case 'KeyP': setPost(!post?.enabled); break;
      case 'KeyN': Music.toggle(); break;
      case 'KeyH': {
        const on = document.body.classList.toggle('dev');
        perfRef?.toggle(on);                       // the frame-time overlay rides with the dev panel
        break;
      }
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
    if (match.paused) {
      if (!ev.repeat && (ev.code === 'Space' || ev.code === 'Enter')) setPaused(false);
      return;                                      // nothing else reaches a paused fight
    }
  }
  if (state.phase === PHASE.SELECT) {
    if (!ev.repeat) handleSelectKey(ev.code);
    return;
  }
  keyboard.down(ev.code);
}

/* Capture phase, so the title, the modal and the remap listener answer before
   the match input does. Nothing falls through to the fight while an overlay is up. */
function onOverlayKey(ev: KeyboardEvent): void {
  if (keyListening) {
    ev.preventDefault();
    ev.stopPropagation();
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
  if (modalOpen()) {
    if (ev.code === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeModal();
    }
    return;
  }
  if (document.body.classList.contains('results')) {
    if (ev.code === 'Escape' || ev.code === 'Enter' || ev.code === 'Space') {
      ev.preventDefault();
      ev.stopPropagation();
      hideResults();
      returnToSelect();
    }
    return;
  }
  if (state.phase !== PHASE.TITLE) return;

  ev.stopPropagation();
  if (document.body.classList.contains('attract')) {
    if (ev.code === 'Escape') return;
    ev.preventDefault();
    Sfx.init();
    showMenu();
    return;
  }
  switch (ev.code) {
    case 'Enter': case 'Space': ev.preventDefault(); leaveTitle(); break;
    case 'KeyC': ev.preventDefault(); openModal('controls', 'title'); break;
    case 'KeyS': ev.preventDefault(); openModal('settings', 'title'); break;
    case 'KeyH': ev.preventDefault(); openModal('help', 'title'); break;
    case 'Escape': ev.preventDefault(); showAttract(); break;
  }
}

/* ── gamepad menus ──────────────────────────────────────────────────────
   The same destinations the keyboard and mouse reach, from a pad: A confirms,
   B backs out, Start starts or pauses, the d-pad or stick moves the select
   cursor for whichever player's pad it is. */

const SELECT_CODES: Readonly<Record<0 | 1, Partial<Record<MenuAction, string>>>> = {
  0: { left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS', confirm: 'KeyJ' },
  1: { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown', confirm: 'Numpad1' },
};

export function padMenuAction(slot: 0 | 1, action: MenuAction): void {
  if (keyListening) return;
  if (modalOpen()) {
    if (action === 'back' || action === 'start') closeModal();
    return;
  }
  if (document.body.classList.contains('results')) {
    if (action === 'confirm' || action === 'start' || action === 'back') {
      Sfx.ui();
      hideResults();
      returnToSelect();
    }
    return;
  }

  switch (state.phase) {
    case PHASE.TITLE: {
      const body = document.body.classList;
      if (body.contains('attract') || body.contains('bye')) {
        showMenu();
        return;
      }
      if (action === 'confirm' || action === 'start') leaveTitle();
      else if (action === 'back') showAttract();
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
      if (action === 'start') setPaused(!match.paused);
      else if (match.paused && (action === 'confirm' || action === 'back')) setPaused(false);
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
  });

  const stored = loadSettings();
  if (isQuality(stored.quality)) settings.quality = stored.quality;
  if (typeof stored.shake === 'boolean') settings.shakeOn = stored.shake;
  if (typeof stored.volMaster === 'number') Sfx.setMaster(stored.volMaster);
  if (typeof stored.volSfx === 'number') Sfx.setSfx(stored.volSfx);
  setQuality(settings.quality);
  setPost(true);
  setBloom(typeof stored.bloom === 'boolean' ? stored.bloom : true);
  // audio needs a gesture, so a remembered mute is held until PLAY provides one
  settings.wantSfx = stored.sfx;
  syncDifficulty(state.difficulty);

  const click = (id: string, fn: () => void): void => {
    const el = maybeById(id);
    if (el) disposer.listen(el, 'click', fn);
  };

  // select screen
  click('m1p', () => { Sfx.ui(); setMode(true); });
  click('m2p', () => { Sfx.ui(); setMode(false); });
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
  click('kreset', () => { resetKeys(); buildKeyUI(); Sfx.ui(); });
  click('mquit', showBye);
  click('byeback', () => { Sfx.ui(); showMenu(); });
  click('mclose', closeModal);
  const modal = maybeById('modal');
  if (modal) disposer.listen(modal, 'click', (ev) => { if (ev.target === modal) closeModal(); });

  // results
  click('ragain', () => { Sfx.ui(); hideResults(); startMatch(); });
  click('rselect', () => { Sfx.ui(); hideResults(); returnToSelect(); });
  click('rmenu', () => { Sfx.ui(); hideResults(); toMainMenu(); });

  // pause card — the modal sits above it, so the match stays paused underneath
  click('presume', () => setPaused(false));
  click('pquit', () => { setPaused(false); returnToSelect(); });
  click('prestart', restartMatch);
  click('pctrl', () => openModal('controls', 'pause'));
  click('pset', () => openModal('settings', 'pause'));
  click('phelp', () => openModal('help', 'pause'));
  click('pmenu', () => { Sfx.ui(); toMainMenu(); });

  // settings
  click('swSfx', () => { Sfx.toggle(); setSwitch('swSfx', Sfx.on); Sfx.ui(); saveSettings(); });
  click('swMusic', () => { Music.toggle(); setSwitch('swMusic', Music.playing); Sfx.ui(); saveSettings(); });
  click('swPost', () => { setPost(!post?.enabled); setSwitch('swPost', post?.enabled ?? false); Sfx.ui(); saveSettings(); });
  click('swShake', () => { settings.shakeOn = !settings.shakeOn; setSwitch('swShake', settings.shakeOn); Sfx.ui(); saveSettings(); });
  click('swBloom', () => { setBloom(!settings.bloomOn); setSwitch('swBloom', settings.bloomOn); Sfx.ui(); saveSettings(); });

  /* `input` updates the sound live as the thumb moves; `change` is where the
     write happens, so dragging does not hammer localStorage. */
  const slider = (id: string, outId: string, set: (v: number) => void): void => {
    const input = maybeById<HTMLInputElement>(id);
    if (!input) return;
    const out = maybeById(outId);
    disposer.listen(input, 'input', () => { set(Number(input.value) / 100); paintSlider(input, out); });
    disposer.listen(input, 'change', () => { Sfx.ui(); saveSettings(); });
    paintSlider(input, out);
  };
  slider('volMaster', 'volMasterV', (v) => Sfx.setMaster(v));
  slider('volSfx', 'volSfxV', (v) => Sfx.setSfx(v));
  const seg = maybeById('segQ');
  if (seg) {
    for (const b of Array.from(seg.children) as HTMLElement[]) {
      disposer.listen(b, 'click', () => {
        if (isQuality(b.dataset.q)) setQuality(b.dataset.q);
        Sfx.ui();
        saveSettings();
      });
    }
  }

  // nobody should have to watch a loading bar they are done with
  click('boot', () => Boot.skip());
  // a click anywhere on the attract screen is as good as a key
  click('title', () => {
    if (document.body.classList.contains('attract')) { Sfx.init(); showMenu(); }
  });

  // input
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
  disposer.listen(window, 'pointerdown', () => Sfx.init(), { passive: true });
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
