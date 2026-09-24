import { GROUND, METER, PHASE, ROUNDS_TO_WIN, S, SPAWN_X } from '../config/constants';
import { Sfx } from '../audio/sfx';
import { ROSTER } from '../config/roster';
import { fightCall, matchOver, resetFeel, roundIntro, roundOver } from '../fx/juice';
import { resetInput, resetInputBuffers } from '../input/controller';
import { announce, calloutAfter, clearAnnounce } from '../ui/announcer';
import { dom } from '../ui/dom';
import { resetKeyLegend } from '../ui/hud';
import { focusMenu, releaseFocus } from '../ui/menu-nav';
import { updateSelectUI } from '../ui/select';
import { attachFighterBodies, physics } from '../physics/port';
import { arena } from '../world/arena';
import { retireAssist } from './assist';
import type { Fighter } from './fighter';
import { enterState } from './fsm';
import { resetBodyLanguage } from './pose';
import { emberHolder, resetRush } from './rush';
import { resetFinish } from './finish';
import { resetSpecials } from './specials';
import { resetFatalBlows } from './fatalblow';
import { resetThrows } from './throws';
import { resetBlood } from '../fx/blood';
import { resetCinematic, setCinematic } from '../camera/camera-rig';
import { clearBanners } from '../ui/banner';
import { hideVersus, showVersus } from '../ui/versus';
import { warmPipelines } from '../render/warmup';
import { hush, say } from '../audio/voice';
import { assistRigs, bindAssist, rigs } from './rigs';
import { state } from './state';

/*
  `epoch` invalidates deferred round-end callbacks. Leaving a match mid-callout
  used to leave a live timer that only checked "are we in a fight?" — start
  another match inside those 2.4 s and it fired into the NEW match, bumping its
  round counter and resetting the fighters mid-round. Every deferred callback
  now carries the epoch it was scheduled under, and bails if that has moved on.
*/
export const match = {
  time: 99,
  over: true,
  freeze: 0,
  round: 1,
  epoch: 0,
  lastTrade: '—',
  lastStop: 0,
  finishCalled: false,
  /** The first clean hit of the round has been banner'd. */
  firstHit: false,
  draws: 0,
  paused: false,
  /** Seconds the simulation holds before the first round: the versus screen. */
  hold: 0,
};

/** The match intro: the versus card, then a close shot of each fighter. */
const VERSUS_MS = 1600;
const INTRO_SHOT = 1.5;
const INTRO_TOTAL = VERSUS_MS / 1000 + INTRO_SHOT * 2;

/* The round call waits for the intro. Holding it here rather than on a timer
   lets a keypress skip the intro and bring the call forward. */
let pendingIntro: (() => void) | null = null;
let introShot = -1;

/** Any key or tap during the intro skips straight to the round call. */
export function skipIntro(): void {
  if (match.hold <= 0 || state.phase !== PHASE.FIGHT) return;
  match.hold = 0.0001;
  hideVersus();
}

/** One step of the match intro; true while it is still holding the round. */
export function stepHold(dt: number): boolean {
  if (match.hold <= 0) return false;
  match.hold = Math.max(0, match.hold - dt);
  const { P1, P2 } = state;
  // which shot: the versus card, then P1 in close, then P2
  const shot = match.hold > INTRO_SHOT * 2 ? 0 : match.hold > INTRO_SHOT ? 1 : 2;
  if (match.hold > 0 && shot !== introShot) {
    introShot = shot;
    if (shot > 0) {
      const f = shot === 1 ? P1 : P2;
      setCinematic({ x: f.x, y: 2.35, dist: 5.0, yaw: f.face * 0.55, h: -0.35 });
      introCard(f, shot === 1 ? 0 : 1);
    }
  }
  if (match.hold > 0) return true;
  // the intro is over: back to the fight rig, and call the round
  introShot = -1;
  introCard(null, 0);
  setCinematic(null);
  document.body.classList.remove('intro');
  const go = pendingIntro;
  pendingIntro = null;
  go?.();
  return false;
}

let cardEl: HTMLElement | null = null;
function introCard(f: Fighter | null, side: 0 | 1): void {
  if (!cardEl) {
    cardEl = document.createElement('div');
    cardEl.id = 'introcard';
    cardEl.setAttribute('aria-hidden', 'true');
    document.getElementById('hud')?.appendChild(cardEl);
  }
  if (!f) {
    cardEl.className = '';
    return;
  }
  cardEl.innerHTML = `<b>${f.def.name}</b><span>${f.def.title.toUpperCase()}</span>`;
  cardEl.style.setProperty('--acc', f.def.hex);
  cardEl.className = '';
  void cardEl.offsetWidth;
  cardEl.className = `on s${side}`;
}

/** A stalemate has to end somewhere. */
export const MAX_ROUNDS = 5;

const timers = new Set<number>();

function later(fn: () => void, ms: number): void {
  const id = window.setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}

export function cancelMatchTimers(): void {
  for (const id of timers) window.clearTimeout(id);
  timers.clear();
}

export function startMatch(): void {
  hideResults();
  const sel = state.sel;
  state.setFighters(rigs[0][sel[0].fighter]!, rigs[1][sel[1].fighter]!);
  bindAssist(state.P1, assistRigs[0][sel[0].assist]!);
  bindAssist(state.P2, assistRigs[1][sel[1].assist]!);
  attachFighterBodies();                // the two slot capsules follow the picked fighters

  for (const f of state.fighters) {
    f.rounds = 0;
    f.dealt = 0;
    f.bestCombo = 0;
  }
  match.round = 1;
  match.draws = 0;
  resetFatalBlows(true);                // one fatal blow each, per match
  match.paused = false;
  resetFeel();
  document.body.classList.remove('paused');
  match.epoch++;                  // orphan any round timer from the last match
  state.phase = PHASE.FIGHT;
  document.body.classList.remove('selecting');
  for (const p of arena.plinths) p.visible = false;
  applyIdentity();
  renderStocks();
  warmPipelines();                      // compiled while the versus card covers the screen
  match.hold = INTRO_TOTAL;
  introShot = -1;
  document.body.classList.add('intro');         // the fight HUD comes in with the round call
  showVersus(state.P1, state.P2, VERSUS_MS);
  newRound();
}

export function returnToSelect(): void {
  hideResults();
  hideVersus();
  hush();
  match.hold = 0;
  pendingIntro = null;
  introShot = -1;
  introCard(null, 0);
  document.body.classList.remove('intro');
  resetFinish();
  resetSpecials();
  resetFatalBlows(false);
  resetThrows();
  resetCinematic();
  state.phase = PHASE.SELECT;
  match.over = true;
  resetFeel();
  match.freeze = 0;
  match.paused = false;
  document.body.classList.remove('paused');
  match.epoch++;                  // any pending round callout is now stale
  for (const f of state.fighters) {
    f.powered = false;
    f.powerLight.intensity = 0;
    f.flash = f.blockFlash = f.white = 0;
    f.vx = f.vy = 0;
    f.y = GROUND;
    f.grounded = true;
    f.lockFace = 0;
    f.dashTime = 0;
    f.combo = 0;
    f.comboTimer = 0;
    clearCombo(f);
    enterState(f, S.IDLE);            // a KO'd fighter must not lie down on the pedestal
    retireAssist(f.assist);
    f.physicsBody?.teleport(f.x, f.y);
  }
  physics?.clearDebris();
  physics?.resetProps();
  // a key still down when Esc was pressed would otherwise stay latched
  resetInput();
  resetKeyLegend();
  state.sel[0].locked = state.sel[1].locked = false;
  document.body.classList.add('selecting');
  clearAnnounce();      // a pending callout would otherwise slam back in here
  updateSelectUI();
}

/** The chosen fighters' colours onto the HUD chrome. */
export function applyIdentity(): void {
  state.fighters.forEach((f, i) => {
    const d = f.def;
    const block = dom.block[i as 0 | 1];
    block.style.setProperty('--acc', d.hex);
    block.style.setProperty('--acc-lite', d.lite);
    block.style.setProperty('--acc-dim', d.dim);
    dom.name[i as 0 | 1].textContent = d.name;
    // the select screen's portrait of this fighter, in the ring at the end of the bar
    const idx = ROSTER.findIndex((r) => r.id === d.id);
    const face = document.querySelector<HTMLElement>(`#grid${i} .card[data-index="${idx}"] .portrait`)?.style.backgroundImage;
    if (face) block.style.setProperty('--face', face);
    const legend = dom.keyName[i as 0 | 1];
    legend.textContent = d.name;
    legend.style.color = d.hex;
    dom.combo[i as 0 | 1].style.setProperty('--acc', d.hex);
    f.lastHp = -1;
    f.lastMeter = -1;
  });
}

export function newRound(): void {
  for (const f of state.fighters) {
    f.hp = 100;
    f.x = SPAWN_X[f.slot === 0 ? 0 : 1];
    f.y = GROUND;
    f.vx = f.vy = 0;
    f.grounded = true;
    f.face = f.slot === 0 ? 1 : -1;
    f.flash = f.blockFlash = f.white = 0;
    f.combo = 0;
    f.comboTimer = 0;
    clearCombo(f);
    f.lockFace = 0;
    f.airMove = false;
    f.dashTime = 0;
    f.dashCd = 0;
    f.airTime = 0;
    f.jumpReleased = true;
    f.meter = METER.start;
    f.assistCd = 0;
    f.powered = false;
    f.powerLight.intensity = 0;
    f.powerLight.distance = 11;
    f.body.rotation.set(0, 0, 0);
    f.body.position.y = 0;
    resetBodyLanguage(f);
    f.root.rotation.y = f.face * Math.PI / 2;
    retireAssist(f.assist);
    enterState(f, S.IDLE);
    f.physicsBody?.teleport(f.x, f.y);         // a set position, not a move: no sweep across the stage
  }
  resetRush();                          // no air dash or double jump carries into a fresh stage
  resetFinish();
  resetCinematic();
  resetSpecials();
  resetFatalBlows(false);
  resetThrows();
  resetBlood();                         // every round starts on clean stones
  resetInputBuffers();                  // no buffered press carries over from the last round
  // every round starts on a tidy courtyard
  physics?.clearDebris();
  physics?.resetProps();
  match.time = 99;
  match.over = false;
  match.finishCalled = false;
  match.firstHit = false;
  clearBanners();
  dom.round.textContent = `ROUND ${match.round < 10 ? '0' : ''}${match.round}`;

  // every round gets the same two-beat callout: which round, then FIGHT —
  // after the versus screen, if one is up
  if (state.phase === PHASE.FIGHT) {
    const epoch = match.epoch;
    const intro = (): void => {
      if (state.phase !== PHASE.FIGHT || match.epoch !== epoch) return;
      const word = ['', 'ROUND ONE', 'ROUND TWO', 'ROUND THREE', 'FINAL ROUND'][match.round] ?? `ROUND ${match.round}`;
      announce(word, 1100, 'slam');
      roundIntro();
      calloutAfter(1250, () => {
        if (state.phase === PHASE.FIGHT && !match.over) {
          // RUSH is tag, and the one thing a player needs to know as it starts is who is it
          const it = emberHolder();
          announce(it ? `${it.def.name} IS IT!` : 'FIGHT', it ? 1100 : 800, 'slam');
          fightCall();
        }
      });
    };
    if (match.hold > 0) pendingIntro = intro;
    else intro();
  }
}

/*
  winner === null is a draw: a time-out with level health, or both fighters
  down on the same step. A draw used to award nobody and silently replay the
  round while still bumping the counter, so two even players could sit at 0-0
  on ROUND 09 forever. Both sides now take the point, which terminates.
*/
export function endRound(winner: Fighter | null, reason: string): void {
  if (match.over) return;
  match.over = true;
  const epoch = match.epoch;

  roundOver(reason);
  if (!winner) {
    match.draws++;
    for (const f of state.fighters) f.rounds = Math.min(ROUNDS_TO_WIN, f.rounds + 1);
  } else {
    winner.rounds = Math.min(ROUNDS_TO_WIN, winner.rounds + 1);
  }
  renderStocks();
  /* Every round is called for its winner, the way the genre calls them; a
     flawless round says so first. A fatality is called by finish.ts. */
  const name = winner?.def.name;
  const named = !!name && (reason === 'K.O.' || reason === 'FLAWLESS VICTORY');
  const call = !named ? reason : reason === 'K.O.' ? `${name} WINS` : `FLAWLESS VICTORY\n${name} WINS`;
  announce(call, 2000, 'slam');
  // and the camera goes to the winner, standing over it
  if (winner && reason !== 'FATALITY' && reason !== 'DRAW') {
    setCinematic({ x: winner.x, y: 2.15, dist: 7.3, yaw: winner.face * 0.42 });
  }

  later(() => {
    if (state.phase !== PHASE.FIGHT || match.epoch !== epoch) return;

    const done = state.fighters.filter((f) => f.rounds >= ROUNDS_TO_WIN);
    const outOfRounds = match.round >= MAX_ROUNDS;

    if (done.length || outOfRounds) {
      const { P1, P2 } = state;
      let champ: Fighter | null = null;
      if (done.length === 1) champ = done[0]!;
      else if (!done.length && outOfRounds) champ = P1.rounds === P2.rounds ? null : P1.rounds > P2.rounds ? P1 : P2;
      // the round call already named the winner (or the fatality card did); only a draw needs its own
      const said = champ && (named || reason === 'FATALITY') && champ === winner;
      if (!said) announce(champ ? `${champ.def.name} WINS` : 'DRAW GAME', 1600, 'slam');
      later(() => {
        if (state.phase === PHASE.FIGHT && match.epoch === epoch) showResults(champ);
      }, said ? 600 : 1700);
    } else {
      match.round++;
      newRound();
    }
  }, 2400);
}

/* ── results ────────────────────────────────────────────────────────────
   The set used to end by dropping straight back to the select screen, which
   threw away the one moment a match has to say what happened. */

function setText(id: string, text: string | number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

export function showResults(champ: Fighter | null): void {
  const draw = champ === null;
  const cpuWon = state.mode1P && champ === state.P2;

  setText('rverdict', draw ? 'DRAW' : cpuWon ? 'DEFEAT' : 'VICTORY');
  setText('rwinner', draw ? 'DRAW GAME' : champ.def.name);
  setText('rsub', draw ? 'NOBODY TOOK THE SET' : cpuWon ? 'THE CPU TAKES THE SET' : 'WINS THE SET');

  [state.P1, state.P2].forEach((f, i) => {
    setText(`rn${i}`, f.def.name);
    setText(`rr${i}`, f.rounds);
    setText(`rq${i}`, f.rounds);
    setText(`rd${i}`, Math.round(f.dealt));
    setText(`rc${i}`, f.bestCombo);
    document.getElementById(`rs${i}`)?.classList.toggle('won', !draw && f === champ);
  });

  document.body.classList.add('results');
  // in 2P versus somebody human always won
  matchOver(draw ? null : state.mode1P ? !cpuWon : true);
  focusMenu('ragain');                   // Enter or A is a rematch; the d-pad reaches the rest
}

export function hideResults(): void {
  if (document.body.classList.contains('results')) releaseFocus();
  document.body.classList.remove('results');
}

/* ── combo counter ──────────────────────────────────────────────────────
   A string survives while hits keep landing inside the window; the display
   only appears from the second hit, and bumps in scale on every one after. */

export function bumpCombo(f: Fighter, damage = 0): void {
  if (f.combo === 0) f.comboDmg = 0;
  f.combo += 1;
  f.comboDmg += damage;
  if (f.combo > f.bestCombo) f.bestCombo = f.combo;
  f.comboTimer = 1.15;
  const el = dom.combo[f.slot === 0 ? 0 : 1];
  // the damage the string has done, then the hit count under it
  const num = el.querySelector('.cnum');
  const dmg = el.querySelector('.cdmg');
  if (num) num.textContent = String(f.combo);
  if (dmg) dmg.textContent = f.comboDmg.toFixed(1);
  if (f.combo < 2) return;
  Sfx.combo(f.combo);
  // the announcer notices a long string
  if (f.combo === 4) say('Excellent!');
  else if (f.combo === 7) say('Outstanding!');
  el.classList.add('on');
  el.classList.remove('bump');
  void el.offsetWidth;                 // restart the keyframe on every hit
  el.classList.add('bump');
}

export function clearCombo(f: Fighter): void {
  dom.combo[f.slot === 0 ? 0 : 1].classList.remove('on', 'bump');
}

export function stepCombo(f: Fighter, dt: number): void {
  if (f.comboTimer <= 0) return;
  f.comboTimer -= dt;
  if (f.comboTimer <= 0) {
    f.comboTimer = 0;
    f.combo = 0;
    clearCombo(f);
  }
}

export function renderStocks(): void {
  state.fighters.forEach((f, i) => {
    const slots = dom.stock[i as 0 | 1].children;
    for (let s = 0; s < slots.length; s++) slots[s]!.className = s < f.rounds ? 'on' : '';
  });
}
