/*
  Every DOM element the game writes to, looked up once.

  A missing required element throws at boot with its id. The monolith looked
  these up at load and failed later, far from the cause, the first time
  something tried to write to a null — usually mid-match.
*/

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
}

function pair<T extends HTMLElement = HTMLElement>(a: string, b: string): [T, T] {
  return [byId<T>(a), byId<T>(b)];
}

export interface DomHandles {
  readonly call: HTMLElement;
  readonly callText: HTMLElement;
  readonly clock: HTMLElement;
  readonly round: HTMLElement;
  readonly block: [HTMLElement, HTMLElement];
  readonly name: [HTMLElement, HTMLElement];
  readonly keyName: [HTMLElement, HTMLElement];
  readonly hp: [HTMLElement, HTMLElement];
  readonly chip: [HTMLElement, HTMLElement];
  readonly gaugeAssist: [HTMLElement, HTMLElement];
  readonly gaugeSuper: [HTMLElement, HTMLElement];
  readonly assistFill: [HTMLElement, HTMLElement];
  readonly superFill: [HTMLElement, HTMLElement];
  readonly combo: [HTMLElement, HTMLElement];
  readonly pill: [HTMLElement, HTMLElement];
  readonly superPill: [HTMLElement, HTMLElement];
  readonly stock: [HTMLElement, HTMLElement];
  readonly sndLabel: HTMLElement;
  readonly startBtn: HTMLButtonElement;
  readonly selPick: [HTMLElement, HTMLElement];
  readonly selSub: [HTMLElement, HTMLElement];
  readonly selSide: [HTMLElement, HTMLElement];
  readonly lock: [HTMLElement, HTMLElement];
}

export let dom: DomHandles;

export function bindDom(): void {
  const call = byId('call');
  const callText = call.firstElementChild;
  if (!(callText instanceof HTMLElement)) throw new Error('#call needs a text child');
  dom = {
    call,
    callText,
    clock: byId('clock'),
    round: byId('roundlbl'),
    block: pair('fb0', 'fb1'),
    name: pair('fn0', 'fn1'),
    keyName: pair('kn0', 'kn1'),
    hp: pair('hp1', 'hp2'),
    chip: pair('chip1', 'chip2'),
    gaugeAssist: pair('ga0', 'ga1'),
    gaugeSuper: pair('gs0', 'gs1'),
    assistFill: pair('gaf0', 'gaf1'),
    superFill: pair('gsf0', 'gsf1'),
    combo: pair('cb0', 'cb1'),
    pill: pair('ps1', 'ps2'),
    superPill: pair('pm1', 'pm2'),
    stock: pair('st1', 'st2'),
    sndLabel: byId('sndstate'),
    startBtn: byId<HTMLButtonElement>('startbtn'),
    selPick: pair('sp0', 'sp1'),
    selSub: pair('sd0', 'sd1'),
    selSide: pair('ss0', 'ss1'),
    lock: pair('lk0', 'lk1'),
  };
}

/** For optional elements — the dev panel, the stage picker — whose absence is not an error. */
export function maybeById<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
