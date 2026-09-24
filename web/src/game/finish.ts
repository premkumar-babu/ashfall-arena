import * as THREE from 'three/webgpu';
import { FLASH_FRAMES, MOVES, PLANE_Z, ROUNDS_TO_WIN, S } from '../config/constants';
import { Music } from '../audio/music';
import { Sfx } from '../audio/sfx';
import { setCinematic } from '../camera/camera-rig';
import { clamp } from '../core/math';
import { gib, pool, spray } from '../fx/blood';
import { addTrauma, impact, knockout, setMood } from '../fx/juice';
import { Burst } from '../fx/particles';
import { spawnRing, spawnStreaks } from '../fx/vfx';
import { BINDINGS, keyLabel } from '../input/bindings';
import { physics } from '../physics/port';
import { scene } from '../render/stage';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { announce, clearAnnounce } from '../ui/announcer';
import type { Fighter } from './fighter';
import { enterState } from './fsm';
import { blankIntent, type Intent } from './intent';
import { endRound } from './match';
import { state } from './state';

/*
  FINISH THEM, and the fatality.

  The blow that would decide the match does not end it. The loser is left on
  their feet with an empty bar, swaying, and the winner gets a few seconds:
  any ordinary hit drops them for a plain K.O., and OVERDRIVE pressed up close
  is the fatality. Let the seconds run out and they fall on their own.

  The fatality is this game's own: the ember that runs through Ashfall. The
  winner closes in and strikes, the loser is lifted off the stones and burns
  from the inside, and then comes apart in blood and ash. With BLOOD off it is
  only the ash.

  Everything here runs in the fixed simulation step on its own clock, so a
  pause, a hit-stop or a slow frame never changes what the sequence looks like.
*/

export const FINISH = {
  /** Seconds the loser stands there before falling on their own. */
  window: 6,
  /** How close the winner has to be for OVERDRIVE to start the fatality. */
  reach: 4.4,
  /** The CPU lets it sit for a beat, then decides. */
  cpuDelay: 1.3,
  cpuFatality: 0.72,
} as const;

type Phase = 'dazed' | 'fatality' | 'done';

interface Finish {
  readonly winner: Fighter;
  readonly loser: Fighter;
  /** The winner's own fatality. */
  readonly script: Script;
  phase: Phase;
  t: number;
  dir: number;
  called: boolean;
  cpu: 'fatal' | 'hit' | null;
  /** Beats of the script that have already fired. */
  readonly done: Set<string>;
  /** Anything a script built for itself (Soul Harvest's ghost). */
  ghost: THREE.Object3D | null;
  /** Scratch for a script: where a leap started. */
  from: number;
}

let fin: Finish | null = null;
let hint: HTMLElement | null = null;
const _c = new THREE.Vector3();

const other = (f: Fighter): Fighter | undefined => state.fighters.find((o) => o !== f);

/** The loser is standing, the clock is stopped, and ordinary blows are still live. */
export function finishing(): boolean {
  return fin !== null && fin.phase !== 'done';
}

/** The fatality itself is playing: nobody has control of anything. */
export function inFatality(): boolean {
  return fin !== null && fin.phase === 'fatality';
}

export function finishVictim(): Fighter | null {
  return fin && fin.phase === 'dazed' ? fin.loser : null;
}

export function finishWinner(): Fighter | null {
  return fin ? fin.winner : null;
}

/** Would taking this fighter to zero decide the match? Then it is FINISH THEM, not K.O. */
export function decides(loser: Fighter): boolean {
  if (state.rush || fin) return false;
  const w = other(loser);
  return !!w && w.hp > 0 && w.state !== S.KO && w.rounds + 1 >= ROUNDS_TO_WIN;
}

function showHint(w: Fighter): void {
  const cpu = state.mode1P && w === state.P2;
  if (cpu) return;
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'finhint';
    document.getElementById('hud')?.appendChild(hint);
  }
  const side = w === state.P1 ? BINDINGS.p1 : BINDINGS.p2;
  const key = keyLabel(side.keys.power[0]);
  hint.innerHTML = `<b>${scriptFor(w).name}</b> get close · press <kbd>${key}</kbd> (OVERDRIVE)`;
  hint.classList.add('on');
}

function hideHint(): void {
  hint?.classList.remove('on');
}

export function beginFinish(loser: Fighter): void {
  const winner = other(loser);
  if (!winner) return;
  fin = {
    winner, loser, script: scriptFor(winner), phase: 'dazed', t: 0, dir: 1,
    called: false, cpu: null, done: new Set(), ghost: null, from: 0,
  };
  fin.script.prepare?.(fin);
  loser.hp = 0;
  loser.dazed = true;
  loser.launched = false;
  loser.flip = 0;
  loser.vy = Math.min(loser.vy, 0);
  loser.vx *= 0.35;
  enterState(loser, S.HITSTUN);
  loser.stunTime = 1e9;
  retireSwing(winner);
  announce('FINISH THEM!', 1900, 'warn');
  setMood(0.5, 0.32);                              // the stage goes dark around them
  Sfx.finishSting();
  Music.duck(0.55, 1.2);
  addTrauma(0.35);
  showHint(winner);
}

/** Whatever the winner was doing when the bar emptied is over; the moment is theirs to choose. */
function retireSwing(f: Fighter): void {
  if (f.state === S.PUNCH || f.state === S.KICK) enterState(f, f.grounded ? S.IDLE : S.JUMP);
}

/** An ordinary blow landed on the standing loser: collision.ts takes it from here as a K.O. */
export function endFinish(): void {
  if (!fin) return;
  cleanup(fin);
  setMood(0, 0);
  fin.loser.dazed = false;
  fin = null;
  hideHint();
}

/** Nobody finished them: they go down on their own. */
function collapse(): void {
  if (!fin) return;
  const l = fin.loser;
  l.dazed = false;
  cleanup(fin);
  fin = null;
  setMood(0, 0);
  hideHint();
  enterState(l, S.KO);
  knockout(l);
  spray(_c.set(l.x, 1.4, PLANE_Z), -l.face, 24, 4);
  pool(l.x, 0.7);
}

export function resetFinish(): void {
  if (fin) {
    fin.loser.dazed = false;
    cleanup(fin);
  }
  fin = null;
  hideHint();
  setCinematic(null);
  setMood(0, 0);
  document.body.classList.remove('cine');
}

function startFatality(): void {
  if (!fin) return;
  const { winner, loser } = fin;
  fin.phase = 'fatality';
  fin.t = 0;
  fin.dir = Math.sign(loser.x - winner.x) || 1;
  hideHint();
  clearAnnounce();                                 // FINISH THEM has been answered
  document.body.classList.add('cine');             // the HUD steps out of the shot
  retireSwing(winner);
  enterState(winner, S.IDLE);
  winner.lockFace = fin.dir;
  winner.face = fin.dir;
  loser.face = -fin.dir;
  // the first cut: low, behind the winner's shoulder, looking up as they close in
  setCinematic({ x: (winner.x + loser.x) / 2, y: 2.2, dist: 7.4, yaw: -fin.dir * 0.3, h: -1.1 });
  setMood(0.72, 0.18);                             // the world drains to grey; the blood does not care
  impact('super');
  Sfx.fatal();
  Music.duck(0.85, 3.5);
}

/*
  The CPU as the winner. It walks in, lets the moment sit, and then mostly
  goes for the fatality — a CPU that never did one would hide the feature from
  anyone playing alone.
*/
export function finishBotIntent(f: Fighter, foe: Fighter): Intent {
  const i = blankIntent();
  if (!fin || fin.phase !== 'dazed' || fin.winner !== f) return i;
  const gap = foe.x - f.x;
  const dist = Math.abs(gap);
  if (dist > FINISH.reach - 1.4) {
    i.move = gap > 0 ? 1 : -1;
    return i;
  }
  if (fin.t < FINISH.cpuDelay) return i;
  fin.cpu ??= Math.random() < FINISH.cpuFatality ? 'fatal' : 'hit';
  if (fin.cpu === 'fatal') i.powerDown = true;
  else i.kickDown = true;
  return i;
}

/** One step. Reads the winner's OVERDRIVE press while they stand over the loser. */
export function stepFinish(i1: Intent, i2: Intent, dt: number): void {
  if (!fin) return;
  fin.t += dt;
  const { winner, loser } = fin;

  if (fin.phase === 'dazed') {
    // a trade that dropped both: no finish, settleKO calls it a double
    if (winner.hp <= 0 || winner.state === S.KO) {
      endFinish();
      return;
    }
    const wi = winner === state.P1 ? i1 : i2;
    const ready = winner.grounded && (winner.state === S.IDLE || winner.state === S.WALK || winner.state === S.BLOCK);
    if (wi.powerDown && ready && Math.abs(winner.x - loser.x) < FINISH.reach) {
      wi.powerDown = false;
      startFatality();
      return;
    }
    if (fin.t > FINISH.window) collapse();
    return;
  }

  if (fin.phase === 'fatality') {
    stepFatality(dt);
    return;
  }

  if (fin.t > fin.script.call + 1.7) {
    setCinematic(null);
    setMood(0, 0);
    document.body.classList.remove('cine');
  }
}

function place(f: Fighter, x: number, y: number): void {
  f.x = x;
  f.y = y;
  f.physicsBody?.teleport(x, y);
}

/** True the first time it is asked for a given key: each beat of a script fires once. */
function once(F: Finish, key: string): boolean {
  if (F.done.has(key)) return false;
  F.done.add(key);
  return true;
}

/** The winner dashes in to `gap` short of the loser, until `until`. */
function closeIn(F: Finish, dt: number, gap: number, until: number): void {
  const { winner: w, loser: l, dir } = F;
  l.vx = 0;
  if (F.t >= until) {
    w.vx = 0;
    return;
  }
  const tx = l.x - dir * gap;
  const step = (tx - w.x) * Math.min(1, 10 * dt);
  place(w, w.x + step, 0);
  w.vx = step / Math.max(dt, 1e-4);
  w.face = dir;
}

function wound(F: Finish, at: THREE.Vector3, dir: number, blood: number, power: number): void {
  const l = F.loser;
  l.flash = 1;
  l.white = FLASH_FRAMES;
  impact('heavy', { victim: l.slot === 0 ? 0 : 1, scale: 1.2 });
  spray(at, dir, blood, power);
  spawnStreaks(at, dir, 0xFFE2A8, 8);
  Sfx.crunch(l.x);
  Sfx.gore(1.1, l.x);
}

/** The fighter's own colours, for the pieces. */
function palette(f: Fighter): number[] {
  const d = f.def;
  return [d.plate, d.cloth, d.flesh, d.accent, 0x7a0a0a, 0x5a0606];
}

/** Everything a script might have built is thrown away with the finish. */
function cleanup(F: Finish): void {
  if (F.ghost) {
    F.ghost.removeFromParent();
    F.ghost.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m && !Array.isArray(m)) m.dispose();
    });
    F.ghost = null;
  }
  F.winner.lean.visible = true;
}

/*
  One fatality per fighter. Each is a script on the finish's own clock: the
  beats fire once, the camera cuts where the script says, and the FATALITY
  card goes up at `call`. `prepare` runs at FINISH THEM, so anything a
  script needs that has never been drawn is compiled then, not mid-fatality.
*/
interface Script {
  readonly name: string;
  readonly call: number;
  prepare?(F: Finish): void;
  step(F: Finish, dt: number): void;
  /** After the pose each step, for anything the pose would otherwise wipe. */
  paint?(F: Finish): void;
}

/* ── CINDERWARD · ASHEN OATH ─────────────────────────────────────────────
   Run through, lifted off the stones burning from the inside, and gone in a
   burst of blood and ash. */
const ASHEN = { close: 0.42, strike: 0.6, burst: 2.2 } as const;

const ashenOath: Script = {
  name: 'ASHEN OATH',
  call: 2.5,
  step(F, dt) {
    const { winner: w, loser: l, dir, t } = F;
    closeIn(F, dt, 1.45, ASHEN.close);
    if (t >= ASHEN.close && once(F, 'swing')) {
      enterState(w, S.KICK, MOVES.FATAL);
      Sfx.swish(1, w.x);
    }
    if (t >= ASHEN.strike && once(F, 'strike')) {
      setCinematic({ x: l.x, y: 2.6, dist: 6.9, yaw: dir * 0.62, h: -0.45 });
      wound(F, _c.set(l.x - dir * 0.3, 1.6, PLANE_Z + 0.2), dir, 46, 8.5);
      spawnRing(_c, 0xFF6A3A);
      Burst.emit(_c, 0xFF8A2A, 40, 7, 0.4);
    }
    if (t >= ASHEN.strike && t < ASHEN.burst) {
      const k = clamp((t - ASHEN.strike) / (ASHEN.burst - ASHEN.strike), 0, 1);
      setCinematic({ x: l.x, y: 2.6 + k * 1.5, dist: 6.9 + k * 1.1, yaw: dir * 0.62 - dir * k * 0.5, h: -0.45 + k * 0.3 });
      place(l, l.x + (Math.random() - 0.5) * k * k * 0.09, k * k * (3 - 2 * k) * 1.9);
      l.grounded = false;
      if (Math.random() < 0.35 + k * 0.6) {
        _c.set(l.x + (Math.random() - 0.5) * 0.9, l.y + 0.6 + Math.random() * 1.8, PLANE_Z);
        Burst.emit(_c, Math.random() < 0.3 ? 0xFFD27A : 0xFF7A2A, 2, 2 + k * 3, 0.6);
      }
      if (Math.random() < 0.12 + k * 0.2) spray(_c.set(l.x, l.y + 1.2, PLANE_Z), Math.random() < 0.5 ? 1 : -1, 2, 1.5);
      addTrauma(0.012 + k * 0.02);
    }
    if (t >= ASHEN.burst && once(F, 'burst')) {
      setCinematic({ x: l.x, y: 1.9, dist: 11.5, yaw: -dir * 0.22, h: 2.4 });
      _c.set(l.x, l.y + 1.3, PLANE_Z);
      l.lean.visible = false;
      l.body.visible = false;
      enterState(l, S.KO);
      knockout(l);
      spray(_c, 1, 120, 11);
      spray(_c, -1, 120, 11);
      pool(l.x, 1.7);
      pool(l.x + 1.1, 0.9);
      pool(l.x - 0.9, 0.8);
      Burst.emit(_c, 0xFF7A2A, 150, 12, 1.2);
      Burst.emit(_c, 0xFFD27A, 70, 8, 1);
      for (let n = 0; n < 3; n++) spawnRing(_c, n ? 0xFF4A2A : 0xFFE2A8);
      physics?.blast(_c, dir, 14, 9, 1);
      physics?.spawnDebris(_c.set(l.x, 1.2, PLANE_Z), dir, 26, 2.2);
      Sfx.gore(1.6, l.x);
      Sfx.bass(1.2, l.x);
      place(l, l.x, 0);
    }
  },
  paint(F) {
    if (F.t < ASHEN.strike || F.t >= ASHEN.burst) return;
    const l = F.loser;
    const k = clamp((F.t - ASHEN.strike) / (ASHEN.burst - ASHEN.strike), 0, 1);
    const flicker = 0.85 + Math.random() * 0.3;
    for (const m of l.modelMats ?? []) {
      m.color.multiplyScalar(1 - k * 0.7);                      // charring
      m.emissive.setRGB(1.9 * k * flicker, 0.62 * k * flicker, 0.12 * k);
    }
    for (const m of l.skin) m.emissive.setRGB(1.9 * k, 0.6 * k, 0.1 * k);
  },
};

/* ── PALE VIGIL · SOUL HARVEST ───────────────────────────────────────────
   The sabre goes in, and what comes out on it is not blood: a spectral copy
   of the loser is torn up out of the body and drawn into the Vigil, while the
   body left behind drains to ash-grey and drops. */
const SOUL = { close: 0.42, impale: 0.56, pull: 0.72, take: 1.95, drop: 2.05 } as const;

const soulHarvest: Script = {
  name: 'SOUL HARVEST',
  call: 2.55,
  prepare(F) {
    const l = F.loser;
    if (!l.model) return;
    const ghost = cloneSkinned(l.model);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x9FF6FF).multiplyScalar(1.6), transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    ghost.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = mat;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
      }
    });
    // parked inside the loser and all but invisible: built and compiled now, at FINISH THEM
    ghost.scale.setScalar(1e-4);
    scene.add(ghost);
    F.ghost = ghost;
  },
  step(F, dt) {
    const { winner: w, loser: l, dir, t } = F;
    closeIn(F, dt, 1.55, SOUL.close);
    if (t >= SOUL.close && once(F, 'thrust')) {
      enterState(w, S.PUNCH, MOVES.FATAL);
      Sfx.swish(1, w.x);
    }
    if (t >= SOUL.impale && once(F, 'impale')) {
      setCinematic({ x: l.x, y: 2.5, dist: 6.6, yaw: dir * 0.6, h: -0.5 });
      wound(F, _c.set(l.x - dir * 0.2, 1.7, PLANE_Z + 0.2), dir, 30, 6);
      spawnRing(_c, 0x9FF6FF);
      l.dazed = false;
    }
    const g = F.ghost;
    if (t >= SOUL.pull && t < SOUL.take && g && l.model) {
      const k = clamp((t - SOUL.pull) / (SOUL.take - SOUL.pull), 0, 1);
      if (once(F, 'rise')) setCinematic({ x: (w.x + l.x) / 2, y: 3.0, dist: 8.8, yaw: dir * 0.5, h: 0.3 });
      // the soul lifts out of the body and leans toward the one taking it
      l.model.updateWorldMatrix(true, false);
      l.model.matrixWorld.decompose(g.position, g.quaternion, g.scale);
      g.position.x += (w.x - l.x) * k * k * 0.55;
      g.position.y += k * 1.5;
      g.scale.multiplyScalar(1 + k * 0.08);
      const mats = new Set<THREE.Material>();
      g.traverse((o) => { const m = (o as THREE.Mesh).material; if (m && !Array.isArray(m)) mats.add(m); });
      for (const m of mats) (m as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(t * 22) * 0.08 + k * 0.35;
      if (Math.random() < 0.8) {
        _c.set(l.x + (Math.random() - 0.5) * 0.8, l.y + 0.8 + Math.random() * 1.6, PLANE_Z);
        Burst.emit(_c, 0x9FF6FF, 1, 1.6 + k * 2, 0.4);
      }
      place(l, l.x + (Math.random() - 0.5) * 0.05, 0);
      addTrauma(0.008);
    }
    if (t >= SOUL.take && once(F, 'take')) {
      if (g) g.scale.setScalar(1e-4);
      _c.set(w.x, 2.0, PLANE_Z);
      Burst.emit(_c, 0x9FF6FF, 90, 7, 0.8);
      Burst.emit(_c, 0xFFFFFF, 30, 5, 0.6);
      for (let n = 0; n < 2; n++) spawnRing(_c, 0x9FF6FF);
      Sfx.fatal();
      addTrauma(0.3);
    }
    if (t >= SOUL.drop && once(F, 'drop')) {
      enterState(l, S.KO);
      knockout(l);
      pool(l.x, 1.2);
    }
  },
  paint(F) {
    if (F.t < SOUL.pull) return;
    // the body the soul left: grey, and getting greyer
    const k = clamp((F.t - SOUL.pull) / (SOUL.take - SOUL.pull), 0, 1);
    for (const m of F.loser.modelMats ?? []) {
      const lum = m.color.r * 0.3 + m.color.g * 0.55 + m.color.b * 0.15;
      m.color.lerp(_grey.setRGB(lum * 0.55, lum * 0.55, lum * 0.6), k);
      m.emissive.setRGB(0.1 * (1 - k), 0.45 * (1 - k), 0.55 * (1 - k));
    }
  },
};

/* ── BRONZEMAW · GROUND POUND ────────────────────────────────────────────
   Picked up, slammed down on one side, over, down on the other, over, down
   again — and then the brute jumps and comes down on them with both feet. */
const POUND = { grab: 0.42, slams: [0.92, 1.42, 1.92], lift: 0.28, jump: 2.15, stomp: 2.6 } as const;

const groundPound: Script = {
  name: 'GROUND POUND',
  call: 3.05,
  step(F, dt) {
    const { winner: w, loser: l, dir, t } = F;
    closeIn(F, dt, 1.25, POUND.grab);
    if (t >= POUND.grab && once(F, 'grab')) {
      enterState(w, S.PUNCH, MOVES.FATAL);
      l.dazed = false;
      setCinematic({ x: w.x, y: 2.2, dist: 10, yaw: dir * 0.18, h: -0.7 });
      Sfx.block(l.x);
    }
    // three slams, alternating sides of the brute, each lifted overhead first
    for (let n = 0; n < POUND.slams.length; n++) {
      const at = POUND.slams[n]!;
      const side = n % 2 === 0 ? dir : -dir;
      const from = n === 0 ? l.x : w.x - side * 1.5;
      if (t >= at - POUND.lift && t < at) {
        const k = clamp((t - (at - POUND.lift)) / POUND.lift, 0, 1);
        const x = from + (w.x + side * 1.5 - from) * k;
        place(l, x, Math.sin(k * Math.PI) * 3.0 + (1 - k) * 0.2);
        l.grounded = false;
        if (once(F, `swing${n}`)) {
          enterState(w, n % 2 ? S.PUNCH : S.KICK, MOVES.FATAL);
          l.flip = 0.001;
          l.flipDir = side === dir ? -1 : 1;
          l.flipTime = POUND.lift;
        }
      }
      if (t >= at && once(F, `slam${n}`)) {
        place(l, w.x + side * 1.5, 0);
        l.grounded = true;
        l.flip = 0;
        l.downT = 2;
        _c.set(l.x, 0.6, PLANE_Z + 0.2);
        wound(F, _c, side, 22 + n * 10, 5 + n);
        Burst.emit(_c.set(l.x, 0.15, PLANE_Z), 0xC9BCA2, 40, 6, 1);
        spawnRing(_c, 0xE8DCC4);
        physics?.spawnDebris(_c, side, 8, 1.2);
        Sfx.bass(1.1, l.x);
        addTrauma(0.45);
      }
    }
    // up, over, and down with both feet
    if (t >= POUND.jump && t < POUND.stomp) {
      const k = clamp((t - POUND.jump) / (POUND.stomp - POUND.jump), 0, 1);
      if (once(F, 'jump')) {
        setCinematic({ x: l.x, y: 0.8, dist: 7.4, yaw: -dir * 0.3, h: 4.2 });
        enterState(w, S.JUMP);
        F.from = w.x;
      }
      place(w, F.from + (l.x - F.from) * k, Math.sin(k * Math.PI) * 3.4);
      w.grounded = false;
    }
    if (t >= POUND.stomp && once(F, 'stomp')) {
      place(w, l.x, 0);
      w.grounded = true;
      enterState(w, S.IDLE);
      w.land = 1;
      enterState(l, S.KO);
      knockout(l);
      _c.set(l.x, 0.4, PLANE_Z + 0.2);
      spray(_c, 1, 110, 9);
      spray(_c, -1, 110, 9);
      gib(_c, dir, palette(l), 8, 5);
      pool(l.x, 2.0);
      Burst.emit(_c, 0xC9BCA2, 60, 8, 1.2);
      for (let n = 0; n < 2; n++) spawnRing(_c, 0xFFE2A8);
      physics?.blast(_c, dir, 12, 8, 1);
      Sfx.gore(1.7, l.x);
      Sfx.bass(1.3, l.x);
    }
    // and steps off, so the camera can see what is left
    if (t >= POUND.stomp + 0.3 && t < POUND.stomp + 0.55) {
      const k = (t - POUND.stomp - 0.3) / 0.25;
      place(w, l.x - dir * 1.4 * k, 0);
      w.vx = -dir * 5;
    }
    if (t >= POUND.stomp + 0.55 && once(F, 'off')) w.vx = 0;
  },
  paint(F) {
    if (F.t < POUND.stomp) return;
    // flattened, and it stays that way
    const l = F.loser;
    if (l.model && l.modelFit) l.model.scale.set(l.modelFit * 1.45, l.modelFit * 0.16, l.modelFit * 1.45);
    for (const m of l.modelMats ?? []) m.color.lerp(_blood, 0.35);
  },
};

/* ── NOCTURNE · THOUSAND CUTS ────────────────────────────────────────────
   Gone, and then everywhere at once: seven cuts from every side, too fast to
   follow, and a moment of stillness before the body comes apart. */
const CUTS = { vanish: 0.08, first: 0.42, every: 0.19, count: 7, show: 0.11, settle: 1.95, apart: 2.35 } as const;

const thousandCuts: Script = {
  name: 'THOUSAND CUTS',
  call: 2.8,
  step(F) {
    const { winner: w, loser: l, dir, t } = F;
    l.vx = w.vx = 0;
    if (t >= CUTS.vanish && once(F, 'vanish')) {
      Burst.emit(_c.set(w.x, 1.5, PLANE_Z), w.def.accent, 40, 5, 0.6);
      w.lean.visible = false;
      l.dazed = false;
      Sfx.whoosh(w.x);
    }
    const orbit = dir * 0.6 + clamp(t - CUTS.first, 0, 2) * 1.1;
    if (t >= CUTS.first && t < CUTS.settle) setCinematic({ x: l.x, y: 2.3, dist: 7.2, yaw: orbit, h: -0.2 });
    for (let n = 0; n < CUTS.count; n++) {
      const at = CUTS.first + n * CUTS.every;
      if (t >= at && once(F, `cut${n}`)) {
        const side = n % 2 === 0 ? -dir : dir;
        const high = n === 3 || n === 5;
        place(w, l.x + side * 1.3, high ? 1.4 : 0);
        w.face = -side;
        w.lean.visible = true;
        enterState(w, n % 2 ? S.PUNCH : S.KICK, MOVES.FATAL);
        _c.set(l.x, 1.2 + Math.random() * 1.2, PLANE_Z + 0.2);
        wound(F, _c, -side, 16, 6);
        spawnStreaks(_c, -side, w.def.lite ? 0xDCB6FF : w.def.accent, 10);
        Burst.emit(_c, w.def.accent, 14, 5, 0.3);
        l.hitDir = -side;
      }
      if (t >= at + CUTS.show && once(F, `hide${n}`) && n < CUTS.count - 1) {
        Burst.emit(_c.set(w.x, w.y + 1.4, PLANE_Z), w.def.accent, 12, 3, 0.4);
        w.lean.visible = false;
      }
    }
    if (t >= CUTS.settle && once(F, 'settle')) {
      // back on the ground behind them, blade away; the loser has not realised yet
      place(w, l.x - dir * 1.8, 0);
      w.face = dir;
      w.lean.visible = true;
      enterState(w, S.IDLE);
      setCinematic({ x: l.x - dir * 0.6, y: 2.2, dist: 7.6, yaw: dir * 0.5, h: -0.3 });
      Sfx.swish(0.6, w.x);
    }
    if (t >= CUTS.apart && once(F, 'apart')) {
      setCinematic({ x: l.x, y: 1.6, dist: 10.5, yaw: -dir * 0.25, h: 2.2 });
      _c.set(l.x, 1.5, PLANE_Z);
      l.lean.visible = false;
      l.body.visible = false;
      enterState(l, S.KO);
      knockout(l);
      gib(_c, dir, palette(l), 24, 6.5);
      spray(_c, 1, 90, 8);
      spray(_c, -1, 90, 8);
      pool(l.x, 1.6);
      Sfx.gore(1.6, l.x);
      Sfx.bass(1, l.x);
    }
  },
};

const SCRIPTS: Readonly<Record<string, Script>> = {
  cinderward: ashenOath,
  palevigil: soulHarvest,
  bronzemaw: groundPound,
  nocturne: thousandCuts,
};

export function scriptFor(f: Fighter): Script {
  return SCRIPTS[f.def.id] ?? ashenOath;
}

/** The fatality's names, for the move list. */
export const FATALITY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SCRIPTS).map(([id, s]) => [id, s.name]),
);

const _grey = new THREE.Color();
const _blood = new THREE.Color(0x5a0606);

function stepFatality(dt: number): void {
  const F = fin!;
  F.script.step(F, dt);
  if (F.t >= F.script.call && !F.called) {
    F.called = true;
    F.phase = 'done';
    // a body the script left in the air comes down
    if (F.loser.y > 0.01 && F.loser.lean.visible) place(F.loser, F.loser.x, 0);
    endRound(F.winner, 'FATALITY');
    // endRound calls the reason as a plain slam; the fatality gets its own card
    announce(`FATALITY\n${F.winner.def.name} WINS`, 3400, 'fatal');
  }
}

/* A script paints after the pose, which resets every material each step from
   its base colour; painting before would be wiped the same frame. */
export function paintFinish(): void {
  if (!fin || fin.phase === 'dazed') return;
  fin.script.paint?.(fin);
}
