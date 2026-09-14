/*
  Quality presets: every number LOW / MEDIUM / HIGH changes, in one table.

  Before this the levels were three tables in three files (render scale in
  settings, the post chain in post.ts, shadows in stage.ts), and scenery
  detail did not follow quality at all. Each consumer now reads its own
  column from here:

      pixelRatio  Viewport — cap on the device pixel ratio
      post        render/post.ts — ambient occlusion, anti-aliasing, depth of field
      shadow      render/stage.ts — key light shadow map size and blur
      lodBias     world/landscape.ts — scales every scenery LOD threshold
      grass       world/landscape.ts — the wind-blown grass on the banks

  AUTO is not a fourth preset. It picks one of the three from the device
  (detectQuality) and lets the frame governor step it down if the frame rate
  cannot hold.
*/

export type Quality = 'low' | 'med' | 'high';
export type QualityChoice = Quality | 'auto';

export const QUALITY_LEVELS: readonly Quality[] = ['low', 'med', 'high'];

export interface QualityPreset {
  readonly label: string;
  readonly pixelRatio: number;
  readonly post: {
    readonly ao: boolean;
    readonly aoSamples: number;
    readonly aa: 'smaa' | 'fxaa';
    readonly dof: boolean;
  };
  readonly shadow: { readonly size: number; readonly radius: number; readonly blur: number };
  /** Multiplies every scenery LOD threshold: 2 drops detail at twice the on-screen size. */
  readonly lodBias: number;
  readonly grass: boolean;
}

export const QUALITY_PRESETS: Readonly<Record<Quality, QualityPreset>> = {
  low: {
    label: 'LOW',
    pixelRatio: 0.7,
    post: { ao: false, aoSamples: 0, aa: 'fxaa', dof: false },
    shadow: { size: 1024, radius: 3, blur: 6 },
    lodBias: 2.2,
    grass: false,
  },
  med: {
    label: 'MEDIUM',
    pixelRatio: 1.0,
    post: { ao: true, aoSamples: 8, aa: 'smaa', dof: false },
    shadow: { size: 2048, radius: 5, blur: 10 },
    lodBias: 1.4,
    grass: true,
  },
  high: {
    label: 'HIGH',
    pixelRatio: 2.0,
    post: { ao: true, aoSamples: 16, aa: 'smaa', dof: true },
    shadow: { size: 2048, radius: 7, blur: 16 },
    lodBias: 1,
    grass: true,
  },
};

export function isQuality(q: unknown): q is Quality {
  return q === 'low' || q === 'med' || q === 'high';
}

export function isQualityChoice(q: unknown): q is QualityChoice {
  return q === 'auto' || isQuality(q);
}

/** The next preset down, or null at the bottom. */
export function lowerQuality(q: Quality): Quality | null {
  const i = QUALITY_LEVELS.indexOf(q);
  return i > 0 ? QUALITY_LEVELS[i - 1]! : null;
}

/*
  A starting guess for AUTO. There is no reliable way to ask a browser how fast
  its GPU is — detect-gpu does it by downloading a benchmark table, which an
  itch.io embed cannot rely on — so this errs low on anything that looks like a
  phone or a small machine, and the governor corrects downward from there if
  the guess was still too ambitious.
*/
export function detectQuality(backend: 'webgpu' | 'webgl2'): Quality {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = nav.deviceMemory ?? 8;
  if (coarse && (memory <= 4 || cores <= 6)) return 'low';
  if (coarse || backend === 'webgl2' || memory <= 4 || cores <= 4) return 'med';
  return 'high';
}
