import { overrideSlot, swingSync } from '../anim/animation';
import type { AnimSlot } from '../anim/types';
import { PHASE, BOUND, S } from '../config/constants';
import { BINDINGS, type ActionId, type Side } from '../input/bindings';
import { simulate } from '../game/game';
import { cancelMatchTimers, match, skipIntro, startMatch } from '../game/match';
import { setDifficulty } from '../game/bot';
import { inFatalBlow } from '../game/fatalblow';
import { finishing, inFatality } from '../game/finish';
import type { Fighter } from '../game/fighter';
import { rigs } from '../game/rigs';
import { state, type Difficulty } from '../game/state';

/*
  Developer harness: an invariant monitor and a random-input monkey, driving the
  real simulation step with no rendering, so a few simulated minutes take
  seconds even on a software GL backend. Exposed as __ASH.harness (debug.ts).

  The monkey presses real keyboard events, the same path a player uses, so the
  controller, the input buffer and the state machine all see ordinary input.
  The monitor checks after every step: finite numbers, inside the stage, health
  in range, no state held implausibly long, and steps that take over 75 ms.
*/

export interface Violation {
  kind: string;
  detail: string;
  /** Simulated seconds into the run. */
  at: number;
  count: number;
}

export interface HarnessReport {
  seed: number;
  steps: number;
  simSeconds: number;
  rounds: number;
  matches: number;
  maxStepMs: number;
  slowSteps: number;
  violations: Violation[];
  statesSeen: Record<string, number>;
  hits: number;
  parries: number;
  bestCombo: number;
}

const DT = 1 / 120;
const ACTIONS: ActionId[] = ['left', 'right', 'jump', 'block', 'dash', 'punch', 'kick', 'assist', 'power'];

/** Longest plausible time in a state, in simulated seconds. */
const STUCK: Partial<Record<string, number>> = {
  [S.HITSTUN]: 4, [S.JUMP]: 5, [S.PUNCH]: 2.5, [S.KICK]: 2.5, [S.WALK]: 30,
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function key(side: Side, a: ActionId, up: boolean): void {
  const code = BINDINGS[side].keys[a][0]!;
  document.body.dispatchEvent(new KeyboardEvent(up ? 'keyup' : 'keydown', { code, key: code, bubbles: true }));
}

export interface StartOptions {
  p1?: number;
  p2?: number;
  assist1?: number;
  assist2?: number;
  /** Two humans (the monkey drives both) rather than monkey against CPU. */
  versus?: boolean;
  rush?: boolean;
  training?: boolean;
  /** The CPU plays both sides. */
  cpuVsCpu?: boolean;
  difficulty?: Difficulty;
}

export function startFight(o: StartOptions = {}): void {
  cancelMatchTimers();
  state.sel[0].fighter = o.p1 ?? state.sel[0].fighter;
  state.sel[1].fighter = o.p2 ?? state.sel[1].fighter;
  state.sel[0].assist = o.assist1 ?? 0;
  state.sel[1].assist = o.assist2 ?? 1;
  state.mode1P = !(o.versus ?? true);
  state.rush = !!o.rush;
  state.training = !!o.training;
  state.autoP1 = !!o.cpuVsCpu;
  if (o.training) state.mode1P = true;
  if (o.difficulty) setDifficulty(o.difficulty);
  document.body.classList.remove('attract', 'titling', 'selecting', 'bye', 'modal');
  startMatch();
  // the select screen is what normally shows the picked pair; skipping it, show them here
  for (const side of rigs) for (const r of side) r.root.visible = false;
  for (const f of state.fighters) f.root.visible = true;
  skipIntro();
  // one step lets the intro close itself, so its HUD and camera state are released properly
  simulate(DT);
}

function bad(f: Fighter): string | null {
  const nums: Array<[string, number]> = [
    ['x', f.x], ['y', f.y], ['vx', f.vx], ['vy', f.vy], ['hp', f.hp], ['meter', f.meter],
    ['flip', f.flip], ['crouch', f.crouch], ['lean', f.lean.rotation.x], ['px', f.root.position.x],
    ['py', f.root.position.y], ['scaleY', f.body.scale.y],
  ];
  for (const [n, v] of nums) if (!Number.isFinite(v)) return `${n}=${v}`;
  if (Math.abs(f.x) > BOUND + 1.5) return `x out of stage ${f.x.toFixed(2)}`;
  if (f.y < -0.5 || f.y > 40) return `y out of range ${f.y.toFixed(2)}`;
  if (f.hp < 0 || f.hp > 100.001) return `hp ${f.hp}`;
  if (f.meter < -0.001 || f.meter > 100.001) return `meter ${f.meter}`;
  if (Math.abs(f.vx) > 60 || Math.abs(f.vy) > 60) return `velocity ${f.vx.toFixed(1)},${f.vy.toFixed(1)}`;
  // standing on a prop is fine; standing on air is not
  if (f.grounded && f.y > 0.6) return `grounded but y=${f.y.toFixed(2)}`;
  return null;
}

export async function runMonkey(seconds: number, seed = 1, opts: StartOptions = {}): Promise<HarnessReport> {
  const rand = rng(seed);
  startFight(opts);
  const report: HarnessReport = {
    seed, steps: 0, simSeconds: 0, rounds: 0, matches: 1, maxStepMs: 0, slowSteps: 0,
    violations: [], statesSeen: {}, hits: 0, parries: 0, bestCombo: 0,
  };
  const seen = new Map<string, Violation>();
  const note = (kind: string, detail: string): void => {
    const k = `${kind}:${detail.replace(/[-\d.]+/g, '#')}`;
    const v = seen.get(k);
    if (v) { v.count++; return; }
    const nv = { kind, detail, at: +report.simSeconds.toFixed(2), count: 1 };
    seen.set(k, nv);
    report.violations.push(nv);
  };

  const held: Record<Side, Set<ActionId>> = { p1: new Set(), p2: new Set() };
  const next: Record<Side, number> = { p1: 0, p2: 0 };
  const sides: Side[] = opts.versus === false ? ['p1'] : ['p1', 'p2'];
  let lastRound = match.round;
  let overFor = 0;

  const total = Math.round(seconds / DT);
  for (let n = 0; n < total; n++) {
    // ── the monkey ──
    for (const side of sides) {
      next[side] -= DT;
      if (next[side] > 0) continue;
      next[side] = 0.04 + rand() * 0.35;
      const a = ACTIONS[Math.floor(rand() * ACTIONS.length)]!;
      const h = held[side];
      // directions and block are held; the rest are taps
      if (a === 'left' || a === 'right' || a === 'block') {
        if (h.has(a)) { key(side, a, true); h.delete(a); } else { key(side, a, false); h.add(a); }
        if (a === 'left' && h.has('right')) { key(side, 'right', true); h.delete('right'); }
        if (a === 'right' && h.has('left')) { key(side, 'left', true); h.delete('left'); }
      } else {
        key(side, a, false);
        if (a === 'jump' && rand() < 0.5) { /* held through the arc */ h.add(a); } else key(side, a, true);
        if (a !== 'jump') continue;
      }
      if (rand() < 0.04) for (const x of [...h]) { key(side, x, true); h.delete(x); }
    }
    for (const side of sides) {
      if (held[side].has('jump') && rand() < 0.02) { key(side, 'jump', true); held[side].delete('jump'); }
    }

    // ── one real step ──
    const t0 = performance.now();
    try {
      simulate(DT);
    } catch (e) {
      note('exception', String((e as Error)?.stack ?? e).split('\n').slice(0, 3).join(' | '));
    }
    const ms = performance.now() - t0;
    report.steps++;
    report.simSeconds += DT;
    if (ms > report.maxStepMs) report.maxStepMs = ms;
    if (ms > 75) { report.slowSteps++; note('slow-step', `${ms.toFixed(0)} ms ${state.P1.state}/${state.P2.state} hp ${state.P1.hp.toFixed(0)}/${state.P2.hp.toFixed(0)} freeze ${match.freeze.toFixed(2)} over ${match.over}`); }

    // ── the monitor ──
    for (const f of state.fighters) {
      // fatalities place both fighters by script (Thousand Cuts stands the winner in the air), so they are exempt
      const e = inFatality() ? null : bad(f);
      if (e) note('invariant', `${f.def.name} ${e}`);
      report.statesSeen[f.state] = (report.statesSeen[f.state] ?? 0) + 1;
      // stateTime restarts on every re-entry, so a long string of hits is not mistaken for a stuck state
      if (!inFatality() && !inFatalBlow() && !finishing() && !match.paused && !match.over) {
        const lim = STUCK[f.state];
        if (lim && f.stateTime > lim) note('stuck', `${f.def.name} in ${f.state} for ${f.stateTime.toFixed(1)}s`);
      }
    }
    if (finishing()) report.statesSeen.FINISH_THEM = (report.statesSeen.FINISH_THEM ?? 0) + 1;
    if (inFatality()) report.statesSeen.FATALITY = (report.statesSeen.FATALITY ?? 0) + 1;
    if (inFatalBlow()) report.statesSeen.FATAL_BLOW = (report.statesSeen.FATAL_BLOW ?? 0) + 1;
    for (const f of state.fighters) {
      report.parries = Math.max(report.parries, f.parries);
      report.bestCombo = Math.max(report.bestCombo, f.bestCombo);
    }
    if (match.round !== lastRound) { report.rounds++; lastRound = match.round; }

    // ── let timers run, and start over when the match is decided ──
    if (n % 240 === 0) await new Promise((r) => setTimeout(r, 0));
    if (match.over) {
      overFor += DT;
      if (overFor > 6) {
        overFor = 0;
        report.matches++;
        for (const side of sides) for (const x of [...held[side]]) key(side, x, true);
        held.p1.clear(); held.p2.clear();
        startFight(opts);
        lastRound = match.round;
      }
    } else overFor = 0;
    if (state.phase !== PHASE.FIGHT) startFight(opts);
  }
  for (const side of sides) for (const x of [...held[side]]) key(side, x, true);
  return report;
}

export interface GaitProbe {
  fighter: string;
  topSpeed: number;
  /** Seconds from standstill to 95% of the walk speed reached. */
  accel: number;
  /** Seconds from release to a stop. */
  stop: number;
  jumpApex: number;
  airTime: number;
  dashDistance: number;
  /** Seconds of reduced walking after a hard landing. */
  landLag: number;
}

function stepFor(seconds: number, each?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    simulate(DT);
    each?.();
  }
}

/** Scripted movement measurements for each fighter: the numbers behind "they move differently". */
export function probeGaits(): GaitProbe[] {
  const out: GaitProbe[] = [];
  for (let i = 0; i < 4; i++) {
    startFight({ p1: i, p2: (i + 1) % 4, versus: true });
    const f = state.P1;
    const g = f.gait;
    f.hp = 100;
    // stand still first
    stepFor(0.3);
    // walk forward (toward the opponent): time to 95% of this walk's own plateau
    key('p1', 'right', false);
    let t = 0;
    let plateau = 0;
    stepFor(1.0, () => { plateau = Math.max(plateau, Math.abs(f.vx)); });
    key('p1', 'right', true);
    key('p1', 'right', false);
    stepFor(0.05);
    // measure accel from rest
    key('p1', 'right', true);
    stepFor(0.6);
    f.vx = 0;
    key('p1', 'right', false);
    let accel = 0;
    stepFor(0.6, () => { if (!accel && Math.abs(f.vx) >= plateau * 0.95) accel = t; t += DT; });
    key('p1', 'right', true);
    // stop time: from plateau to zero
    f.vx = plateau;
    let stop = 0;
    t = 0;
    stepFor(0.6, () => { t += DT; if (!stop && Math.abs(f.vx) < 0.02) stop = t; });
    // jump on the spot, held through the rise
    f.x = 0;
    f.vx = 0;
    key('p1', 'jump', false);
    let apex = 0;
    let air = 0;
    let left = false;
    stepFor(0.05);
    stepFor(2.5, () => {
      apex = Math.max(apex, f.y);
      if (!f.grounded) { air += DT; left = true; }
      if (left && f.grounded && f.landLag > 0 && air > 0) { /* landed */ }
    });
    key('p1', 'jump', true);
    const lag = g.landLag;
    // dash distance
    f.vx = 0;
    f.x = -3;
    stepFor(0.5);
    const x0 = f.x;
    key('p1', 'dash', false);
    stepFor(0.02);
    key('p1', 'dash', true);
    stepFor(0.6);
    out.push({
      fighter: f.def.name, topSpeed: +f.def.speed.toFixed(2), accel: +accel.toFixed(3), stop: +stop.toFixed(3),
      jumpApex: +apex.toFixed(2), airTime: +air.toFixed(2), dashDistance: +(f.x - x0).toFixed(2), landLag: lag,
    });
  }
  return out;
}

/** Scripted combat scenarios: each returns what happened, for a human to read or a script to assert on. */
export function probeCombat(): Record<string, unknown> {
  const res: Record<string, unknown> = {};
  const place = (gap: number): void => {
    state.P1.x = -gap / 2;
    state.P2.x = gap / 2;
    state.P1.physicsBody?.teleport?.(state.P1.x, 0);
    state.P2.physicsBody?.teleport?.(state.P2.x, 0);
  };
  const tap = (side: Side, a: ActionId, hold = 0.03): void => {
    key(side, a, false);
    stepFor(hold);
    key(side, a, true);
  };

  // 1. a light connects, and training reports it
  startFight({ p1: 0, p2: 2, training: true });
  stepFor(0.2);
  place(1.5);
  tap('p1', 'punch');
  stepFor(0.5);
  res.lightHit = { hp2: +state.P2.hp.toFixed(1), p2: state.P2.state, combo: state.P1.combo };

  // 2. chain: a string of lights; the last link that is allowed launches
  startFight({ p1: 3, p2: 2, versus: true });
  stepFor(0.2);
  place(1.3);
  state.P2.hp = 100;
  const chain: string[] = [];
  for (let k = 0; k < 6; k++) {
    tap('p1', 'punch');
    stepFor(0.15);
    chain.push(`${k}:chain=${state.P1.chain},hp2=${state.P2.hp.toFixed(0)},launched=${state.P2.launched}`);
  }
  stepFor(1);
  res.chain = chain;

  // 2b. the finisher: a punch thrown as the last allowed link launches
  startFight({ p1: 3, p2: 2, versus: true });
  stepFor(0.2);
  place(1.3);
  state.P1.chain = state.P1.gait.chainMax;
  tap('p1', 'punch');
  stepFor(0.25);
  res.ender = { launched: state.P2.launched, vy: +state.P2.vy.toFixed(1), y: +state.P2.y.toFixed(2) };

  // 3. parry: the defender taps block as the swing lands
  startFight({ p1: 0, p2: 3, versus: true });
  stepFor(0.2);
  place(1.4);
  key('p1', 'punch', false);
  stepFor(0.03);
  key('p1', 'punch', true);
  stepFor(0.04);
  key('p2', 'block', false);
  stepFor(0.25);
  key('p2', 'block', true);
  res.parry = { hp2: +state.P2.hp.toFixed(1), p1: state.P1.state, parries: state.P2.parries };

  // 4. the same swing against a held guard is a plain block
  startFight({ p1: 0, p2: 3, versus: true });
  stepFor(0.2);
  place(1.4);
  key('p2', 'block', false);
  stepFor(0.3);
  tap('p1', 'punch');
  stepFor(0.4);
  key('p2', 'block', true);
  res.heldBlock = { hp2: +state.P2.hp.toFixed(1), p1: state.P1.state, parries: state.P2.parries };

  // 4b. input buffer: a press made just before recovery ends still comes out, one made long before does not
  startFight({ p1: 0, p2: 3, versus: true });
  stepFor(0.2);
  place(4);
  tap('p1', 'punch');
  stepFor(0.22);                                    // 0.25 s in; a punch is 0.31 s long
  tap('p1', 'punch', 0.01);
  stepFor(0.12);
  const early = { state: state.P1.state, t: +state.P1.stateTime.toFixed(2) };
  stepFor(1);
  startFight({ p1: 0, p2: 3, versus: true });
  stepFor(0.2);
  place(4);
  tap('p1', 'punch');
  stepFor(0.02);
  tap('p1', 'punch', 0.01);                         // pressed far too early: 0.28 s before the end
  stepFor(0.45);
  res.buffer = { justBefore: early, tooEarly: { state: state.P1.state, t: +state.P1.stateTime.toFixed(2) } };

  // 4c. armour: a jab into Bronzemaw's heavy wind-up does not stop the heavy
  startFight({ p1: 2, p2: 3, versus: true });
  stepFor(0.2);
  place(1.8);
  tap('p1', 'kick');
  stepFor(0.02);
  tap('p2', 'punch');
  stepFor(0.12);
  const midSwing = { p1: state.P1.state, hp1: +state.P1.hp.toFixed(1) };
  stepFor(0.4);
  res.armor = { midSwing, p2hp: +state.P2.hp.toFixed(1), trade: match.lastTrade };

  // 5a. control: the same heavy in open space
  startFight({ p1: 0, p2: 2, versus: true });
  stepFor(0.2);
  place(1.5);
  const hpC = state.P2.hp;
  tap('p1', 'kick');
  stepFor(0.6);
  res.heavyOpen = { dmg: +(hpC - state.P2.hp).toFixed(1), x2: +state.P2.x.toFixed(2), p1: state.P1.state };

  // 5. corner: a heavy into the wall
  startFight({ p1: 0, p2: 2, versus: true });
  stepFor(0.2);
  state.P2.x = BOUND - 0.4;
  state.P1.x = BOUND - 1.9;
  state.P1.physicsBody?.teleport?.(state.P1.x, 0);
  state.P2.physicsBody?.teleport?.(state.P2.x, 0);
  stepFor(0.05);
  const hp0 = state.P2.hp;
  tap('p1', 'kick');
  stepFor(0.6);
  res.corner = { dmg: +(hp0 - state.P2.hp).toFixed(1), x2: +state.P2.x.toFixed(2), p1x: +state.P1.x.toFixed(2) };
  return res;
}

/** Raw stepping and key access, for ad-hoc scripts from the console. */
export const raw = {
  clip: (slot: string, name: string): boolean => overrideSlot(state.P1, slot as AnimSlot, name),
  step: (seconds: number, each?: () => void): void => stepFor(seconds, each),
  key: (side: Side, a: ActionId, up = false): void => key(side, a, up),
};

/** The furthest gap, in world units between the two fighters, at which each normal still connects. */
export function probeReach(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 4; i++) {
    startFight({ p1: i, p2: (i + 2) % 4, versus: true });
    stepFor(0.2);
    const row: Record<string, unknown> = { fighter: state.P1.def.name };
    for (const kind of ['punch', 'kick', 'sweep'] as const) {
      let best = 0;
      for (let gap = 1.6; gap <= 4.4; gap += 0.2) {
        state.P1.x = -gap / 2;
        state.P2.x = gap / 2;
        state.P1.physicsBody?.teleport(state.P1.x, 0);
        state.P2.physicsBody?.teleport(state.P2.x, 0);
        state.P1.hp = state.P2.hp = 100;
        state.P1.vx = state.P2.vx = 0;
        stepFor(0.9);
        // the dummy may have been knocked about: put the gap back
        state.P1.x = -gap / 2;
        state.P2.x = gap / 2;
        state.P1.physicsBody?.teleport(state.P1.x, 0);
        state.P2.physicsBody?.teleport(state.P2.x, 0);
        state.P2.hp = 100;
        if (kind === 'sweep') key('p1', 'block', false);
        key('p1', kind === 'punch' ? 'punch' : 'kick', false);
        stepFor(0.03);
        key('p1', kind === 'punch' ? 'punch' : 'kick', true);
        if (kind === 'sweep') key('p1', 'block', true);
        stepFor(0.6);
        if (state.P2.hp < 100) best = gap;
      }
      row[kind] = +best.toFixed(1);
    }
    out.push(row);
  }
  return out;
}

/** Every fighter's fatality and fatal blow, played through once, with exceptions caught and reported. */
export function probeFinishers(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const run = (seconds: number, each?: () => void): void => {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      try { simulate(DT); } catch (e) { errors.push(String((e as Error)?.stack ?? e).split('\n').slice(0, 2).join(' | ')); }
      each?.();
    }
  };
  for (let i = 0; i < 4; i++) {
    const row: Record<string, unknown> = { fighter: ['CINDERWARD', 'PALE VIGIL', 'BRONZEMAW', 'NOCTURNE'][i] };
    // the fatality: a blow that would end the match leaves them standing
    startFight({ p1: i, p2: (i + 1) % 4, versus: true });
    run(0.2);
    state.P1.x = -0.7; state.P2.x = 0.7;
    state.P1.physicsBody?.teleport(-0.7, 0); state.P2.physicsBody?.teleport(0.7, 0);
    state.P1.rounds = 1;                              // one round up, so this one decides the match
    state.P1.hp = 20;                                 // low enough for a fatal blow: Overdrive must still be the fatality
    state.P2.hp = 2;
    key('p1', 'punch', false); run(0.03); key('p1', 'punch', true);
    run(0.5);
    row.finishing = finishing();
    key('p1', 'power', false); run(0.05); key('p1', 'power', true);
    let sawFatality = false;
    let stolen = false;
    run(9, () => { if (inFatality()) sawFatality = true; if (inFatalBlow()) stolen = true; });
    row.fatality = sawFatality;
    row.fatalBlowStoleIt = stolen;
    row.over = match.over;
    // the fatal blow: Overdrive at low health
    startFight({ p1: i, p2: (i + 2) % 4, versus: true });
    run(0.2);
    state.P1.x = -0.9; state.P2.x = 0.9;
    state.P1.physicsBody?.teleport(-0.9, 0); state.P2.physicsBody?.teleport(0.9, 0);
    state.P1.hp = 20;
    key('p1', 'power', false); run(0.05); key('p1', 'power', true);
    let sawBlow = false;
    run(5, () => { if (inFatalBlow()) sawBlow = true; });
    row.fatalBlow = sawBlow;
    row.p2hp = +state.P2.hp.toFixed(0);
    out.push(row);
  }
  out.push({ errors });
  return out;
}

export interface DuelResult {
  p1: string;
  p2: string;
  p1Wins: number;
  p2Wins: number;
  draws: number;
  avgRound: number;
  violations: number;
}

/** CPU against CPU, one round per bout, for a given number of rounds. Both sides use the same difficulty. */
export async function cpuDuel(p1: number, p2: number, rounds: number, difficulty: Difficulty = 'NORMAL'): Promise<DuelResult> {
  const r: DuelResult = { p1: '', p2: '', p1Wins: 0, p2Wins: 0, draws: 0, avgRound: 0, violations: 0 };
  let total = 0;
  for (let k = 0; k < rounds; k++) {
    startFight({ p1, p2, versus: false, cpuVsCpu: true, difficulty });
    r.p1 = state.P1.def.name;
    r.p2 = state.P2.def.name;
    let t = 0;
    let n = 0;
    while (!match.over && t < 120) {
      try { simulate(DT); } catch { r.violations++; }
      for (const f of state.fighters) if (bad(f)) r.violations++;
      t += DT;
      if (++n % 600 === 0) await new Promise((res) => setTimeout(res, 0));
    }
    // let a finish or a fatal blow play out so the next bout starts clean
    for (let w = 0; w < 600 && (finishing() || inFatality() || inFatalBlow()); w++) simulate(DT);
    total += t;
    if (state.P1.won && !state.P2.won) r.p1Wins++;
    else if (state.P2.won && !state.P1.won) r.p2Wins++;
    else r.draws++;
  }
  state.autoP1 = false;
  r.avgRound = +(total / rounds).toFixed(1);
  return r;
}

/**
 * Where each scripted swing's clip is when its blow lands: summons at the orb or
 * the quake, the fatal blow and the fatality at each wound. `dt` is clip time
 * minus the clip's measured contact frame: 0 to about 0.09 means the strike
 * pose is on screen at the moment of impact.
 */
export function probeSync(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const place = (a: number, b: number): void => {
    state.P1.x = a; state.P2.x = b;
    state.P1.physicsBody?.teleport(a, 0); state.P2.physicsBody?.teleport(b, 0);
  };
  // summons
  for (const k of [0, 1]) {
    startFight({ p1: 0, p2: 2, assist1: k, versus: true });
    stepFor(0.2);
    place(-3, 3);
    state.P1.meter = 100;
    state.P1.assistCd = 0;
    key('p1', 'assist', false); stepFor(0.03); key('p1', 'assist', true);
    const a = state.P1.assist;
    const rows: string[] = [];
    let orbDone = false;
    let quakeDone = false;
    stepFor(2, () => {
      if (!a || a.state !== 'STRIKE') return;
      const s = swingSync(a);
      if (!s) return;
      if (!orbDone && a.orbT >= 0) { orbDone = true; rows.push(`orb t=${a.t.toFixed(2)} clip=${s.time} contact=${s.contact}`); }
      if (!quakeDone && a.quaked) { quakeDone = true; rows.push(`quake t=${a.t.toFixed(2)} clip=${s.time} contact=${s.contact}`); }
    });
    out[a?.def.name ?? `assist${k}`] = rows;
  }
  // the fatal blow and each fatality: clip against contact at every wound
  for (let i = 0; i < 4; i++) {
    const row: string[] = [];
    const watch = (att: Fighter, vic: Fighter, tag: string): void => {
      let prev = vic.flash;
      let n = 0;
      stepFor(6, () => {
        if (vic.flash >= 0.99 && prev < 0.99) {
          const s = swingSync(att);
          n++;
          if (s && s.contact !== null) row.push(`${tag}${n} ${s.clip} dt=${(s.time - s.contact).toFixed(3)}`);
        }
        prev = vic.flash;
      });
    };
    startFight({ p1: i, p2: (i + 2) % 4, versus: true });
    stepFor(0.2);
    place(-0.9, 0.9);
    state.P1.hp = 20;
    key('p1', 'power', false); stepFor(0.05); key('p1', 'power', true);
    watch(state.P1, state.P2, 'blow');
    startFight({ p1: i, p2: (i + 1) % 4, versus: true });
    stepFor(0.2);
    place(-0.7, 0.7);
    state.P1.rounds = 1;
    state.P2.hp = 2;
    key('p1', 'punch', false); stepFor(0.03); key('p1', 'punch', true);
    stepFor(0.5);
    key('p1', 'power', false); stepFor(0.05); key('p1', 'power', true);
    watch(state.P1, state.P2, 'fatality');
    out[state.P1.def.name] = row;
  }
  return out;
}
