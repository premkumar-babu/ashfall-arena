import * as THREE from 'three/webgpu';
import { pbrMat, useEnv } from '../render/materials';
import type { Theme } from '../config/themes';
import { createMoteField, type MoteField } from '../fx/particles';
import { legacyIntensity, pointLight } from '../render/lights';
import { toonMat } from '../render/materials';
import { scene } from '../render/stage';
import {
  flagstoneTexture, hazeTexture, moteSprite, runeRingTexture, sunPathTexture, waterTexture,
} from '../render/textures';
import { collapseInstances, mergeStatic } from './instancing';

/*
  The courtyard: floor, dais, water, pavilions, lanterns, balustrade, guardian
  statues, banners, trees, the distant tower, clouds, birds, foreground
  branches, the shoreline, the select-screen plinths, falling motes, palms, the
  sun's path, near-field dust and ground mist.

  Built once. Every theme change re-tints what is here rather than rebuilding
  it, which is why so many materials are kept as named handles.

  Repeated pieces — balusters, columns, lantern posts, blossom clusters, palm
  fronds, cloud lumps — share one geometry each and are folded into
  InstancedMesh draws once their group is built (see instancing.ts). The land
  beyond the walls is world/landscape.ts.
*/

type BasicMesh<G extends THREE.BufferGeometry = THREE.BufferGeometry> = THREE.Mesh<G, THREE.MeshBasicMaterial>;

export interface Brazier {
  readonly light: THREE.PointLight | null;
  readonly flame: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  readonly seed: number;
  /** Resting light intensity, already in current units. */
  readonly base: number;
  glow: THREE.Sprite | null;
}

export interface Banner { readonly mesh: THREE.Mesh; readonly seed: number }
/** One cloud: a drifting anchor and the lumps that ride it, all drawn by `arena.cloudMesh`. */
export interface Cloud { readonly pos: THREE.Vector3; readonly sp: number; readonly lumps: readonly THREE.Matrix4[] }
export interface Bird { readonly g: THREE.Group; readonly sp: number; readonly ph: number }
export interface Palm { readonly g: THREE.Group; readonly crown: THREE.Group; readonly seed: number }
export interface HazeLayer { readonly mesh: BasicMesh<THREE.PlaneGeometry>; readonly sp: number; readonly base: number; readonly y0: number }

export interface Arena {
  readonly group: THREE.Group;
  readonly floor: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  readonly dais: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  readonly runes: BasicMesh<THREE.PlaneGeometry>;
  readonly water: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  readonly waterTex: THREE.CanvasTexture;
  readonly timberMat: THREE.MeshStandardMaterial;
  readonly tileMat: THREE.MeshStandardMaterial;
  readonly stoneMat: THREE.MeshStandardMaterial;
  readonly trimMat: THREE.MeshStandardMaterial;
  /** Every masonry material, each a multiple of the theme's stone colour. */
  readonly stoneTones: THREE.MeshStandardMaterial[];
  readonly braziers: Brazier[];
  readonly guardians: THREE.Group[];
  readonly banners: Banner[];
  readonly cloudMat: THREE.MeshBasicMaterial;
  readonly clouds: Cloud[];
  readonly cloudMesh: THREE.InstancedMesh;
  readonly birdMat: THREE.MeshBasicMaterial;
  readonly birds: Bird[];
  readonly barkMat: THREE.MeshBasicMaterial;
  readonly petalMat: THREE.MeshBasicMaterial;
  readonly petalMat2: THREE.MeshBasicMaterial;
  readonly branches: THREE.Group[];
  readonly ridgeMat: THREE.MeshStandardMaterial;
  readonly plinths: THREE.Mesh[];
  readonly embers: MoteField;
  readonly emberVel: Float32Array;
  readonly palmMat: THREE.MeshBasicMaterial;
  readonly palms: Palm[];
  readonly sunPath: BasicMesh<THREE.PlaneGeometry>;
  readonly dust: MoteField;
  readonly dustSeed: Float32Array;
  readonly hazeLayers: HazeLayer[];
}

export const EMBERS = 420;
export const DUST = 90;
const MIST_Z = [-3.5, -9.5, -18.0];
const CLOUD_LUMPS = 5;

export let arena: Arena;

/*
  Masonry comes in several tones, but every one is the theme's stone times a
  multiplier. The multiplier is relative, so on a pale theme a highlight tone
  would run past white and flatten the statue out; clipping the result keeps
  the relationship between tones on a dark stage and stops it clipping on a
  bright one.
*/
export function tintStone(m: THREE.MeshStandardMaterial, base: number, k: number): void {
  const c = m.color.set(base).multiplyScalar(k);
  const mx = Math.max(c.r, c.g, c.b);
  if (mx > 0.84) c.multiplyScalar(0.84 / mx);
}

const cloudAnchor = new THREE.Matrix4();
const cloudLump = new THREE.Matrix4();

/** Write every cloud's lumps into the shared instanced draw. Called after the clouds move. */
export function syncClouds(): void {
  const a = arena;
  let i = 0;
  for (const c of a.clouds) {
    cloudAnchor.makeTranslation(c.pos.x, c.pos.y, c.pos.z);
    for (const lump of c.lumps) a.cloudMesh.setMatrixAt(i++, cloudLump.multiplyMatrices(cloudAnchor, lump));
  }
  a.cloudMesh.instanceMatrix.needsUpdate = true;
}

export function buildArena(theme: Theme): Arena {
  const group = new THREE.Group();
  scene.add(group);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(64, 64),
    /* The courtyard is the largest surface on screen and the one the key light
       rakes across, so it is the one place a real PBR response is worth paying
       for: a little metalness gives the wet-stone specular that sells "dark
       fantasy courtyard" rather than "grey plane". */
    new THREE.MeshStandardMaterial({ map: flagstoneTexture(), color: theme.floor, roughness: 0.3, metalness: 0.1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  // a faint sky reflection in the wet flagstones; kept low, or the floor goes milky
  useEnv(floor.material, 0.45);
  group.add(floor);

  const dais = new THREE.Mesh(new THREE.CylinderGeometry(15.2, 15.8, 0.5, 72), pbrMat(theme.dais, 'stone'));
  dais.position.y = -0.26;
  dais.receiveShadow = true;
  group.add(dais);

  const runes = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.MeshBasicMaterial({ map: runeRingTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85 }),
  );
  runes.rotation.x = -Math.PI / 2;
  runes.position.y = 0.012;
  group.add(runes);

  /* ── lake ──────────────────────────────────────────────────────────── */
  const waterTex = waterTexture();
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(420, 420),
    new THREE.MeshStandardMaterial({
      color: theme.water, map: waterTex, roughness: theme.wRough, metalness: theme.wMetal,
      transparent: true, opacity: theme.wOp,
    }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.15;
  useEnv(water.material, 1.1);          // open water should mirror the sky
  group.add(water);

  /* ── temple pavilions flanking the duelling platform ───────────────── */
  /* The architecture is physically shaded: rough stone, oiled timber, glazed
     roof tile and gilded metal trim each answer the key light and the sky
     differently, which is what gives the courtyard depth under the grade. */
  const timberMat = pbrMat(theme.timber, 'timber');
  const tileMat = pbrMat(theme.tile, 'tile');
  const stoneTones: THREE.MeshStandardMaterial[] = [];
  const stoneTone = (k: number): THREE.MeshStandardMaterial => {
    const m = pbrMat(0xffffff, 'stone');
    m.userData.tone = k;
    tintStone(m, theme.stone, k);
    stoneTones.push(m);
    return m;
  };
  const stoneMat = stoneTone(1.00);
  const trimMat = pbrMat(theme.trim, 'metal', { emissive: 0x3A2A08 });

  // a swept pagoda roof: a 4-sided pyramid with a flared, upturned eave
  const roofTier = (width: number, height: number, flare: number): THREE.Group => {
    const g = new THREE.Group();
    const roof = new THREE.Mesh(new THREE.ConeGeometry(width, height, 4), tileMat);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    g.add(roof);
    const eave = new THREE.Mesh(new THREE.ConeGeometry(width * flare, height * 0.30, 4, 1, true), tileMat);
    eave.rotation.y = Math.PI / 4;
    eave.position.y = -height * 0.40;
    eave.castShadow = true;
    g.add(eave);
    const band = new THREE.Mesh(new THREE.TorusGeometry(width * 0.62, 0.07, 6, 4), trimMat);
    band.rotation.set(Math.PI / 2, 0, Math.PI / 4);
    band.position.y = -height * 0.34;
    g.add(band);
    return g;
  };

  const columnGeo = new THREE.CylinderGeometry(0.34, 0.38, 6.4, 10);

  const makePavilion = (x: number, z: number, s: number, flip: boolean): void => {
    const p = new THREE.Group();
    p.position.set(x, 0, z);
    p.scale.setScalar(s);
    p.rotation.y = flip ? 0.42 : -0.42;

    const base = new THREE.Mesh(new THREE.BoxGeometry(9, 1.1, 9), stoneMat);
    base.position.y = 0.1;
    base.receiveShadow = true;
    base.castShadow = true;
    p.add(base);

    for (const [cx, cz] of [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]] as const) {
      const col = new THREE.Mesh(columnGeo, timberMat);
      col.position.set(cx, 3.85, cz);
      col.castShadow = true;
      p.add(col);
    }

    const lintel = new THREE.Mesh(new THREE.BoxGeometry(8.2, 0.55, 8.2), timberMat);
    lintel.position.y = 7.2;
    lintel.castShadow = true;
    p.add(lintel);

    const lower = roofTier(7.4, 3.0, 1.18);
    lower.position.y = 8.7;
    p.add(lower);

    const upper = roofTier(4.6, 2.4, 1.20);
    upper.position.y = 11.6;
    p.add(upper);

    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), trimMat);
    finial.position.y = 13.1;
    p.add(finial);

    // columns become one instanced draw; tile, trim, stone and timber one mesh each
    collapseInstances(p);
    mergeStatic(p);
    group.add(p);
  };

  makePavilion(-19, -14, 1.05, false);
  makePavilion(19, -14, 1.05, true);
  makePavilion(-30, -30, 1.5, false);
  makePavilion(31, -31, 1.4, true);

  /* ── hanging lanterns: the arena's warm accent ─────────────────────── */
  const braziers: Brazier[] = [];
  const lanternRig = new THREE.Group();
  const postGeo = new THREE.CylinderGeometry(0.22, 0.26, 7.2, 8);
  const armGeo = new THREE.BoxGeometry(1.5, 0.16, 0.16);
  [-13.5, -8.6, 8.6, 13.5].forEach((px, i) => {
    const depth = i === 0 || i === 3 ? -11.5 : -8.2;

    const post = new THREE.Mesh(postGeo, timberMat);
    post.position.set(px, 3.6, depth);
    post.castShadow = true;
    post.receiveShadow = true;
    lanternRig.add(post);

    const arm = new THREE.Mesh(armGeo, timberMat);
    arm.position.set(px + (px < 0 ? 0.6 : -0.6), 7.0, depth);
    arm.castShadow = true;
    lanternRig.add(arm);

    // each flame keeps its own material: they flicker independently
    const flame = new THREE.Mesh(
      new THREE.SphereGeometry(0.52, 14, 12),
      new THREE.MeshStandardMaterial({ color: 0xD8402E, emissive: 0xFF6B3A, emissiveIntensity: 3.0, roughness: 0.65, metalness: 0.0 }),
    );
    flame.scale.set(1, 0.82, 1);
    flame.position.set(px + (px < 0 ? 1.2 : -1.2), 6.4, depth);
    group.add(flame);

    // only the inner two carry a real light: four lamps would push every lit
    // shader in the scene up a light, for a difference nobody can see
    let light: THREE.PointLight | null = null;
    if (i === 1 || i === 2) {
      /* The reach stops short of the foreground: at 18 the floor between
         lamp and camera caught each flame's reflection as a hot orange pool. */
      light = pointLight(0xffa060, 0.45, 12.5);
      light.position.copy(flame.position);
      group.add(light);
    }
    braziers.push({ light, flame, seed: Math.random() * 10, base: legacyIntensity(0.45), glow: null });
  });
  group.add(lanternRig);
  collapseInstances(lanternRig);

  /* ── stone balustrade defining the duelling ground ─────────────────── */
  const balustrade = new THREE.Group();
  const balusterGeo = new THREE.CylinderGeometry(0.15, 0.19, 0.86, 7);
  for (let rb = -13; rb <= 13; rb += 1.55) {
    const baluster = new THREE.Mesh(balusterGeo, stoneMat);
    baluster.position.set(rb, 0.43, -6.4);
    baluster.castShadow = true;
    baluster.receiveShadow = true;
    balustrade.add(baluster);
  }
  const railTop = new THREE.Mesh(new THREE.BoxGeometry(28, 0.20, 0.52), stoneMat);
  railTop.position.set(0, 0.94, -6.4);
  railTop.castShadow = true;
  balustrade.add(railTop);
  const railBase = new THREE.Mesh(new THREE.BoxGeometry(28, 0.22, 0.66), stoneMat);
  railBase.position.set(0, 0.10, -6.4);
  railBase.receiveShadow = true;
  balustrade.add(railBase);
  group.add(balustrade);
  collapseInstances(balustrade);
  mergeStatic(balustrade);

  /* ── guardian lions flanking the arena ─────────────────────────────── */
  const eyeMat = toonMat(0x1E1A16);
  const guardian = (x: number, faceIn: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, 0, -4.6);
    g.rotation.y = faceIn * 0.5;

    const ped = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.15, 1.5), stoneTone(1.75));
    ped.position.y = 0.57;
    ped.castShadow = true;
    ped.receiveShadow = true;
    g.add(ped);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.16, 1.72), stoneTone(2.10));
    cap.position.y = 1.22;
    g.add(cap);

    const st = stoneTone(1.55);
    const bodyL = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.78, 1.15), st);
    bodyL.position.y = 1.72;
    bodyL.castShadow = true;
    g.add(bodyL);
    const headL = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.62, 0.58), st);
    headL.position.set(0, 2.34, 0.34);
    headL.castShadow = true;
    g.add(headL);
    const maneL = new THREE.Mesh(new THREE.SphereGeometry(0.46, 8, 7), stoneTone(1.20));
    maneL.position.set(0, 2.32, 0.16);
    g.add(maneL);
    for (const s of [-1, 1]) {
      const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), eyeMat);
      eyeL.position.set(s * 0.16, 2.40, 0.62);
      g.add(eyeL);
      const pawL = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 0.5), st);
      pawL.position.set(s * 0.26, 1.44, 0.52);
      pawL.castShadow = true;                      // same flags as the body, so they merge into it
      g.add(pawL);
    }
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 7), stoneTone(1.95));
    ball.position.set(0, 1.36, 0.86);
    g.add(ball);

    // ten meshes a statue become six; the group stays whole so the theme can still hide it
    mergeStatic(g);
    group.add(g);
    return g;
  };
  const guardians = [guardian(-9.2, 1), guardian(9.2, -1)];

  /* ── banner poles: cloth that catches the wind ─────────────────────── */
  const banners: Banner[] = [];
  [-11.6, 11.6].forEach((bx, bi) => {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, 9.5, 8), timberMat);
    pole.position.set(bx, 4.75, -5.2);
    pole.castShadow = true;
    group.add(pole);
    const finialB = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.44, 6), trimMat);
    finialB.position.set(bx, 9.7, -5.2);
    group.add(finialB);

    const cloth = new THREE.Mesh(
      new THREE.PlaneGeometry(1.5, 4.2, 4, 5),
      pbrMat(bi ? 0x2F6C86 : 0xC0402A, 'cloth', { side: THREE.DoubleSide }),
    );
    cloth.position.set(bx + (bi ? -0.82 : 0.82), 6.9, -5.15);
    cloth.castShadow = true;
    group.add(cloth);
    banners.push({ mesh: cloth, seed: bi * 2.1 });
  });

  /* ── cherry tree anchoring the left of the stage ───────────────────── */
  {
    const t = new THREE.Group();
    t.position.set(-20.5, 0, -7.5);
    const barkToon = toonMat(0x4A3128);

    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.86, 7.4, 8), barkToon);
    trunk.position.y = 3.7;
    trunk.rotation.z = 0.13;
    trunk.castShadow = true;
    t.add(trunk);

    const limbGeo = new THREE.CylinderGeometry(0.14, 0.30, 3.0, 6);
    for (const [bx, by, bz] of [[1.5, 5.6, 0.9], [-1.4, 6.2, -0.6], [0.6, 7.4, 0.4]] as const) {
      const lb = new THREE.Mesh(limbGeo, barkToon);
      lb.position.set(bx, by, bz);
      lb.rotation.z = bx > 0 ? -0.85 : 0.85;
      lb.castShadow = true;
      t.add(lb);
    }

    // one unit puff, scaled per cluster; two blossom tones instead of a material per puff
    const puffGeo = new THREE.IcosahedronGeometry(1, 0);
    const puffPale = toonMat(0xEFBBCE);
    const puffDeep = toonMat(0xE18AAA);
    for (let cl = 0; cl < 16; cl++) {
      const r = 0.85 + Math.random() * 0.6;
      const puff = new THREE.Mesh(puffGeo, cl % 3 === 0 ? puffPale : puffDeep);
      puff.position.set((Math.random() - 0.5) * 6.4, 7.4 + Math.random() * 3.0, (Math.random() - 0.5) * 4.2);
      puff.scale.set(r, r * 0.72, r);
      puff.castShadow = true;
      t.add(puff);
    }
    collapseInstances(t);
    group.add(t);
  }

  /* ── distant pagoda tower ──────────────────────────────────────────── */
  {
    const tw = new THREE.Group();
    tw.position.set(-46, 0, -120);
    tw.scale.setScalar(3.4);
    const storeyGeo = new THREE.BoxGeometry(1, 2.1, 1);
    const towerRoofGeo = new THREE.ConeGeometry(1.15, 1.15, 4);
    for (let lvl = 0; lvl < 5; lvl++) {
      const w = 3.1 - lvl * 0.42;
      const storey = new THREE.Mesh(storeyGeo, stoneMat);
      storey.scale.set(w, 1, w);
      storey.position.y = 1.05 + lvl * 3.0;
      tw.add(storey);
      const rf = new THREE.Mesh(towerRoofGeo, tileMat);
      rf.scale.set(w, 1, w);
      rf.rotation.y = Math.PI / 4;
      rf.position.y = 2.65 + lvl * 3.0;
      tw.add(rf);
    }
    collapseInstances(tw);
    group.add(tw);
  }

  /* ── clouds and birds ──────────────────────────────────────────────── */
  /* Forty-five lumps in one draw. The clouds drift, so their instance
     matrices are rewritten every frame (syncClouds) — forty-five small
     multiplies, against forty-five draw calls. */
  const cloudMat = new THREE.MeshBasicMaterial({ color: theme.cloud, fog: false, transparent: true, opacity: theme.cloudOp });
  const clouds: Cloud[] = [];
  for (let cd = 0; cd < 9; cd++) {
    const lumps: THREE.Matrix4[] = [];
    for (let lump = 0; lump < CLOUD_LUMPS; lump++) {
      const r = 4 + Math.random() * 3.5;
      lumps.push(new THREE.Matrix4().compose(
        new THREE.Vector3((lump - 2) * 4.2 + Math.random() * 2, Math.random() * 2.2, Math.random() * 3),
        new THREE.Quaternion(),
        new THREE.Vector3(r, r * 0.52, r),
      ));
    }
    clouds.push({
      pos: new THREE.Vector3(-120 + cd * 32 + Math.random() * 18, 34 + Math.random() * 18, -150 - Math.random() * 60),
      sp: 0.35 + Math.random() * 0.5,
      lumps,
    });
  }
  const cloudMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), cloudMat, clouds.length * CLOUD_LUMPS);
  cloudMesh.name = 'clouds';
  cloudMesh.frustumCulled = false;         // they move every frame; a stale bound would cull them
  scene.add(cloudMesh);

  const birdMat = new THREE.MeshBasicMaterial({ color: theme.bird, fog: false, side: THREE.DoubleSide });
  const birds: Bird[] = [];
  const wingGeo = new THREE.PlaneGeometry(0.9, 0.16);
  for (let bd = 0; bd < 6; bd++) {
    const g = new THREE.Group();
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(wingGeo, birdMat);
      wing.position.x = s * 0.45;
      wing.rotation.z = s * 0.45;
      g.add(wing);
    }
    g.position.set(-40 + Math.random() * 80, 16 + Math.random() * 12, -40 - Math.random() * 40);
    scene.add(g);
    birds.push({ g, sp: 2.2 + Math.random() * 2.4, ph: Math.random() * 6 });
  }

  /* ── foreground blossom branches ───────────────────────────────────────
     Framing the top corners gives the shot a near plane, which is most of
     what makes a flat stage read as depth. */
  const barkMat = new THREE.MeshBasicMaterial({ color: theme.bark, fog: false });
  const petalMat = new THREE.MeshBasicMaterial({ color: theme.petal, fog: false });
  const petalMat2 = new THREE.MeshBasicMaterial({ color: theme.petal2, fog: false });
  const branchGeo = new THREE.CylinderGeometry(0.10, 0.24, 7.5, 6);
  const twigGeo = new THREE.CylinderGeometry(0.045, 0.09, 1, 5);
  const clusterGeo = new THREE.IcosahedronGeometry(1, 0);

  const blossomBranch = (x: number, y: number, z: number, rot: number, s: number): THREE.Group => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.z = rot;
    g.scale.setScalar(s);

    const main = new THREE.Mesh(branchGeo, barkMat);
    main.rotation.z = Math.PI / 2;
    g.add(main);

    for (let i = 0; i < 7; i++) {
      const t = -3.2 + i * 1.0;
      const twig = new THREE.Mesh(twigGeo, barkMat);
      twig.scale.y = 1.5 + Math.random();
      twig.position.set(t, -0.5, (Math.random() - 0.5) * 0.7);
      twig.rotation.z = (Math.random() - 0.5) * 1.1;
      twig.rotation.x = (Math.random() - 0.5) * 0.8;
      g.add(twig);

      for (let c = 0; c < 5; c++) {
        const r = 0.34 + Math.random() * 0.26;
        const cl = new THREE.Mesh(clusterGeo, Math.random() > 0.5 ? petalMat : petalMat2);
        cl.position.set(t + (Math.random() - 0.5) * 1.3, -1.0 - Math.random() * 1.2, (Math.random() - 0.5) * 1.4);
        cl.scale.set(r, r * 0.7, r);
        g.add(cl);
      }
    }
    // the branch sways as a whole (ambience.ts), so its instances stay relative to it
    collapseInstances(g);
    scene.add(g);
    return g;
  };
  const branches = [blossomBranch(-7.2, 4.9, 2.8, -0.30, 0.82), blossomBranch(7.8, 5.3, 2.1, 0.26, 0.70)];

  /* ── distant shoreline, kept below the haze line ───────────────────── */
  const ridgeMat = pbrMat(theme.ridge ?? 0x8FA6B4, 'rough');
  const hills = new THREE.Group();
  const hillGeo = new THREE.ConeGeometry(1, 0.82, 5);
  for (const [hx, hz, hr] of [[-96, -185, 30], [-30, -215, 40], [46, -200, 34], [116, -178, 26]] as const) {
    const hill = new THREE.Mesh(hillGeo, ridgeMat);
    hill.scale.setScalar(hr);
    hill.rotation.y = Math.random() * 3;
    hill.position.set(hx, hr * 0.26, hz);
    hills.add(hill);
  }
  group.add(hills);
  collapseInstances(hills);

  /* ── select-screen plinths ─────────────────────────────────────────── */
  const plinths = [-2.3, 2.3].map((px) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.75, 0.34, 24), stoneMat);
    m.position.set(px, 0.17, 0.2);
    m.receiveShadow = true;
    m.castShadow = true;
    m.visible = false;
    group.add(m);
    return m;
  });

  /* ── drifting embers ───────────────────────────────────────────────── */
  const emberVel = new Float32Array(EMBERS);
  const embers = createMoteField({
    count: EMBERS,
    map: moteSprite(),
    color: theme.motes.color,
    size: theme.motes.size,
    opacity: theme.motes.op,
    fog: true,
  });
  for (let e = 0; e < EMBERS; e++) {
    embers.positions[e * 3] = (Math.random() - 0.5) * 46;
    embers.positions[e * 3 + 1] = Math.random() * 18;
    embers.positions[e * 3 + 2] = -16 + Math.random() * 22;
    emberVel[e] = -(0.45 + Math.random() * 0.9);
  }
  embers.commit();
  scene.add(embers.object);

  /* ── palms ─────────────────────────────────────────────────────────────
     Flat black silhouettes with fog off, framing the near corners. Nothing
     about them is lit — in a backlit shot the near plane is the one thing
     genuinely in shadow, and a hard black shape is what tells the eye
     everything behind it is bright. */
  const palmMat = new THREE.MeshBasicMaterial({ color: theme.bark, fog: false });
  const palms: Palm[] = [];
  // a unit trunk segment, tapered; each segment scales it to its own radius and length
  const trunkGeo = new THREE.CylinderGeometry(0.9, 1, 1, 7);
  const frondGeo = new THREE.ConeGeometry(0.46, 2.5, 4, 1, false);
  const frondTipGeo = new THREE.ConeGeometry(0.30, 2.1, 4, 1, false);
  const nutGeo = new THREE.SphereGeometry(0.24, 7, 6);

  const palmTree = (x: number, y: number, z: number, s: number, lean: number, flip: boolean): void => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    g.rotation.y = flip ? Math.PI : 0;

    // the trunk curves: eight short segments, each leaning a little further
    const seg = 8;
    const r = 0.30;
    const h = 1.35;
    let cur: THREE.Group = g;
    for (let i = 0; i < seg; i++) {
      const rb = r * (1 - (i - 1) * 0.075);
      const piece = new THREE.Mesh(trunkGeo, palmMat);
      piece.scale.set(rb, h, rb);
      piece.position.y = h * 0.5;
      const joint = new THREE.Group();
      joint.add(piece);
      joint.rotation.z = i === 0 ? lean * 0.35 : lean * 0.16;
      joint.position.y = i === 0 ? 0 : h;
      cur.add(joint);
      cur = joint;
    }

    const crown = new THREE.Group();
    crown.position.y = h;
    cur.add(crown);

    for (let f = 0; f < 9; f++) {
      const a = (f / 9) * Math.PI * 2 + Math.random() * 0.2;
      const droop = 0.55 + Math.random() * 0.5;
      const frond = new THREE.Group();
      frond.rotation.y = a;
      frond.rotation.z = -droop;
      // a frond is a long flattened wedge, split so it bends as it falls
      const inner = new THREE.Mesh(frondGeo, palmMat);
      inner.rotation.z = -Math.PI / 2;
      inner.position.x = 1.25;
      inner.scale.z = 0.16;
      frond.add(inner);
      const tip = new THREE.Mesh(frondTipGeo, palmMat);
      tip.rotation.z = -Math.PI / 2 - 0.5;
      tip.position.set(3.1, -0.45, 0);
      tip.scale.z = 0.14;
      frond.add(tip);
      crown.add(frond);
    }

    // a few coconuts read as detail even in pure black
    for (let c = 0; c < 3; c++) {
      const nut = new THREE.Mesh(nutGeo, palmMat);
      nut.position.set(Math.cos(c * 2.1) * 0.34, -0.2, Math.sin(c * 2.1) * 0.34);
      crown.add(nut);
    }

    /* The crown sways (ambience.ts), the trunk does not: fold each on its own.
       Twenty-nine meshes a palm become four draws. */
    collapseInstances(crown);
    collapseInstances(g, { skip: new Set([crown]) });
    scene.add(g);
    palms.push({ g, crown, seed: Math.random() * 10 });
  };

  /* Depth sets the framing. The fight camera sits around z = 8 with a 38°
     lens, so anything nearer than the rail has to be past x = ±6 to reach
     frame — inside the fighting space. Behind the balustrade they can stand
     at ±13 and still land on the edges of the shot. */
  palmTree(-13.0, -1.0, -14.0, 0.86, -0.26, false);
  palmTree(13.6, -1.0, -15.0, 0.90, 0.28, true);
  palmTree(-20.5, -1.2, -26.0, 0.78, 0.18, true);
  palmTree(21.5, -1.2, -28.0, 0.74, -0.16, false);

  /* ── the sun's path on the water ───────────────────────────────────── */
  const sunPath = new THREE.Mesh(
    new THREE.PlaneGeometry(13, 110),
    new THREE.MeshBasicMaterial({
      map: sunPathTexture(), color: 0xFFB24A, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, opacity: 0.0,
    }),
  );
  sunPath.rotation.x = -Math.PI / 2;
  sunPath.position.set(0, -1.12, -58);
  sunPath.renderOrder = 1;
  scene.add(sunPath);

  /* ── near-field dust ───────────────────────────────────────────────────
     A second, much sparser field close to the camera. Its only job is
     parallax: motes crossing the lens far faster than the ones over the
     courtyard are what stop a flat stage reading as a backdrop. */
  const dustSeed = new Float32Array(DUST);
  const dust = createMoteField({
    count: DUST,
    map: moteSprite(),
    color: theme.dust.color,
    size: 0.30,
    opacity: theme.dust.op,
    fog: false,
  });
  for (let d = 0; d < DUST; d++) {
    dust.positions[d * 3] = (Math.random() - 0.5) * 26;
    dust.positions[d * 3 + 1] = Math.random() * 9;
    dust.positions[d * 3 + 2] = 4 + Math.random() * 7;      // in front of the fighters
    dustSeed[d] = Math.random() * 100;
  }
  dust.commit();
  scene.add(dust.object);

  /* ── ground mist ───────────────────────────────────────────────────────
     Upright bands rather than sheets lying on the flagstones. The camera sits
     barely a metre above the floor, so a horizontal sheet is seen edge-on,
     every pixel of the lower screen takes the full additive pass, and the
     courtyard washes out to white. */
  const hazeTex = hazeTexture();
  const hazeLayers: HazeLayer[] = [];
  MIST_Z.forEach((z, i) => {
    const fade = 1 - i * 0.16;
    const map = hazeTex.clone();
    map.needsUpdate = true;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(56 + i * 18, 4.4 + i * 1.8),
      new THREE.MeshBasicMaterial({
        map, color: theme.haze.color, transparent: true,
        opacity: theme.haze.op * fade * 1.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    mesh.position.set(0, 0.5 + i * 0.4, z);
    mesh.renderOrder = 2;
    scene.add(mesh);
    hazeLayers.push({ mesh, sp: 0.018 - i * 0.005, base: fade * 1.9, y0: mesh.position.y });
  });

  arena = {
    group, floor, dais, runes, water, waterTex,
    timberMat, tileMat, stoneMat, trimMat, stoneTones,
    braziers, guardians, banners,
    cloudMat, clouds, cloudMesh, birdMat, birds,
    barkMat, petalMat, petalMat2, branches,
    ridgeMat, plinths,
    embers, emberVel,
    palmMat, palms, sunPath,
    dust, dustSeed, hazeLayers,
  };
  syncClouds();
  return arena;
}
