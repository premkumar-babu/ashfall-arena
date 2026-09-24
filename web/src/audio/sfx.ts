/*
  The audio engine and every sound effect. Everything is synthesised —
  oscillators, one buffer of white noise and a generated room impulse — so
  there is nothing to download and nothing to decode.

  The graph:

      voice → [stereo pan] → sfx ───┐
                        └→ reverb ──┤
      music score ─────────→ music ─┼→ master (volume, mute) → limiter → out
      positional beds ─────→ amb ───┘

  Music, ambience and effects each have their own gain under master, so each
  slider is relative to master rather than a second master, and mute is one
  ramp on master. The limiter is what lets a KO, the score and three brazier
  beds land on the same frame without clipping.

  Effects are placed in the stereo field by world X relative to the camera
  (setListener), which is the spatial audio a side-on fighting game can use:
  a blow on the left of the screen is heard on the left. The scene's fixed
  emitters (braziers, water) use true 3D panners; see ambience.ts.

  Browsers refuse to start an AudioContext without a user gesture, so init()
  is called from the first click or key, and every setter works before that —
  the value is held and applied when the context is allowed to exist.
*/

type ToggleListener = (on: boolean) => void;

interface WebkitWindow extends Window {
  webkitAudioContext?: typeof AudioContext;
}

interface VoiceOpts {
  /** Stereo position, -1 left to 1 right. */
  pan?: number;
  /** Reverb send, 0–1. */
  send?: number;
  /** Random pitch spread as a fraction; defaults to ±3%. */
  jitter?: number;
  /** Plays even when the voice budget is spent (KO, round calls). */
  priority?: boolean;
}

/** Concurrent one-shots allowed before low-priority sounds are dropped. */
const MAX_VOICES = 32;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function roomImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // early reflections off the flagstones, then a diffuse tail into open sky
      const early = i < ctx.sampleRate * 0.03 && Math.random() < 0.02 ? 0.8 : 0;
      d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay)) + early * (1 - t);
    }
  }
  return buf;
}

export class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private ambGain: GainNode | null = null;
  private reverbIn: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;
  private masterVolume = 0.5;
  private sfxVolume = 1.0;
  private ambVolume = 0.6;
  private voices = 0;
  private listenerX = 0;
  private halfWidth = 8;
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

  get ambVol(): number {
    return this.ambVolume;
  }

  /** The context, once a gesture has allowed one. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** The music bus. The score connects here so it skips the effects gain. */
  get bus(): GainNode | null {
    return this.musicGain;
  }

  /** The ambience bus, for the positional beds. */
  get ambience(): GainNode | null {
    return this.ambGain;
  }

  get noiseBuffer(): AudioBuffer | null {
    return this.noise;
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

    const ctx = new AC({ latencyHint: 'interactive' });

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 6;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    master.connect(limiter);

    const bus = (level: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = level;
      g.connect(master);
      return g;
    };
    this.musicGain = bus(1);
    this.ambGain = bus(this.ambVolume);
    this.sfxGain = bus(this.sfxVolume);

    // a stone courtyard under open sky: short, bright, no long cathedral tail
    const convolver = ctx.createConvolver();
    convolver.buffer = roomImpulse(ctx, 1.4, 3.2);
    const wet = ctx.createGain();
    wet.gain.value = 0.55;
    convolver.connect(wet);
    wet.connect(this.sfxGain);
    const reverbIn = ctx.createGain();
    reverbIn.connect(convolver);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

    this.ctx = ctx;
    this.master = master;
    this.reverbIn = reverbIn;
    this.noise = noise;
    this.enabled = true;
    this.emit();
  }

  /** A hidden tab: stop the audio clock, so a backgrounded game costs no battery. */
  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  /** Visible again, or a gesture after iOS interrupted the context (a call, another app's audio). */
  resume(): void {
    if (this.ctx && this.ctx.state !== 'running' && !document.hidden) void this.ctx.resume();
  }

  toggle(): void {
    if (!this.ctx || !this.master) {
      this.init();
      return;
    }
    this.enabled = !this.enabled;
    this.applyMaster();
    this.emit();
  }

  setMaster(v: number): void {
    this.masterVolume = clamp(v, 0, 1);
    this.applyMaster();
  }

  setSfx(v: number): void {
    this.sfxVolume = clamp(v, 0, 1);
    this.glide(this.sfxGain, this.sfxVolume);
  }

  setAmbience(v: number): void {
    this.ambVolume = clamp(v, 0, 1);
    this.glide(this.ambGain, this.ambVolume);
  }

  /** Where the camera is looking along the fighting plane, and how wide the view is there. */
  setListener(x: number, halfWidth: number): void {
    this.listenerX = x;
    this.halfWidth = Math.max(1, halfWidth);
  }

  /** Stereo position for a world X. Never hard-panned: a sound fully in one ear reads as broken. */
  pan(x: number | undefined): number {
    if (x === undefined) return 0;
    return clamp((x - this.listenerX) / this.halfWidth, -1, 1) * 0.75;
  }

  /* ── combat ─────────────────────────────────────────────────────────── */

  /** The low end of a heavy blow: a sub drop and a rumble of grit. */
  bass(p: number, x?: number): void {
    const o = { pan: this.pan(x), send: 0.2 };
    this.tone('sine', 95, 22, 0.75 * p, 0.008, 0.55, o);
    this.hiss(0.22 * p, 0.26, 130, 0.7, o);
  }

  /** A clean hit: a transient click for the snap, a body thump, and a crack of noise. */
  hit(p: number, x?: number): void {
    const o = { pan: this.pan(x), send: 0.14, jitter: 0.08 };
    this.tone('square', 2400, 380, 0.09 * p, 0.001, 0.025, o);
    this.tone('sine', 160, 42, 0.52 * p, 0.004, 0.17, o);
    this.hiss(0.34 * p, 0.10, 950, 0.9, o);
  }

  /** A guard: a metallic ring with an inharmonic partial, and a hiss of scraped steel. */
  block(x?: number): void {
    const o = { pan: this.pan(x), send: 0.3, jitter: 0.05 };
    this.tone('triangle', 1250, 620, 0.20, 0.003, 0.12, o);
    this.tone('sine', 1870, 1640, 0.07, 0.003, 0.28, o);
    this.hiss(0.11, 0.06, 3200, 3, o);
  }

  whiff(x?: number): void {
    this.hiss(0.09, 0.13, 520, 1.4, { pan: this.pan(x), jitter: 0.12 });
  }

  /** The swing itself, pitched by weight: a jab hisses high and short, a heavy sweeps low and wide. */
  swish(p = 1, x?: number): void {
    this.hiss(0.11 * p, 0.10 + 0.10 * p, 2600 - 1500 * p, 1.1, { pan: this.pan(x), jitter: 0.1 });
  }

  whoosh(x?: number): void {
    this.hiss(0.10, 0.16, 380, 1.0, { pan: this.pan(x) });
  }

  jump(x?: number): void {
    const o = { pan: this.pan(x), jitter: 0.1 };
    this.hiss(0.08, 0.12, 700, 1.2, o);
    this.tone('sine', 170, 300, 0.07, 0.01, 0.09, o);
  }

  /** Feet meeting stone, scaled by how far they fell. */
  land(p: number, x?: number): void {
    const o = { pan: this.pan(x), jitter: 0.1, send: 0.08 };
    this.tone('sine', 120, 42, 0.34 * p, 0.003, 0.13, o);
    this.hiss(0.14 * p, 0.09, 420, 0.8, o);
  }

  dash(x?: number): void {
    const o = { pan: this.pan(x), jitter: 0.08 };
    this.hiss(0.14, 0.18, 900, 0.9, o);
    this.tone('sine', 95, 58, 0.14, 0.005, 0.12, o);
  }

  /** Each hit of a string climbs a semitone, up to an octave. */
  combo(n: number): void {
    const f = 560 * Math.pow(2, Math.min(n - 2, 12) / 12);
    this.tone('square', f, f * 1.01, 0.05, 0.002, 0.07, { jitter: 0, send: 0.2 });
  }

  call(x?: number): void {
    this.tone('sawtooth', 92, 240, 0.20, 0.02, 0.34, { pan: this.pan(x), send: 0.3 });
  }

  arrive(x?: number): void {
    const o = { pan: this.pan(x), send: 0.3 };
    this.hiss(0.22, 0.22, 320, 0.8, o);
    this.tone('sine', 320, 90, 0.22, 0.01, 0.26, o);
  }

  quake(x?: number): void {
    const o = { pan: this.pan(x), send: 0.45, priority: true };
    this.tone('sine', 90, 26, 0.6, 0.01, 0.5, o);
    this.tone('sine', 48, 30, 0.5, 0.01, 0.9, o);
    this.hiss(0.34, 0.34, 180, 0.6, o);
  }

  power(): void {
    [220, 330, 440, 660].forEach((f, i) => {
      this.later(i * 65, () => this.tone('square', f, f * 1.5, 0.13, 0.01, 0.22, { send: 0.35, jitter: 0 }));
    });
  }

  ko(x?: number): void {
    const o = { pan: this.pan(x), send: 0.6, priority: true };
    this.tone('sine', 120, 30, 0.6, 0.01, 0.9, o);
    this.tone('sine', 52, 34, 0.55, 0.01, 1.6, o);
    this.hiss(0.42, 0.55, 240, 0.6, o);
  }

  /** Wet and heavy: a low body thump under a smear of band-passed noise. */
  gore(p: number, x?: number): void {
    const o = { pan: this.pan(x), send: 0.25, jitter: 0.12 };
    this.tone('sine', 110, 36, 0.42 * p, 0.003, 0.24, o);
    this.hiss(0.30 * p, 0.24, 420, 2.4, o);
    this.hiss(0.16 * p, 0.09, 1900, 1.2, o);
  }

  /** Bone: two dry cracks a few milliseconds apart. */
  crunch(x?: number): void {
    const o = { pan: this.pan(x), send: 0.12, jitter: 0.1 };
    this.tone('square', 1800, 240, 0.11, 0.001, 0.04, o);
    this.later(26, () => this.tone('square', 1300, 170, 0.09, 0.001, 0.05, o));
    this.hiss(0.24, 0.07, 2600, 1.6, o);
  }

  /** FINISH THEM: a low heartbeat under the call. */
  finishSting(): void {
    const o = { send: 0.5, jitter: 0, priority: true };
    this.tone('sine', 62, 40, 0.55, 0.01, 0.35, o);
    this.later(260, () => this.tone('sine', 58, 38, 0.45, 0.01, 0.4, o));
  }

  /** The fatality: a sub drop that swells under a long dark tail. */
  fatal(): void {
    const o = { send: 0.8, jitter: 0, priority: true };
    this.tone('sawtooth', 55, 40, 0.24, 0.35, 2.4, o);
    this.tone('sine', 82, 28, 0.6, 0.02, 2.2, o);
    this.hiss(0.3, 1.5, 160, 0.5, o);
  }

  /* ── match calls ────────────────────────────────────────────────────── */

  /** Round start: a struck bronze gong, inharmonic partials and a long bloom. */
  gong(): void {
    const o = { send: 0.7, jitter: 0, priority: true };
    for (const [f, peak, d] of [[98, 0.30, 2.6], [196.4, 0.14, 1.8], [263, 0.10, 1.4], [412, 0.06, 1.0]] as const) {
      this.tone('sine', f * 1.02, f, peak, 0.004, d, o);
    }
    this.hiss(0.12, 0.3, 1400, 1.2, o);
  }

  /** FIGHT!: a brass-like stab with a snare crack under it. */
  fight(): void {
    const o = { send: 0.4, jitter: 0, priority: true };
    for (const f of [146.8, 220, 293.7]) this.tone('sawtooth', f * 0.94, f, 0.09, 0.012, 0.42, o);
    this.hiss(0.3, 0.14, 1800, 0.8, o);
  }

  timeUp(): void {
    const o = { send: 0.4, jitter: 0, priority: true };
    this.tone('square', 880, 440, 0.12, 0.005, 0.5, o);
    this.tone('square', 660, 330, 0.08, 0.005, 0.6, o);
  }

  /** The last seconds of the clock: a tick that sharpens for the final three. */
  tick(urgent: boolean): void {
    this.tone('square', urgent ? 1760 : 1320, urgent ? 1740 : 1300, urgent ? 0.08 : 0.05, 0.001, 0.05, { jitter: 0 });
  }

  victory(): void {
    [392, 523.3, 659.3, 784].forEach((f, i) => {
      this.later(i * 110, () => this.tone('triangle', f, f, 0.14, 0.01, i === 3 ? 0.9 : 0.22, { send: 0.5, jitter: 0, priority: true }));
    });
  }

  defeat(): void {
    [392, 349.2, 311.1, 261.6].forEach((f, i) => {
      this.later(i * 170, () => this.tone('triangle', f, f * 0.99, 0.12, 0.02, i === 3 ? 1.1 : 0.3, { send: 0.5, jitter: 0, priority: true }));
    });
  }

  /* ── interface ──────────────────────────────────────────────────────── */

  /** Confirm. */
  ui(): void {
    this.tone('square', 640, 880, 0.07, 0.004, 0.06, { jitter: 0 });
  }

  /** The menu cursor moving: quieter and shorter than a confirm, so scrolling never nags. */
  uiMove(): void {
    this.tone('triangle', 980, 1040, 0.045, 0.002, 0.035, { jitter: 0.02 });
  }

  /** Back out / close / resume. */
  uiBack(): void {
    this.tone('square', 600, 380, 0.06, 0.004, 0.07, { jitter: 0 });
  }

  lock(): void {
    this.tone('square', 440, 660, 0.12, 0.005, 0.14, { jitter: 0, send: 0.2 });
  }

  dispose(): void {
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.listeners.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = this.sfxGain = this.musicGain = this.ambGain = this.reverbIn = null;
    this.noise = null;
    this.enabled = false;
    this.voices = 0;
  }

  /* ── synthesis ──────────────────────────────────────────────────────── */

  private emit(): void {
    for (const fn of this.listeners) fn(this.enabled);
  }

  private applyMaster(): void {
    this.glide(this.master, this.enabled ? this.masterVolume : 0);
  }

  /** A short glide rather than a jump, so a slider drag or a mute never clicks. */
  private glide(g: GainNode | null, v: number): void {
    if (!g || !this.ctx) return;
    g.gain.cancelScheduledValues(this.ctx.currentTime);
    g.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  private later(ms: number, fn: () => void): void {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private canPlay(o: VoiceOpts): boolean {
    return this.enabled && !!this.ctx && (this.voices < MAX_VOICES || !!o.priority);
  }

  /** Envelope, optional pan and reverb send; returns when the voice ends. */
  private env(node: AudioNode, peak: number, attack: number, decay: number, o: VoiceOpts): number {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    // a little level variation, so a flurry of identical blows does not machine-gun
    const level = Math.max(0.0002, peak * (0.92 + Math.random() * 0.16));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    let tail: AudioNode = g;
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      g.connect(p);
      tail = p;
    }
    tail.connect(this.sfxGain!);
    if (o.send && this.reverbIn) {
      const s = ctx.createGain();
      s.gain.value = o.send;
      tail.connect(s);
      s.connect(this.reverbIn);
    }
    return t + attack + decay;
  }

  private tone(type: OscillatorType, f0: number, f1: number, peak: number, attack: number, decay: number, o: VoiceOpts = {}): void {
    if (!this.canPlay(o)) return;
    const ctx = this.ctx!;
    const j = 1 + (Math.random() - 0.5) * 2 * (o.jitter ?? 0.03);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0 * j, ctx.currentTime);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * j), ctx.currentTime + attack + decay);
    const end = this.env(osc, peak, attack, decay, o);
    this.voices++;
    osc.onended = () => { this.voices--; };
    osc.start();
    osc.stop(end + 0.02);
  }

  private hiss(peak: number, decay: number, freq: number, q = 1, o: VoiceOpts = {}): void {
    if (!this.canPlay(o) || !this.noise) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 1 + (Math.random() - 0.5) * 2 * (o.jitter ?? 0.03);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq;
    bp.Q.value = q;
    src.connect(bp);
    const end = this.env(bp, peak, 0.004, decay, o);
    this.voices++;
    src.onended = () => { this.voices--; };
    // a random read head: the same buffer never plays the same grain twice in a row
    src.start(0, Math.random() * 1.5);
    src.stop(end + 0.02);
  }
}

export const Sfx = new SfxEngine();
