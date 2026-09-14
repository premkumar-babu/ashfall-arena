import { storageGetJSON, storageSetJSON } from '../core/platform';

/*
  Player settings: the values themselves, and their persisted form. The
  switches that change them live in front-end.ts; everything that only needs
  to read a setting (the camera reads shakeOn, the renderer reads quality)
  imports this and nothing else.
*/

export type Quality = 'low' | 'med' | 'high';

/** Render-scale cap per quality level, applied as a maximum device pixel ratio. */
export const QUALITY: Readonly<Record<Quality, number>> = { low: 0.7, med: 1.0, high: 2.0 };

export function isQuality(q: unknown): q is Quality {
  return q === 'low' || q === 'med' || q === 'high';
}

export type ModalBack = 'title' | 'pause';

export const settings = {
  /** Where the modal returns to: the same pane is reachable from the title and from a paused match. */
  modalBack: 'title' as ModalBack,
  quality: 'high' as Quality,
  shakeOn: true,
  bloomOn: true,
  /** A remembered mute, held until PLAY supplies the user gesture audio needs. */
  wantSfx: undefined as boolean | undefined,
};

export interface StoredSettings {
  sfx?: boolean;
  music?: boolean;
  post?: boolean;
  quality?: Quality;
  shake?: boolean;
  bloom?: boolean;
  volMaster?: number;
  volSfx?: number;
}

const SETTINGS_KEY = 'ashfall.settings';

export function loadSettings(): StoredSettings {
  return storageGetJSON<StoredSettings>(SETTINGS_KEY) ?? {};
}

export function writeSettings(s: StoredSettings): void {
  storageSetJSON(SETTINGS_KEY, s);
}
