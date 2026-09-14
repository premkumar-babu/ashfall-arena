/*
  Collision groups. Rapier packs membership into the high 16 bits and the
  filter into the low 16; two colliders interact only when each one's
  membership is in the other's filter.

  The matrix, and why:

               STATIC  WALL  FIGHTER  PROP  DEBRIS
    STATIC       ·      ·      ✓       ✓      ✓
    WALL         ·      ·      ✓       ·      ·     invisible bounds are for fighters only;
                                                    an urn bouncing off thin air looks broken
    FIGHTER      ✓      ✓      ·       ✓      ·     fighters never collide with each other:
                                                    pushboxes shove, they don't block (movement.ts)
    PROP         ✓      ·      ✓       ✓      ✓
    DEBRIS       ✓      ·      ·       ✓      ✓     chips skip the fighters' capsules, which
                                                    only approximate the visible model
*/

export const GROUP = {
  STATIC: 1 << 0,
  WALL: 1 << 1,
  FIGHTER: 1 << 2,
  PROP: 1 << 3,
  DEBRIS: 1 << 4,
} as const;

export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export const SCENERY = groups(GROUP.STATIC, GROUP.FIGHTER | GROUP.PROP | GROUP.DEBRIS);
export const BOUNDS = groups(GROUP.WALL, GROUP.FIGHTER);
export const FIGHTER_BODY = groups(GROUP.FIGHTER, GROUP.PROP);
/** What the character controller sweeps against: scenery and bounds only. */
export const FIGHTER_QUERY = groups(GROUP.FIGHTER, GROUP.STATIC | GROUP.WALL);
export const PROP_BODY = groups(GROUP.PROP, GROUP.STATIC | GROUP.FIGHTER | GROUP.PROP | GROUP.DEBRIS);
export const DEBRIS_BODY = groups(GROUP.DEBRIS, GROUP.STATIC | GROUP.PROP | GROUP.DEBRIS);
