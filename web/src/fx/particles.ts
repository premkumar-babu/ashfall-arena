import * as THREE from 'three/webgpu';
import { instancedDynamicBufferAttribute, materialColor, vec4 } from 'three/tsl';
import { GRAVITY } from '../config/constants';
import { loadTex } from '../assets/texture-loader';
import { scene } from '../render/stage';

/*
  Every particle in the game — falling motes, near-field dust, impact sparks,
  weapon and overdrive trails — is an instanced sprite.

  The monolith used THREE.Points with a world-space size. That cannot survive
  WebGPU: the spec has no point size, so a point primitive is exactly one pixel
  wide, and three's PointsNodeMaterial documents that size is ignored for
  Points on the WebGPU backend. Every effect would have silently become a
  scatter of single pixels — while still looking correct on the WebGL2
  fallback, which is the worst kind of bug to find late.

  A Sprite with PointsNodeMaterial and `count = N` draws N camera-facing quads
  in one call, and honours `size` with the same attenuation WebGL's
  PointsMaterial used (size · (half canvas height / −viewZ)). So the sizes the
  game was tuned with carry over unchanged, and both backends run this one path.
*/

type CountedSprite = THREE.Sprite & { count: number };

interface CloudOptions {
  size: number;
  map?: THREE.Texture | null;
  color?: THREE.ColorRepresentation;
  opacity?: number;
  fog?: boolean;
  alphaTest?: number;
  /** Per-particle RGB, multiplied with the material colour (and map). */
  perInstanceColor?: boolean;
}

interface SpriteCloud {
  readonly sprite: CountedSprite;
  readonly material: THREE.PointsNodeMaterial;
  readonly positions: THREE.InstancedBufferAttribute;
  readonly colors: THREE.InstancedBufferAttribute | null;
}

function makeCloud(count: number, o: CloudOptions): SpriteCloud {
  const positions = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);

  const material = new THREE.PointsNodeMaterial({
    size: o.size,
    sizeAttenuation: true,
    map: o.map ?? null,
    color: o.color ?? 0xffffff,
    opacity: o.opacity ?? 1,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: o.fog ?? true,
    alphaTest: o.alphaTest ?? 0,
  });
  material.positionNode = instancedDynamicBufferAttribute(positions);

  let colors: THREE.InstancedBufferAttribute | null = null;
  if (o.perInstanceColor) {
    colors = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    colors.setUsage(THREE.DynamicDrawUsage);
    const tint = instancedDynamicBufferAttribute(colors);
    // keep the material colour and map; the instance colour scales them
    /* materialColor is the colour multiplied by the map's texel: a vec4 once a
       map is set, a vec3 before one lands. vec4() normalises both, so the
       instance tint scales rgb and the sprite's own alpha survives. */
    const base = vec4(materialColor as unknown as THREE.Node<'vec4'>);
    material.colorNode = vec4(base.rgb.mul(tint as THREE.Node<'vec3'>), base.a);
  }

  const sprite = new THREE.Sprite(material as unknown as THREE.SpriteMaterial) as CountedSprite;
  sprite.count = count;
  // the sprite's own position is the origin; its particles are everywhere
  sprite.frustumCulled = false;
  return { sprite, material, positions, colors };
}

/* ── ambient fields: embers and dust ──────────────────────────────────── */

export interface MoteField {
  readonly object: THREE.Object3D;
  readonly count: number;
  /** xyz per particle. Write freely, then call commit(). */
  readonly positions: Float32Array;
  commit(): void;
  setMap(map: THREE.Texture): void;
  setColor(color: THREE.ColorRepresentation): void;
  setOpacity(opacity: number): void;
  setSize(size: number): void;
}

export function createMoteField(o: {
  count: number;
  map: THREE.Texture;
  color: THREE.ColorRepresentation;
  size: number;
  opacity: number;
  fog: boolean;
}): MoteField {
  const cloud = makeCloud(o.count, { size: o.size, map: o.map, color: o.color, opacity: o.opacity, fog: o.fog, alphaTest: 0.02 });
  const m = cloud.material;
  return {
    object: cloud.sprite,
    count: o.count,
    positions: cloud.positions.array as Float32Array,
    commit: () => {
      cloud.positions.needsUpdate = true;
    },
    setMap: (map) => {
      m.map = map;
      m.needsUpdate = true;
    },
    setColor: (color) => {
      m.color.set(color);
    },
    setOpacity: (opacity) => {
      m.opacity = opacity;
    },
    setSize: (size) => {
      m.size = size;
    },
  };
}

/* ── impact debris ────────────────────────────────────────────────────── */

export class BurstSystem {
  private static readonly N = 340;

  private readonly cloud: SpriteCloud;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly vel = new Float32Array(BurstSystem.N * 3);
  private readonly tint = new Float32Array(BurstSystem.N * 3);
  private readonly life = new Float32Array(BurstSystem.N);
  private readonly span = new Float32Array(BurstSystem.N);
  private readonly scratch = new THREE.Color();
  private head = 0;
  private live = 0;

  constructor() {
    // HDR white: debris sparks sit above bloom's threshold and glow as they fly
    this.cloud = makeCloud(BurstSystem.N, { size: 0.17, perInstanceColor: true, color: new THREE.Color(2.4, 2.4, 2.4) });
    this.pos = this.cloud.positions.array as Float32Array;
    this.col = this.cloud.colors!.array as Float32Array;
    scene.add(this.cloud.sprite);
  }

  get alive(): number {
    return this.live;
  }

  setSprite(map: THREE.Texture, size: number): void {
    this.cloud.material.map = map;
    this.cloud.material.size = size;
    this.cloud.material.needsUpdate = true;
  }

  emit(at: { readonly x: number; readonly y: number; readonly z: number }, colorHex: number, count: number, speed: number, spread: number): void {
    const c = this.scratch.setHex(colorHex);
    const N = BurstSystem.N;
    for (let i = 0; i < count; i++) {
      const k = this.head;
      this.head = (this.head + 1) % N;
      this.pos[k * 3] = at.x;
      this.pos[k * 3 + 1] = at.y;
      this.pos[k * 3 + 2] = at.z;
      const a = Math.random() * Math.PI * 2;
      const b = (Math.random() - 0.5) * Math.PI;
      const s = speed * (0.35 + Math.random() * 0.9);
      this.vel[k * 3] = Math.cos(a) * s * (1 + spread);
      this.vel[k * 3 + 1] = Math.abs(Math.sin(b)) * s * 0.9 + s * 0.25;
      this.vel[k * 3 + 2] = Math.sin(a) * s * 0.55;
      this.tint[k * 3] = c.r;
      this.tint[k * 3 + 1] = c.g;
      this.tint[k * 3 + 2] = c.b;
      this.span[k] = 0.42 + Math.random() * 0.5;
      this.life[k] = this.span[k]!;
    }
  }

  update(dt: number): void {
    const { pos, col, vel, tint, life, span } = this;
    let live = 0;
    for (let i = 0; i < BurstSystem.N; i++) {
      if (life[i]! <= 0) {
        // additive blending: black is invisible, so a dead particle needs no hiding
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
        continue;
      }
      life[i]! -= dt;
      live++;
      vel[i * 3 + 1]! += GRAVITY * 0.45 * dt;
      pos[i * 3]! += vel[i * 3]! * dt;
      pos[i * 3 + 1]! += vel[i * 3 + 1]! * dt;
      pos[i * 3 + 2]! += vel[i * 3 + 2]! * dt;
      if (pos[i * 3 + 1]! < 0.05) {
        pos[i * 3 + 1] = 0.05;
        vel[i * 3 + 1]! *= -0.32;
      }
      const k = Math.max(0, life[i]! / span[i]!);
      col[i * 3] = tint[i * 3]! * k;
      col[i * 3 + 1] = tint[i * 3 + 1]! * k;
      col[i * 3 + 2] = tint[i * 3 + 2]! * k;
    }
    this.live = live;
    this.cloud.positions.needsUpdate = true;
    this.cloud.colors!.needsUpdate = true;
  }
}

export let Burst: BurstSystem;

/* ── trails ───────────────────────────────────────────────────────────── */

export interface Trail {
  push(x: number, y: number, z: number): void;
  fade(dt: number): void;
}

const TRAIL_N = 110;
const trails: SpriteCloud[] = [];
let trailSprite: { map: THREE.Texture; size: number } | null = null;

export function createTrail(colorHex: number): Trail {
  const cloud = makeCloud(TRAIL_N, { size: 0.14, perInstanceColor: true, color: new THREE.Color(1.6, 1.6, 1.6) });
  if (trailSprite) {
    cloud.material.map = trailSprite.map;
    cloud.material.size = trailSprite.size;
  }
  trails.push(cloud);
  scene.add(cloud.sprite);

  const pos = cloud.positions.array as Float32Array;
  const col = cloud.colors!.array as Float32Array;
  const c = new THREE.Color(colorHex);
  let head = 0;

  return {
    push(x, y, z) {
      const k = head;
      head = (head + 1) % TRAIL_N;
      pos[k * 3] = x + (Math.random() - 0.5) * 0.5;
      pos[k * 3 + 1] = y + 0.6 + Math.random() * 1.7;
      pos[k * 3 + 2] = z + (Math.random() - 0.5) * 0.5;
      col[k * 3] = c.r;
      col[k * 3 + 1] = c.g;
      col[k * 3 + 2] = c.b;
      cloud.positions.needsUpdate = true;
    },
    fade(dt) {
      const f = Math.exp(-4.6 * dt);
      for (let i = 0; i < col.length; i++) col[i]! *= f;
      cloud.colors!.needsUpdate = true;
    },
  };
}

/* Motion and swing trails were untextured points, which drew as a ladder of
   hard white squares behind every blade — the one effect that looked like
   debug output. They share the impact spark sprite once it lands. */
function setTrailSprite(map: THREE.Texture, size: number): void {
  trailSprite = { map, size };
  for (const t of trails) {
    t.material.map = map;
    t.material.size = size;
    t.material.needsUpdate = true;
  }
}

export function initParticles(): void {
  Burst = new BurstSystem();
  // impact debris gets a struck-spark shape rather than a soft dot
  loadTex('vfx/spark_05.png', (t) => {
    Burst.setSprite(t, 0.26);
    setTrailSprite(t, 0.20);
  });
}

export function resetParticles(): void {
  trails.length = 0;
  trailSprite = null;
}
