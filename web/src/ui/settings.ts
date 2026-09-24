import type { Quality, QualityChoice } from '../config/quality';
import { storageGetJSON, storageSetJSON } from '../core/platform';

export { isQuality, isQualityChoice, type Quality, type QualityChoice } from '../config/quality';

/*
  Player settings: the values themselves, and their persisted form. The
  switches that change them live in front-end.ts; everything that only needs
  to read a setting (the camera reads shakeOn, the renderer reads the quality
  level) imports this and nothing else. What each quality level changes is
  config/quality.ts.
*/

export type ModalBack = 'title' | 'pause';

export const settings = {
  /** Where the modal returns to: the same pane is reachable from the title and from a paused match. */
  modalBack: 'title' as ModalBack,
  /** What the player picked: a preset, or AUTO. */
  quality: 'auto' as QualityChoice,
  /** The preset actually running. Under AUTO the frame governor can lower it. */
  level: 'high' as Quality,
  shakeOn: true,
  bloomOn: true,
  /** Blood sprays and pools. */
  goreOn: true,
  /** The spoken announcer. */
  voiceOn: true,
  /** A remembered mute, held until PLAY supplies the user gesture audio needs. */
  wantSfx: undefined as boolean | undefined,
  /** Remembered music, started by the same gesture. */
  wantMusic: undefined as boolean | undefined,
};

/** What RESET TO DEFAULTS restores. */
export const DEFAULTS = {
  volMaster: 0.5, volSfx: 1, volMusic: 0.7, volAmb: 0.6, quality: 'auto' as QualityChoice,
  post: true, bloom: true, shake: true, haptics: true, gore: true, voice: true,
} as const;

export interface StoredSettings {
  sfx?: boolean;
  music?: boolean;
  post?: boolean;
  quality?: QualityChoice;
  shake?: boolean;
  bloom?: boolean;
  volMaster?: number;
  volSfx?: number;
  volMusic?: number;
  volAmb?: number;
  haptics?: boolean;
  gore?: boolean;
  voice?: boolean;
}

const SETTINGS_KEY = 'ashfall.settings';

export function loadSettings(): StoredSettings {
  return storageGetJSON<StoredSettings>(SETTINGS_KEY) ?? {};
}

export function writeSettings(s: StoredSettings): void {
  storageSetJSON(SETTINGS_KEY, s);
}
