import { INPUT } from '../../config/controls';

/*
  Gamepads, standard mapping.

  Polled once per simulation step: getGamepads() returns a fresh snapshot
  array per call, and the Gamepad API has no events for buttons, so edges are
  derived here by comparing against the previous poll.

  Pads are assigned to players in connection order, not by browser index — a
  controller that reports as index 1 because another device once occupied 0
  should still drive Player 1.

  Face buttons follow the fighting-game convention:
    X light · Y heavy · B summon · RB Overdrive · LB dash · A / up jump · triggers / down block
*/

export const PAD = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7,
  BACK: 8, START: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
} as const;

export type MenuAction = 'up' | 'down' | 'left' | 'right' | 'confirm' | 'back' | 'start';

const BUTTONS = 16;

export class PadState {
  index = -1;
  id = '';
  connected = false;

  /** Digital horizontal move: d-pad first, stick second. */
  moveX = 0;
  stickUp = false;
  stickDown = false;

  private readonly held = new Uint8Array(BUTTONS);
  private readonly prev = new Uint8Array(BUTTONS);
  private stickX = 0;
  private stickXEdge = 0;
  private stickUpEdge = false;
  private stickDownEdge = false;

  update(gp: Gamepad): void {
    this.index = gp.index;
    this.id = gp.id;
    this.connected = true;
    this.prev.set(this.held);

    for (let i = 0; i < BUTTONS; i++) {
      const b = gp.buttons[i];
      let on = !!b?.pressed;
      // analog triggers report `pressed` at wildly different travel per vendor
      if (b && (i === PAD.LT || i === PAD.RT)) on = b.value > INPUT.trigger;
      this.held[i] = on ? 1 : 0;
    }

    // radial deadzone, rescaled so output starts from zero at its edge instead of jumping
    let x = gp.axes[0] ?? 0;
    let y = gp.axes[1] ?? 0;
    const len = Math.hypot(x, y);
    if (len < INPUT.stickDeadzone) {
      x = y = 0;
    } else {
      const k = Math.min(1, (len - INPUT.stickDeadzone) / (1 - INPUT.stickDeadzone)) / len;
      x *= k;
      y *= k;
    }

    // hysteresis: engage at stickOn, release only below stickOff
    let sx = this.stickX;
    if (sx === 0 || x * sx < INPUT.stickOff) sx = x > INPUT.stickOn ? 1 : x < -INPUT.stickOn ? -1 : 0;
    // up/down need the stick mostly vertical, so a diagonal walk doesn't jump
    const vertical = Math.abs(y) > Math.abs(x) * 0.7;
    const up = this.stickUp ? y < -INPUT.stickUpOff : y < -INPUT.stickUpOn && vertical;
    const down = this.stickDown ? y > INPUT.stickUpOff : y > INPUT.stickUpOn && vertical;

    this.stickXEdge = sx !== 0 && sx !== this.stickX ? sx : 0;
    this.stickUpEdge = up && !this.stickUp;
    this.stickDownEdge = down && !this.stickDown;
    this.stickX = sx;
    this.stickUp = up;
    this.stickDown = down;

    const dpad = (this.held[PAD.RIGHT] ? 1 : 0) - (this.held[PAD.LEFT] ? 1 : 0);
    this.moveX = dpad || sx;
  }

  disconnect(): void {
    this.connected = false;
    this.held.fill(0);
    this.prev.fill(0);
    this.moveX = this.stickX = this.stickXEdge = 0;
    this.stickUp = this.stickDown = this.stickUpEdge = this.stickDownEdge = false;
  }

  isHeld(button: number): boolean {
    return this.held[button] === 1;
  }

  pressed(button: number): boolean {
    return this.held[button] === 1 && this.prev[button] === 0;
  }

  get jumpHeld(): boolean {
    return this.isHeld(PAD.A) || this.isHeld(PAD.UP) || this.stickUp;
  }

  get jumpPressed(): boolean {
    return this.pressed(PAD.A) || this.pressed(PAD.UP) || this.stickUpEdge;
  }

  get block(): boolean {
    return this.isHeld(PAD.LT) || this.isHeld(PAD.RT) || this.isHeld(PAD.DOWN) || this.stickDown;
  }

  menu(action: MenuAction): boolean {
    switch (action) {
      case 'up': return this.pressed(PAD.UP) || this.stickUpEdge;
      case 'down': return this.pressed(PAD.DOWN) || this.stickDownEdge;
      case 'left': return this.pressed(PAD.LEFT) || this.stickXEdge === -1;
      case 'right': return this.pressed(PAD.RIGHT) || this.stickXEdge === 1;
      case 'confirm': return this.pressed(PAD.A);
      case 'back': return this.pressed(PAD.B);
      case 'start': return this.pressed(PAD.START);
    }
  }
}

type Haptics = { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> };

export class GamepadDevice {
  private readonly states = [new PadState(), new PadState(), new PadState(), new PadState()];
  private readonly order: PadState[] = [];

  poll(): void {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    this.order.length = 0;
    for (let i = 0; i < this.states.length; i++) {
      const gp = list[i];
      const s = this.states[i]!;
      if (gp && gp.connected) {
        s.update(gp);
        this.order.push(s);
      } else if (s.connected) {
        s.disconnect();
      }
    }
  }

  get connectedCount(): number {
    return this.order.length;
  }

  forSlot(slot: number): PadState | null {
    return this.order[slot] ?? null;
  }

  /** Dual-motor rumble on the pad driving `slot`, where the browser and pad support it. */
  rumble(slot: number, strong: number, weak: number, ms: number): void {
    const s = this.order[slot];
    if (!s) return;
    const gp = navigator.getGamepads?.()[s.index];
    const act = gp?.vibrationActuator as unknown as Haptics | undefined;
    act?.playEffect?.('dual-rumble', {
      startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak,
    }).catch(() => { /* unsupported pad: silence is fine */ });
  }
}
