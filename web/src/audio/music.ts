import { Sfx } from './sfx';

/*
  Optional external track, with a synthesised ambient drone as the fallback —
  which is what plays whenever the network is blocked or no track is set.
*/

export type MusicMode = 'off' | 'connecting' | 'external' | 'ambient synth' | 'unavailable';

/** No track ships; set a URL here to try one before the synth. */
export const MUSIC_URL: string | null = null;

interface Voice {
  stop(): void;
}

class MusicPlayer {
  private el: HTMLAudioElement | null = null;
  private synth: Voice | null = null;
  private stopTimer = 0;
  private listeners = new Set<(mode: MusicMode) => void>();
  private _playing = false;
  private _mode: MusicMode = 'off';

  get playing(): boolean {
    return this._playing;
  }

  get mode(): MusicMode {
    return this._mode;
  }

  onChange(fn: (mode: MusicMode) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  toggle(url: string | null = MUSIC_URL): MusicMode {
    if (this._playing) {
      this.stop();
      return this._mode;
    }
    // the external track first; any failure falls through to the synth
    if (url) {
      const el = new Audio(url);
      el.loop = true;
      el.volume = 0.4;
      this.el = el;
      const fallback = (): void => {
        if (this.el !== el) return;
        this.el = null;
        if (this._playing && this.startSynth()) this.setMode('ambient synth');
      };
      el.addEventListener('error', fallback);
      el.play().then(() => {
        if (this.el === el) this.setMode('external');
      }, fallback);
      this._playing = true;
      this.setMode('connecting');
      return this._mode;
    }
    this._playing = this.startSynth();
    this.setMode(this._playing ? 'ambient synth' : 'unavailable');
    return this._mode;
  }

  stop(): void {
    if (this.el) {
      this.el.pause();
      this.el = null;
    }
    this.synth?.stop();
    this.synth = null;
    this._playing = false;
    this.setMode('off');
  }

  dispose(): void {
    this.stop();
    window.clearTimeout(this.stopTimer);
    this.listeners.clear();
  }

  private setMode(mode: MusicMode): void {
    this._mode = mode;
    for (const fn of this.listeners) fn(mode);
  }

  private startSynth(): boolean {
    const ctx = Sfx.context;
    const bus = Sfx.bus;
    if (!ctx || !bus) return false;

    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.gain.exponentialRampToValueAtTime(0.13, ctx.currentTime + 2.5);
    out.connect(bus);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 4;
    filter.connect(out);

    // two detuned saws an octave apart: a slow, hollow drone
    const voices = [55, 55.6, 110, 82.4].map((hz, i) => {
      const o = ctx.createOscillator();
      o.type = i > 1 ? 'triangle' : 'sawtooth';
      o.frequency.value = hz;
      const g = ctx.createGain();
      g.gain.value = i > 1 ? 0.12 : 0.3;
      o.connect(g);
      g.connect(filter);
      o.start();
      return o;
    });

    // a slow filter sweep so the bed breathes
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    this.synth = {
      stop: () => {
        out.gain.cancelScheduledValues(ctx.currentTime);
        out.gain.setValueAtTime(out.gain.value, ctx.currentTime);
        out.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
        this.stopTimer = window.setTimeout(() => {
          for (const o of voices) o.stop();
          lfo.stop();
          out.disconnect();
        }, 900);
      },
    };
    return true;
  }
}

export const Music = new MusicPlayer();
