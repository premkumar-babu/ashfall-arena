import * as THREE from 'three/webgpu';
import {
  convertToTexture, dot, float, fract, Fn, length, mix, pass, renderOutput, screenUV, sin, smoothstep,
  toneMapping, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import type { Theme } from '../config/themes';
import { QUALITY_PRESETS, type Quality } from '../config/quality';

/*
  The post-processing pipeline.

  EffectComposer, N8AO and the WebGL SMAA pass were not used: they are
  WebGLRenderer-only and cannot run under WebGPURenderer at all. RenderPipeline
  is the node-based replacement — the same idea, a chain of passes — and every
  stage below is a TSL node that compiles to WGSL on WebGPU and GLSL on the
  WebGL2 fallback.

    scene (HDR, half-float)
      → GTAO ambient occlusion (half resolution, normals rebuilt from depth)
      → bloom on HDR values
      → Neutral tone mapping → sRGB
      → depth of field (high quality only)
      → SMAA (FXAA on low)
      → grade: split-tone, contrast, saturation, fringing, vignette, grain

  Why this order:
  - AO is applied to the lit HDR image before bloom, so glow isn't darkened.
  - Bloom thresholds HDR values, so only genuinely bright things glow —
    flames and sparks are authored above 1.0 to get it, lit stone isn't.
  - Neutral (Khronos PBR Neutral) leaves colours below ~0.8 almost untouched
    and only rolls off highlights. The whole stage was tuned without tone
    mapping, and ACES at the theme exposures crushed it to near-black; this
    keeps that look while giving bloom and speculars headroom.
  - Anti-aliasing runs on the final LDR image, before grain and fringing,
    which would otherwise read as edges to smooth.

  AO normals come from depth, not an MRT normal target: additive particles
  draw into every colour attachment they're given and would corrupt a normal
  buffer wherever they overlap, whereas they never write depth.
*/

/* Bloom baseline, on HDR values. Themes bias these rather than replacing them. */
const BLOOM_BASE = { strength: 0.32, radius: 0.45, threshold: 1.0 } as const;
export const BLOOM: { strength: number; radius: number; threshold: number } = { ...BLOOM_BASE };

/* What each quality level runs (ambient occlusion, AA, depth of field) is the
   `post` column of config/quality.ts. */

type DisposableNode = { dispose(): void };
/** Nodes that render to their own target at runtime, where the typings omit the accessor. */
type TextureOutput = { getTextureNode(): THREE.TextureNode };

export class PostStack {
  private readonly pipeline: THREE.RenderPipeline;
  private readonly scenePass: ReturnType<typeof pass>;
  private bloomNode: ReturnType<typeof bloom> | null = null;
  private owned: DisposableNode[] = [];
  private quality: Quality | null = null;
  private theme: Theme | null = null;

  private readonly u = {
    time: uniform(0),
    exposure: uniform(1.0),
    aoStrength: uniform(0.9),
    vignette: uniform(0.94),
    grain: uniform(0.020),
    aberration: uniform(0.0018),
    contrast: uniform(1.14),
    saturation: uniform(1.12),
    lift: uniform(new THREE.Vector3(-0.020, -0.006, 0.018)),
    gain: uniform(new THREE.Vector3(0.026, 0.014, -0.010)),
    focus: uniform(10),
    focalRange: uniform(24),
    bokeh: uniform(1.0),
    // impact kicks, driven each frame by fx/juice.ts and added on top of the theme's grade
    kickAb: uniform(0),
    kickFlash: uniform(0),
    kickDesat: uniform(0),
  };

  enabled = true;
  bloomOn = true;

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    quality: Quality,
  ) {
    /* No MSAA on the scene pass. It would inherit the renderer's 4 samples,
       which makes the depth texture multisampled — and GTAO and depth of
       field both sample depth with filtering that multisampled textures
       don't support (the shaders fail to compile). SMAA / FXAA below do the
       anti-aliasing instead, on the final image. */
    this.scenePass = pass(scene, camera, { samples: 0 });
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputColorTransform = false;   // tone mapping and sRGB are done explicitly below
    this.setQuality(quality);
  }

  /** Rebuild the graph for a quality level. Costs a shader compile, so it only happens on a settings change. */
  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    const p = QUALITY_PRESETS[q].post;

    for (const n of this.owned) n.dispose();
    this.owned = [];

    const color = this.scenePass.getTextureNode('output');
    const depth = this.scenePass.getTextureNode('depth');
    let hdr = color.rgb;

    if (p.ao) {
      // normals rebuilt from depth (see the header): transparent effects can't disturb it
      // null normals is supported by GTAONode (it reconstructs from depth); the typings just don't admit it
      const aoNode = ao(depth, null as unknown as THREE.Node, this.camera);
      aoNode.resolutionScale = 0.5;
      aoNode.samples.value = p.aoSamples;
      // scene units: fighters are 3.2 tall, so contact shadow should reach most of a metre
      aoNode.radius.value = 0.7;
      aoNode.thickness.value = 1.4;
      aoNode.distanceExponent.value = 1.2;
      this.owned.push(aoNode);
      // the sky writes no depth; GTAO discards there, so it is forced unoccluded
      const occlusion = depth.r.greaterThanEqual(0.99999).select(float(1), aoNode.getTextureNode().r);
      hdr = hdr.mul(mix(float(1), occlusion, this.u.aoStrength));
    }

    const bloomNode = bloom(vec4(hdr, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.bloomNode = bloomNode;
    this.owned.push(bloomNode);

    const mapped = toneMapping(THREE.NeutralToneMapping, this.u.exposure.mul(float(1).add(this.u.kickFlash)), hdr.add(bloomNode.rgb));
    // the tone-mapping node carries alpha; only its colour is taken
    let ldr: THREE.Node = renderOutput(vec4(mapped.xyz, 1), THREE.NoToneMapping, THREE.SRGBColorSpace);

    if (p.dof) {
      const dofNode = dof(ldr, this.scenePass.getViewZNode(), this.u.focus, this.u.focalRange, this.u.bokeh);
      this.owned.push(dofNode);
      /* The node itself goes into the graph, not getTextureNode(): DOF hands
         back a plain texture that is not tied to the node, so sampling it
         never triggers the node's per-frame render and reads black. */
      ldr = dofNode;
    }

    /* SMAA renders into its own target and exposes it; FXAA is a single
       inline pass with no target, so it gets one for the grade to sample. */
    let src: THREE.TextureNode;
    if (p.aa === 'smaa') {
      const aaNode = smaa(ldr);
      this.owned.push(aaNode);
      src = (aaNode as unknown as TextureOutput).getTextureNode();
    } else {
      const aaNode = fxaa(ldr);
      this.owned.push(aaNode);
      src = convertToTexture(aaNode);
    }
    const u = this.u;

    const graded = Fn(() => {
      const c = screenUV.sub(0.5);
      const r = length(c);
      // lens fringing grows toward the edge, so the centre of the fight stays clean
      const off = c.mul(u.aberration.add(u.kickAb)).mul(r).mul(2.4);
      const col = vec3(
        src.sample(screenUV.add(off)).r,
        src.sample(screenUV).g,
        src.sample(screenUV.sub(off)).b,
      ).toVar();

      const lum = dot(col, vec3(0.2126, 0.7152, 0.0722)).toVar();
      col.assign(mix(vec3(lum), col, u.saturation.mul(float(1).sub(u.kickDesat))));
      col.assign(col.sub(0.5).mul(u.contrast).add(0.5).clamp(0, 1));
      const sh = float(1).sub(smoothstep(0.0, 0.55, lum));
      const hi = smoothstep(0.45, 1.0, lum);
      col.addAssign(u.lift.mul(sh).add(u.gain.mul(hi)));

      const v = float(1).sub(smoothstep(0.26, 0.80, r.mul(u.vignette))).toVar();
      col.mulAssign(mix(0.52, 1.0, v));
      const seed = screenUV.mul(900).add(fract(u.time).mul(131));
      const g = fract(sin(dot(seed, vec2(127.1, 311.7))).mul(43758.5453)).sub(0.5);
      col.addAssign(g.mul(u.grain).mul(float(1).sub(v.mul(0.55))));
      return vec4(col, 1);
    })();

    this.pipeline.outputNode = graded;
    this.pipeline.needsUpdate = true;
    if (this.theme) this.applyTheme(this.theme);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  setBloomOn(on: boolean): void {
    this.bloomOn = on;
    if (this.bloomNode) this.bloomNode.strength.value = on ? BLOOM.strength : 0;
  }

  /** Per-frame impact kicks: extra fringing, an exposure flash (fraction), and desaturation (0–1). */
  setKick(aberration: number, flash: number, desat: number): void {
    this.u.kickAb.value = aberration;
    this.u.kickFlash.value = flash;
    this.u.kickDesat.value = desat;
  }

  /** Where the depth of field focuses (distance from camera) and how quickly it falls off. */
  setFocus(distance: number, range: number, bokeh: number): void {
    this.u.focus.value = distance;
    this.u.focalRange.value = range;
    this.u.bokeh.value = bokeh;
  }

  /* A theme's bloom numbers are a bias on the baseline, read relative to the
     values they were authored against (0.78 / 0.66 / 0.88). */
  applyTheme(T: Theme): void {
    this.theme = T;
    BLOOM.strength = BLOOM_BASE.strength * (T.bloom.s / 0.78);
    BLOOM.radius = BLOOM_BASE.radius * (T.bloom.r / 0.66);
    BLOOM.threshold = BLOOM_BASE.threshold + (T.bloom.t - 0.88);
    if (this.bloomNode) {
      this.bloomNode.strength.value = this.bloomOn ? BLOOM.strength : 0;
      this.bloomNode.radius.value = BLOOM.radius;
      this.bloomNode.threshold.value = BLOOM.threshold;
    }

    const gr = T.grade;
    this.u.contrast.value = gr.contrast;
    this.u.saturation.value = gr.sat;
    this.u.vignette.value = gr.vig;
    this.u.aberration.value = gr.ab;
    this.u.grain.value = gr.grain;
    this.u.lift.value.set(...gr.lift);
    this.u.gain.value.set(...gr.gain);
  }

  /** Dev-panel readout. */
  label(): string {
    if (!this.enabled) return 'OFF';
    const p = QUALITY_PRESETS[this.quality ?? 'high'].post;
    const parts = [p.ao ? 'GTAO' : null, this.bloomOn ? `BLOOM ${BLOOM.strength.toFixed(2)}` : null, p.aa.toUpperCase(), p.dof ? 'DOF' : null];
    return parts.filter(Boolean).join(' · ');
  }

  render(time: number): void {
    if (this.enabled) {
      this.u.time.value = time;
      this.pipeline.render();
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    for (const n of this.owned) n.dispose();
    this.owned = [];
    this.scenePass.dispose();
    this.pipeline.dispose();
  }
}

export let post: PostStack | null = null;

export function createPost(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, quality: Quality): PostStack {
  post = new PostStack(renderer, scene, camera, quality);
  return post;
}

export function disposePost(): void {
  post?.dispose();
  post = null;
}
