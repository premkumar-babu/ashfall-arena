import * as THREE from 'three/webgpu';
import { GROUND, METER, PAL, S, SPAWN_X, type FighterState, type Move } from '../config/constants';
import type { FighterDef } from '../config/roster';
import type { ActionMap, BoneRig } from '../anim/types';
import type { CharacterBody } from '../physics/port';
import { createTrail, type Trail } from '../fx/particles';
import { makeAura } from '../fx/vfx';
import { pointLight } from '../render/lights';
import { inkOutline, toonMat } from '../render/materials';
import { scene } from '../render/stage';
import type { Assist } from './assist-rig';
import { createBrain, type Brain } from './brain';
import { makeVolume, type Volume } from './volumes';

export interface ArmRig {
  readonly shoulder: THREE.Group;
  readonly elbow: THREE.Group;
  readonly fist: THREE.Mesh;
}

export interface LegRig {
  readonly hip: THREE.Group;
  readonly knee: THREE.Group;
  readonly foot: THREE.Mesh;
}

export type BodyPart = 'HEAD' | 'TORSO' | 'LEGS';

export interface Hurtbox {
  readonly part: BodyPart;
  readonly mult: number;
  readonly vol: Volume;
}

export interface Hitboxes {
  readonly fist: Volume;
  readonly foot: Volume;
  /** Unarmed fighters alias this to `foot`; it is never read for them. */
  readonly blade: Volume;
}

/*
  A fighter is two things at once: a primitive rig built from cylinders and
  boxes, which carries every hitbox and hurtbox and is posed by the state
  machine, and — once one loads — an imported character model laid over it
  and driven to match. The rig goes invisible when the model arrives but never
  stops posing, because collision is resolved against it, not against the art.
*/
export interface Fighter {
  readonly def: FighterDef;
  readonly slot: number;

  // ── primitive rig ──
  readonly root: THREE.Group;
  readonly body: THREE.Group;
  readonly torso: THREE.Group;
  readonly neck: THREE.Group;
  readonly armF: ArmRig;
  readonly armB: ArmRig;
  readonly legF: LegRig;
  readonly legB: LegRig;
  readonly cape: THREE.Mesh;
  readonly blob: THREE.Mesh;
  readonly glow: THREE.MeshToonMaterial;
  readonly skin: THREE.MeshToonMaterial[];
  readonly powerLight: THREE.PointLight;
  readonly trail: Trail;
  readonly swingTrail: Trail;
  readonly aura: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly ribbons: THREE.Mesh[];
  readonly tail: THREE.Mesh;
  readonly skirt: THREE.Mesh;
  readonly weapon: THREE.Group | null;
  readonly bladeTip: THREE.Object3D | null;
  readonly hurtboxes: readonly Hurtbox[];
  readonly hitboxes: Hitboxes;
  assist: Assist | null;
  arcFired: boolean;

  // ── per-set tallies, for the results card ──
  dealt: number;
  bestCombo: number;

  // ── state machine ──
  state: FighterState;
  stateTime: number;
  move: Move | null;
  hitLanded: boolean;
  activeHitbox: Volume | null;
  stunTime: number;
  lockFace: number;
  airMove: boolean;
  land: number;
  hitDir: number;

  // ── movement ──
  dashTime: number;
  dashCd: number;
  dashDir: number;
  /** Seconds since last standing on something; 0 while grounded. Drives coyote time. */
  airTime: number;
  /** This jump's button has been let go (or the jump has been cut), so the rise is no longer extended. */
  jumpReleased: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  face: number;
  grounded: boolean;
  /** The physics capsule, while this fighter holds a player slot and physics is loaded. */
  physicsBody: CharacterBody | null;

  // ── resources ──
  hp: number;
  lastHp: number;
  rounds: number;
  meter: number;
  lastMeter: number;
  assistCd: number;
  powered: boolean;

  // ── loaded model ──
  model: THREE.Object3D | null;
  modelFit: number;
  /** The loaded model's converted materials, so the damage flash reaches the visible art. */
  modelMats: THREE.MeshStandardMaterial[] | null;
  weaponBone: THREE.Bone | null;
  mixer: THREE.AnimationMixer | null;
  actions: ActionMap | null;
  currentAction: THREE.AnimationAction | null;
  boneRig: BoneRig | null;
  /** Slots filled by a guess rather than a matched clip, which the shared library may replace. */
  standIn: Partial<Record<FighterState, boolean>>;
  libBound: boolean;

  // ── feel ──
  stepGate: number;
  brain: Brain;
  flash: number;
  blockFlash: number;
  white: number;
  combo: number;
  comboTimer: number;
  /** Phase offset for idle breathing, so the two sides never sway in lockstep. */
  readonly phase: number;
}

function limb(mat: THREE.Material, rTop: number, rBot: number, len: number): THREE.Group {
  const pivot = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, 10), mat);
  m.position.y = -len / 2;
  m.castShadow = true;
  pivot.add(m);
  return pivot;
}

export function createFighter(def: FighterDef, slot: number): Fighter {
  const bulk = def.bulk;
  const plate = toonMat(def.plate);
  const cloth = toonMat(def.cloth);
  const skinMat = toonMat(def.flesh || 0xC79A78);
  const hairMat = toonMat(def.hair || 0x181018);
  const glow = toonMat(def.accent, { emissive: def.accent, emissiveIntensity: 1.15 });
  const skin = [plate, cloth, skinMat];
  for (const m of skin) m.userData.base = m.color.clone();

  const root = new THREE.Group();
  root.scale.setScalar(def.scale);
  root.visible = false;
  const body = new THREE.Group();
  root.add(body);

  const powerLight = pointLight(def.accent, 0, 11);
  powerLight.position.set(0, 1.9, 0);
  root.add(powerLight);

  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.62 * bulk, 0.40, 0.42), cloth);
  hips.position.y = 1.52;
  hips.castShadow = true;
  inkOutline(hips, 0.09);
  body.add(hips);

  // flared robe skirt — the silhouette that reads as wuxia at a glance
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42 * bulk, 0.86 * bulk, 1.15, 10, 1, true),
    toonMat(def.cape, { side: THREE.DoubleSide }),
  );
  skirt.position.y = 1.16;
  skirt.castShadow = true;
  body.add(skirt);

  const torso = new THREE.Group();
  torso.position.y = 1.70;
  body.add(torso);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.80 * bulk, 0.86, 0.46 * bulk), plate);
  chest.position.y = 0.40;
  chest.castShadow = true;
  inkOutline(chest, 0.07);
  torso.add(chest);

  // crossed lapels
  const lapel = new THREE.Mesh(new THREE.BoxGeometry(0.52 * bulk, 0.80, 0.10), cloth);
  lapel.position.set(0, 0.40, 0.24 * bulk);
  lapel.rotation.z = 0.20;
  torso.add(lapel);

  const sash = new THREE.Mesh(new THREE.BoxGeometry(0.88 * bulk, 0.20, 0.52 * bulk), glow);
  sash.position.y = 0.02;
  torso.add(sash);

  // two ribbons trailing off the sash
  const ribbons: THREE.Mesh[] = [];
  for (const s of [-1, 1]) {
    const rb = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 1.25, 1, 3), toonMat(def.accent, { side: THREE.DoubleSide }));
    rb.position.set(s * 0.26 * bulk, -0.55, -0.24);
    torso.add(rb);
    ribbons.push(rb);
  }

  for (const s of [-1, 1]) {
    const pad = new THREE.Mesh(new THREE.SphereGeometry(def.pad * 0.82, 10, 8), plate);
    pad.position.set(s * 0.48 * bulk, 0.74, 0);
    pad.scale.y = 0.72;
    pad.castShadow = true;
    torso.add(pad);
  }

  const neck = new THREE.Group();
  neck.position.y = 0.90;
  torso.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 14, 12), skinMat);
  head.position.y = 0.22;
  head.castShadow = true;
  head.scale.set(0.94, 1.06, 0.94);
  inkOutline(head, 0.08);
  neck.add(head);

  // hair cap, topknot and a tail that whips with the motion
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.265, 12, 10), hairMat);
  hair.position.y = 0.26;
  hair.scale.set(1, 0.88, 1);
  neck.add(hair);
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 7), hairMat);
  knot.position.y = 0.52;
  neck.add(knot);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.026, 5, 10), glow);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.44;
  neck.add(band);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.95, 6), hairMat);
  tail.position.set(0, 0.34, -0.20);
  tail.rotation.x = -0.7;
  neck.add(tail);

  const brow = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.06), glow);
  brow.position.set(0, 0.24, 0.22);
  neck.add(brow);

  const arm = (side: number): ArmRig => {
    const shoulder = limb(cloth, 0.105, 0.092, 0.58);
    shoulder.position.set(side * 0.44 * bulk, 0.64, 0);
    const elbow = limb(def.blade && side > 0 ? glow : skinMat, 0.085, 0.072, 0.54);
    elbow.position.y = -0.58;
    shoulder.add(elbow);
    // wrist wrap
    const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.095, 0.20, 8), glow);
    wrap.position.y = -0.48;
    elbow.add(wrap);
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.115, 8, 7), skinMat);
    fist.position.y = -0.58;
    fist.castShadow = true;
    elbow.add(fist);
    torso.add(shoulder);
    return { shoulder, elbow, fist };
  };
  const armF = arm(1);
  const armB = arm(-1);

  const leg = (side: number): LegRig => {
    const hip = limb(cloth, 0.135, 0.115, 0.78);
    hip.position.set(side * 0.20 * bulk, 1.52, 0);
    const knee = limb(cloth, 0.11, 0.085, 0.72);
    knee.position.y = -0.78;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.075, 0.30, 8), glow);
    shin.position.y = -0.60;
    knee.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.12, 0.40), plate);
    foot.position.set(0, -0.76, 0.07);
    foot.castShadow = true;
    inkOutline(foot, 0.10);
    knee.add(foot);
    body.add(hip);
    return { hip, knee, foot };
  };
  const legF = leg(1);
  const legB = leg(-1);

  // back mantle, still called cape by the animation code
  const cape = new THREE.Mesh(new THREE.PlaneGeometry(0.92 * bulk, 1.35, 1, 4), toonMat(def.cape, { side: THREE.DoubleSide }));
  cape.position.set(0, 0.24, -0.28);
  cape.castShadow = true;
  torso.add(cape);

  /* ── detailing: small pieces that read at fighting-game distance — a face,
        trim on every hem, a hip scabbard for the armed half ──────────────── */
  const trimMat2 = toonMat(def.accent, { emissive: def.accent, emissiveIntensity: 0.5 });
  const darkMat = toonMat(0x140E18);

  // high mandarin collar
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.33, 0.26, 8, 1, true), toonMat(def.cape, { side: THREE.DoubleSide }));
  collar.position.y = 0.82;
  torso.add(collar);

  // eyes and brow ridge — the single biggest readability win
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.038, 6, 5), darkMat);
    eye.position.set(s * 0.095, 0.205, 0.225);
    eye.scale.set(1, 0.72, 0.6);
    neck.add(eye);
    const brow2 = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.028, 0.05), darkMat);
    brow2.position.set(s * 0.10, 0.268, 0.222);
    brow2.rotation.z = s * 0.22;
    neck.add(brow2);
  }

  // chest crest
  const crest = new THREE.Mesh(new THREE.CircleGeometry(0.13, 6), trimMat2);
  crest.position.set(0, 0.52, 0.235 * bulk);
  torso.add(crest);

  // shoulder mantle over the upper robe
  const mantle = new THREE.Mesh(new THREE.ConeGeometry(0.62 * bulk, 0.52, 10, 1, true), toonMat(def.cape, { side: THREE.DoubleSide }));
  mantle.position.y = 0.62;
  mantle.castShadow = true;
  torso.add(mantle);

  // belt knot with two tassels
  const knotM = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.17, 0.14), trimMat2);
  knotM.position.set(0, 0.00, 0.27 * bulk);
  knotM.rotation.z = Math.PI / 4;
  torso.add(knotM);
  for (const s of [-1, 1]) {
    const tas = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.035, 0.42, 5), trimMat2);
    tas.position.set(s * 0.07, -0.24, 0.26 * bulk);
    torso.add(tas);
  }

  // hem trim around the robe skirt
  const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.875 * bulk, 0.875 * bulk, 0.11, 10, 1, true), toonMat(def.accent, { side: THREE.DoubleSide }));
  hem.position.y = 0.60;
  body.add(hem);

  // forearm bracers
  for (const a of [armF, armB]) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.088, 0.26, 8), plate);
    br.position.y = -0.22;
    a.elbow.add(br);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.018, 4, 10), trimMat2);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.35;
    a.elbow.add(ring);
  }

  // knee wraps
  for (const l of [legF, legB]) {
    const kw = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.026, 4, 10), trimMat2);
    kw.rotation.x = Math.PI / 2;
    kw.position.y = -0.02;
    l.knee.add(kw);
  }

  // scabbard on the off hip, for the armed half of the roster
  if (def.armed) {
    const scab = new THREE.Group();
    scab.position.set(-0.30 * bulk, 1.45, -0.12);
    scab.rotation.z = 0.42;
    scab.rotation.x = -0.20;
    const sheath = new THREE.Mesh(new THREE.BoxGeometry(0.10, def.heavyReach * 0.92, 0.055), toonMat(0x241A22));
    sheath.position.y = -def.heavyReach * 0.42;
    sheath.castShadow = true;
    scab.add(sheath);
    for (const o of [0.05, -0.42, -0.86]) {
      const bandS = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.05, 0.075), trimMat2);
      bandS.position.y = o * def.heavyReach * 0.9;
      scab.add(bandS);
    }
    body.add(scab);
  }

  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.62 * bulk, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.02;
  root.add(blob);

  scene.add(root);

  const sc = def.scale;
  const rc = def.reach * def.scale;
  const headAnchor = new THREE.Object3D();
  headAnchor.position.y = 0.24;
  neck.add(headAnchor);
  const torsoAnchor = new THREE.Object3D();
  torsoAnchor.position.y = 0.44;
  torso.add(torsoAnchor);
  const legsAnchor = new THREE.Object3D();
  legsAnchor.position.y = 0.80;
  body.add(legsAnchor);

  const hurtboxes: Hurtbox[] = [
    { part: 'HEAD', mult: 1.3, vol: makeVolume(headAnchor, 0.52 * sc, 0.62 * sc, 0.52 * sc, PAL.hurtbox) },
    { part: 'TORSO', mult: 1.0, vol: makeVolume(torsoAnchor, 0.86 * sc * bulk, 1.20 * sc, 0.86 * sc, PAL.hurtbox) },
    { part: 'LEGS', mult: 0.8, vol: makeVolume(legsAnchor, 0.78 * sc * bulk, 1.50 * sc, 0.78 * sc, PAL.hurtbox) },
  ];

  /* ── weapon, for the armed half of the roster. Parented to the lead fist,
        so it inherits the punch/slash animation for free and its hitbox
        tracks the swing. ──────────────────────────────────────────────── */
  let weapon: THREE.Group | null = null;
  let bladeTip: THREE.Object3D | null = null;
  if (def.armed) {
    weapon = new THREE.Group();
    weapon.position.set(0, -0.06, 0.10);
    weapon.rotation.x = -Math.PI / 2;     // blade points out along the arm

    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.42, 8), new THREE.MeshStandardMaterial({ color: 0x2E211A, roughness: 0.85 }));
    weapon.add(grip);

    const brass = new THREE.MeshStandardMaterial({ color: 0xC9A23C, roughness: 0.35, metalness: 0.85 });
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.14), brass);
    guard.position.y = 0.24;
    weapon.add(guard);

    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), brass);
    pommel.position.y = -0.24;
    weapon.add(pommel);

    const steel = new THREE.MeshStandardMaterial({
      color: 0xD8E2E8, roughness: 0.14, metalness: 0.95,
      emissive: def.accent, emissiveIntensity: 0.22,
    });
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.10, def.heavyReach, 0.028), steel);
    blade.position.y = 0.28 + def.heavyReach / 2;
    blade.castShadow = true;
    weapon.add(blade);

    // a slight taper at the point reads as a real blade at this scale
    const point = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.26, 4), steel);
    point.position.y = 0.28 + def.heavyReach + 0.11;
    point.rotation.y = Math.PI / 4;
    weapon.add(point);

    bladeTip = new THREE.Object3D();
    bladeTip.position.y = 0.28 + def.heavyReach * 0.72;
    weapon.add(bladeTip);

    armF.fist.add(weapon);
  }

  const fist = makeVolume(armF.fist, 0.64 * rc, 0.56 * rc, 0.64 * rc, PAL.strike);
  const foot = makeVolume(legF.foot, 0.86 * rc, 0.62 * rc, 0.86 * rc, PAL.strike);
  // the blade sweeps a long, thin volume; unarmed fighters never use it
  const blade = def.armed && bladeTip
    ? makeVolume(bladeTip, def.heavyReach * 0.95 * sc, 0.85 * sc, 0.7 * sc, PAL.gold)
    : foot;

  const aura = makeAura(def.accent);
  root.add(aura);

  return {
    def, slot, root, body, torso, neck,
    armF, armB, legF, legB, cape, blob,
    glow, skin, powerLight,
    trail: createTrail(def.accent),
    swingTrail: createTrail(def.accent),
    aura,
    ribbons, tail, skirt, arcFired: false,
    weapon, bladeTip,
    hurtboxes, hitboxes: { fist, foot, blade }, assist: null,

    dealt: 0, bestCombo: 0,
    state: S.IDLE, stateTime: 0, move: null,
    hitLanded: false, activeHitbox: null, stunTime: 0,
    lockFace: 0, airMove: false, land: 0, hitDir: 0,
    dashTime: 0, dashCd: 0, dashDir: 1,
    airTime: 0, jumpReleased: true,

    x: SPAWN_X[slot === 0 ? 0 : 1], y: GROUND, vx: 0, vy: 0,
    face: slot === 0 ? 1 : -1, grounded: true, physicsBody: null,

    hp: 100, lastHp: 100, rounds: 0,
    meter: METER.start, lastMeter: -1, assistCd: 0, powered: false,

    model: null, modelFit: 0, modelMats: null, weaponBone: null,
    mixer: null, actions: null, currentAction: null, boneRig: null, standIn: {}, libBound: false,

    stepGate: 0, brain: createBrain(),
    flash: 0, blockFlash: 0, white: 0, combo: 0, comboTimer: 0,
    phase: Math.random() * Math.PI * 2,
  };
}
