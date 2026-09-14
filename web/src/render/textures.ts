import * as THREE from 'three/webgpu';
import type { Theme } from '../config/themes';
import { clamp } from '../core/math';

/*
  Procedural canvas textures. Everything the stage needs before a single file
  has downloaded is painted here, so the game has a complete look on its first
  frame and the downloaded art replaces it in place when it arrives.

  Colour space follows the monolith exactly. The textures it sRGB-encoded are
  SRGBColorSpace here; the ones it left linear — the haze mask, the rune ring,
  the toon ramp — stay NoColorSpace, because moving them would shift the look
  for no reason. The difference is invisible on pure-white masks and very
  visible on the rune ring's orange.
*/

function paint(width: number, height: number): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas context unavailable');
  return { canvas, g };
}

function srgb<T extends THREE.Texture>(t: T): T {
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** "#RRGGBB" + alpha → "rgba(r,g,b,a)", for canvas gradient stops. */
export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function flagstoneTexture(): THREE.CanvasTexture {
  const s = 512;
  const { canvas, g } = paint(s, s);
  // sunlit granite flagstones — pale, warm, with mortar joints
  g.fillStyle = '#8E8371';
  g.fillRect(0, 0, s, s);
  const cell = 64;
  for (let y = 0; y < s; y += cell) {
    const off = ((y / cell) % 2) * (cell / 2);
    for (let x = -cell; x < s; x += cell) {
      const v = 176 + Math.random() * 46;
      g.fillStyle = `rgb(${Math.round(v)},${Math.round(v * 0.955)},${Math.round(v * 0.865)})`;
      g.fillRect(x + off + 2.5, y + 2.5, cell - 5, cell - 5);
    }
  }
  // weathering: cool shadow in the joints, warm dust on the faces
  for (let i = 0; i < 5200; i++) {
    const a = Math.random() * 0.07;
    g.fillStyle = Math.random() > 0.55 ? `rgba(150,120,80,${a})` : `rgba(70,80,95,${a})`;
    g.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 2);
  }
  const t = srgb(new THREE.CanvasTexture(canvas));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(9, 9);
  t.anisotropy = 4;
  return t;
}

/*
  A painted sky rather than a vertical ramp: at full width, so the theme's sun
  or moon can sit somewhere specific, throw a halo and light a band of cloud
  from below. The sphere's UVs put v = 1 at the zenith and image row 0 maps
  there, so canvas y reads top-down from the zenith; v = 0.5 is the horizon.
*/
export function skyTexture(theme: Theme): THREE.CanvasTexture {
  const W = 1024;
  const H = 512;
  const { canvas, g } = paint(W, H);

  const grad = g.createLinearGradient(0, 0, 0, H);
  for (const [stop, colour] of theme.sky) grad.addColorStop(stop, colour);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // horizontal cloud banding — soft, stretched, thickest near the horizon
  const bn = theme.band;
  for (let b = 0; b < bn.n; b++) {
    const by = H * (0.42 + Math.random() * 0.52);
    const bh = 3 + Math.random() * 16;
    const bx = Math.random() * W;
    const bw = W * (0.18 + Math.random() * 0.5);
    const near = 1 - Math.abs(by / H - 0.86) * 2.2;
    const band = g.createLinearGradient(bx, 0, bx + bw, 0);
    band.addColorStop(0, `rgba(${bn.color},0)`);
    band.addColorStop(0.5, `rgba(${bn.color},${(bn.op * Math.max(0.15, near)).toFixed(3)})`);
    band.addColorStop(1, `rgba(${bn.color},0)`);
    g.fillStyle = band;
    g.fillRect(bx, by, bw, bh);
  }

  // the sun or moon: a hard core inside a wide falloff halo
  const s0 = theme.sun;
  const sx = s0.u * W;
  const sy = (1 - s0.elev) * H;
  const hr = H * s0.halo;

  const halo = g.createRadialGradient(sx, sy, 0, sx, sy, hr);
  halo.addColorStop(0.00, hexA(s0.glow, 0.80));
  halo.addColorStop(0.18, hexA(s0.glow, 0.34));
  halo.addColorStop(0.50, hexA(s0.glow, 0.10));
  halo.addColorStop(1.00, hexA(s0.glow, 0.0));
  g.fillStyle = halo;
  g.fillRect(0, 0, W, H);

  const cr = H * s0.r;
  const core = g.createRadialGradient(sx, sy, 0, sx, sy, cr);
  core.addColorStop(0.00, hexA(s0.core, 1.0));
  core.addColorStop(0.55, hexA(s0.core, 0.88));
  core.addColorStop(1.00, hexA(s0.core, 0.0));
  g.fillStyle = core;
  g.beginPath();
  g.arc(sx, sy, cr, 0, Math.PI * 2);
  g.fill();

  // and the light it lays along the horizon either side of itself
  const lane = g.createLinearGradient(0, sy - hr * 0.14, 0, sy + hr * 0.14);
  lane.addColorStop(0, hexA(s0.glow, 0));
  lane.addColorStop(0.5, hexA(s0.glow, 0.22));
  lane.addColorStop(1, hexA(s0.glow, 0));
  g.fillStyle = lane;
  g.fillRect(0, sy - hr * 0.14, W, hr * 0.28);

  return srgb(new THREE.CanvasTexture(canvas));
}

export function waterTexture(): THREE.CanvasTexture {
  const s = 512;
  const { canvas, g } = paint(s, s);
  g.fillStyle = '#79b9c9';
  g.fillRect(0, 0, s, s);
  // soft horizontal ripple bands
  for (let i = 0; i < 240; i++) {
    const y = Math.random() * s;
    const w = 30 + Math.random() * 190;
    const x = Math.random() * s;
    g.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.16})`;
    g.lineWidth = 0.6 + Math.random() * 2.2;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + w * 0.3, y - 3, x + w * 0.7, y + 3, x + w, y);
    g.stroke();
  }
  for (let d = 0; d < 90; d++) {
    g.fillStyle = `rgba(40,110,130,${0.05 + Math.random() * 0.12})`;
    g.fillRect(Math.random() * s, Math.random() * s, 40 + Math.random() * 120, 2);
  }
  const t = srgb(new THREE.CanvasTexture(canvas));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  return t;
}

/** A soft round mote. Square points are the tell that a particle system is a particle system. */
export function moteSprite(): THREE.CanvasTexture {
  const s = 64;
  const { canvas, g } = paint(s, s);
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0.00, 'rgba(255,255,255,1)');
  grd.addColorStop(0.28, 'rgba(255,255,255,.78)');
  grd.addColorStop(0.62, 'rgba(255,255,255,.20)');
  grd.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return srgb(new THREE.CanvasTexture(canvas));
}

/** Torn cloud for the ground haze: soft blobs punched out of nothing, so the band has holes. */
export function hazeTexture(): THREE.CanvasTexture {
  const s = 512;
  const { canvas, g } = paint(s, s);
  g.clearRect(0, 0, s, s);
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * s;
    const y = Math.random() * s;
    const r = 36 + Math.random() * 120;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + Math.random() * 0.14;
    grd.addColorStop(0, `rgba(255,255,255,${a})`);
    grd.addColorStop(0.55, `rgba(255,255,255,${(a * 0.4).toFixed(3)})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // feather the top and bottom to nothing, so the band has no visible edge
  g.globalCompositeOperation = 'destination-in';
  const mask = g.createLinearGradient(0, 0, 0, s);
  mask.addColorStop(0.00, 'rgba(0,0,0,0)');
  mask.addColorStop(0.34, 'rgba(0,0,0,.55)');
  mask.addColorStop(0.72, 'rgba(0,0,0,1)');
  mask.addColorStop(1.00, 'rgba(0,0,0,.85)');
  g.fillStyle = mask;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over';

  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(2, 1);
  return t;
}

/** The glitter path a low sun lays across water: narrow at the source, breaking up toward the viewer. */
export function sunPathTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 512;
  const { canvas, g } = paint(w, h);
  g.clearRect(0, 0, w, h);
  for (let y = 0; y < h; y++) {
    const t = y / h;                                   // 0 at the horizon end
    const spread = Math.min(0.49, 0.10 + t * 0.38);    // the cone widens toward the camera
    const fade = Math.pow(1 - t, 0.55);
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(clamp(0.5 - spread, 0, 1), 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, `rgba(255,255,255,${(fade * 0.85).toFixed(3)})`);
    grad.addColorStop(clamp(0.5 + spread, 0, 1), 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, y, w, 1);
  }
  // break it into ripples, otherwise it reads as a painted stripe
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 300; i++) {
    const ry = Math.random() * h;
    g.fillStyle = `rgba(0,0,0,${0.18 + Math.random() * 0.5})`;
    g.fillRect(0, ry, w, 1 + Math.random() * 2.6);
  }
  g.globalCompositeOperation = 'source-over';
  return srgb(new THREE.CanvasTexture(canvas));
}

export function runeRingTexture(): THREE.CanvasTexture {
  const s = 512;
  const { canvas, g } = paint(s, s);
  const cx = s / 2;
  const cy = s / 2;
  const r = s * 0.40;
  g.strokeStyle = 'rgba(255,180,84,.62)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  g.lineWidth = 1;
  g.strokeStyle = 'rgba(226,97,43,.42)';
  g.beginPath();
  g.arc(cx, cy, r * 0.90, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const major = i % 4 === 0;
    const len = major ? 20 : 9;
    g.strokeStyle = `rgba(255,180,84,${major ? 0.85 : 0.35})`;
    g.lineWidth = major ? 3 : 1.5;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * (r - len), cy + Math.sin(a) * (r - len));
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(canvas);
  t.anisotropy = 4;
  return t;
}

/** A banded lighting ramp for MeshToonMaterial: flat primitives read as deliberate rather than cheap. */
export function toonRamp(steps: number): THREE.CanvasTexture {
  const { canvas, g } = paint(steps, 1);
  for (let i = 0; i < steps; i++) {
    const v = Math.round(255 * (0.34 + 0.54 * Math.pow(i / (steps - 1), 0.8)));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(i, 0, 1, 1);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}
