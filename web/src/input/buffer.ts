/*
  The input buffer.

  Every fighting game has one, because humans press buttons a few frames
  early. Without it, a punch pressed 40 ms before the previous punch's
  recovery ends is simply dropped — the single most common reason controls
  feel "unresponsive" when nothing is technically wrong.

  Each action holds the seconds its latest press has left. The window counts
  down only while the match is actually running, so a button pressed during
  hit-stop is still live when the freeze lifts — that is what lets a player
  react to a hit landing.
*/

/** One slot per ACT flag in game/intent.ts. */
const SLOTS = 7;

const slotOf = (act: number): number => 31 - Math.clz32(act);

export class InputBuffer {
  private readonly left = new Float32Array(SLOTS);

  press(act: number, window: number): void {
    this.left[slotOf(act)] = window;
  }

  has(act: number): boolean {
    return this.left[slotOf(act)]! > 0;
  }

  tick(dt: number): void {
    for (let i = 0; i < SLOTS; i++) this.left[i] = Math.max(0, this.left[i]! - dt);
  }

  consume(mask: number): void {
    for (let i = 0; i < SLOTS; i++) if (mask & (1 << i)) this.left[i] = 0;
  }

  clear(): void {
    this.left.fill(0);
  }
}
