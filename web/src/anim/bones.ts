import * as THREE from 'three/webgpu';
import { S } from '../config/constants';
import { clamp } from '../core/math';
import type { Fighter } from '../game/fighter';
import { attackExtension, kickingLeg, slashing } from '../game/fsm';

/*
  Bone driving.

  A loaded model arrives fully rigged but inert: once its stub clips are
  rejected nothing moves its bones, so it stands in bind pose while only the
  model group travels. This aims the real limb bones from the same state
  machine that poses the primitive rig.

  Each bone is aimed by rotating its rest direction (taken from where its
  child bone sits) onto a desired direction, converted into the parent bone's
  space — which sidesteps having to know each rig's local axis convention.
*/

/* ── bone naming ────────────────────────────────────────────────────────
   Auto-riggers disagree on prefix (`mixamorigRightArm`), separator
   (`Right_Arm`), side-as-suffix (`upperarm_r`, `arm.R`) and what the upper arm
   is even called. Everything is normalised to one lowercase, separator-free,
   side-first form, and these aliases collapse the naming disagreements that
   survive that — which is what lets one animation library drive a cast rigged
   by three different tools. */
const BONE_ALIAS: Readonly<Record<string, string>> = {
  arm: 'upperarm', forearm: 'lowerarm', elbow: 'lowerarm',
  upleg: 'upperleg', thigh: 'upperleg',
  leg: 'lowerleg', calf: 'lowerleg', shin: 'lowerleg', knee: 'lowerleg',
  toebase: 'toes', toe: 'toes',
  spine1: 'chest', spine01: 'chest', spine02: 'chest',
  pelvis: 'hips',
};

export function normBone(name: string): string {
  let n = String(name)
    .replace(/^mixamorig\d*[:_]?/i, '')
    .replace(/^(bip\d*|bone|def|org|ctrl)[:_-]/i, '')
    .toLowerCase();

  // side may be a suffix (`hand_r`, `arm.R`) or a prefix (`RightArm`)
  let side = '';
  const suf = n.match(/^(.*?)[._\- ]?(r|l|right|left)$/);
  if (suf && suf[1]) {
    side = suf[2] === 'r' || suf[2] === 'right' ? 'right' : 'left';
    n = suf[1];
  } else {
    const pre = n.match(/^(right|left)[._\- ]?(.+)$/);
    if (pre) {
      side = pre[1]!;
      n = pre[2]!;
    }
  }

  n = n.replace(/[._\-\s:]/g, '');
  return side + (BONE_ALIAS[n] ?? n);
}

export type BoneSlot =
  | 'hips' | 'spine' | 'head'
  | 'armLead' | 'foreLead' | 'armRear' | 'foreRear'
  | 'legLead' | 'shinLead' | 'legRear' | 'shinRear';

/* Ordered most-specific-first. The first pattern in a slot's list that matches
   an unclaimed bone wins, and a bone fills only one slot — otherwise the loose
   thigh pattern would swallow the shin. */
const BONE_SLOTS: ReadonlyArray<readonly [BoneSlot, readonly RegExp[]]> = [
  ['hips', [/^hips$/, /^pelvis$/, /^root$/]],
  ['spine', [/^spine1$/, /^spine02$/, /^spine_01$/, /^chest$/, /^spine$/]],
  ['head', [/^neck$/, /^neck01$/, /^head$/]],
  ['armLead', [/^rightarm$/, /^rightupperarm$/, /^rightshoulderarm$/, /^rightupperarm01$/]],
  ['foreLead', [/^rightforearm$/, /^rightlowerarm$/, /^rightelbow$/]],
  ['armRear', [/^leftarm$/, /^leftupperarm$/, /^leftshoulderarm$/, /^leftupperarm01$/]],
  ['foreRear', [/^leftforearm$/, /^leftlowerarm$/, /^leftelbow$/]],
  ['legLead', [/^rightupleg$/, /^rightthigh$/, /^rightupperleg$/, /^righthip$/]],
  ['shinLead', [/^rightleg$/, /^rightcalf$/, /^rightshin$/, /^rightlowerleg$/, /^rightknee$/]],
  ['legRear', [/^leftupleg$/, /^leftthigh$/, /^leftupperleg$/, /^lefthip$/]],
  ['shinRear', [/^leftleg$/, /^leftcalf$/, /^leftshin$/, /^leftlowerleg$/, /^leftknee$/]],
];

export interface BoneRecord {
  readonly bone: THREE.Bone;
  /** Direction from this bone to its first child, in this bone's local space. */
  readonly rest: THREE.Vector3;
}

export type BoneRig = Partial<Record<BoneSlot, BoneRecord>>;

export interface NamedBone {
  readonly node: THREE.Bone;
  readonly key: string;
}

export function isBone(o: THREE.Object3D): o is THREE.Bone {
  return (o as Partial<THREE.Bone>).isBone === true;
}

export function collectBones(model: THREE.Object3D): NamedBone[] {
  const out: NamedBone[] = [];
  model.traverse((n) => {
    if (isBone(n)) out.push({ node: n, key: normBone(n.name) });
  });
  return out;
}

/** Find one bone by a pattern list, skipping any already claimed. */
export function pickBone(bones: readonly NamedBone[], patterns: readonly RegExp[], taken: ReadonlySet<string> | null): THREE.Bone | null {
  for (const p of patterns) {
    for (const b of bones) {
      if (taken?.has(b.node.uuid)) continue;
      if (p.test(b.key)) return b.node;
    }
  }
  return null;
}

function boneRecord(bone: THREE.Bone): BoneRecord {
  const child = bone.children.find(isBone);
  const rest = child && child.position.lengthSq() > 1e-8
    ? child.position.clone().normalize()
    : new THREE.Vector3(0, 1, 0);
  return { bone, rest };
}

export function buildBoneRig(model: THREE.Object3D): BoneRig | null {
  const bones = collectBones(model);
  if (!bones.length) return null;
  const found: BoneRig = {};
  const taken = new Set<string>();
  let hits = 0;
  for (const [slot, patterns] of BONE_SLOTS) {
    const node = pickBone(bones, patterns, taken);
    if (!node) continue;
    taken.add(node.uuid);
    found[slot] = boneRecord(node);
    hits++;
  }
  return hits >= 6 ? found : null;      // not a humanoid rig we recognise
}

const _pq = new THREE.Quaternion();
const _dv = new THREE.Vector3();

function aimBone(rec: BoneRecord | undefined, fx: number, fy: number, fz: number, face: number): void {
  if (!rec || !rec.bone.parent) return;
  rec.bone.parent.getWorldQuaternion(_pq);   // refreshes the ancestor chain
  _pq.invert();
  _dv.set(fx * face, fy, fz).normalize().applyQuaternion(_pq);
  rec.bone.quaternion.setFromUnitVectors(rec.rest, _dv);
}

type Dir = readonly [number, number, number];

function mixDir(a: Dir, b: Dir, k: number): Dir {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function aim(rec: BoneRecord | undefined, d: Dir, face: number): void {
  aimBone(rec, d[0], d[1], d[2], face);
}

export function driveBones(f: Fighter, t: number): void {
  const R = f.boneRig;
  if (!R) return;
  const face = f.face;

  const speed = Math.abs(f.vx) / f.def.speed;
  const stride = t * 9.5 + f.phase;
  const swing = Math.sin(stride) * 0.55 * speed;

  /* Idle life. Every neutral pose below is a constant direction, so without
     this the model holds one exact stance forever. A breath up the spine and a
     weight shift across the hips, both fading out as the fighter picks up
     speed so they never fight the walk cycle. */
  const calm = 1 - Math.min(1, speed * 1.6);
  const idleT = t * 1.9 + f.phase;
  const breath = Math.sin(idleT) * 0.045 * calm;
  const sway = Math.sin(idleT * 0.63 + 1.1) * 0.035 * calm;
  const punching = f.state === S.PUNCH;
  const slash = slashing(f);
  const kicking = kickingLeg(f);
  const raw = f.state === S.PUNCH || f.state === S.KICK ? attackExtension(f) : 0;
  const ext = clamp(raw, 0, 1);
  const draw = clamp(raw < 0 ? -raw / 0.22 : 0, 0, 1);   // the wind-up half
  const guard = f.state === S.BLOCK;
  const hurt = f.state === S.HITSTUN ? 1 : 0;
  const down = f.state === S.KO;
  const airborne = !f.grounded && !down ? 1 : 0;

  // ── torso: hips carry the weight shift, spine leads the blow ──
  aimBone(R.hips, (slash ? -0.10 + ext * 0.22 : 0) + f.vx * 0.012 + sway, 0.99, breath * 0.4, face);
  aimBone(R.spine, 0.10 + ext * 0.16 - hurt * 0.22 - draw * 0.14 + airborne * 0.10 + breath, 0.98, -sway * 0.8, face);
  aimBone(R.head, 0.06 - hurt * 0.3 + (slash ? ext * 0.14 : 0) - breath * 0.7, 0.99, sway * 1.4, face);

  // ── lead arm: guard stance driving out into the punch ──
  /* An armed fighter rests the blade across the body on a diagonal: the hand
     bone is what the sword hangs off, so the neutral forearm angle IS the
     weapon's resting angle. */
  let leadArm: Dir = f.def.armed ? [0.34, -0.84 + breath * 0.5, 0.26 + sway] : [0.28, -0.88 + breath * 0.5, 0.22 + sway];
  let leadFore: Dir = f.def.armed ? [0.74, 0.46 - breath, 0.30] : [0.62, 0.62 - breath, 0.18];
  if (guard) { leadArm = [0.10, -0.80, 0.35]; leadFore = [0.30, 0.86, 0.30]; }
  if (hurt) { leadArm = [-0.30, -0.80, 0.25]; leadFore = [-0.10, 0.75, 0.30]; }
  if (punching) {
    leadArm = mixDir([0.05, -0.92, 0.18], [0.94, -0.06, 0.10], ext);
    leadFore = mixDir([0.20, 0.90, 0.20], [1.00, 0.02, 0.00], ext);
  }
  if (slash) {
    /* Overhead cut. The blade rides the lead hand, so this arc IS the hitbox
       path: up and behind on the draw, then down and through to hip height. */
    const up: Dir = [-0.28, 0.94, 0.16];
    const mid: Dir = [0.86, 0.42, 0.10];
    const thru: Dir = [0.62, -0.72, 0.06];
    leadArm = draw > 0
      ? mixDir([0.05, -0.30, 0.20], up, draw)
      : ext < 0.5 ? mixDir(up, mid, ext * 2) : mixDir(mid, thru, (ext - 0.5) * 2);
    leadFore = mixDir([0.30, 0.90, 0.10], [0.95, 0.28, 0.0], clamp(ext * 1.6, 0, 1));
  }
  aim(R.armLead, leadArm, face);
  aim(R.foreLead, leadFore, face);

  // ── rear arm counterbalances ──
  let rearArm: Dir = [-0.05, -0.94 + breath * 0.5, -0.20 - sway];
  let rearFore: Dir = [0.45, 0.75 - breath, -0.25];
  if (guard) { rearArm = [0.05, -0.86, -0.30]; rearFore = [0.22, 0.88, -0.25]; }
  if (punching) rearArm = mixDir(rearArm, [-0.35, -0.80, -0.28], ext);
  if (slash) rearArm = mixDir([0.20, -0.70, -0.30], [-0.45, -0.78, -0.24], ext);
  if (airborne && !punching && !slash) rearArm = [-0.20, -0.72, -0.34];
  aim(R.armRear, rearArm, face);
  aim(R.foreRear, rearFore, face);

  /* ── legs ──
     A kick chambers before it extends: knee up with the shin folded back, then
     the shin snaps out. Driving thigh and shin forward together gives a
     stiff-legged shove instead of a kick. */
  let leadLeg: Dir, leadShin: Dir, rearLeg: Dir, rearShin: Dir;

  if (kicking) {
    const chamber = clamp(raw < 0 ? -raw / 0.22 : 1 - raw, 0, 1);
    leadLeg = mixDir([0.10, -0.95, 0.08], [0.80, -0.30, 0.05], Math.max(chamber * 0.55, ext));
    leadShin = mixDir([-0.55, -0.78, 0], [0.97, -0.12, 0], ext);
    rearLeg = [-0.22, -0.96, -0.08];
    rearShin = [-0.16, -0.97, 0];
  } else if (airborne) {
    // knees tuck on the way up, front leg reaches out on the way down
    const fall = clamp(-f.vy / 9, 0, 1);
    leadLeg = mixDir([0.42, -0.86, 0.10], [0.20, -0.96, 0.10], fall);
    leadShin = mixDir([-0.62, -0.72, 0], [-0.16, -0.98, 0], fall);
    rearLeg = [-0.30, -0.92, -0.10];
    rearShin = [-0.50, -0.82, 0];
  } else if (slash) {
    // step through the cut: lead foot plants forward, back leg drives
    leadLeg = mixDir([0.02, -0.99, 0.10], [0.44, -0.88, 0.10], ext);
    leadShin = [-0.12, -0.98, 0];
    rearLeg = mixDir([-0.12, -0.98, -0.10], [-0.44, -0.88, -0.10], ext);
    rearShin = [-0.24, -0.96, 0];
  } else {
    // the standing weight shifts between the feet as the hips sway
    leadLeg = [0.16 + swing - sway * 0.8, -0.96, 0.10];
    leadShin = [-0.10 + Math.max(0, -swing) * 0.7 - breath * 0.4, -0.98, 0];
    rearLeg = [-0.18 - swing - sway * 0.8, -0.95, -0.10];
    rearShin = [-0.12 + Math.max(0, swing) * 0.7 + breath * 0.4, -0.98, 0];
  }

  aim(R.legLead, leadLeg, face);
  aim(R.shinLead, leadShin, face);
  aim(R.legRear, rearLeg, face);
  aim(R.shinRear, rearShin, face);

  if (down) {
    aimBone(R.spine, -0.9, 0.4, 0, face);
    aimBone(R.legLead, -0.6, -0.7, 0, face);
    aimBone(R.legRear, -0.5, -0.8, 0, face);
  }
}
