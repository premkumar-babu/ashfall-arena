import * as THREE from 'three/webgpu';
import { A, type FighterState } from '../config/constants';
import type { FighterDef } from '../config/roster';
import { clamp, damp } from '../core/math';
import { CLIPS, clipUrl, loadModel, manifestEntry } from '../assets/loader';
import { Assets } from '../assets/pipeline';
import type { Assist } from '../game/assist-rig';
import type { Fighter } from '../game/fighter';
import { assistRigs, rigs } from '../game/rigs';
import { driveBones, isBone, normBone } from './bones';
import type { AnimSlot, AnimTarget } from './types';

type ClipTable = Partial<Record<AnimSlot, string>>;
type Pool = readonly [readonly AnimTarget[], readonly AnimTarget[]];

/* Clip-name fragments mapped onto the state machine. Mixamo names a merged
   download after the animation ("High Kick", "Hit Reaction"). */
const ANIM_MAP: Readonly<Record<FighterState, readonly string[]>> = {
  IDLE: ['idle', 'breath', 'stand', 'fighting stance'],
  WALK: ['walk', 'walking', 'strafe'],
  JUMP: ['jump', 'run'],
  PUNCH: ['punch', 'jab', 'slash', 'sword', 'cut', 'stab', 'attack'],
  KICK: ['kick', 'roundhouse'],
  BLOCK: ['block', 'guard', 'brace'],
  HITSTUN: ['hit', 'hurt', 'impact', 'stagger', 'react'],
  KO: ['death', 'dying', 'fall', 'knock'],
};

/** Unmatched clips (every single Mixamo download is called "mixamo.com") are dealt out in this order. */
const CLIP_ORDER: readonly FighterState[] = ['IDLE', 'KICK', 'PUNCH', 'HITSTUN', 'KO', 'WALK'];
const ONE_SHOT: readonly AnimSlot[] = ['PUNCH', 'KICK', 'HITSTUN', 'KO', 'LAND'];

/* Mixamo character-only exports still carry a stub track — "mixamo.com" at
   0.03 s — which is a single bind-pose frame, not motion. Binding one looks
   identical to being frozen, so they are rejected. */
export const MIN_CLIP = 0.12;

/* A clip binds by track name and nothing else: authored against `Hips` on a
   model that calls it `mixamorigHips`, it attaches, plays and moves nothing.
   Returning null below this match ratio turns that silent failure into a
   reported one. */
const RETARGET_MIN = 0.3;

export function matchClip(name: string): FighterState | null {
  const n = name.toLowerCase();
  for (const slot of Object.keys(ANIM_MAP) as FighterState[]) {
    if (ANIM_MAP[slot].some((frag) => n.includes(frag))) return slot;
  }
  return null;
}

function setOneShots(target: AnimTarget): void {
  for (const slot of ONE_SHOT) {
    const a = target.actions?.[slot];
    if (!a) continue;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
  }
}

/* Dealing a leftover into a slot is a guess, not a match, so it is marked as a
   stand-in the shared library may replace later. */
function fillClipGaps(target: AnimTarget, leftovers: readonly THREE.AnimationAction[]): void {
  const actions = target.actions!;
  for (const action of leftovers) {
    const slot = CLIP_ORDER.find((s) => !actions[s]);
    if (!slot) break;
    actions[slot] = action;
    target.standIn[slot] = true;
  }
}

/** Which node does a track drive? Exporters write `Hips.quaternion`, `.bones[Hips].position`, `Armature/Hips.scale`. */
export function trackNodeName(name: string): string {
  const m = name.match(/\.bones\[([^\]]+)\]/);
  if (m) return m[1]!;
  let s = name.replace(/^\./, '');
  const dot = s.lastIndexOf('.');
  if (dot > 0) s = s.slice(0, dot);
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  return s;
}

/* ── shared animation library ───────────────────────────────────────────
   The KayKit cast ships bare rigged meshes and one library of clips authored
   against the same skeleton: four characters and one set of motion is a tenth
   of the download of each carrying a private walk cycle. The names below are
   clip names inside those files. */
export const ANIM_LIB = {
  root: 'assets/anim/',
  files: ['Rig_Medium_General.glb', 'Rig_Medium_MovementBasic.glb', 'Rig_Medium_CombatMelee.glb'],
  common: {
    IDLE: 'Melee_Unarmed_Idle',
    WALK: 'Walking_A',
    JUMP: 'Jump_Idle',
    PUNCH: 'Melee_Unarmed_Attack_Punch_A',
    KICK: 'Melee_Unarmed_Attack_Kick',
    BLOCK: 'Melee_Blocking',
    HITSTUN: 'Hit_A',
    KO: 'Death_A',
  } satisfies ClipTable,
  /* An armed fighter swinging a bare fist while holding a sword reads as broken
     even when nobody can say why: the two armed fighters get blade work. */
  perId: {
    cinderward: { IDLE: 'Melee_2H_Idle', PUNCH: 'Melee_1H_Attack_Stab', KICK: 'Melee_1H_Attack_Chop', BLOCK: 'Melee_Block' },
    palevigil: { IDLE: 'Melee_2H_Idle', PUNCH: 'Melee_1H_Attack_Slice_Horizontal', KICK: 'Melee_1H_Attack_Slice_Diagonal', BLOCK: 'Melee_Block' },
    bronzemaw: { KICK: 'Melee_2H_Attack_Chop', HITSTUN: 'Hit_B' },
    nocturne: { PUNCH: 'Melee_Dualwield_Attack_Stab', KICK: 'Melee_2H_Attack_Spin', KO: 'Death_B' },
  } as Readonly<Record<string, ClipTable>>,
  /* How a fighter gets around, beside the state machine's slots: a run cycle
     for anything faster than a walk, and a landing. Summons never land and
     have their own run, so these are the fighters' alone. The two light
     fighters get the looser, arms-back run. */
  loco: { RUN: 'Running_A', LAND: 'Jump_Land' } satisfies ClipTable,
  locoPerId: {
    palevigil: { RUN: 'Running_B' },
    nocturne: { RUN: 'Running_B' },
  } as Readonly<Record<string, ClipTable>>,
  /** Where a library clip beats whatever the model happened to ship with. */
  force: ['PUNCH', 'KICK', 'BLOCK', 'HITSTUN', 'KO'] as readonly FighterState[],
  /** Summons only ever idle, run in and strike. */
  assist: {
    IDLE: 'Melee_Unarmed_Idle',
    WALK: 'Running_A',
    PUNCH: 'Melee_1H_Attack_Chop',
    KICK: 'Melee_2H_Attack_Slice',
  } satisfies ClipTable,
};

class ClipLibrary {
  private readonly clips = new Map<string, THREE.AnimationClip>();
  /** Normalised bone name → the rest quaternion of the rig the clips were authored on. */
  private readonly rest = new Map<string, THREE.Quaternion>();
  private listeners: Array<() => void> = [];
  private pending = 0;
  private started = false;
  private settled = false;

  get count(): number {
    return this.clips.size;
  }

  get(name: string): THREE.AnimationClip | null {
    return this.clips.get(name) ?? null;
  }

  restOf(key: string): THREE.Quaternion | null {
    return this.rest.get(key) ?? null;
  }

  ready(fn: () => void): void {
    if (this.settled) fn();
    else this.listeners.push(fn);
  }

  load(): void {
    if (this.started) return;
    this.started = true;
    if (!ANIM_LIB.files.length) {
      this.finish();
      return;
    }
    for (const file of ANIM_LIB.files) Assets.expect(ANIM_LIB.root + file, 'motion');
    for (const file of ANIM_LIB.files) {
      this.pending++;
      const path = ANIM_LIB.root + file;
      const job = Assets.job(path, 'motion');
      loadModel(path, job.progress)
        .then((asset) => {
          job.done();
          for (const c of asset.animations) if (c.name && !this.clips.has(c.name)) this.clips.set(c.name, c);
          /* Without the rest pose the tracks are meaningless on any other
             skeleton: a rotation is only a pose relative to where the bone started. */
          asset.object.traverse((n) => {
            if (!isBone(n)) return;
            const k = normBone(n.name);
            if (!this.rest.has(k)) this.rest.set(k, n.quaternion.clone());
          });
          // the clips and rest pose are all that is kept; the library rig's meshes are freed
          Assets.release(path);
        })
        .catch(() => {
          job.fail();                   // a missing library file leaves those slots to the bone driver
        })
        .finally(() => {
          if (--this.pending === 0) this.finish();
        });
    }
  }

  reset(): void {
    this.clips.clear();
    this.rest.clear();
    this.listeners = [];
    this.pending = 0;
    this.started = this.settled = false;
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    const list = this.listeners;
    this.listeners = [];
    for (const fn of list) {
      try { fn(); } catch (err) { console.error('[anim] library listener failed', err); }
    }
  }
}

export const ClipLib = new ClipLibrary();

/*
  Retarget one library clip onto a skeleton it was not authored for.

  Copying tracks by name is not enough, and the failure is spectacular: the
  library rig is authored Z-up and exported Y-up, the Mixamo rig is authored
  Y-up, and a raw copy of the hip rotation lays the fighter flat on their back.

  Each key is taken out of the source bone's rest frame and put into the
  target's:  Qt = Rt · Rs⁻¹ · Qs.  Position and scale tracks are dropped: a
  pose is rotation plus the target rig's own bone lengths.
*/
const _rqS = new THREE.Quaternion();
const _rqK = new THREE.Quaternion();

function indexNodes(model: THREE.Object3D): { exact: Map<string, THREE.Object3D>; byNorm: Map<string, THREE.Object3D> } {
  const exact = new Map<string, THREE.Object3D>();
  const byNorm = new Map<string, THREE.Object3D>();
  model.traverse((n) => {
    if (!n.name) return;
    if (!exact.has(n.name)) exact.set(n.name, n);
    const k = normBone(n.name);
    if (!byNorm.has(k)) byNorm.set(k, n);
  });
  return { exact, byNorm };
}

function retargetLibClip(model: THREE.Object3D, clip: THREE.AnimationClip): THREE.AnimationClip | null {
  const { exact, byNorm } = indexNodes(model);
  const tracks: THREE.KeyframeTrack[] = [];
  let seen = 0;
  let hit = 0;

  for (const t of clip.tracks) {
    const full = String(t.name);
    const dot = full.lastIndexOf('.');
    const prop = dot > 0 ? full.slice(dot + 1) : 'quaternion';
    if (prop !== 'quaternion') continue;             // rotation only
    seen++;

    const node = trackNodeName(full);
    const key = normBone(node);
    const target = exact.get(node) ?? byNorm.get(key);
    if (!target) continue;
    hit++;

    const copy = t.clone();
    copy.name = `${target.name}.quaternion`;

    const sRest = ClipLib.restOf(key);
    const tRest = target.userData.restQ as THREE.Quaternion | undefined;
    if (sRest && tRest) {
      _rqS.copy(sRest).invert();
      const v = copy.values;
      for (let k = 0; k + 3 < v.length; k += 4) {
        _rqK.set(v[k]!, v[k + 1]!, v[k + 2]!, v[k + 3]!);
        _rqK.premultiply(_rqS);                       // into the source rest frame
        _rqK.premultiply(tRest);                      // and out into the target's
        v[k] = _rqK.x; v[k + 1] = _rqK.y; v[k + 2] = _rqK.z; v[k + 3] = _rqK.w;
      }
    }
    tracks.push(copy);
  }

  if (!tracks.length || !seen || hit / seen < RETARGET_MIN) return null;
  return new THREE.AnimationClip(clip.name || 'clip', clip.duration, tracks);
}

/** The bind pose, taken the moment a model lands and before anything poses it. */
export function captureRest(model: THREE.Object3D): void {
  model.traverse((n) => {
    if (isBone(n) && !n.userData.restQ) n.userData.restQ = n.quaternion.clone();
  });
}

/*
  Build an action set out of the library. A character's own idle, walk and
  jump are kept — they are what makes it read as that character — but for the
  forced combat slots the library always wins: a model exported for a
  cutscene brings a wave and a shrug, and those get dealt into PUNCH and BLOCK
  by the gap filler because something has to go there.
*/
export function applyLibraryClips(target: AnimTarget, table: ClipTable): boolean {
  if (target.libBound || !target.model || !ClipLib.count) return false;

  const need: Array<{ slot: AnimSlot; clip: THREE.AnimationClip }> = [];
  for (const slot of Object.keys(table) as AnimSlot[]) {
    const forced = (ANIM_LIB.force as readonly AnimSlot[]).includes(slot);
    if (!forced && target.actions?.[slot] && !target.standIn[slot]) continue;
    const src = ClipLib.get(table[slot]!);
    if (!src) continue;
    const re = retargetLibClip(target.model, src);
    if (re) need.push({ slot, clip: re });
  }
  if (!need.length) return false;

  target.mixer ??= new THREE.AnimationMixer(target.model);
  if (!target.actions) {
    target.actions = {};
    target.currentAction = null;
  }
  for (const { slot, clip } of need) {
    target.actions[slot] = target.mixer.clipAction(clip);
    target.standIn[slot] = false;
  }
  setOneShots(target);
  playAction(target, 'IDLE');
  target.libBound = true;
  return true;
}

export function libraryTable(def: FighterDef | null, isAssist: boolean): ClipTable {
  if (isAssist) return { ...ANIM_LIB.assist };
  return {
    ...ANIM_LIB.common, ...ANIM_LIB.loco,
    ...(def ? ANIM_LIB.perId[def.id] : undefined),
    ...(def ? ANIM_LIB.locoPerId[def.id] : undefined),
  };
}

/** Called from both ends of the race — a model landing, and the library finishing. Whichever is second does the work. */
export function bindLibraryToAll(): number {
  let bound = 0;
  for (const s of [0, 1] as const) {
    for (const f of rigs[s]) if (applyLibraryClips(f, libraryTable(f.def, false))) bound++;
    for (const a of assistRigs[s]) if (applyLibraryClips(a, libraryTable(null, true))) bound++;
  }
  return bound;
}

/* ── per-file clips from clips.json ─────────────────────────────────── */

function retargetClip(model: THREE.Object3D, clip: THREE.AnimationClip): THREE.AnimationClip | null {
  if (!clip.tracks.length) return null;
  const { exact, byNorm } = indexNodes(model);
  const tracks: THREE.KeyframeTrack[] = [];
  let hit = 0;
  for (const t of clip.tracks) {
    const full = String(t.name);
    const dot = full.lastIndexOf('.');
    const prop = dot > 0 ? full.slice(dot + 1) : 'quaternion';
    const node = trackNodeName(full);
    const target = exact.has(node) ? node : byNorm.get(normBone(node))?.name;
    if (!target) continue;
    hit++;
    const copy = t.clone();
    copy.name = `${target}.${prop}`;
    tracks.push(copy);
  }
  if (!tracks.length || hit / clip.tracks.length < RETARGET_MIN) return null;
  return new THREE.AnimationClip(clip.name || 'clip', clip.duration, tracks);
}

interface ClipEntry {
  readonly slot: FighterState;
  readonly clip: THREE.AnimationClip;
}

/** Attach externally supplied clips to an already-dressed fighter or summon. */
export function attachClips(target: AnimTarget, model: THREE.Object3D, entries: readonly ClipEntry[]): number {
  if (!entries.length) return 0;
  target.actions ??= {};
  target.mixer ??= new THREE.AnimationMixer(model);

  let added = 0;
  for (const { slot, clip } of entries) {
    if (clip.duration < MIN_CLIP) { CLIPS.rejected++; continue; }
    const fitted = retargetClip(model, clip);
    if (!fitted) { CLIPS.rejected++; continue; }
    target.actions[slot] = target.mixer.clipAction(fitted);
    added++;
  }
  if (!added) return 0;

  setOneShots(target);
  // borrow only from slots that actually arrived
  const borrow: ReadonlyArray<readonly [FighterState, FighterState]> = [
    ['KICK', 'PUNCH'], ['PUNCH', 'KICK'], ['BLOCK', 'IDLE'], ['WALK', 'IDLE'], ['JUMP', 'WALK'],
  ];
  for (const [to, from] of borrow) {
    if (target.actions[to] || !target.actions[from]) continue;
    target.actions[to] = target.actions[from];
    target.standIn[to] = true;
  }
  if (target.actions.IDLE) playAction(target, 'IDLE');
  return added;
}

/* Fetch every manifest clip for one character, then hand the set to both slot
   copies — an AnimationClip is data, so one clip drives two skeletons. */
export function loadCharacterClips(paths: readonly string[], pool: Pool, onChange: () => void): void {
  if (!CLIPS.manifest) return;
  paths.forEach((path, index) => {
    const files = manifestEntry(path)?.clips;
    if (!files) return;
    const slots = Object.keys(files) as FighterState[];
    if (!slots.length) return;

    void Promise.all(
      slots.map((slot) =>
        loadModel(clipUrl(files[slot]!))
          .then((asset) => asset.animations.map((clip): ClipEntry => ({ slot, clip })))
          .catch(() => { CLIPS.missing++; return [] as ClipEntry[]; }),
      ),
    ).then((groups) => {
      const best = new Map<FighterState, ClipEntry>();
      for (const e of groups.flat()) {
        const prev = best.get(e.slot);
        if (!prev || e.clip.duration > prev.clip.duration) best.set(e.slot, e);
      }
      const list = [...best.values()];
      for (const s of [0, 1] as const) {
        const target = pool[s][index];
        if (!target?.model) continue;
        const n = attachClips(target, target.model, list);
        if (s === 0) CLIPS.added += n;             // count the set once, not per slot
      }
      onChange();
    });
  });
}

/*
  Bind a mixer and map a model's own clips onto states. Returns how many stub
  clips were rejected. A model with no usable clips still gets a mixer: the
  library needs one to retarget onto, and an early return here once left a
  loaded mesh in its T-pose with the primitive rig already hidden.
*/
export function bindClips(target: AnimTarget, model: THREE.Object3D, animations: readonly THREE.AnimationClip[]): number {
  target.actions = {};
  target.standIn = {};
  target.currentAction = null;
  target.mixer = new THREE.AnimationMixer(model);

  let stubs = 0;
  const usable = animations.filter((clip) => {
    if (clip.duration >= MIN_CLIP) return true;
    stubs++;
    return false;
  });
  if (!usable.length) return stubs;

  const actions = target.actions;
  const leftovers: THREE.AnimationAction[] = [];
  for (const clip of usable) {
    const action = target.mixer.clipAction(clip);
    const slot = matchClip(clip.name);
    if (slot && !actions[slot]) actions[slot] = action;
    else leftovers.push(action);
  }
  fillClipGaps(target, leftovers);
  setOneShots(target);

  actions.KICK ??= actions.PUNCH;
  actions.PUNCH ??= actions.KICK;
  actions.BLOCK ??= actions.IDLE;
  actions.WALK ??= actions.IDLE;
  actions.JUMP ??= actions.WALK;

  playAction(target, 'IDLE');               // idle runs on the select screen
  return stubs;
}

/* ── playback ─────────────────────────────────────────────────────────── */

/* A punch has to be on screen the frame it is thrown or the animation is lying
   about the frame data, so combat states cut in nearly hard. */
const FADE = { fast: 0.06, normal: 0.15 } as const;
const FADE_FAST: ReadonlySet<FighterState> = new Set(['PUNCH', 'KICK', 'HITSTUN', 'KO']);

export function playAction(target: AnimTarget, slot: AnimSlot): void {
  if (!target.mixer || !target.actions) return;
  const next = target.actions[slot] ?? target.actions.IDLE;
  if (!next || next === target.currentAction) return;
  const dur = FADE_FAST.has(slot as FighterState) || slot === 'LAND' ? FADE.fast : FADE.normal;
  const prev = target.currentAction;

  next.reset().setEffectiveWeight(1).play();
  /* Walk into run and back: start the new cycle at the same point of the
     stride the old one had reached, so the feet do not swap mid-blend. */
  const acts = target.actions;
  const cycle = (a: THREE.AnimationAction | null | undefined): boolean => !!a && (a === acts.WALK || a === acts.RUN);
  if (prev && cycle(prev) && cycle(next)) {
    const phase = (prev.time / prev.getClip().duration) % 1;
    next.time = (phase < 0 ? phase + 1 : phase) * next.getClip().duration;
  }
  /* crossFadeTo ties both weights to one clock so they always sum to 1. Two
     independent fades briefly sum to less, and the skeleton sags toward its
     rest pose mid-blend — visible on a hit reaction. */
  if (prev) prev.crossFadeTo(next, dur, false);
  else next.fadeIn(dur);
  target.currentAction = next;
}

function stopActions(target: AnimTarget): void {
  if (!target.actions) return;
  for (const a of Object.values(target.actions)) a?.stop();
  target.currentAction = null;
}

/* ── locomotion ──────────────────────────────────────────────────────────
   The state machine only knows IDLE, WALK and JUMP. Played as-is, a fighter
   crossing the stage at full speed ran the walking clip at its authored rate
   while the root slid underneath it — feet skating over the stones, which is
   most of what makes a character read as a toy being pushed around. So the
   moving states pick their clip from the speed actually being travelled, and
   play it at the rate that keeps the planted foot planted. */

/** Run takes over from walk around the geometric mean of their two gait speeds; the gap is hysteresis. */
const RUN_ON = 1.1;
const RUN_OFF = 0.9;
/* Rate limits, so a creep or a dash does not play a cycle at a silly speed.
   The KayKit cast is chibi — a stride is barely a quarter of their height — so
   a full sprint wants the run near three times over. Past the cap the feet
   slide a little rather than blur. */
const RATE = { WALK: [0.5, 2.2], RUN: [0.8, 3.0] } as const;
/** A hard landing shows the landing clip for this long, sped up, unless the fighter is already moving off. */
const LAND = { time: 0.3, rate: 1.7, minImpact: 0.3, maxSpeed: 2.5 } as const;
/** World units per second at rate 1, used only if a rig's feet cannot be found. */
const GAIT_FALLBACK = { WALK: 2.2, RUN: 5.0 } as const;

const gaitCache = new WeakMap<THREE.AnimationAction, number>();
const _gw = new THREE.Vector3();

/*
  How fast a cycle travels at rate 1. The library clips are in place — the
  root never moves — so the planted foot slides backward at exactly the speed
  the body should be going forward. Sampling the lower foot through one loop
  measures that directly off the rig, per fighter, with that fighter's own
  proportions and scale, instead of a number tuned by eye for one of them.
*/
function measureGait(f: Fighter, clip: THREE.AnimationClip): number {
  const model = f.model;
  const frame = model?.parent;
  if (!model || !frame) return 0;
  const feet: THREE.Object3D[] = [];
  const saved: Array<[THREE.Object3D, THREE.Quaternion]> = [];
  model.traverse((n) => {
    if (!isBone(n)) return;
    saved.push([n, n.quaternion.clone()]);
    const k = normBone(n.name);
    if (k === 'leftfoot' || k === 'rightfoot') feet.push(n);
  });
  if (feet.length < 2) return 0;

  const probe = new THREE.AnimationMixer(model);
  probe.clipAction(clip).play();
  frame.updateWorldMatrix(true, false);
  const N = 48;
  const step = clip.duration / N;
  const path: Array<[THREE.Vector3, THREE.Vector3]> = [];
  for (let i = 0; i <= N; i++) {
    probe.setTime(i * step);
    model.updateMatrixWorld(true);
    const a = frame.worldToLocal(feet[0]!.getWorldPosition(_gw)).clone();
    const b = frame.worldToLocal(feet[1]!.getWorldPosition(_gw)).clone();
    path.push([a, b]);
  }
  probe.stopAllAction();
  probe.uncacheRoot(model);
  for (const [n, q] of saved) n.quaternion.copy(q);

  /* The lower foot is the planted one, and its backward travel is the body's
     forward speed. Around each footfall the swinging foot dips below the
     planted one for a sample or two while still moving forward; counting that
     as negative travel undercounted a run by a third, so only backward travel
     is summed. */
  let travel = 0;
  for (let i = 0; i < N; i++) {
    const [a0, b0] = path[i]!;
    const [a1, b1] = path[i + 1]!;
    const k = a0.y + a1.y <= b0.y + b1.y ? 0 : 1;
    const p0 = k === 0 ? a0 : b0;
    const p1 = k === 0 ? a1 : b1;
    travel += Math.max(0, p0.z - p1.z);
  }
  return (travel / clip.duration) * f.root.scale.x;
}

function gait(f: Fighter, slot: 'WALK' | 'RUN'): number {
  const a = f.actions?.[slot];
  if (!a) return GAIT_FALLBACK[slot];
  let v = gaitCache.get(a);
  if (v === undefined) {
    v = measureGait(f, a.getClip());
    if (!(v > 0.4)) v = GAIT_FALLBACK[slot];
    gaitCache.set(a, v);
  }
  return v;
}

/** Which clip the fighter's body should be showing, which is not always the state it is in. */
function bodySlot(f: Fighter, dt: number): AnimSlot {
  const air = !f.grounded;
  if (f.wasAir && !air && f.land > LAND.minImpact) f.landT = LAND.time;
  f.wasAir = air;
  if (f.landT > 0) f.landT = Math.max(0, f.landT - dt);

  const s = f.state;
  if (s !== 'IDLE' && s !== 'WALK' && s !== 'JUMP') return s;
  if (air) return 'JUMP';

  const acts = f.actions!;
  const speed = Math.abs(f.vx);
  const forward = Math.sign(f.vx) === f.face;
  if (f.dashTime > 0) return forward && acts.RUN ? 'RUN' : 'JUMP';     // a backdash reads as a hop
  if (f.landT > 0 && speed < LAND.maxSpeed && acts.LAND) return 'LAND';
  if (s === 'IDLE' || speed < 0.35) {
    f.running = false;
    return 'IDLE';
  }
  if (!forward || !acts.RUN) {
    f.running = false;
    return 'WALK';
  }
  const mid = Math.sqrt(gait(f, 'WALK') * gait(f, 'RUN'));
  f.running = speed > mid * (f.running ? RUN_OFF : RUN_ON);
  return f.running ? 'RUN' : 'WALK';
}

/** Cycles play at the rate that matches the ground being covered; backwards for a backpedal. */
function setRate(f: Fighter, slot: AnimSlot): void {
  const a = f.actions?.[slot];
  if (!a) return;
  if (slot === 'WALK' || slot === 'RUN') {
    const [lo, hi] = RATE[slot];
    const dir = f.vx !== 0 && Math.sign(f.vx) !== f.face ? -1 : 1;
    a.timeScale = clamp(Math.abs(f.vx) / gait(f, slot), lo, hi) * dir;
  } else {
    a.timeScale = slot === 'LAND' ? LAND.rate : 1;
  }
}

/** Measured gait speeds, for tuning from the console. */
export function gaitReport(f: Fighter): Record<string, number> {
  return { walk: +gait(f, 'WALK').toFixed(2), run: +gait(f, 'RUN').toFixed(2), top: f.def.speed };
}

/* Per state, not all-or-nothing. Where a clip exists for the current state
   the mixer owns the skeleton; where one does not, every action is stopped so
   the mixer writes nothing and the bone driver takes that state back. */
export function driveMixer(f: Fighter, dt: number, t: number): void {
  if (f.mixer) {
    const slot = f.actions ? bodySlot(f, dt) : f.state;
    if (f.actions?.[slot]) {
      playAction(f, slot);
      setRate(f, slot);
      f.mixer.update(dt);
      return;
    }
    if (f.currentAction) stopActions(f);
    f.mixer.update(dt);
  }
  if (f.boneRig) driveBones(f, t);
}

function assistAnimSlot(a: Assist): FighterState {
  if (a.state === A.STRIKE) return a.def.pattern === 'slam' ? 'KICK' : 'PUNCH';
  if (a.state === A.RUSH || a.state === A.RETREAT) return 'WALK';
  return 'IDLE';
}

export function driveAssistMixer(a: Assist | null, dt: number): void {
  if (!a) return;
  if (a.mixer) {
    playAction(a, assistAnimSlot(a));
    a.mixer.update(dt);
  }
  poseAssistModel(a, dt);
}

/* Body-level performance for a loaded summon: wind-up, lunge or overhead
   drive, and recoil. Full strength with no usable clips, a subtle overlay
   with them — so real motion leads and this only adds weight. */
function poseAssistModel(a: Assist, dt: number): void {
  const m = a.model;
  if (!m) return;

  const w = a.mixer ? 0.3 : 1;
  let pitch = 0;
  let roll = 0;
  let lift = 0;
  let punch = 1;

  if (a.state === A.RUSH) {
    pitch = -0.30;
    lift = Math.abs(Math.sin(a.t * 13)) * 0.09;
  } else if (a.state === A.STRIKE) {
    const slam = a.def.pattern === 'slam';
    const k = clamp(a.t / (slam ? 0.90 : 0.62), 0, 1);
    const swell = Math.sin(k * Math.PI);
    if (slam) {
      pitch = -0.55 + k * 1.30;                    // coil up, then drive down
      lift = swell * 0.30;
      punch = 1 + swell * 0.16;
    } else {
      pitch = -0.62 * swell;                       // lunge out and back
      roll = a.dir * swell * 0.55;
      punch = 1 + swell * 0.20;
    }
  } else if (a.state === A.RETREAT) {
    pitch = 0.26;
  }

  m.rotation.x = damp(m.rotation.x, pitch * w, 15, dt);
  m.rotation.z = damp(m.rotation.z, roll * w, 15, dt);
  m.rotation.y = a.baseYaw;
  m.position.y = damp(m.position.y, a.baseY + lift * w, 13, dt);
  m.scale.setScalar(damp(m.scale.x, a.baseScale * (1 + (punch - 1) * w), 13, dt));
}
