export interface FighterDef {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly accent: number;
  readonly hex: string;
  readonly lite: string;
  readonly dim: string;
  readonly plate: number;
  readonly cloth: number;
  readonly cape: number;
  readonly flesh: number;
  readonly hair: number;
  readonly rough: number;
  readonly metal: number;
  readonly scale: number;
  readonly bulk: number;
  readonly pad: number;
  readonly helm: number;
  readonly blade: boolean;
  readonly speed: number;
  readonly jump: number;
  readonly power: number;
  readonly reach: number;
  readonly armed: boolean;
  readonly style: string;
  readonly heavy: 'SLASH' | 'KICK';
  readonly heavyMul: number;
  readonly heavyReach: number;
}

export interface AssistDef {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly build: 'wraith' | 'idol';
  readonly pattern: 'leap' | 'slam';
  readonly color: number;
  readonly hex: string;
  readonly rushSpeed: number;
  readonly strikeRange: number;
  readonly activeFrom: number;
  readonly activeTo: number;
  readonly damage: number;
  readonly knockback: number;
  readonly hitstun: number;
  readonly orb: boolean;
  readonly orbAt?: number;
  readonly orbDamage?: number;
  readonly orbKnockback?: number;
  readonly orbHitstun?: number;
  readonly orbSpeed?: number;
  readonly orbLife?: number;
}

export const ROSTER: readonly FighterDef[] = [
  {
    id: 'cinderward', name: 'CINDERWARD', title: 'Ember Knight',
    accent: 0xe2612b, hex: '#E2612B', lite: '#FFB454', dim: '#8E3413',
    plate: 0xC24F22, cloth: 0x2B3E52, cape: 0xB02C12, flesh: 0xD2A281, hair: 0x1A1016,
    rough: 0.55, metal: 0.55, scale: 1.00, bulk: 1.00,
    pad: 0.34, helm: 0.62, blade: false,
    speed: 6.2, jump: 9.4, power: 1.00, reach: 1.00,
    armed: true, style: 'STRAIGHT SWORD', heavy: 'SLASH', heavyMul: 1.20, heavyReach: 2.05,
  },
  {
    id: 'palevigil', name: 'PALE VIGIL', title: 'Spectral Sentinel',
    accent: 0x5bc8d8, hex: '#5BC8D8', lite: '#B6EEF6', dim: '#1B6C7B',
    plate: 0x5E9FBE, cloth: 0x2C5570, cape: 0x1B5670, flesh: 0xC9A88E, hair: 0xE8E4DC,
    rough: 0.35, metal: 0.72, scale: 1.08, bulk: 0.86,
    pad: 0.27, helm: 0.86, blade: true,
    speed: 6.9, jump: 10.2, power: 0.86, reach: 1.16,
    armed: true, style: 'CURVED SABRE', heavy: 'SLASH', heavyMul: 1.10, heavyReach: 2.35,
  },
  {
    id: 'bronzemaw', name: 'BRONZEMAW', title: 'Verdigris Brute',
    accent: 0x7fb03a, hex: '#7FB03A', lite: '#C3E86A', dim: '#3E5A18',
    plate: 0x74A033, cloth: 0x2F4020, cape: 0x4E8228, flesh: 0xC08A62, hair: 0x241A10,
    rough: 0.80, metal: 0.35, scale: 0.96, bulk: 1.34,
    pad: 0.44, helm: 0.34, blade: false,
    speed: 5.2, jump: 8.2, power: 1.38, reach: 0.94,
    armed: false, style: 'IRON PALM', heavy: 'KICK', heavyMul: 1.00, heavyReach: 0,
  },
  {
    id: 'nocturne', name: 'NOCTURNE', title: 'Violet Cutthroat',
    accent: 0xa76be0, hex: '#A76BE0', lite: '#DCB6FF', dim: '#4C2775',
    plate: 0x7E4CB8, cloth: 0x2A1E3E, cape: 0x8235C4, flesh: 0xCE9C86, hair: 0x2A1638,
    rough: 0.45, metal: 0.50, scale: 0.95, bulk: 0.76,
    pad: 0.24, helm: 0.74, blade: true,
    speed: 8.0, jump: 11.2, power: 0.72, reach: 1.02,
    armed: false, style: 'DRUNKEN FIST', heavy: 'KICK', heavyMul: 1.00, heavyReach: 0,
  },
];

/*
  The two summons are balanced to one budget: 10 damage per call — less than
  a light attack plus a heavy, so a summon opens space or extends a combo
  rather than deciding a round — with the same knockback and hitstun per
  blow, the same rush speed and a strike window of the same length. What
  differs is only how the damage is delivered.

    EMBERWRAITH   6 on the leap + 4 on the cinder orb (one orb per call).
                  Two chances to land, and the orb carries it at range, but
                  only both together reach 10.
    CARRION IDOL  10 in one slam whose shockwave widens along the floor.
                  Hard to jump or walk out of, but it is one roll of the dice
                  and it starts later.

  Summon hits ignore hurtbox zones (collision.ts), so the budget is exact:
  a head contact is not worth more than a leg.
*/
export const ASSIST_ROSTER: readonly AssistDef[] = [
  {
    id: 'emberwraith', name: 'EMBERWRAITH', title: 'Leap + cinder orb',
    build: 'wraith', pattern: 'leap',
    color: 0xf0c24b, hex: '#F0C24B',
    rushSpeed: 14.0, strikeRange: 3.0,
    activeFrom: 0.07, activeTo: 0.39,
    damage: 6, knockback: 9.0, hitstun: 0.38,
    orb: true, orbAt: 0.13, orbDamage: 4, orbKnockback: 9.0, orbHitstun: 0.38, orbSpeed: 13.5, orbLife: 1.5,
  },
  {
    id: 'carrionidol', name: 'CARRION IDOL', title: 'Ground-slam shockwave',
    build: 'idol', pattern: 'slam',
    color: 0x9ad7c0, hex: '#9AD7C0',
    rushSpeed: 14.0, strikeRange: 2.8,
    activeFrom: 0.36, activeTo: 0.68,
    damage: 10, knockback: 9.0, hitstun: 0.38,
    orb: false,
  },
];

export const ASSIST_COMMON = {
  spawnBack: 10.5, despawnBack: 13.5, z: -0.42, retreatSpeed: 19.0, rushTimeout: 1.8,
} as const;
