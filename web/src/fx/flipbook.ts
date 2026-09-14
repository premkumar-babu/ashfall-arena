import * as THREE from 'three/webgpu';
import { loadTex } from '../assets/texture-loader';
import { camera, scene } from '../render/stage';

/*
  Flipbook impact art: a sheet of frames read left-to-right, top-to-bottom and
  played across a camera-facing quad. This is what a hit actually looks like —
  the freeze, the shake and the sparks were all timing, with nothing drawn at
  the point of contact but a pair of expanding rings.

  CC0 sprites from Brackeys' VFX Bundle (Kenney, Picster, CodeManu).
*/

interface FlipSheet {
  readonly file: string;
  readonly cols: number;
  readonly rows: number;
  readonly fps: number;
}

export const FLIPBOOKS = {
  hit: { file: 'vfx/big_hit_6x5.png', cols: 6, rows: 5, fps: 64 },
  clash: { file: 'vfx/impact_white_6x4.png', cols: 6, rows: 4, fps: 70 },
  ring: { file: 'vfx/electric_ring_6x5.png', cols: 6, rows: 5, fps: 46 },
  fire: { file: 'vfx/fire_ring_6x5.png', cols: 6, rows: 5, fps: 42 },
  charge: { file: 'vfx/charge_7x6.png', cols: 7, rows: 6, fps: 50 },
  burst: { file: 'vfx/star_explosion_6x5.png', cols: 6, rows: 5, fps: 44 },
} as const satisfies Record<string, FlipSheet>;

export type FlipKey = keyof typeof FLIPBOOKS;

const POOL = 12;

interface FlipItem {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  maps: Partial<Record<FlipKey, THREE.Texture>>;
  key: FlipKey | null;
  t: number;
  dur: number;
  roll: number;
  scale: number;
  peak: number;
}

class FlipbookSystem {
  private readonly sheets: Partial<Record<FlipKey, THREE.Texture>> = {};
  private readonly items: FlipItem[] = [];
  private built = false;

  /** Queue every sheet for download. The pool is built when the first one lands. */
  load(): void {
    for (const k of Object.keys(FLIPBOOKS) as FlipKey[]) {
      loadTex(FLIPBOOKS[k].file, (t) => {
        this.build();
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        this.sheets[k] = t;
      });
    }
  }

  has(k: FlipKey): boolean {
    return this.sheets[k] !== undefined;
  }

  play(k: FlipKey, pos: THREE.Vector3, scale = 1, colour = 0xffffff, roll = 0, alpha = 1): boolean {
    const sheet = this.sheets[k];
    if (!sheet) return false;
    const d = FLIPBOOKS[k];
    for (const it of this.items) {
      if (it.t > 0) continue;
      let map = it.maps[k];
      if (!map) {
        // each pooled quad gets its own clone so frames can be offset independently
        map = sheet.clone();
        map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
        map.repeat.set(1 / d.cols, 1 / d.rows);
        map.needsUpdate = true;
        it.maps[k] = map;
      }
      it.key = k;
      it.mesh.material.map = map;
      it.mesh.material.color.setHex(colour);
      it.peak = alpha;
      it.mesh.material.opacity = alpha;
      it.mesh.material.needsUpdate = true;
      it.t = 0.00001;
      it.dur = (d.cols * d.rows) / d.fps;
      it.roll = roll;
      it.scale = scale;
      it.mesh.position.copy(pos);
      it.mesh.scale.setScalar(scale);
      it.mesh.visible = true;
      return true;
    }
    return false;
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (it.t <= 0 || !it.key) continue;
      it.t += dt;
      const d = FLIPBOOKS[it.key];
      const n = d.cols * d.rows;
      const f = Math.floor((it.t / it.dur) * n);
      if (f >= n) {
        it.t = 0;
        it.mesh.visible = false;
        continue;
      }
      const map = it.maps[it.key]!;
      map.offset.x = (f % d.cols) / d.cols;
      map.offset.y = 1 - (Math.floor(f / d.cols) + 1) / d.rows;
      // billboard, then roll in screen space so slashes can be angled
      it.mesh.quaternion.copy(camera.quaternion);
      if (it.roll) it.mesh.rotateZ(it.roll);
      // a touch of growth and a fade on the tail keeps it from popping out
      const k = it.t / it.dur;
      it.mesh.scale.setScalar(it.scale * (1 + k * 0.22));
      it.mesh.material.opacity = it.peak * (k > 0.72 ? (1 - k) / 0.28 : 1);
    }
  }

  private build(): void {
    if (this.built) return;
    this.built = true;
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          transparent: true, depthWrite: false, fog: false,
          blending: THREE.AdditiveBlending, opacity: 1, side: THREE.DoubleSide,
        }),
      );
      mesh.visible = false;
      mesh.renderOrder = 12;
      scene.add(mesh);
      this.items.push({ mesh, maps: {}, key: null, t: 0, dur: 0, roll: 0, scale: 1, peak: 1 });
    }
  }

  reset(): void {
    for (const it of this.items) for (const m of Object.values(it.maps)) m?.dispose();
    this.items.length = 0;
    for (const k of Object.keys(this.sheets) as FlipKey[]) delete this.sheets[k];
    this.built = false;
  }
}

export const Flip = new FlipbookSystem();
