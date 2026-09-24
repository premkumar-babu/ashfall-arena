import * as THREE from 'three/webgpu';
import { loadTex } from '../assets/texture-loader';
import { state } from '../game/state';
import { arena } from './arena';

/*
  Downloaded surfaces laid over the procedural stand-ins, keeping every tint
  the theme applies. The canvas flagstone and the soft mote gradient were
  always placeholders that happened to be good enough.

  Surfaces: CC BY 4.0, beefpuppy's Hand Painted Tiling Textures.
  Slate:    CC0, Poly Haven's slate_floor_02.
*/

interface FloorTextures {
  stone: THREE.Texture | null;
  plank: THREE.Texture | null;
  slate: THREE.Texture | null;
  slateNor: THREE.Texture | null;
  slateRough: THREE.Texture | null;
}

const FLOOR_TEX: FloorTextures = { stone: null, plank: null, slate: null, slateNor: null, slateRough: null };

/*
  Which floor the theme wants, and everything that goes with it. A theme
  asking for slate gets the normal and roughness maps too; a dock or a painted
  courtyard gets them cleared, because a slate normal map left under timber
  planking reads as "the lighting is broken" long before anyone works out why.
*/
export function syncFloorTex(): void {
  if (!arena) return;
  const m = arena.floor.material;
  const T = state.theme;
  let dirty = false;

  const slate = T.slate === true && FLOOR_TEX.slate !== null;
  const want = slate ? FLOOR_TEX.slate : T.plank ? FLOOR_TEX.plank : FLOOR_TEX.stone;
  if (want && m.map !== want) {
    m.map = want;
    dirty = true;
  }

  const nor = slate ? FLOOR_TEX.slateNor : null;
  const rough = slate ? FLOOR_TEX.slateRough : null;
  if (m.normalMap !== nor) {
    m.normalMap = nor;
    dirty = true;
  }
  if (m.roughnessMap !== rough) {
    m.roughnessMap = rough;
    dirty = true;
  }
  if (nor) m.normalScale.setScalar(T.normalScale ?? 1);

  /* Gloss follows what the floor is made of. One wet-stone value for all of
     them turned every low light into a blown-out smear on boards and tiles:
     SUNDOWN's sun behind the stage became a pillar of white between the
     fighters, and each lantern left a hot pool in the foreground. Slate keeps
     its sheen — its roughness map breaks the reflection into wet joints. */
  m.roughness = slate ? 0.5 : T.plank ? 0.64 : 0.56;
  m.metalness = slate ? 0.05 : 0;

  if (dirty) m.needsUpdate = true;     // a map swap relinks the program
}

export function loadSurfaces(): void {
  loadTex('textures/stone_tile.jpg', (t) => {
    FLOOR_TEX.stone = t;
    syncFloorTex();
  }, { repeat: [11, 11], aniso: 8 });

  /* Dark slate as a real PBR set: albedo, tangent-space normal and roughness.
     The roughness map is what makes the floor worth lighting — it breaks the
     specular into wet-looking joints and dry faces. Each map loads on its own:
     a normal map that never arrives leaves a floor that is merely flat, not a
     floor that is missing. */
  loadTex('textures/slate_diff.jpg', (t) => {
    FLOOR_TEX.slate = t;
    syncFloorTex();
  }, { repeat: [9, 9], aniso: 8 });
  loadTex('textures/slate_nor.jpg', (t) => {
    FLOOR_TEX.slateNor = t;
    syncFloorTex();
  }, { repeat: [9, 9], aniso: 8, linear: true });
  loadTex('textures/slate_rough.jpg', (t) => {
    FLOOR_TEX.slateRough = t;
    syncFloorTex();
  }, { repeat: [9, 9], aniso: 8, linear: true });

  // the dock: the same timber as the posts, laid long and narrow
  loadTex('textures/timber.jpg', (t) => {
    const planks = t.clone();
    planks.wrapS = planks.wrapT = THREE.RepeatWrapping;
    planks.repeat.set(3, 30);
    planks.anisotropy = 8;
    planks.needsUpdate = true;
    FLOOR_TEX.plank = planks;
    syncFloorTex();
  }, { repeat: [1, 2] });

  loadTex('textures/rock.jpg', (t) => {
    arena.dais.material.map = t;
    arena.dais.material.needsUpdate = true;
    for (const m of arena.stoneTones) {
      m.map = t;
      m.needsUpdate = true;
    }
  }, { repeat: [4, 4] });

  loadTex('textures/timber.jpg', (t) => {
    arena.timberMat.map = t;
    arena.timberMat.needsUpdate = true;
  }, { repeat: [1, 2] });

  // round, soft motes instead of the canvas gradient
  loadTex('vfx/circle_05.png', (t) => {
    arena.embers.setMap(t);
    arena.dust.setMap(t);
  });

  /* Lantern bloom as a drawn sprite rather than as post-processing. Leaning on
     bloom meant the glow was whatever the threshold happened to leave, which
     at dusk was a white hole where the lantern used to be. A billboard carries
     the falloff itself, so the emissive can come down and the lamp still reads
     as a light source. */
  loadTex('vfx/light_01.png', (t) => {
    for (const b of arena.braziers) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: t, color: 0xFFB878, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      glow.scale.setScalar(3.4);
      glow.position.copy(b.flame.position);
      arena.group.add(glow);
      b.glow = glow;
    }
  });
}

export function resetSurfaces(): void {
  FLOOR_TEX.stone = FLOOR_TEX.plank = FLOOR_TEX.slate = FLOOR_TEX.slateNor = FLOOR_TEX.slateRough = null;
}
