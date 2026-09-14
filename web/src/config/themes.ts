import { storageGet, storageSet } from '../core/platform';

/*
  One table drives the whole look: the painted sky, the fog, every light in the
  rig, the water and stonework tints, what falls out of the air, the bloom
  curve, the final grade and the HTML palette.

  Everything here is data — the theme system is the only code that reads it —
  so a new time of day is a new object, not a new branch.

  Light intensities are in the LEGACY units they were tuned under; they are
  converted once where lights are written (see LEGACY_LIGHT_SCALE).
*/

type Vec3 = readonly [number, number, number];

export interface Theme {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly swatch: string;
  /** Vertical gradient stops for the sky sphere: [v, css colour]. v = 0.5 is the horizon. */
  readonly sky: ReadonlyArray<readonly [number, string]>;
  readonly sun: { readonly u: number; readonly elev: number; readonly core: string; readonly glow: string; readonly r: number; readonly halo: number };
  readonly band: { readonly color: string; readonly n: number; readonly op: number };
  readonly bg: number;
  readonly fog: number;
  readonly fogD: number;
  readonly ridge?: number;
  readonly amb: { readonly c: number; readonly f: number; readonly s: number };
  readonly hemi: { readonly sky: number; readonly gnd: number; readonly f: number; readonly s: number };
  readonly key: { readonly c: number; readonly f: number; readonly s: number; readonly pos: Vec3 };
  readonly rim: { readonly c: number; readonly i: number; readonly pos: Vec3 };
  readonly water: number;
  readonly wRough: number;
  readonly wMetal: number;
  readonly wOp: number;
  readonly cloud: number;
  readonly cloudOp: number;
  readonly bird: number;
  readonly floor: number;
  readonly dais: number;
  readonly stone: number;
  readonly timber: number;
  readonly tile: number;
  readonly trim: number;
  readonly petal: number;
  readonly petal2: number;
  readonly bark: number;
  /** Ask the floor for the full slate PBR set (albedo + normal + roughness). */
  readonly slate?: boolean;
  readonly normalScale?: number;
  readonly palms?: boolean;
  readonly plank?: boolean;
  readonly statues?: boolean;
  /** Neither palms nor blossom: palms:false on its own used to mean "cherry blossom". */
  readonly bare?: boolean;
  readonly motes: { readonly color: number; readonly size: number; readonly fall: number; readonly drift: number; readonly op: number };
  readonly haze: { readonly color: number; readonly op: number };
  readonly glint?: number;
  readonly dust: { readonly color: number; readonly op: number };
  readonly bloom: { readonly s: number; readonly r: number; readonly t: number };
  readonly exposure: number;
  readonly modelEnv: number;
  readonly grade: {
    readonly contrast: number; readonly sat: number; readonly vig: number;
    readonly ab: number; readonly grain: number; readonly lift: Vec3; readonly gain: Vec3;
  };
  readonly css: {
    readonly acc: string; readonly acc2: string; readonly ink: string; readonly panel: string;
    readonly line: string; readonly text: string; readonly dim: string;
  };
}

export const THEMES: readonly Theme[] = [
  /* OBSIDIAN is the dark-fantasy stage, and the default. It is built round a
     two-light schema rather than a painted sky: a warm gold key raking across
     wet slate, and a cold teal fill from behind and opposite, which is what
     puts a cool edge on a silhouette standing in front of a dark background.
     Everything else — the near-black fog, the low bloom threshold, the
     desaturated grade — exists to keep those two colours the only saturated
     things on screen. */
  {
    id: 'obsidian', name: 'OBSIDIAN', tag: 'the black court, by torchlight',
    swatch: '#FFAA44',
    /* Almost no sky: a cold violet gradient with one dull ember band where the
       horizon would be. The rim light does the separation a sky would. */
    sky: [[0.00, '#05030A'], [0.26, '#0A0710'], [0.40, '#140C1E'],
      [0.47, '#2A1430'], [0.50, '#4A2038'], [0.58, '#1A0E1C'], [1.00, '#05030A']],
    sun: { u: 0.50, elev: 0.520, core: '#FFCE8A', glow: '#C25A20', r: 0.030, halo: 0.30 },
    band: { color: '255,170,68', n: 9, op: 0.07 },
    bg: 0x0A0710, fog: 0x0A0710, fogD: 0.035, ridge: 0x1C1026,
    /* With a key at 2.5 the ambient terms decide whether the stage is dark or
       merely tinted. The shadow side of a fighter should fall to almost nothing
       and be rescued by the teal fill, not by fill-in ambient. */
    amb: { c: 0x4A3C5A, f: 0.05, s: 0.07 },
    hemi: { sky: 0x241A34, gnd: 0x060409, f: 0.09, s: 0.11 },
    key: { c: 0xFFAA44, f: 2.50, s: 2.50, pos: [-14, 7.5, 10] },
    rim: { c: 0x004466, i: 2.20, pos: [12, 7, -14] },
    water: 0x0A0714, wRough: 0.12, wMetal: 0.86, wOp: 0.96,
    cloud: 0x17101F, cloudOp: 0.05, bird: 0x080510,
    floor: 0x6A6A7E, dais: 0x1A1420, stone: 0x3A3040,
    timber: 0x2E2028, tile: 0x1E1A2E, trim: 0xC98A3A,
    petal: 0x2A1C34, petal2: 0x3A2844, bark: 0x120A16,
    slate: true, normalScale: 1.15,
    palms: false, plank: false, statues: true, bare: true,
    motes: { color: 0xFFAA44, size: 0.12, fall: 0.28, drift: 1.30, op: 0.55 },
    haze: { color: 0x2A1838, op: 0.050 },
    dust: { color: 0xC9A06A, op: 0.22 },
    bloom: { s: 0.78, r: 0.66, t: 0.88 },
    exposure: 0.66,
    modelEnv: 0.45,
    grade: {
      contrast: 1.24, sat: 0.92, vig: 1.18, ab: 0.0026, grain: 0.030,
      lift: [-0.016, -0.012, 0.022], gain: [0.004, 0.010, 0.030],
    },
    css: { acc: '#FFAA44', acc2: '#3FB7D0', ink: '#06040A', panel: '#120C18', line: '#2E2438', text: '#EDE6DC', dim: '#8C8098' },
  },
  {
    id: 'sundown', name: 'SUNDOWN', tag: 'the dock at the end of the day',
    swatch: '#FF5A2A',
    /* A huge pale sun on the waterline, orange overhead falling through crimson
       at the mountains and back up to gold at the horizon. Fighters are lit
       from the front and rimmed hard from behind by the sun. */
    sky: [[0.00, '#8E2436'], [0.22, '#C43038'], [0.36, '#E8452C'],
      [0.45, '#F4732E'], [0.50, '#FFC65A'], [0.58, '#C9533F'], [1.00, '#6E2030']],
    sun: { u: 0.50, elev: 0.532, core: '#FFF8DC', glow: '#FF9B32', r: 0.118, halo: 0.46 },
    band: { color: '255,120,70', n: 13, op: 0.15 },
    bg: 0xC43040, fog: 0xC9533F, fogD: 0.0082, ridge: 0x9E3446,
    amb: { c: 0xFF9A6A, f: 0.30, s: 0.34 },
    hemi: { sky: 0xFF7A4A, gnd: 0x3A1020, f: 0.34, s: 0.40 },
    key: { c: 0xFFD2A0, f: 0.74, s: 0.82, pos: [-11, 12, 11] },
    rim: { c: 0xFF9A4A, i: 0.58, pos: [0, 5, -22] },
    water: 0x8E2A40, wRough: 0.10, wMetal: 0.58, wOp: 0.96,
    cloud: 0xE8674A, cloudOp: 0.44, bird: 0x2A0A14,
    floor: 0x9A7048, dais: 0x4A2A1C, stone: 0x7A5A42,
    timber: 0x6A4530, tile: 0x54202E, trim: 0xE0A050,
    petal: 0x1E0A12, petal2: 0x24101A, bark: 0x160610,
    palms: true, plank: true, statues: false,
    motes: { color: 0xFFC070, size: 0.14, fall: 0.40, drift: 1.20, op: 0.70 },
    haze: { color: 0xFF8A4A, op: 0.046 }, glint: 0.95,
    dust: { color: 0xFFD79A, op: 0.30 },
    bloom: { s: 0.96, r: 0.70, t: 0.78 },
    exposure: 1.00,
    modelEnv: 1.15,
    grade: {
      contrast: 1.16, sat: 1.06, vig: 1.02, ab: 0.0024, grain: 0.020,
      lift: [0.004, -0.012, 0.010], gain: [0.038, 0.014, -0.016],
    },
    css: { acc: '#FF6A33', acc2: '#FFC46A', ink: '#160509', panel: '#20090F', line: '#4A1A24', text: '#FFF0DC', dim: '#B08A82' },
  },
  {
    id: 'ashfall', name: 'ASHFALL', tag: 'dusk over the cinder courtyard',
    swatch: '#FF7A33',
    sky: [[0.00, '#120B1C'], [0.24, '#2E1733'], [0.38, '#6B2937'],
      [0.46, '#B54A2C'], [0.50, '#F09A4E'], [0.58, '#7A3A2E'], [1.00, '#1A0E18']],
    sun: { u: 0.50, elev: 0.535, core: '#FFF0CC', glow: '#FF8A2E', r: 0.046, halo: 0.34 },
    band: { color: '255,150,90', n: 16, op: 0.16 },
    bg: 0x24132A, fog: 0x53263A, fogD: 0.0108, ridge: 0x6E3050,
    amb: { c: 0xFFAE84, f: 0.27, s: 0.30 },
    hemi: { sky: 0xFFA274, gnd: 0x2B1A26, f: 0.34, s: 0.36 },
    key: { c: 0xFFD2A2, f: 0.84, s: 0.94, pos: [-15, 13, 10] },
    rim: { c: 0x74AEE2, i: 0.46, pos: [11, 8, -13] },
    water: 0x2C2342, wRough: 0.10, wMetal: 0.82, wOp: 0.95,
    cloud: 0xD98AA6, cloudOp: 0.50, bird: 0x2B1622,
    floor: 0x33251E, dais: 0x2A1D1A, stone: 0x4C3A30,
    timber: 0x6B3A2C, tile: 0x3E5468, trim: 0xE0BC55,
    petal: 0xE79CB8, petal2: 0xF3BFD2, bark: 0x2B1B1E,
    motes: { color: 0xFF9646, size: 0.15, fall: 0.55, drift: 1.00, op: 0.90 },
    haze: { color: 0xE8734A, op: 0.032 },
    dust: { color: 0xFFC489, op: 0.34 },
    bloom: { s: 0.88, r: 0.66, t: 0.82 },
    exposure: 0.98,
    modelEnv: 1.25,
    grade: {
      contrast: 1.15, sat: 1.16, vig: 1.00, ab: 0.0022, grain: 0.023,
      lift: [-0.006, -0.020, 0.016], gain: [0.050, 0.018, -0.024],
    },
    css: { acc: '#FF7A33', acc2: '#FFC46A', ink: '#0A0710', panel: '#160D14', line: '#42262F', text: '#F2E6D6', dim: '#A08C86' },
  },
  {
    id: 'daybreak', name: 'DAYBREAK', tag: 'clear morning, high sun',
    swatch: '#7FC6E8',
    sky: [[0.00, '#2E6FA8'], [0.26, '#63A6CE'], [0.40, '#A6CBD6'],
      [0.48, '#CFC59C'], [0.50, '#E6D8AE'], [0.60, '#9FB8C0'], [1.00, '#6E8894']],
    sun: { u: 0.30, elev: 0.74, core: '#FFFFF2', glow: '#FFE9B0', r: 0.026, halo: 0.20 },
    band: { color: '255,255,255', n: 12, op: 0.10 },
    bg: 0xC9DCE4, fog: 0xD9E6E2, fogD: 0.0062, ridge: 0x8FA6B4,
    amb: { c: 0xBBD4E4, f: 0.15, s: 0.22 },
    hemi: { sky: 0xCFE7F5, gnd: 0xB39A72, f: 0.20, s: 0.30 },
    key: { c: 0xFFF3DC, f: 0.72, s: 0.84, pos: [11, 19, 12] },
    rim: { c: 0xA8DCEC, i: 0.14, pos: [-9, 7, -12] },
    water: 0x3E8CA6, wRough: 0.16, wMetal: 0.62, wOp: 0.94,
    cloud: 0xFDFBF6, cloudOp: 0.92, bird: 0x3B2A2E,
    floor: 0xA89E88, dais: 0x968B76, stone: 0xC6BAA0,
    timber: 0xC24E31, tile: 0x53768A, trim: 0xE0BC55,
    petal: 0xE79CB8, petal2: 0xF3BFD2, bark: 0x2B1B1E,
    motes: { color: 0xF2A6C0, size: 0.16, fall: 0.70, drift: 1.00, op: 0.90 },
    haze: { color: 0xDCEAF0, op: 0.030 },
    dust: { color: 0xFFF4D8, op: 0.20 },
    bloom: { s: 0.72, r: 0.58, t: 0.88 },
    exposure: 0.94,
    modelEnv: 0.85,
    grade: {
      contrast: 1.14, sat: 1.12, vig: 0.94, ab: 0.0018, grain: 0.020,
      lift: [-0.020, -0.006, 0.018], gain: [0.026, 0.014, -0.010],
    },
    css: { acc: '#E2612B', acc2: '#F0C24B', ink: '#0B0809', panel: '#15100F', line: '#3A2E2A', text: '#EDE3D2', dim: '#9A8A7C' },
  },
  {
    id: 'bloodmoon', name: 'BLOOD MOON', tag: 'an eclipse nobody asked for',
    swatch: '#E2334A',
    sky: [[0.00, '#0A0308'], [0.22, '#1E0712'], [0.36, '#3E0C1A'],
      [0.46, '#701424'], [0.50, '#B8232F'], [0.58, '#4A0E1A'], [1.00, '#160408']],
    sun: { u: 0.62, elev: 0.63, core: '#FF6A5A', glow: '#B01020', r: 0.058, halo: 0.42 },
    band: { color: '255,60,70', n: 10, op: 0.14 },
    bg: 0x16040C, fog: 0x360A18, fogD: 0.0150, ridge: 0x5A1024,
    amb: { c: 0xFF5A66, f: 0.20, s: 0.28 },
    hemi: { sky: 0xC81E34, gnd: 0x180410, f: 0.26, s: 0.34 },
    key: { c: 0xFFA090, f: 0.92, s: 1.02, pos: [12, 15, -8] },
    rim: { c: 0x7A4CE0, i: 0.60, pos: [-12, 7, 11] },
    water: 0x2A0814, wRough: 0.08, wMetal: 0.90, wOp: 0.96,
    cloud: 0x5E1220, cloudOp: 0.74, bird: 0x150208,
    floor: 0x2E1A1C, dais: 0x241216, stone: 0x5C3A38,
    timber: 0x8E2418, tile: 0x2A1A2E, trim: 0xE05C3C,
    petal: 0xC03050, petal2: 0xE2506A, bark: 0x1A0A10,
    motes: { color: 0xFF3A48, size: 0.14, fall: 0.35, drift: 1.60, op: 0.85 },
    haze: { color: 0xB01828, op: 0.040 },
    dust: { color: 0xFF7A72, op: 0.30 },
    bloom: { s: 1.02, r: 0.72, t: 0.76 },
    exposure: 1.00,
    modelEnv: 1.35,
    grade: {
      contrast: 1.22, sat: 1.10, vig: 1.14, ab: 0.0030, grain: 0.030,
      lift: [0.022, -0.014, 0.004], gain: [0.058, -0.010, -0.006],
    },
    css: { acc: '#E2334A', acc2: '#FF7A5E', ink: '#080306', panel: '#16060E', line: '#4A1824', text: '#F4DCDC', dim: '#A07A80' },
  },
  {
    id: 'frostfall', name: 'FROSTFALL', tag: 'snow on the duelling stones',
    swatch: '#9FD8F0',
    sky: [[0.00, '#243C58'], [0.24, '#40607E'], [0.38, '#7A98AC'],
      [0.46, '#B8CBD4'], [0.50, '#E2ECEE'], [0.60, '#A8BCC6'], [1.00, '#7A8C98']],
    sun: { u: 0.42, elev: 0.585, core: '#FFFFFF', glow: '#BFE0F2', r: 0.038, halo: 0.34 },
    band: { color: '220,240,255', n: 14, op: 0.13 },
    bg: 0x9FB4C2, fog: 0xB6CAD4, fogD: 0.0128, ridge: 0xAEC4D2,
    amb: { c: 0xCADEEE, f: 0.26, s: 0.36 },
    hemi: { sky: 0xDCEEFA, gnd: 0x6E7E8E, f: 0.34, s: 0.44 },
    key: { c: 0xEAF4FF, f: 0.80, s: 0.92, pos: [-10, 16, 12] },
    rim: { c: 0x8AB4E0, i: 0.30, pos: [12, 8, -10] },
    water: 0x6E96AC, wRough: 0.22, wMetal: 0.48, wOp: 0.92,
    cloud: 0xF2F8FC, cloudOp: 0.86, bird: 0x40505E,
    floor: 0x8E9CA8, dais: 0x74838F, stone: 0xB0BCC6,
    timber: 0x8E5A48, tile: 0x4A6474, trim: 0xCBD8E0,
    petal: 0xFFFFFF, petal2: 0xE4F0F8, bark: 0x34302E,
    motes: { color: 0xFFFFFF, size: 0.19, fall: 0.30, drift: 1.90, op: 0.95 },
    haze: { color: 0xCFE2EE, op: 0.034 },
    dust: { color: 0xFFFFFF, op: 0.30 },
    bloom: { s: 0.78, r: 0.62, t: 0.88 },
    exposure: 0.96,
    modelEnv: 1.00,
    grade: {
      contrast: 1.12, sat: 0.92, vig: 0.90, ab: 0.0014, grain: 0.018,
      lift: [-0.012, -0.002, 0.022], gain: [0.008, 0.016, 0.030],
    },
    css: { acc: '#6EB6E0', acc2: '#BFE4F6', ink: '#080C10', panel: '#101820', line: '#2C3C4A', text: '#E8F0F6', dim: '#8A9AA6' },
  },
  {
    id: 'voidgate', name: 'VOIDGATE', tag: 'somewhere the sun never was',
    swatch: '#B44CF0',
    sky: [[0.00, '#05030A'], [0.26, '#0E0620'], [0.40, '#1E0C3E'],
      [0.47, '#40188A'], [0.50, '#9432D4'], [0.58, '#2A0C50'], [1.00, '#0A0418']],
    sun: { u: 0.50, elev: 0.605, core: '#F0C8FF', glow: '#8A2EE0', r: 0.052, halo: 0.46 },
    band: { color: '170,90,255', n: 12, op: 0.16 },
    bg: 0x0A0418, fog: 0x1C0A34, fogD: 0.0165, ridge: 0x3C1A6E,
    amb: { c: 0xA060F0, f: 0.22, s: 0.30 },
    hemi: { sky: 0x8A3CE0, gnd: 0x0A0418, f: 0.28, s: 0.36 },
    key: { c: 0xE0C0FF, f: 0.86, s: 0.96, pos: [-12, 14, -10] },
    rim: { c: 0x2EE8D0, i: 0.68, pos: [12, 8, 12] },
    water: 0x140838, wRough: 0.06, wMetal: 0.94, wOp: 0.97,
    cloud: 0x3A1470, cloudOp: 0.60, bird: 0x10041E,
    floor: 0x241C3A, dais: 0x1A142C, stone: 0x4E4270,
    timber: 0x5E2A8E, tile: 0x1E1040, trim: 0x3EE8D0,
    petal: 0x9A4CE0, petal2: 0x50E8D8, bark: 0x180830,
    motes: { color: 0x9A5CFF, size: 0.16, fall: 0.22, drift: 2.30, op: 0.95 },
    haze: { color: 0x6A24C0, op: 0.044 },
    dust: { color: 0x50E8D8, op: 0.36 },
    bloom: { s: 1.08, r: 0.76, t: 0.74 },
    exposure: 1.00,
    modelEnv: 1.45,
    grade: {
      contrast: 1.26, sat: 1.28, vig: 1.18, ab: 0.0036, grain: 0.028,
      lift: [0.016, -0.014, 0.034], gain: [0.030, -0.014, 0.056],
    },
    css: { acc: '#B44CF0', acc2: '#3EE8D0', ink: '#05030A', panel: '#120A22', line: '#3A2060', text: '#EDE2FA', dim: '#9484AE' },
  },
];

const THEME_KEY = 'ashfall.theme';

/** The saved stage, or the default (OBSIDIAN) when there is none or it no longer exists. */
export function restoreThemeIndex(): number {
  const saved = storageGet(THEME_KEY);
  const i = THEMES.findIndex((t) => t.id === saved);
  return i >= 0 ? i : 0;
}

export function saveTheme(theme: Theme): void {
  storageSet(THEME_KEY, theme.id);
}
