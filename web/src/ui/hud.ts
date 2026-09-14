import { onAssetStatus } from '../assets/models';
import { Assets } from '../assets/pipeline';
import { onArtProgress } from '../assets/texture-loader';
import { Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { rigState } from '../camera/camera-rig';
import { A, METER, MOVES, RIG, S } from '../config/constants';
import type { Disposer } from '../core/disposal';
import { clamp } from '../core/math';
import { Burst } from '../fx/particles';
import { assistStriking } from '../game/collision';
import type { Fighter } from '../game/fighter';
import { attackPhase } from '../game/fsm';
import { match } from '../game/match';
import { state } from '../game/state';
import { dom, maybeById } from './dom';

/*
  The match HUD (health, gauges, state pills, clock) and the developer panel
  toggled with H. Health is written on change only, so the CSS transition owns
  its motion; everything else is throttled to ~16 writes a second, because
  reading a number off a pill does not need 144 layout invalidations a second.
*/

type DevId =
  | 'mid' | 'sep' | 'z' | 'hb' | 'trade' | 'dbg' | 'a1' | 'a2' | 'parts' | 'dt'
  | 'post' | 'stop' | 'models' | 'bot' | 'botstate' | 'music' | 'stage' | 'art';

const DEV_IDS: readonly DevId[] = [
  'mid', 'sep', 'z', 'hb', 'trade', 'dbg', 'a1', 'a2', 'parts', 'dt',
  'post', 'stop', 'models', 'bot', 'botstate', 'music', 'stage', 'art',
];

const dev = {} as Record<DevId, HTMLElement | null>;
let railFill: HTMLElement | null = null;
let railMark: HTMLElement | null = null;

/** Write a dev-panel row. Missing rows are fine: the panel is optional markup. */
export function devText(id: DevId, text: string, cls?: string): void {
  const el = dev[id];
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  if (cls !== undefined && el.className !== cls) el.className = cls;
}

export function bindHud(disposer: Disposer): void {
  for (const id of DEV_IDS) dev[id] = maybeById(`t-${id}`);
  railFill = maybeById('railfill');
  railMark = maybeById('railmark');

  // labels that used to be written from wherever the change happened now subscribe to it
  disposer.defer(Sfx.onToggle(() => { dom.sndLabel.textContent = Sfx.on ? 'on' : 'off'; }));
  disposer.defer(Music.onChange((mode) => devText('music', mode)));
  disposer.defer(onAssetStatus((status, anyLoaded) => devText('models', status, anyLoaded ? 'gold' : '')));
  disposer.defer(onArtProgress((s) => devText(
    'art',
    `${s.got}/${s.want}${s.failed ? `  (${s.failed} missing)` : ''}`
      + (Assets.counters.ktx2 || Assets.counters.draco ? ` · KTX2 ${Assets.counters.ktx2} · DRACO ${Assets.counters.draco}` : ''),
    s.failed ? 'hot' : s.got === s.want ? 'gold' : '',
  )));
}

interface PillLabel { readonly text: string; readonly cls: string }

function stateLabel(f: Fighter): PillLabel {
  if ((f.state === S.PUNCH || f.state === S.KICK) && f.move) {
    const ph = attackPhase(f) ?? 'recovery';
    const name = f.move === MOVES.KICK ? f.def.heavy : f.move.name;
    return { text: `${name} · ${ph.toUpperCase()}`, cls: ph === 'active' ? 'active' : ph === 'startup' ? 'startup' : 'recover' };
  }
  if (f.state === S.BLOCK) return { text: 'BLOCK', cls: 'block' };
  if (f.state === S.HITSTUN) return { text: 'HITSTUN', cls: 'hurt' };
  if (f.state === S.KO) return { text: 'K.O.', cls: 'ko' };
  return { text: f.state, cls: '' };
}

function superLabel(f: Fighter): PillLabel {
  if (f.powered) return { text: `OVERDRIVE ${(f.meter / METER.powerDrain).toFixed(1)}s`, cls: 'powered' };
  if (f.assist && f.assist.state !== A.DORMANT) return { text: `${f.assist.def.name.split(' ')[0]} ${f.assist.state}`, cls: 'live' };
  if (f.assistCd > 0) return { text: `COOLDOWN ${f.assistCd.toFixed(1)}s`, cls: '' };
  if (f.meter >= METER.powerCost) return { text: 'OVERDRIVE READY', cls: 'maxed' };
  if (f.meter >= METER.assistCost) return { text: 'ASSIST READY', cls: 'ready' };
  return { text: `METER ${Math.floor(f.meter)}%`, cls: '' };
}

function setPill(el: HTMLElement, lab: PillLabel): void {
  if (el.textContent !== lab.text) el.textContent = lab.text;
  const cls = lab.cls ? `pill ${lab.cls}` : 'pill';
  if (el.className !== cls) el.className = cls;
}

let hudAccum = 0;

export function syncHud(frameDt: number): void {
  const fighters = state.fighters;
  for (let i = 0; i < 2; i++) {
    const f = fighters[i]!;
    if (f.hp === f.lastHp) continue;
    const s = `scaleX(${(f.hp / 100).toFixed(4)})`;
    dom.hp[i as 0 | 1].style.transform = s;
    dom.chip[i as 0 | 1].style.transform = s;
    // the last quarter of health pulses, so "one more hit" reads without looking at the number
    dom.block[i as 0 | 1].classList.toggle('danger', f.hp > 0 && f.hp <= 25);
    f.lastHp = f.hp;
  }

  hudAccum += frameDt;
  if (hudAccum < 0.06) return;
  hudAccum = 0;

  for (let k = 0; k < 2; k++) {
    const f = fighters[k]!;
    const side = k as 0 | 1;
    setPill(dom.pill[side], stateLabel(f));
    setPill(dom.superPill[side], superLabel(f));

    const lvl = f.meter / METER.max + (f.assistCd > 0 ? 10 + f.assistCd : 0);
    if (Math.abs(lvl - f.lastMeter) <= 0.004) continue;
    // one meter, two gauges: 0–50 fills ASSIST, 50–100 fills SUPER
    const cooling = f.assistCd > 0;
    const aPart = cooling ? 1 - f.assistCd / METER.assistCooldown : clamp(f.meter / METER.assistCost, 0, 1);
    const sPart = clamp((f.meter - METER.assistCost) / (METER.powerCost - METER.assistCost), 0, 1);
    dom.assistFill[side].style.transform = `scaleX(${aPart.toFixed(3)})`;
    dom.superFill[side].style.transform = `scaleX(${sPart.toFixed(3)})`;
    const ga = dom.gaugeAssist[side];
    ga.classList.toggle('cooling', cooling);
    ga.style.setProperty('--cd', `${(aPart * 100).toFixed(1)}%`);
    ga.classList.toggle('lit', !cooling && f.meter >= METER.assistCost);
    const label = ga.querySelector('b');
    const text = cooling ? `${f.assistCd.toFixed(1)}s` : 'ASSIST';
    if (label && label.textContent !== text) label.textContent = text;
    dom.gaugeSuper[side].classList.toggle('lit', f.meter >= METER.powerCost);
    f.lastMeter = lvl;
  }

  const { P1, P2 } = state;
  const pct = (rigState.z - RIG.zMin) / (RIG.zMax - RIG.zMin);
  devText('mid', rigState.mid.toFixed(2));
  devText('sep', rigState.sep.toFixed(2));
  devText('z', rigState.z.toFixed(2));
  if (railFill) railFill.style.width = `${(pct * 100).toFixed(1)}%`;
  if (railMark) railMark.style.left = `calc(${(pct * 100).toFixed(1)}% - 1px)`;

  const live: string[] = [];
  if (P1.activeHitbox && P1.move) live.push(`P1 ${P1.move.limb.toUpperCase()}`);
  if (P2.activeHitbox && P2.move) live.push(`P2 ${P2.move.limb.toUpperCase()}`);
  if (assistStriking(P1.assist)) live.push('A1 STRIKE');
  if (assistStriking(P2.assist)) live.push('A2 STRIKE');
  if (P1.assist?.orbActive) live.push('A1 ORB');
  if (P2.assist?.orbActive) live.push('A2 ORB');
  devText('hb', live.length ? live.join(' / ') : 'none', live.length ? 'hot' : '');

  const a1 = P1.assist;
  const a2 = P2.assist;
  if (a1) devText('a1', a1.state + (a1.orbActive ? ' +ORB' : ''), a1.state === A.DORMANT ? '' : 'gold');
  if (a2) devText('a2', a2.state + (a2.orbActive ? ' +ORB' : ''), a2.state === A.DORMANT ? '' : 'gold');

  devText('parts', String(Burst.alive));
  devText('botstate', state.mode1P ? P2.brain.state : '—');
  devText('trade', match.lastTrade);
  devText('stop', `${match.lastStop} ms`);
  devText('dt', `${(frameDt * 1000).toFixed(1)} ms`);

  const secs = Math.ceil(match.time);
  dom.clock.textContent = `${secs < 10 ? '0' : ''}${secs}`;
  // the clock goes red once the round is nearly gone
  dom.clock.parentElement?.classList.toggle('low', secs <= 10 && !match.over);
}

/* The control legend fades once the player is clearly playing. */
let keysLive = 0;
let keysHushed = false;

export function stepKeyLegend(dt: number, playing: boolean): void {
  if (keysHushed) return;
  keysLive += dt;
  if (keysLive > 8 || playing) {
    keysHushed = true;
    document.body.classList.add('hushkeys');
  }
}

export function resetKeyLegend(): void {
  keysLive = 0;
  keysHushed = false;
  document.body.classList.remove('hushkeys');
}
