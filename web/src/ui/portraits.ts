import * as THREE from 'three/webgpu';
import { ROSTER } from '../config/roster';
import type { Fighter } from '../game/fighter';
import { rigs } from '../game/rigs';
import { legacyIntensity } from '../render/lights';

/*
  Select-card portraits.

  The actual fighter, not a placeholder polygon. The rig is borrowed into a
  private scene for one render, lit as a portrait rather than a stage, shot
  from the chest up and read back into a canvas. Borrowing rather than cloning
  guarantees the card shows the same art the match will use, including
  whichever model finished downloading.

  Readback is asynchronous under WebGPU (the GPU copies into a mapped buffer
  when it gets to it), so a refresh is async and a refresh requested while one
  is running is coalesced into one more pass afterwards. The rig is returned
  to the stage synchronously, straight after the render call, so the match
  never sees a missing fighter while the pixels are in flight.
*/

const SIZE = 256;
const _head = new THREE.Vector3();

/* A render target gets neither tone mapping nor the sRGB output transform —
   those belong to the canvas — so the linear bytes are encoded here. The
   monolith's portrait target was sRGB-encoded and untonemapped, which this
   matches. */
const LINEAR_TO_SRGB = (() => {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    const s = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    lut[i] = Math.round(s * 255);
  }
  return lut;
})();

function backdropTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(s / 2, s * 0.30, 0, s / 2, s * 0.30, s * 0.78);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.42, 'rgba(255,255,255,.42)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A held stance rather than a frame of the idle loop: weight back, lead shoulder open to camera. */
function holdPortraitPose(f: Fighter): void {
  f.body.position.set(0, 0, 0);
  f.body.rotation.set(0, 0, 0);
  f.torso.rotation.set(0.02, -0.22, 0);
  f.neck.rotation.set(-0.06, 0.18, 0);
  f.armF.shoulder.rotation.set(-0.52, 0, -0.30);
  f.armF.elbow.rotation.set(-1.05, 0, 0);
  f.armB.shoulder.rotation.set(-0.30, 0, 0.34);
  f.armB.elbow.rotation.set(-0.86, 0, 0);
  f.legF.hip.rotation.set(0.16, 0, 0);
  f.legB.hip.rotation.set(-0.18, 0, 0);
  f.legF.knee.rotation.set(0.10, 0, 0);
  f.legB.knee.rotation.set(0.14, 0, 0);
  f.cape.rotation.set(-0.20, 0, 0);
}

class PortraitStudio {
  private readonly rt = new THREE.RenderTarget(SIZE, SIZE);
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  private readonly rim: THREE.DirectionalLight;
  private readonly back: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  /* WebGL reads rows bottom-up; WebGPU textures are top-down. */
  private readonly flipRows: boolean;
  private busy = false;
  private queued = false;
  private disposed = false;

  constructor(private readonly renderer: THREE.WebGPURenderer) {
    this.flipRows = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true;
    this.cam.position.set(0.95, 2.70, 2.75);
    this.cam.lookAt(0, 2.42, 0);

    // a portrait rig, not a stage rig: hard key, coloured kicker, just enough fill
    const key = new THREE.DirectionalLight(0xfff2e0, legacyIntensity(2.05));
    key.position.set(2.4, 4.2, 3.4);
    this.rim = new THREE.DirectionalLight(0xffffff, legacyIntensity(2.60));
    this.rim.position.set(-2.8, 2.6, -2.2);
    const fill = new THREE.HemisphereLight(0xbfd4e8, 0x2a2028, legacyIntensity(0.80));
    this.scene.add(key, this.rim, fill);

    this.back = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 9),
      new THREE.MeshBasicMaterial({ map: backdropTexture(), transparent: true, depthWrite: false, opacity: 0.92 }),
    );
    this.back.position.set(0, 2.5, -2.6);
    this.scene.add(this.back);

    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d')!;
  }

  async refresh(): Promise<void> {
    if (this.busy) {
      this.queued = true;
      return;
    }
    this.busy = true;
    try {
      for (let i = 0; i < ROSTER.length; i++) {
        if (this.disposed) return;
        const f = rigs[0][i];
        if (!f) continue;
        let url: string;
        try {
          url = await this.shoot(f, ROSTER[i]!.accent);
        } catch (err) {
          if (import.meta.env.DEV) console.warn('[portraits] shot failed', err);
          continue;                               // one bad card must not cost the rest
        }
        if (this.disposed) return;
        for (const s of [0, 1]) {
          const slot = document.querySelector<HTMLElement>(`#grid${s} .card[data-index="${i}"] .portrait`);
          if (!slot) continue;
          slot.style.backgroundImage = `url(${url})`;
          slot.classList.add('shot');
        }
      }
    } finally {
      this.busy = false;
      if (this.queued && !this.disposed) {
        this.queued = false;
        void this.refresh();
      }
    }
  }

  private async shoot(f: Fighter, accent: number): Promise<string> {
    const { renderer } = this;
    const root = f.root;
    const home = root.parent;
    const was = { vis: root.visible, aura: f.aura.visible, blob: f.blob.visible, light: f.powerLight.intensity };
    const pos = root.position.clone();
    const rot = root.rotation.clone();
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();

    this.rim.color.set(accent);
    this.back.material.color.set(accent);
    root.visible = true;
    f.aura.visible = false;               // the power aura is a match effect
    f.blob.visible = false;               // and so is the ground shadow
    f.powerLight.intensity = 0;
    root.position.set(0, 0, 0);
    root.rotation.set(0, 0.42, 0);
    holdPortraitPose(f);
    this.scene.add(root);
    root.updateMatrixWorld(true);
    this.frameOn(f);

    let pixels: Promise<ArrayBufferView>;
    try {
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.rt);
      renderer.clear();
      renderer.render(this.scene, this.cam);
      // queued now, while this frame is still in the target; resolved later
      pixels = renderer.readRenderTargetPixelsAsync(this.rt, 0, 0, SIZE, SIZE) as Promise<ArrayBufferView>;
    } finally {
      renderer.setRenderTarget(null);
      renderer.setClearColor(clearColor, clearAlpha);
      if (home) home.add(root);
      else this.scene.remove(root);
      root.visible = was.vis;
      f.aura.visible = was.aura;
      f.blob.visible = was.blob;
      f.powerLight.intensity = was.light;
      root.position.copy(pos);
      root.rotation.copy(rot);
    }

    const view = await pixels;
    const src = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const img = this.ctx.createImageData(SIZE, SIZE);
    const row = SIZE * 4;
    for (let y = 0; y < SIZE; y++) {
      const from = (this.flipRows ? SIZE - 1 - y : y) * row;
      const to = y * row;
      for (let x = 0; x < row; x += 4) {
        img.data[to + x] = LINEAR_TO_SRGB[src[from + x]!]!;
        img.data[to + x + 1] = LINEAR_TO_SRGB[src[from + x + 1]!]!;
        img.data[to + x + 2] = LINEAR_TO_SRGB[src[from + x + 2]!]!;
        img.data[to + x + 3] = src[from + x + 3]!;
      }
    }
    this.ctx.putImageData(img, 0, 0);
    return this.canvas.toDataURL('image/png');
  }

  /* Chest-up on the fighter's own head, not a fixed height: the cast's builds
     (longer legs on some, a lower brute) put every head somewhere different. */
  private frameOn(f: Fighter): void {
    let head: THREE.Object3D | null = null;
    f.model?.traverse((n) => {
      if (!head && (n as THREE.Bone).isBone && /^head$/i.test(n.name)) head = n;
    });
    const y = head ? (head as THREE.Object3D).getWorldPosition(_head).y + 0.22 : 2.42;
    this.cam.position.set(0.95, y + 0.28, 2.75);
    this.cam.lookAt(0, y, 0);
    this.back.position.y = y + 0.08;
  }

  dispose(): void {
    this.disposed = true;
    this.rt.dispose();
    this.back.geometry.dispose();
    this.back.material.map?.dispose();
    this.back.material.dispose();
  }
}

let studio: PortraitStudio | null = null;
let timer = 0;

export function initPortraits(renderer: THREE.WebGPURenderer): void {
  studio = new PortraitStudio(renderer);
}

export function refreshPortraits(): Promise<void> {
  return studio ? studio.refresh() : Promise.resolve();
}

/** Debounced: several models landing together cost one re-shoot. */
export function schedulePortraits(delayMs = 120): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refreshPortraits(), delayMs);
}

export function disposePortraits(): void {
  window.clearTimeout(timer);
  studio?.dispose();
  studio = null;
}
