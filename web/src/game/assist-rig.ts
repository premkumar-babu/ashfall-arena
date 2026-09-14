import * as THREE from 'three/webgpu';
import { A, PAL, type AssistState, type FighterState } from '../config/constants';
import type { AssistDef } from '../config/roster';
import type { ActionMap } from '../anim/types';
import { createTrail, type Trail } from '../fx/particles';
import { makePortal, makeScorch, type Portal, type Scorch } from '../fx/vfx';
import { pointLight } from '../render/lights';
import { toonMat } from '../render/materials';
import { scene } from '../render/stage';
import type { Fighter } from './fighter';
import { makeVolume, type Volume } from './volumes';

export interface AssistParts {
  readonly blades: THREE.Mesh[];
  readonly tatters: THREE.Mesh[];
  readonly halo: THREE.Mesh | null;
  readonly core: THREE.Mesh;
  readonly lamp: THREE.PointLight;
}

export interface Assist {
  readonly def: AssistDef;
  readonly slot: number;
  owner: Fighter | null;
  readonly group: THREE.Group;
  readonly parts: AssistParts;
  /** The procedural pieces, hidden when a model loads over them. */
  readonly primParts: THREE.Object3D[];
  model: THREE.Object3D | null;
  mixer: THREE.AnimationMixer | null;
  actions: ActionMap | null;
  currentAction: THREE.AnimationAction | null;
  standIn: Partial<Record<FighterState, boolean>>;
  libBound: boolean;
  readonly wave: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  readonly orb: THREE.Group;
  readonly orbCore: THREE.Mesh;
  readonly orbHalo: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  readonly hitbox: Volume;
  readonly orbBox: Volume;
  readonly portal: Portal;
  readonly scorch: Scorch;
  readonly trail: Trail;
  baseY: number;
  baseScale: number;
  baseYaw: number;
  state: AssistState;
  t: number;
  dir: number;
  x: number;
  y: number;
  vy: number;
  hitLanded: boolean;
  quaked: boolean;
  orbActive: boolean;
  orbT: number;
  orbX: number;
  orbY: number;
}

export function createAssist(def: AssistDef, slot: number): Assist {
  // matched to the fighters: at bloom threshold 0.88, 2.0 on an accent colour
  // blew the summons out to white flares
  const lit = toonMat(def.color, { emissive: def.color, emissiveIntensity: 1.2 });
  const stone = toonMat(def.build === 'idol' ? 0x9A9182 : 0x2A2230);

  const group = new THREE.Group();
  group.visible = false;
  const blades: THREE.Mesh[] = [];
  const tatters: THREE.Mesh[] = [];
  let halo: THREE.Mesh | null = null;
  let core: THREE.Mesh;

  if (def.build === 'wraith') {
    const shroud = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.75, 9, 1, true), stone);
    shroud.position.y = 0.95;
    shroud.castShadow = true;
    group.add(shroud);
    const cowl = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.72, 8), stone);
    cowl.position.y = 2.02;
    cowl.castShadow = true;
    group.add(cowl);
    // bone mask inside the cowl, with a pair of burning eyes
    const mask = new THREE.Mesh(new THREE.SphereGeometry(0.21, 10, 8), toonMat(0xD9CDBA));
    mask.scale.set(0.86, 1.05, 0.7);
    mask.position.set(0, 1.86, 0.13);
    group.add(mask);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), lit);
      eye.position.set(s * 0.075, 1.90, 0.26);
      group.add(eye);
    }
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, 0.05), toonMat(0x2A2230));
    jaw.position.set(0, 1.76, 0.24);
    group.add(jaw);

    // halo ring hanging behind the hood
    halo = new THREE.Mesh(
      new THREE.TorusGeometry(0.52, 0.032, 6, 20),
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    halo.position.set(0, 1.92, -0.30);
    group.add(halo);

    // bead chain across the chest
    for (let bd = 0; bd < 7; bd++) {
      const bead = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 5), lit);
      const ang = -0.9 + bd * 0.3;
      bead.position.set(Math.sin(ang) * 0.36, 1.44 - Math.cos(ang) * 0.10, 0.30);
      group.add(bead);
    }

    core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.19, 1), lit);
    core.position.set(0, 1.30, 0.30);
    group.add(core);
    for (const s of [-1, 1]) {
      const bl = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.15, 6), lit);
      bl.position.set(s * 0.55, 1.42, -0.1);
      bl.rotation.set(1.15, 0, s * 0.35);
      group.add(bl);
      blades.push(bl);
    }
    for (let i = 0; i < 3; i++) {
      const tt = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.95), toonMat(0x2A2230, { side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
      tt.position.set((i - 1) * 0.32, 0.34, -0.18);
      group.add(tt);
      tatters.push(tt);
    }
  } else {
    // carrion idol: squat and four-armed
    const block = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.2, 0.9), stone);
    block.position.y = 1.15;
    block.castShadow = true;
    group.add(block);
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.6, 0.62), stone);
    skull.position.y = 2.02;
    skull.castShadow = true;
    group.add(skull);
    // carved face: sunken eyes and a slotted mouth
    for (const s of [-1, 1]) {
      const socket = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.11, 0.06), toonMat(0x2C2A26));
      socket.position.set(s * 0.15, 2.08, 0.31);
      group.add(socket);
      const glowEye = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 5), lit);
      glowEye.position.set(s * 0.15, 2.08, 0.34);
      group.add(glowEye);
    }
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.05, 0.05), toonMat(0x2C2A26));
    mouth.position.set(0, 1.88, 0.31);
    group.add(mouth);

    // stacked stone tiers and rune plates
    const tier = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.20, 1.05), stone);
    tier.position.y = 0.55;
    tier.castShadow = true;
    group.add(tier);
    const tier2 = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.18, 0.78), stone);
    tier2.position.y = 1.84;
    group.add(tier2);

    for (const s of [-1, 1]) {
      const plateR = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.52, 0.04), lit);
      plateR.position.set(s * 0.62, 1.15, 0.47);
      group.add(plateR);
    }

    // hanging chains at the corners
    for (const [cx, cz] of [[-0.62, -0.48], [0.62, -0.48], [-0.62, 0.48], [0.62, 0.48]] as const) {
      for (let li = 0; li < 4; li++) {
        const link = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 4, 8), toonMat(0x4A443C));
        link.position.set(cx, 0.40 - li * 0.13, cz);
        link.rotation.x = (li % 2) * Math.PI / 2;
        group.add(link);
      }
    }

    core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 1), lit);
    core.position.set(0, 1.42, 0.44);
    group.add(core);
    for (const [px, py] of [[-1, 1.55], [1, 1.55], [-1, 1.05], [1, 1.05]] as const) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.2, 0.2), stone);
      arm.position.set(px * 0.86, py, 0);
      arm.rotation.z = px * -0.35;
      arm.castShadow = true;
      group.add(arm);
      blades.push(arm);
    }
    const band = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.12, 0.95), lit);
    band.position.y = 1.42;
    group.add(band);
  }

  const lamp = pointLight(def.color, 0, 9);
  scene.add(lamp);
  scene.add(group);

  // shockwave ring, used by the slam pattern
  const wave = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 0.86, 32),
    new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
  );
  wave.rotation.x = -Math.PI / 2;
  wave.position.y = 0.06;
  wave.visible = false;
  scene.add(wave);

  // orb projectile, used by the leap pattern
  const orb = new THREE.Group();
  orb.visible = false;
  const orbCore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 1), lit);
  const orbHalo = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.44, 1),
    new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  orb.add(orbCore, orbHalo);
  scene.add(orb);

  const primParts = group.children.slice();   // hidden if a model loads over them

  const strikeAnchor = new THREE.Object3D();
  strikeAnchor.position.set(0, def.build === 'wraith' ? 1.35 : 0.75, 0.25);
  group.add(strikeAnchor);

  return {
    def, slot, owner: null, group,
    parts: { blades, tatters, halo, core, lamp },
    primParts, model: null, mixer: null, actions: null, currentAction: null, standIn: {}, libBound: false,
    wave, orb, orbCore, orbHalo,
    hitbox: makeVolume(strikeAnchor, def.build === 'wraith' ? 1.25 : 1.6, def.build === 'wraith' ? 1.45 : 1.1, 1.0, PAL.gold),
    orbBox: makeVolume(orb, 0.72, 0.72, 0.72, PAL.gold),
    portal: makePortal(def.color),
    scorch: makeScorch(),
    trail: createTrail(def.color),
    baseY: 0, baseScale: 1, baseYaw: 0,
    state: A.DORMANT, t: 0, dir: 1, x: 0, y: 0, vy: 0,
    hitLanded: false, quaked: false,
    orbActive: false, orbT: 0, orbX: 0, orbY: 0,
  };
}
