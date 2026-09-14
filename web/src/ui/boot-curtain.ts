import { Assets, type LoadGroup, type LoadSnapshot } from '../assets/pipeline';

/*
  The loading screen, in two parts.

  The curtain covers the title on a cold start. It reads the asset pipeline's
  job list — every file registered up front, weighted by its real size from
  the optimised-asset manifest — so the bar moves in bytes rather than in
  "items", and a row of stages shows what is actually arriving.

  It is a curtain, not a gate. The scene renders underneath from the first
  frame, every asset degrades to something playable, and the curtain lifts
  once the courtyard, its surfaces and the cast are in, on a deadline whether
  or not they are, or the moment the player clicks it. The animation library
  and effect sprites are not waited for at all.

  Whatever is still in flight after the lift shows in the streaming pill at
  the bottom of the screen, which fades once the queue is empty.
*/

const STAGE_LABEL: Readonly<Record<LoadGroup, string>> = {
  arena: 'raising the courtyard',
  surfaces: 'laying the stone',
  fighters: 'reaching for the cast',
  motion: 'teaching them to move',
  effects: 'lighting the embers',
};

/** What the curtain waits for. Everything else streams in behind the title. */
const GATE: readonly LoadGroup[] = ['arena', 'surfaces', 'fighters'];
const DEADLINE_MS = 12_000;
const HINT_MS = 1500;
const MIN_SHOW_MS = 400;
/** The DOM is written at most this often; the pipeline is cheap to read, layout is not. */
const SAMPLE_MS = 90;
const STREAM_LINGER_MS = 900;

const mb = (bytes: number): string => (bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0);

class BootCurtain {
  private root: HTMLElement | null = null;
  private fill: HTMLElement | null = null;
  private pct: HTMLElement | null = null;
  private what: HTMLElement | null = null;
  private bytes: HTMLElement | null = null;
  private readonly chips = new Map<LoadGroup, HTMLElement>();
  private stream: HTMLElement | null = null;
  private streamFill: HTMLElement | null = null;
  private streamText: HTMLElement | null = null;

  private done = false;
  private shown = 0;
  private started = 0;
  private deadline = 0;
  private lastSample = 0;
  private idleSince = 0;
  private liftTimer = 0;

  start(): void {
    this.root = document.getElementById('boot');
    this.fill = document.getElementById('bfill');
    this.pct = document.getElementById('bpct');
    this.what = document.getElementById('bwhat');
    this.bytes = document.getElementById('bbytes');
    this.stream = document.getElementById('stream');
    this.streamFill = document.getElementById('sfill');
    this.streamText = document.getElementById('stext');
    this.chips.clear();
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('#bstages [data-g]'))) {
      this.chips.set(el.dataset.g as LoadGroup, el);
    }
    this.done = false;
    this.shown = 0;
    this.started = performance.now();
    this.deadline = this.started + DEADLINE_MS;
    this.lastSample = 0;
    this.idleSince = 0;
    this.root?.classList.remove('hinted');
  }

  /** Every presentation frame, in every phase. */
  tick(): void {
    const now = performance.now();
    if (now - this.lastSample < SAMPLE_MS) return;
    this.lastSample = now;
    const s = Assets.snapshot();
    if (!this.done) {
      this.paintCurtain(s, now);
      if (this.gateOpen(s, now) || now > this.deadline) this.skip();
      return;
    }
    this.paintStream(s, now);
  }

  skip(): void {
    if (this.done) return;
    this.done = true;
    this.paintBar(1);
    if (this.what) this.what.textContent = 'ready';
    // let the bar read 100 for a beat before the curtain lifts
    this.liftTimer = window.setTimeout(() => document.body.classList.add('booted'), 260);
  }

  dispose(): void {
    window.clearTimeout(this.liftTimer);
    this.stream?.classList.remove('on');
  }

  private gateOpen(s: LoadSnapshot, now: number): boolean {
    if (now - this.started < MIN_SHOW_MS) return false;
    return GATE.every((g) => s.groups[g].settled >= s.groups[g].count);
  }

  private paintCurtain(s: LoadSnapshot, now: number): void {
    this.paintBar(s.ratio);
    if (this.what) this.what.textContent = s.current ? STAGE_LABEL[s.current.group] : s.pending ? 'loading' : 'ready';
    if (this.bytes && s.total > 0) this.bytes.textContent = `${mb(s.loaded)} / ${mb(s.total)} MB`;
    for (const [g, el] of this.chips) {
      const p = s.groups[g];
      const next = p.count === 0 ? 'wait' : p.settled < p.count ? 'live' : p.failed ? 'warn' : 'done';
      if (el.dataset.state !== next) el.dataset.state = next;
    }
    if (now - this.started > HINT_MS) this.root?.classList.add('hinted');
  }

  private paintStream(s: LoadSnapshot, now: number): void {
    const el = this.stream;
    if (!el) return;
    if (s.pending > 0) {
      this.idleSince = 0;
      el.classList.add('on');
      const text = `${s.current ? STAGE_LABEL[s.current.group] : 'streaming'} · ${mb(s.loaded)}/${mb(s.total)} MB`;
      if (this.streamText && this.streamText.textContent !== text) this.streamText.textContent = text;
      if (this.streamFill) this.streamFill.style.transform = `scaleX(${s.ratio.toFixed(3)})`;
    } else if (el.classList.contains('on')) {
      this.idleSince ||= now;
      if (this.streamFill) this.streamFill.style.transform = 'scaleX(1)';
      if (now - this.idleSince > STREAM_LINGER_MS) el.classList.remove('on');
    }
  }

  private paintBar(r: number): void {
    if (!this.fill) return;
    this.shown = Math.max(this.shown, Math.min(1, r));      // a loading bar never rewinds
    this.fill.style.transform = `scaleX(${this.shown.toFixed(3)})`;
    if (this.pct) this.pct.textContent = `${Math.round(this.shown * 100)}%`;
  }
}

export const Boot = new BootCurtain();
