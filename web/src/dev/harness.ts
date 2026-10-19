import { PHASE, BOUND, S } from '../config/constants';
import { BINDINGS, type ActionId, type Side } from '../input/bindings';
import { simulate } from '../game/game';
import { cancelMatchTimers, match, skipIntro, startMatch } from '../game/match';
import { setDifficulty } from '../game/bot';
import { inFatalBlow } from '../game/fatalblow';
import { finishing, inFatality } from '../game/finish';
import type { Fighter } from '../game/fighter';
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
  if (o.difficulty) setDifficulty(o.difficulty);
  startMatch();
  skipIntro();
  match.hold = 0;
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
    violations: [], statesSeen: {}, hits: 0,
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
      const e = bad(f);
      if (e) note('invariant', `${f.def.name} ${e}`);
      report.statesSeen[f.state] = (report.statesSeen[f.state] ?? 0) + 1;
      // stateTime restarts on every re-entry, so a long string of hits is not mistaken for a stuck state
      if (!inFatality() && !inFatalBlow() && !finishing() && !match.paused && !match.over) {
        const lim = STUCK[f.state];
        if (lim && f.stateTime > lim) note('stuck', `${f.def.name} in ${f.state} for ${f.stateTime.toFixed(1)}s`);
      }
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
