import { Sfx } from './sfx';

/*
  The courtyard's ambient bed, placed in the world.

  These are the sounds that genuinely have a position the camera moves
  relative to, so they use real 3D PannerNodes with the AudioListener riding
  the camera: each brazier crackles from where it burns, the lake laps from
  behind the balustrade, and as the fight camera dollies and tracks, the fires
  swing across the stereo field and swell or fade with distance. A wind bed
  with no position sits under all of it.

  All procedural: the crackle is a generated loop of sparse pops over hiss.
*/

export interface Point {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ListenerPose {
  readonly position: Point;
  readonly forward: Point;
  readonly up: Point;
}

function crackleBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.floor(rate * seconds), rate);
  const d = buf.getChannelData(0);
  let lp = 0;
  let pop = 0;
  for (let i = 0; i < d.length; i++) {
    // roughly 18 pops a second, each a few milliseconds of decaying noise
    if (Math.random() < 18 / rate) pop = 0.35 + Math.random() * 0.65;
    pop *= 0.992;
    const n = Math.random() * 2 - 1;
    lp += (n - lp) * 0.08;                         // the low roar under the pops
    d[i] = lp * 0.35 + n * pop;
  }
  return buf;
}

class AmbienceBed {
  private nodes: AudioScheduledSourceNode[] = [];
  private chain: AudioNode[] = [];
  private started = false;

  get running(): boolean {
    return this.started;
  }

  /** Start once audio exists. Positions are sampled now; the braziers never move. */
  start(fires: readonly Point[], water: Point): void {
    const ctx = Sfx.context;
    const bus = Sfx.ambience;
    const noise = Sfx.noiseBuffer;
    if (this.started || !ctx || !bus || !noise) return;
    this.started = true;

    const crackle = crackleBuffer(ctx, 3);
    const panner = (p: Point, ref: number, rolloff: number): PannerNode => {
      const pn = ctx.createPanner();
      pn.panningModel = 'equalpower';
      pn.distanceModel = 'inverse';
      pn.refDistance = ref;
      pn.maxDistance = 80;
      pn.rolloffFactor = rolloff;
      if (pn.positionX) {
        pn.positionX.value = p.x;
        pn.positionY.value = p.y;
        pn.positionZ.value = p.z;
      } else {
        pn.setPosition(p.x, p.y, p.z);
      }
      pn.connect(bus);
      this.chain.push(pn);
      return pn;
    };
    const loop = (buffer: AudioBuffer, out: AudioNode, gain: number, filter?: BiquadFilterNode): void => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.playbackRate.value = 0.9 + Math.random() * 0.2;   // no two fires in phase
      const g = ctx.createGain();
      g.gain.value = gain;
      if (filter) {
        src.connect(filter);
        filter.connect(g);
        this.chain.push(filter);
      } else {
        src.connect(g);
      }
      g.connect(out);
      this.chain.push(g);
      src.start(0, Math.random() * buffer.duration);
      this.nodes.push(src);
    };

    for (const f of fires) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 280;
      loop(crackle, panner(f, 3.5, 1.3), 0.45, hp);
    }

    // the lake: low rumble that swells and recedes on a slow LFO
    const waterLp = ctx.createBiquadFilter();
    waterLp.type = 'lowpass';
    waterLp.frequency.value = 340;
    const waterGain = ctx.createGain();
    waterGain.gain.value = 0.28;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.17;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.16;
    lfo.connect(lfoDepth);
    lfoDepth.connect(waterGain.gain);
    lfo.start();
    this.nodes.push(lfo);
    this.chain.push(lfoDepth, waterGain);
    waterGain.connect(panner(water, 9, 0.8));
    loop(noise, waterGain, 1, waterLp);

    // wind: band-passed noise whose centre wanders, unpositioned
    const windBp = ctx.createBiquadFilter();
    windBp.type = 'bandpass';
    windBp.frequency.value = 420;
    windBp.Q.value = 0.6;
    const sweep = ctx.createOscillator();
    sweep.frequency.value = 0.06;
    const sweepDepth = ctx.createGain();
    sweepDepth.gain.value = 220;
    sweep.connect(sweepDepth);
    sweepDepth.connect(windBp.frequency);
    sweep.start();
    this.nodes.push(sweep);
    this.chain.push(sweepDepth);
    loop(noise, bus, 0.09, windBp);
  }

  /** Once per frame: the listener is the camera. */
  update(pose: ListenerPose): void {
    const ctx = Sfx.context;
    if (!this.started || !ctx) return;
    const l = ctx.listener;
    const { position: p, forward: f, up: u } = pose;
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = f.x;
      l.forwardY.value = f.y;
      l.forwardZ.value = f.z;
      l.upX.value = u.x;
      l.upY.value = u.y;
      l.upZ.value = u.z;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  stop(): void {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* already stopped with its context */
      }
    }
    for (const n of this.chain) n.disconnect();
    this.nodes = [];
    this.chain = [];
    this.started = false;
  }
}

export const Ambience = new AmbienceBed();
