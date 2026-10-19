import { SfxEngine } from '../audio/sfx';

/*
  Dev only: measure the synthesised effects without hearing them. Each sound is
  rendered on an OfflineAudioContext through the real effects graph (buses,
  reverb, limiter) and reduced to a few numbers:

    peak       highest sample, 0 to 1; near 1 means the limiter is working hard
    rms        loudness over the part of the render that is not silence
    centroid   spectral centroid in Hz: low for a thud, high for a crack
    length     seconds until the sound falls 60 dB under its peak

  Exposed as __ash.audioProbe() (debug.ts).
*/

export interface SoundStats {
  name: string;
  peak: number;
  rms: number;
  centroid: number;
  length: number;
}

type Play = (e: SfxEngine) => void;

export const SOUNDS: ReadonlyArray<readonly [string, Play]> = [
  ['hit light', (e) => e.hit(0.7, 0)],
  ['hit heavy', (e) => e.hit(1.2, 0)],
  ['hit Bronzemaw', (e) => e.hit(1, 0, 1 / Math.pow(1.34, 0.6))],
  ['hit Nocturne', (e) => e.hit(1, 0, 1 / Math.pow(0.76, 0.6))],
  ['slash', (e) => e.slash(1, 0)],
  ['block', (e) => e.block(0)],
  ['parry', (e) => e.parry(0)],
  ['splat', (e) => e.splat(0)],
  ['bass', (e) => e.bass(1, 0)],
  ['gore', (e) => e.gore(1, 0)],
  ['crunch', (e) => e.crunch(0)],
  ['whiff', (e) => e.whiff(0)],
  ['swish light', (e) => e.swish(0.6, 0)],
  ['swish heavy', (e) => e.swish(1, 0)],
  ['jump', (e) => e.jump(0)],
  ['land soft', (e) => e.land(0.3, 0)],
  ['land hard', (e) => e.land(1, 0)],
  ['dash', (e) => e.dash(0)],
  ['call', (e) => e.call(0)],
  ['arrive', (e) => e.arrive(0)],
  ['quake', (e) => e.quake(0)],
  ['power', (e) => e.power()],
  ['ko', (e) => e.ko(0)],
  ['finishSting', (e) => e.finishSting()],
  ['fatal', (e) => e.fatal()],
];

function fftMag(re: Float32Array): Float32Array {
  const n = re.length;
  const im = new Float32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]!; re[i] = re[j]!; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * wr - im[b]! * wi, xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a] = re[a]! + xr; im[a] = im[a]! + xi;
      }
    }
  }
  const mag = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i]!, im[i]!);
  return mag;
}

export function stats(name: string, buf: AudioBuffer): SoundStats {
  const a = buf.getChannelData(0);
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
  const n = a.length;
  const mono = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = (a[i]! + b[i]!) / 2;
    mono[i] = v;
    const m = Math.max(Math.abs(a[i]!), Math.abs(b[i]!));
    if (m > peak) peak = m;
  }
  const floor = peak * 0.001;                       // -60 dB
  let last = 0;
  for (let i = n - 1; i >= 0; i--) if (Math.abs(mono[i]!) > floor) { last = i; break; }
  let sum = 0;
  for (let i = 0; i <= last; i++) sum += mono[i]! * mono[i]!;
  const rms = Math.sqrt(sum / Math.max(1, last + 1));
  // centroid over the loudest stretch: 8192 samples from the first sample within 6 dB of the peak
  let start = 0;
  for (let i = 0; i < n; i++) if (Math.abs(mono[i]!) > peak * 0.5) { start = i; break; }
  const N = 8192;
  const frame = new Float32Array(N);
  for (let i = 0; i < N && start + i < n; i++) frame[i] = mono[start + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const mag = fftMag(frame);
  let num = 0, den = 0;
  for (let i = 1; i < mag.length; i++) { const f = (i * buf.sampleRate) / N; num += f * mag[i]!; den += mag[i]!; }
  return {
    name,
    peak: +peak.toFixed(3),
    rms: +rms.toFixed(4),
    centroid: Math.round(den > 0 ? num / den : 0),
    length: +(last / buf.sampleRate).toFixed(2),
  };
}

export async function audioProbe(only?: string[]): Promise<SoundStats[]> {
  const out: SoundStats[] = [];
  for (const [name, play] of SOUNDS) {
    if (only && !only.includes(name)) continue;
    const buf = await SfxEngine.renderOffline(play, 3);
    out.push(stats(name, buf));
  }
  return out;
}
