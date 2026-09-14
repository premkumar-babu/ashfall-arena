import { Burst } from '../fx/particles';
import { sparks, updatePortals, updateScorch, updateStreaks, updateVfx, type Portal, type Scorch } from '../fx/vfx';
import { state } from '../game/state';
import { arena, DUST, EMBERS, syncClouds } from './arena';
import { updateLandscape } from './landscape';

/*
  Everything on the stage that moves without being told to: branches and palm
  crowns in the wind, clouds and birds crossing, banners, the water scrolling,
  the lanterns flickering, what falls out of the air, the near-field dust and
  the mist — plus the ageing of every pooled effect.

  Presentation, not simulation: this runs once per displayed frame on real
  time, so it stays smooth on any display and never touches match state.
*/

const portals: Portal[] = [];
const scorches: Scorch[] = [];

export function updateAmbience(dt: number, t: number): void {
  const a = arena;
  const { P1, P2 } = state;

  for (let i = 0; i < a.branches.length; i++) {
    a.branches[i]!.rotation.z += Math.sin(t * 0.5 + i) * 0.00035;
  }
  for (const pt of a.palms) {
    if (!pt.g.visible) continue;
    pt.crown.rotation.z = Math.sin(t * 0.62 + pt.seed) * 0.075;
    pt.crown.rotation.x = Math.cos(t * 0.44 + pt.seed) * 0.055;
  }
  for (const c of a.clouds) {
    c.pos.x += c.sp * dt;
    if (c.pos.x > 170) c.pos.x = -170;
  }
  syncClouds();
  updateLandscape();                    // re-picks prop LODs only if the camera moved
  for (const b of a.birds) {
    b.g.position.x += b.sp * dt;
    b.g.position.y += Math.sin(t * 2.2 + b.ph) * 0.012;
    b.g.children[0]!.rotation.z = 0.45 + Math.sin(t * 9 + b.ph) * 0.5;
    b.g.children[1]!.rotation.z = -0.45 - Math.sin(t * 9 + b.ph) * 0.5;
    if (b.g.position.x > 60) b.g.position.x = -60;
  }
  for (const bn of a.banners) {
    bn.mesh.rotation.y = Math.sin(t * 1.1 + bn.seed) * 0.34;
    bn.mesh.rotation.z = Math.sin(t * 1.7 + bn.seed) * 0.06;
  }
  if (P1.assist?.parts.halo) P1.assist.parts.halo.rotation.z += dt * 1.1;
  if (P2.assist?.parts.halo) P2.assist.parts.halo.rotation.z += dt * 1.1;

  a.waterTex.offset.x += dt * 0.010;
  a.waterTex.offset.y -= dt * 0.006;
  a.runes.rotation.z += dt * 0.055;
  a.runes.material.opacity = 0.30 + Math.sin(t * 1.4) * 0.08;

  a.braziers.forEach((b, i) => {
    const f = 0.78 + Math.sin(t * 8 + b.seed) * 0.13 + Math.sin(t * 19.3 + i) * 0.08;
    if (b.light) b.light.intensity = b.base * (0.88 + (f - 0.78) * 0.5);
    // HDR: bloom now thresholds at 1.0 in linear light, so a flame has to sit
    // well above it to glow, and the flicker drives the glow with it
    b.flame.material.emissiveIntensity = (0.95 + (f - 0.78) * 0.8) * 2.8;
    if (b.glow) {
      b.glow.material.opacity = 0.44 + (f - 0.78) * 0.55;
      b.glow.scale.setScalar(3.4 + (f - 0.78) * 1.2);
    }
  });

  /* What falls out of the air is the theme's, not the stage's: blossom
     drifts, embers rise on their own heat, snow hangs and wanders, void motes
     barely fall at all. One multiplier each. */
  const mo = state.theme.motes;
  const pos = a.embers.positions;
  for (let i = 0; i < EMBERS; i++) {
    pos[i * 3 + 1]! += a.emberVel[i]! * mo.fall * dt;
    pos[i * 3]! += Math.sin(t * 1.4 + i) * 0.016 * mo.drift;
    pos[i * 3 + 2]! += Math.cos(t * 0.9 + i) * 0.006 * mo.drift;
    if (pos[i * 3 + 1]! < -1.0) {
      pos[i * 3 + 1] = 20;
      pos[i * 3] = (Math.random() - 0.5) * 52;
    }
  }
  a.embers.commit();

  // near-field dust: faster, wider, and it wraps in a much tighter box
  const dp = a.dust.positions;
  for (let d = 0; d < DUST; d++) {
    const seed = a.dustSeed[d]!;
    dp[d * 3]! += Math.sin(t * 0.7 + seed) * 0.055;
    dp[d * 3 + 1]! += (Math.cos(t * 0.5 + seed) * 0.02 - 0.10) * dt * 6;
    if (dp[d * 3 + 1]! < -0.5) {
      dp[d * 3 + 1] = 9;
      dp[d * 3] = (Math.random() - 0.5) * 26;
    }
    if (dp[d * 3]! > 14) dp[d * 3] = -14;
    if (dp[d * 3]! < -14) dp[d * 3] = 14;
  }
  a.dust.commit();

  // the mist bands scroll sideways at their own rate and breathe on the vertical
  a.hazeLayers.forEach((layer, i) => {
    const map = layer.mesh.material.map;
    if (map) map.offset.x += layer.sp * dt;
    layer.mesh.position.y = layer.y0 + Math.sin(t * 0.24 + i * 1.9) * 0.14;
  });

  for (const sk of sparks) {
    if (sk.life <= 0) continue;
    sk.life -= dt * 4.5;
    if (sk.life <= 0) {
      sk.mesh.visible = false;
      sk.life = 0;
      continue;
    }
    sk.mesh.material.opacity = sk.life * 0.42;
    sk.mesh.scale.setScalar(0.30 + (1 - sk.life) * 0.75);
    sk.mesh.rotation.set(sk.life * 5, sk.life * 4, 0);
  }

  Burst.update(dt);
  updateVfx(dt);
  updateStreaks(dt);

  // reuse two small arrays rather than allocating a pair per frame
  portals[0] = P1.assist!.portal;
  portals[1] = P2.assist!.portal;
  scorches[0] = P1.assist!.scorch;
  scorches[1] = P2.assist!.scorch;
  updatePortals(portals, dt);
  updateScorch(scorches, dt);
}
