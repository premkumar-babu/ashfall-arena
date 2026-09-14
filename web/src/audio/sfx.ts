/*
  Every sound in the game is synthesised: oscillators and one buffer of white
  noise run through envelopes. No audio files, nothing to download.

  The graph is  envelope → sfxGain → master → destination.  Effects get their
  own gain under master so the SFX slider is relative to master rather than a
  second master; the music synth taps `master` directly, which is the whole
  reason for the split.

  Browsers refuse to start an AudioContext without a user gesture, so init()
  is called from the first click or key, and every setter works before that —
  the value is held and applied when the context is allowed to exist.
*/

type ToggleListener = (on: boolean) => void;

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

export class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;
  private masterVolume = 0.5;
  private sfxVolume = 1.0;
  private readonly listeners = new Set<ToggleListener>();
  private readonly timers = new Set<number>();

  get on(): boolean {
    return this.enabled;
  }

  get masterVol(): number {
    return this.masterVolume;
  }

  get sfxVol(): number {
    return this.sfxVolume;
  }

  /** The context, once a gesture has allowed one. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** The master bus. Music connects here so it skips the SFX gain. */
  get bus(): GainNode | null {
    return this.master;
  }

  onToggle(fn: ToggleListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  init(): void {
    if (this.ctx) return;
    const AC = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(ctx.destination);

    const sfxGain = ctx.createGain();
    sfxGain.gain.value = this.sfxVolume;
    sfxGain.connect(master);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.sfxGain = sfxGain;
    this.noise = noise;
    this.enabled = true;
    this.emit();
  }

  toggle(): void {
    if (!this.ctx || !this.master) {
      this.init();
      return;
    }
    this.enabled = !this.enabled;
    this.master.gain.value = this.enabled ? this.masterVolume : 0;
    this.emit();
  }

  setMaster(v: number): void {
    this.masterVolume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.enabled ? this.masterVolume : 0;
  }

  setSfx(v: number): void {
    this.sfxVolume = Math.max(0, Math.min(1, v));
    if (this.sfxGain) this.sfxGain.gain.value = this.sfxVolume;
  }

  /* ── the sounds ─────────────────────────────────────────────────────── */

  bass(p: number): void {
    if (!this.enabled) return;
    this.tone('sine', 95, 22, 0.75 * p, 0.008, 0.55);
    this.hiss(0.22 * p, 0.26, 130, 0.7);
  }

  hit(p: number): void {
    this.tone('sine', 150, 42, 0.5 * p, 0.005, 0.16);
    this.hiss(0.32 * p, 0.10, 900, 0.9);
  }

  block(): void {
    this.tone('triangle', 1250, 620, 0.20, 0.004, 0.10);
    this.hiss(0.10, 0.05, 3200, 3);
  }

  whiff(): void {
    this.hiss(0.09, 0.13, 520, 1.4);
  }

  /** The swing itself, pitched by weight: a jab hisses high and short, a heavy sweeps low and wide. */
  swish(p = 1): void {
    this.hiss(0.11 * p, 0.10 + 0.10 * p, 2600 - 1500 * p, 1.1);
  }

  whoosh(): void {
    this.hiss(0.10, 0.16, 380, 1.0);
  }

  call(): void {
    this.tone('sawtooth', 92, 240, 0.20, 0.02, 0.34);
  }

  arrive(): void {
    this.hiss(0.22, 0.22, 320, 0.8);
    this.tone('sine', 320, 90, 0.22, 0.01, 0.26);
  }

  quake(): void {
    this.tone('sine', 90, 26, 0.6, 0.01, 0.5);
    this.hiss(0.34, 0.34, 180, 0.6);
  }

  power(): void {
    [220, 330, 440, 660].forEach((f, i) => {
      const id = window.setTimeout(() => {
        this.timers.delete(id);
        this.tone('square', f, f * 1.5, 0.13, 0.01, 0.22);
      }, i * 65);
      this.timers.add(id);
    });
  }

  ui(): void {
    this.tone('square', 640, 880, 0.07, 0.004, 0.06);
  }

  lock(): void {
    this.tone('square', 440, 660, 0.12, 0.005, 0.14);
  }

  ko(): void {
    this.tone('sine', 120, 30, 0.6, 0.01, 0.9);
    this.hiss(0.4, 0.5, 240, 0.6);
  }

  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.listeners.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.sfxGain = null;
    this.noise = null;
    this.enabled = false;
  }

  /* ── synthesis ──────────────────────────────────────────────────────── */

  private emit(): void {
    for (const fn of this.listeners) fn(this.enabled);
  }

  private env(node: AudioNode, peak: number, attack: number, decay: number): number {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(this.sfxGain!);
    return t + attack + decay;
  }

  private tone(type: OscillatorType, f0: number, f1: number, peak: number, attack: number, decay: number): void {
    if (!this.enabled || !this.ctx) return;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, this.ctx.currentTime);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, this.ctx.currentTime + attack + decay);
    const end = this.env(o, peak, attack, decay);
    o.start();
    o.stop(end + 0.02);
  }

  private hiss(peak: number, decay: number, freq: number, q = 1): void {
    if (!this.enabled || !this.ctx || !this.noise) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    src.connect(bp);
    const end = this.env(bp, peak, 0.004, decay);
    src.start();
    src.stop(end + 0.02);
  }
}

export const Sfx = new SfxEngine();
