import type { Disposer } from '../../core/disposal';

/*
  Mouse buttons as attack buttons for Player 1: left light, right heavy,
  middle summon, and the two thumb buttons for Overdrive and dash.

  mousedown/mouseup rather than pointer events: a pointer fires pointerdown
  only for the first button held, so pressing right-click while holding left
  would never arrive. Clicks on the HUD's real controls (buttons, sliders, the
  touch overlay) are left alone, and the context menu is suppressed only while
  a fight is live.
*/

export const MOUSE = { LEFT: 0, MIDDLE: 1, RIGHT: 2, BACK: 3, FORWARD: 4 } as const;

const INTERACTIVE = 'button, input, select, a, label, .tc-root, #modal, #pause, #results';

export class MouseDevice {
  private held = 0;
  private latched = 0;

  attach(disposer: Disposer, enabled: () => boolean): void {
    const onGameSurface = (ev: MouseEvent): boolean =>
      !(ev.target instanceof Element && ev.target.closest(INTERACTIVE));

    disposer.listen(window, 'mousedown', (ev) => {
      if (!enabled() || !onGameSurface(ev)) return;
      const bit = 1 << ev.button;
      if (!(this.held & bit)) this.latched |= bit;
      this.held |= bit;
      if (ev.button !== MOUSE.LEFT) ev.preventDefault();   // no autoscroll, no browser back/forward
    });
    disposer.listen(window, 'mouseup', (ev) => {
      this.held &= ~(1 << ev.button);
      if (enabled() && (ev.button === MOUSE.BACK || ev.button === MOUSE.FORWARD)) ev.preventDefault();
    });
    disposer.listen(window, 'contextmenu', (ev) => {
      if (enabled() && onGameSurface(ev)) ev.preventDefault();
    });
    disposer.listen(window, 'blur', () => this.reset());
  }

  wasPressed(button: number): boolean {
    return (this.latched & (1 << button)) !== 0;
  }

  isHeld(button: number): boolean {
    return (this.held & (1 << button)) !== 0;
  }

  endStep(): void {
    this.latched = 0;
  }

  reset(): void {
    this.held = 0;
    this.latched = 0;
  }
}
