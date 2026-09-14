import * as THREE from 'three/webgpu';
import { A, type FighterState } from '../config/constants';
import type { FighterDef } from '../config/roster';
import { clamp, damp } from '../core/math';
import { CLIPS, clipUrl, loadModel, manifestEntry } from '../assets/loader';
import type { Assist } from '../game/assist-rig';
import type { Fighter } from '../game/fighter';
import { assistRigs, rigs } from '../game/rigs';
import { driveBones, isBone, normBone } from './bones';
import type { AnimTarget } from './types';

type ClipTable = Partial<Record<FighterState, string>>;
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
const ONE_SHOT: readonly FighterState[] = ['PUNCH', 'KICK', 'HITSTUN', 'KO'];

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
    for (const file of ANIM_LIB.files) {
      this.pending++;
      loadModel(ANIM_LIB.root + file)
        .then((asset) => {
          for (const c of asset.animations) if (c.name && !this.clips.has(c.name)) this.clips.set(c.name, c);
          /* Without the rest pose the tracks are meaningless on any other
             skeleton: a rotation is only a pose relative to where the bone started. */
          asset.object.traverse((n) => {
            if (!isBone(n)) return;
            const k = normBone(n.name);
            if (!this.rest.has(k)) this.rest.set(k, n.quaternion.clone());
          });
        })
        .catch(() => { /* a missing library file leaves those slots to the bone driver */ })
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

  const need: Array<{ slot: FighterState; clip: THREE.AnimationClip }> = [];
  for (const slot of Object.keys(table) as FighterState[]) {
    const forced = ANIM_LIB.force.includes(slot);
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
  return { ...ANIM_LIB.common, ...(def ? ANIM_LIB.perId[def.id] : undefined) };
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

export function playAction(target: AnimTarget, slot: FighterState): void {
  if (!target.mixer || !target.actions) return;
  const next = target.actions[slot] ?? target.actions.IDLE;
  if (!next || next === target.currentAction) return;
  const dur = FADE_FAST.has(slot) ? FADE.fast : FADE.normal;
  const prev = target.currentAction;

  next.reset().setEffectiveWeight(1).play();
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

/* Per state, not all-or-nothing. Where a clip exists for the current state
   the mixer owns the skeleton; where one does not, every action is stopped so
   the mixer writes nothing and the bone driver takes that state back. */
export function driveMixer(f: Fighter, dt: number, t: number): void {
  if (f.mixer) {
    if (f.actions?.[f.state]) {
      playAction(f, f.state);
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
