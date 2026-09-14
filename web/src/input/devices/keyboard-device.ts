/*
  Keyboard state. Held keys, plus a latch of keys that went down since the
  last simulation step.

  The latch matters. Input is read once per 120 Hz step; a key tapped and
  released inside one 8 ms step used to be seen neither down nor up, and the
  press vanished. Latching the down-edge at event time means every press
  reaches the game, however short.
*/
export class KeyboardDevice {
  private readonly held = new Set<string>();
  private readonly latched = new Set<string>();

  down(code: string): void {
    if (!this.held.has(code)) this.latched.add(code);   // auto-repeat is not a new press
    this.held.add(code);
  }

  up(code: string): void {
    this.held.delete(code);
  }

  isHeld(codes: readonly string[]): boolean {
    for (const c of codes) if (this.held.has(c)) return true;
    return false;
  }

  wasPressed(codes: readonly string[]): boolean {
    for (const c of codes) if (this.latched.has(c)) return true;
    return false;
  }

  endStep(): void {
    this.latched.clear();
  }

  reset(): void {
    this.held.clear();
    this.latched.clear();
  }
}
