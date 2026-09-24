import { INPUT } from '../config/controls';
import type { Fighter } from '../game/fighter';
import { ACT, blankIntent, type Intent } from '../game/intent';
import { BINDINGS, type PlayerBindings } from './bindings';
import { InputBuffer } from './buffer';
import { GamepadDevice, PAD } from './devices/gamepad-device';
import { KeyboardDevice } from './devices/keyboard-device';
import { MOUSE, MouseDevice } from './devices/mouse-device';
import type { TouchAct, TouchControls } from './devices/touch-controls';

export type { MenuAction } from './devices/gamepad-device';

/*
  The player controller: every input device merged into one Intent per
  player, per simulation step.

    keyboard ─┐
    gamepad  ─┼─► capture() ─► InputBuffer ─► intent() ─► state machine ─► acknowledge()
    mouse    ─┤   (held state, presses,       (buffered     (marks what it
    touch    ─┘    double-tap dash)            presses)      acted on)

  Player 1 takes keyboard (left cluster), the first gamepad, the mouse and the
  touch overlay. Player 2 takes the arrow cluster and the second gamepad.
  Every source is OR'd — pick up a pad mid-round and it simply works.

  capture() runs even during hit-stop, so presses made in the freeze are
  buffered, but the buffer only ages while the match is running.
*/

export const keyboard = new KeyboardDevice();
export const gamepads = new GamepadDevice();
export const mouse = new MouseDevice();
export const input = { touch: null as TouchControls | null };

export class PlayerController {
  private readonly buffer = new InputBuffer();
  private readonly out = blankIntent();
  private clock = 0;
  private move = 0;
  private block = false;
  private jumpHeld = false;
  private prevMove = 0;
  private tapDir = 0;
  private tapTime = -Infinity;
  private dashDir = 0;
  private backTime = -Infinity;
  private motionTime = -Infinity;

  constructor(readonly slot: 0 | 1, private readonly map: PlayerBindings) {}

  capture(f: Fighter, dt: number, frozen: boolean): void {
    if (!frozen) {
      this.clock += dt;
      this.buffer.tick(dt);
    }

    const k = this.map.keys;
    const pad = gamepads.forSlot(this.slot);
    const primary = this.slot === 0;
    const touch = primary && input.touch?.active ? input.touch : null;

    // held state: keyboard wins, then touch, then pad
    let move = (keyboard.isHeld(k.right) ? 1 : 0) - (keyboard.isHeld(k.left) ? 1 : 0);
    if (!move && touch) move = touch.moveX;
    if (!move && pad) move = pad.moveX;
    this.move = move;
    this.block = keyboard.isHeld(k.block) || !!pad?.block || !!touch?.stickDown;
    this.jumpHeld = keyboard.isHeld(k.jump) || !!pad?.jumpHeld || !!touch?.jumpHeld;

    const pressed = (keys: readonly string[], padButton: number, mouseButton: number, touchAct: TouchAct): boolean =>
      keyboard.wasPressed(keys)
      || !!pad?.pressed(padButton)
      || (primary && mouse.wasPressed(mouseButton))
      || !!touch?.wasPressed(touchAct);

    /* Motion input: back, then forward, relative to where the fighter faces.
       Light pressed just after is the special instead of a jab. Read before
       prevMove moves on, so forward + light on the same step still counts. */
    if (move !== 0 && move !== this.prevMove) {
      if (move * f.face < 0) this.backTime = this.clock;
      else if (this.clock - this.backTime < INPUT.motion) this.motionTime = this.clock;
    }

    if (keyboard.wasPressed(k.jump) || pad?.jumpPressed || touch?.wasPressed('jump')) this.buffer.press(ACT.JUMP, INPUT.buffer);
    if (pressed(k.punch, PAD.X, MOUSE.LEFT, 'punch')) {
      const special = this.clock - this.motionTime < INPUT.motionPress;
      this.buffer.press(special ? ACT.SPECIAL : ACT.PUNCH, INPUT.buffer);
      if (special) this.motionTime = -Infinity;
    }
    if (pressed(k.kick, PAD.Y, MOUSE.RIGHT, 'kick')) this.buffer.press(ACT.KICK, INPUT.buffer);
    if (pressed(k.assist, PAD.B, MOUSE.MIDDLE, 'assist')) this.buffer.press(ACT.ASSIST, INPUT.buffer);
    if (pressed(k.power, PAD.RB, MOUSE.BACK, 'power')) this.buffer.press(ACT.POWER, INPUT.buffer);

    // dash button: the held direction, or forward from neutral
    if (pressed(k.dash, PAD.LB, MOUSE.FORWARD, 'dash')) {
      this.dashDir = move || f.face;
      this.buffer.press(ACT.DASH, INPUT.dashBuffer);
    }

    /* Double-tap dash. The direction has to be released and re-pressed inside
       the window, so holding a direction never accumulates into one. */
    if (move !== 0 && move !== this.prevMove) {
      if (this.tapDir === move && this.clock - this.tapTime < INPUT.dashTap) {
        this.dashDir = move;
        this.buffer.press(ACT.DASH, INPUT.dashBuffer);
        this.tapDir = 0;
      } else {
        this.tapDir = move;
        this.tapTime = this.clock;
      }
    }
    this.prevMove = move;
  }

  /** This step's Intent. The object is reused; read it before the next step. */
  intent(): Intent {
    const o = this.out;
    const b = this.buffer;
    o.move = this.move;
    o.block = this.block;
    o.jumpHeld = this.jumpHeld;
    o.dash = b.has(ACT.DASH) ? this.dashDir : 0;
    o.jumpDown = b.has(ACT.JUMP);
    o.punchDown = b.has(ACT.PUNCH);
    o.kickDown = b.has(ACT.KICK);
    o.assistDown = b.has(ACT.ASSIST);
    o.powerDown = b.has(ACT.POWER);
    o.specialDown = b.has(ACT.SPECIAL);
    o.consumed = 0;
    return o;
  }

  /** Spend the presses the game acted on, so one press is one action. */
  acknowledge(intent: Intent): void {
    this.buffer.consume(intent.consumed);
  }

  resetBuffer(): void {
    this.buffer.clear();
    this.tapDir = 0;
    this.tapTime = -Infinity;
    this.backTime = this.motionTime = -Infinity;
  }
}

export const controllers = [
  new PlayerController(0, BINDINGS.p1),
  new PlayerController(1, BINDINGS.p2),
] as const;

/** Once per simulation step, before anything reads input. */
export function pollDevices(): void {
  gamepads.poll();
}

/** Once per simulation step, after everything has read input: presses latched for this step are spent. */
export function endInputStep(): void {
  keyboard.endStep();
  mouse.endStep();
  input.touch?.endStep();
}

/** Round starts: drop buffered presses and dash taps, but keep what is physically held. */
export function resetInputBuffers(): void {
  for (const c of controllers) c.resetBuffer();
}

/** Pause, blur, leaving a match: never resume into a stuck key. */
export function resetInput(): void {
  keyboard.reset();
  mouse.reset();
  input.touch?.reset();
  resetInputBuffers();
}
