import { Sfx } from './sfx';

/*
  The score: a procedural piece in D minor, sequenced live on the audio clock.

  One loop of four bars plays forever. What changes is how much of it is
  heard — four layers fade in and out with the game's intensity:

      0  title    pad and a distant bell
      1  select   + a pulsing bass
      2  fight    + drums
      3  clutch   + a sixteenth-note arpeggio, hats doubled, filter opened
                  (final round, or a human player low on health)

  So moving from the menu into a fight never restarts the music; the fight
  simply arrives on top of what was already playing.

  Timing is the standard Web Audio lookahead scheduler: a 25 ms timer queues
  every note due in the next 120 ms at an exact audio-clock time, so the
  groove stays tight however busy the main thread is.

  Everything goes through a duck gain (hits pull the music down for a moment)
  and a low-pass (a KO muffles it, as if the world went underwater), then the
  music volume trim, then the music bus.
*/

export type MusicMode = 'off' | 'score' | 'unavailable';

const BPM = 92;
const STEP = 60 / BPM / 4;              // one sixteenth
const LOOKAHEAD = 0.12;
const TICK_MS = 25;

/* D minor: Dm – Bb – Gm – A. The A major at the end of the loop is the pull back to Dm. */
const CHORDS: readonly (readonly number[])[] = [
  [146.83, 174.61, 220.0],
  [116.54, 146.83, 174.61],
  [98.0, 116.54, 146.83],
  [110.0, 138.59, 164.81],
];
const BASS: readonly number[] = [73.42, 58.27, 49.0, 55.0];
const KICK = new Set([0, 6, 8, 11]);
const SNARE = new Set([4, 12]);

type Layer = 'pad' | 'bass' | 'drums' | 'arp';
const LAYER_LEVEL: Readonly<Record<Layer, readonly [number, number, number, number]>> = {
  //        title  select fight  clutch
  pad: [0.9, 0.8, 0.55, 0.5],
  bass: [0, 0.7, 0.8, 0.85],
  drums: [0, 0, 0.75, 0.9],
  arp: [0, 0, 0, 0.55],
};

export type Stinger = 'round' | 'ko' | 'victory' | 'defeat';

class MusicPlayer {
  private listeners = new Set<(mode: MusicMode) => void>();
  private _playing = false;
  private _mode: MusicMode = 'off';
  private volume = 0.7;
  private intensity = 0;

  private trim: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private layers: Record<Layer, GainNode> | null = null;
  private timer = 0;
  private nextTime = 0;
  private step = 0;
  private teardown = 0;

  get playing(): boolean {
    return this._playing;
  }

  get mode(): MusicMode {
    return this._mode;
  }

  get vol(): number {
    return this.volume;
  }

  get level(): number {
    return this.intensity;
  }

  onChange(fn: (mode: MusicMode) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    const ctx = Sfx.context;
    // a short glide, so dragging the slider does not zipper
    if (this.trim && ctx) this.trim.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.04);
  }

  toggle(): MusicMode {
    if (this._playing) this.stop();
    else this.start();
    return this._mode;
  }

  start(): void {
    if (this._playing) return;
    const ctx = Sfx.context;
    const bus = Sfx.bus;
    if (!ctx || !bus) {
      this.setMode('unavailable');
      return;
    }
    window.clearTimeout(this.teardown);

    const trim = ctx.createGain();
    trim.gain.value = 0.0001;
    trim.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.6);   // fade in, never slam in
    trim.connect(bus);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 16000;
    filter.Q.value = 0.7;
    filter.connect(trim);
    const duck = ctx.createGain();
    duck.connect(filter);

    const layer = (l: Layer): GainNode => {
      const g = ctx.createGain();
      g.gain.value = LAYER_LEVEL[l][this.intensity]!;
      g.connect(duck);
      return g;
    };
    this.layers = { pad: layer('pad'), bass: layer('bass'), drums: layer('drums'), arp: layer('arp') };
    this.trim = trim;
    this.filter = filter;
    this.duckGain = duck;

    this.step = 0;
    this.nextTime = ctx.currentTime + 0.08;
    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
    this._playing = true;
    this.setMode('score');
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    const ctx = Sfx.context;
    const trim = this.trim;
    if (ctx && trim) {
      trim.gain.cancelScheduledValues(ctx.currentTime);
      trim.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25);
      // notes already queued ring out under the fade, then the chain is dropped
      this.teardown = window.setTimeout(() => trim.disconnect(), 1500);
    }
    this.trim = this.duckGain = this.filter = null;
    this.layers = null;
    this._playing = false;
    this.setMode('off');
  }

  /** 0 title · 1 select · 2 fight · 3 clutch. Layers cross-fade over a beat or two. */
  setIntensity(level: number): void {
    const next = Math.max(0, Math.min(3, Math.round(level)));
    if (next === this.intensity) return;
    this.intensity = next;
    const ctx = Sfx.context;
    if (!ctx || !this.layers || !this.filter) return;
    for (const l of Object.keys(this.layers) as Layer[]) {
      this.layers[l].gain.setTargetAtTime(LAYER_LEVEL[l][next]!, ctx.currentTime, 0.9);
    }
  }

  /** Pull the score down under an impact, then let it breathe back. */
  duck(depth: number, recover = 0.3): void {
    const ctx = Sfx.context;
    const g = this.duckGain;
    if (!ctx || !g || depth <= 0) return;
    const t = ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(Math.max(0.2, 1 - depth), t + 0.015);
    g.gain.setTargetAtTime(1, t + 0.06, recover);
  }

  /** Close the filter for `seconds`, as if the fight went underwater, then open it again. */
  muffle(seconds: number): void {
    const ctx = Sfx.context;
    const f = this.filter;
    if (!ctx || !f) return;
    const t = ctx.currentTime;
    f.frequency.cancelScheduledValues(t);
    f.frequency.setValueAtTime(f.frequency.value, t);
    f.frequency.exponentialRampToValueAtTime(420, t + 0.08);
    f.frequency.setTargetAtTime(16000, t + seconds, 0.35);
  }

  /** Short motifs over the score. They bypass the duck and the filter, so a KO sting is never muffled. */
  stinger(kind: Stinger): void {
    const ctx = Sfx.context;
    const out = this.trim;
    if (!ctx || !out) return;
    const t = ctx.currentTime + 0.02;
    type Note = readonly [freq: number, at: number, len: number];
    const STINGS: Readonly<Record<Stinger, readonly Note[]>> = {
      round: [[146.83, 0, 0.5], [220, 0, 0.5], [293.66, 0.18, 0.9]],
      ko: [[293.66, 0, 0.18], [277.18, 0.16, 0.18], [220, 0.32, 1.4], [146.83, 0.32, 1.6]],
      victory: [[293.66, 0, 0.2], [369.99, 0.14, 0.2], [440, 0.28, 0.2], [587.33, 0.42, 1.3]],
      defeat: [[293.66, 0, 0.3], [261.63, 0.26, 0.3], [233.08, 0.52, 0.3], [220, 0.78, 1.4]],
    };
    const notes = STINGS[kind];
    for (const [f, at, len] of notes) this.voice(out, 'sawtooth', f, t + at, len, 0.07, 2400);
  }

  dispose(): void {
    this.stop();
    window.clearTimeout(this.teardown);
    this.listeners.clear();
  }

  private setMode(mode: MusicMode): void {
    this._mode = mode;
    for (const fn of this.listeners) fn(mode);
  }

  /* ── sequencing ─────────────────────────────────────────────────────── */

  private schedule(): void {
    const ctx = Sfx.context;
    if (!ctx || !this.layers) return;
    // a tab that slept wakes up late: skip ahead instead of firing a backlog of notes at once
    if (this.nextTime < ctx.currentTime - 0.25) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, t: number): void {
    const L = this.layers!;
    const bar = Math.floor(step / 16);
    const s = step % 16;
    const chord = CHORDS[bar]!;
    const level = this.intensity;

    // pad: one swell per bar, two detuned saws per chord tone
    if (s === 0) {
      for (const f of chord) {
        this.voice(L.pad, 'sawtooth', f, t, STEP * 16, 0.045, 900, 0.9, 1.004);
        this.voice(L.pad, 'sawtooth', f * 0.5, t, STEP * 16, 0.03, 700, 0.9, 0.996);
      }
    }
    // a distant bell on the title, every other bar
    if (level === 0 && s === 8 && bar % 2 === 0) this.bell(L.pad, chord[2]! * 2, t);

    // bass: eighth-note pulse on the root, octave jump on the "and" of 4
    if (s % 2 === 0) {
      const f = BASS[bar]! * (s === 14 ? 2 : 1);
      this.voice(L.bass, 'square', f, t, STEP * 1.6, 0.11, 420, 0.004);
    }

    // drums
    if (KICK.has(s)) this.kick(L.drums, t);
    if (SNARE.has(s)) this.snare(L.drums, t);
    if (s % 2 === 0 || level >= 3) this.hat(L.drums, t, s % 4 === 2 ? 0.05 : 0.025);
    if (level >= 3 && bar === 3 && (s === 13 || s === 14 || s === 15)) this.tom(L.drums, t, 130 - (s - 13) * 18);

    // arp: chord tones up an octave, sixteenths
    if (level >= 3) {
      const f = chord[s % 3]! * (s % 6 < 3 ? 2 : 4);
      this.voice(L.arp, 'triangle', f, t, STEP * 0.9, 0.05, 5000, 0.002);
    }
  }

  /* ── instruments ────────────────────────────────────────────────────── */

  private voice(out: AudioNode, type: OscillatorType, f: number, t: number, len: number, peak: number,
    cutoff: number, attack = 0.01, detune = 1): void {
    const ctx = Sfx.context!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f * detune;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0.0001, t + Math.max(attack, len * 0.7), len * 0.25);
    o.connect(lp);
    lp.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + len + 0.6);
  }

  private bell(out: AudioNode, f: number, t: number): void {
    const ctx = Sfx.context!;
    for (const [k, peak] of [[1, 0.05], [2.76, 0.02], [5.4, 0.01]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f * k;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4 / k);
      o.connect(g);
      g.connect(out);
      o.start(t);
      o.stop(t + 2.5);
    }
  }

  private kick(out: AudioNode, t: number): void {
    const ctx = Sfx.context!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.32);
  }

  private noiseHit(out: AudioNode, t: number, type: BiquadFilterType, freq: number, peak: number, decay: number): void {
    const ctx = Sfx.context!;
    const buf = Sfx.noiseBuffer;
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay + 0.02);
  }

  private snare(out: AudioNode, t: number): void {
    this.noiseHit(out, t, 'bandpass', 1900, 0.22, 0.16);
    const ctx = Sfx.context!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.12);
  }

  private hat(out: AudioNode, t: number, peak: number): void {
    this.noiseHit(out, t, 'highpass', 7200, peak, 0.035);
  }

  private tom(out: AudioNode, t: number, f: number): void {
    const ctx = Sfx.context!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    o.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.28);
  }
}

export const Music = new MusicPlayer();
