import { INPUT } from '../../config/controls';
import type { Disposer } from '../../core/disposal';

/*
  On-screen controls for phones and tablets, driving Player 1.

  Left half: a floating stick. It appears wherever the thumb lands rather than
  at a fixed spot, which is what stops a thumb slowly drifting off a fixed
  stick mid-round. Up on the stick jumps, down blocks, and flicking it the same
  way twice dashes — the double-tap logic is the keyboard's own.

  Right: a face-button diamond (light, heavy, jump, dash) with summon and
  Overdrive above it, and a pause button under the clock.

  Multitouch is tracked per pointer id with pointer capture, so the stick and
  a button held together never steal each other's touch. `touch-action: none`
  on every control keeps the browser from scrolling or zooming mid-combo.

  Shown only on touch: the first touch activates it, a physical key press
  hides it again (a tablet with a keyboard attached).
*/

export type TouchAct = 'jump' | 'punch' | 'kick' | 'assist' | 'power' | 'dash';

/* Capture can throw if the pointer lifted between the event firing and this
   call; the press itself must still count. */
function capture(el: Element, pointerId: number): void {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* pointer already released */
  }
}

const BUTTONS: ReadonlyArray<{ act: TouchAct; label: string; cls: string }> = [
  { act: 'jump', label: 'JUMP', cls: 'tc-jump' },
  { act: 'punch', label: 'LIGHT', cls: 'tc-punch' },
  { act: 'kick', label: 'HEAVY', cls: 'tc-kick' },
  { act: 'dash', label: 'DASH', cls: 'tc-dash' },
  { act: 'assist', label: 'SUMMON', cls: 'tc-small tc-assist' },
  { act: 'power', label: 'O.D.', cls: 'tc-small tc-power' },
];

export class TouchControls {
  active = window.matchMedia('(pointer: coarse)').matches;

  private readonly root = document.createElement('div');
  private readonly zone = document.createElement('div');
  private readonly stick = document.createElement('div');
  private readonly knob = document.createElement('div');
  private readonly rotate = document.createElement('div');

  private stickId: number | null = null;
  private originX = 0;
  private originY = 0;
  private x = 0;
  private y = 0;
  private wasUp = false;

  private readonly held = new Set<TouchAct>();
  private readonly latched = new Set<TouchAct>();

  constructor(disposer: Disposer, onPause: () => void) {
    this.root.className = 'tc-root';
    this.root.hidden = true;
    this.zone.className = 'tc-zone';
    this.stick.className = 'tc-stick';
    this.knob.className = 'tc-knob';
    this.stick.appendChild(this.knob);
    this.zone.appendChild(this.stick);
    this.root.appendChild(this.zone);

    const pad = document.createElement('div');
    pad.className = 'tc-buttons';
    for (const b of BUTTONS) pad.appendChild(this.makeButton(disposer, b.act, b.label, b.cls));
    this.root.appendChild(pad);

    const pause = document.createElement('button');
    pause.type = 'button';
    pause.className = 'tc-pause';
    pause.setAttribute('aria-label', 'Pause');
    pause.textContent = '❚❚';
    disposer.listen(pause, 'click', onPause);
    this.root.appendChild(pause);

    this.rotate.className = 'tc-rotate';
    this.rotate.textContent = 'Turn your device sideways to fight';

    document.body.append(this.root, this.rotate);
    document.body.classList.toggle('touch', this.active);
    disposer.defer(() => {
      this.root.remove();
      this.rotate.remove();
      document.body.classList.remove('touch');
    });

    this.wireStick(disposer);

    disposer.listen(window, 'pointerdown', (ev) => {
      if (ev.pointerType === 'touch' && !this.active) this.setActive(true);
    }, { passive: true });
    disposer.listen(window, 'keydown', (ev) => {
      // only a real keypress hides the overlay; synthetic test presses carry no key repeat info either way
      if (ev.isTrusted && this.active) this.setActive(false);
    });
  }

  /** -1 / 0 / 1 after the deadzone. */
  get moveX(): number {
    return Math.abs(this.x) < INPUT.touchDeadzone ? 0 : Math.sign(this.x);
  }

  get stickUp(): boolean {
    return this.y < -0.6 && Math.abs(this.y) > Math.abs(this.x) * 0.6;
  }

  get stickDown(): boolean {
    return this.y > 0.6 && Math.abs(this.y) > Math.abs(this.x) * 0.6;
  }

  get jumpHeld(): boolean {
    return this.held.has('jump') || this.stickUp;
  }

  wasPressed(act: TouchAct): boolean {
    return this.latched.has(act);
  }

  /** Show or hide for the current phase. Hiding releases every touch, so nothing stays held behind a menu. */
  sync(inFight: boolean): void {
    const show = this.active && inFight;
    if (this.root.hidden !== show) return;
    this.root.hidden = !show;
    if (!show) this.releaseAll();
  }

  endStep(): void {
    this.latched.clear();
  }

  reset(): void {
    this.releaseAll();
  }

  private setActive(on: boolean): void {
    this.active = on;
    document.body.classList.toggle('touch', on);
    if (!on) this.releaseAll();
  }

  private releaseAll(): void {
    this.held.clear();
    this.latched.clear();
    this.stickId = null;
    this.x = this.y = 0;
    this.wasUp = false;
    this.stick.classList.remove('on');
    this.stick.style.left = this.stick.style.top = '';
    this.knob.style.transform = '';
    for (const el of this.root.querySelectorAll('.tc-btn.down')) el.classList.remove('down');
  }

  private makeButton(disposer: Disposer, act: TouchAct, label: string, cls: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tc-btn ${cls}`;
    b.textContent = label;
    b.setAttribute('aria-label', label);
    let owner: number | null = null;

    disposer.listen(b, 'pointerdown', (ev) => {
      ev.preventDefault();
      if (owner !== null) return;
      owner = ev.pointerId;
      capture(b, ev.pointerId);
      if (!this.held.has(act)) this.latched.add(act);
      this.held.add(act);
      b.classList.add('down');
      if (ev.isTrusted) navigator.vibrate?.(6);    // a synthetic press has no user activation to vibrate with
    });
    const release = (ev: PointerEvent): void => {
      if (ev.pointerId !== owner) return;
      owner = null;
      this.held.delete(act);
      b.classList.remove('down');
    };
    disposer.listen(b, 'pointerup', release);
    disposer.listen(b, 'pointercancel', release);
    disposer.listen(b, 'lostpointercapture', release);
    return b;
  }

  private wireStick(disposer: Disposer): void {
    const zone = this.zone;
    disposer.listen(zone, 'pointerdown', (ev) => {
      ev.preventDefault();
      if (this.stickId !== null) return;
      this.stickId = ev.pointerId;
      capture(zone, ev.pointerId);
      const r = zone.getBoundingClientRect();
      this.originX = ev.clientX;
      this.originY = ev.clientY;
      this.stick.style.left = `${ev.clientX - r.left}px`;
      this.stick.style.top = `${ev.clientY - r.top}px`;
      this.stick.classList.add('on');
      this.track(ev);
    });
    disposer.listen(zone, 'pointermove', (ev) => {
      if (ev.pointerId === this.stickId) this.track(ev);
    });
    const end = (ev: PointerEvent): void => {
      if (ev.pointerId !== this.stickId) return;
      this.stickId = null;
      this.x = this.y = 0;
      this.wasUp = false;
      this.stick.classList.remove('on');
      this.stick.style.left = this.stick.style.top = '';
      this.knob.style.transform = '';
    };
    disposer.listen(zone, 'pointerup', end);
    disposer.listen(zone, 'pointercancel', end);
    disposer.listen(zone, 'lostpointercapture', end);
  }

  private track(ev: PointerEvent): void {
    const R = INPUT.touchRadius;
    let dx = ev.clientX - this.originX;
    let dy = ev.clientY - this.originY;
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx *= R / len;
      dy *= R / len;
    }
    this.x = dx / R;
    this.y = dy / R;
    this.knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;

    // flicking the stick up is a jump press, latched like a button so a quick flick can't be missed
    const up = this.stickUp;
    if (up && !this.wasUp) this.latched.add('jump');
    this.wasUp = up;
  }
}
