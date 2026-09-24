import { say } from '../audio/voice';
import { dom } from './dom';

export type CalloutKind = 'slam' | 'toast' | 'warn' | 'fatal';

/*
  The big words: ROUND ONE, FIGHT!, K.O., FINISH THEM!, FATALITY, a summon's name.

  Keyframe-driven. Restarting a CSS animation needs the class removed, a
  reflow forced, and the class put back — reading offsetWidth is the reflow.
*/

let callTimer = 0;
let outTimer = 0;
let chainTimer = 0;

export function clearAnnounce(): void {
  window.clearTimeout(callTimer);
  window.clearTimeout(outTimer);
  window.clearTimeout(chainTimer);
  callTimer = outTimer = chainTimer = 0;
  dom.call.className = '';
}

export function announce(text: string, ms: number, kind: CalloutKind = 'slam'): void {
  // the big calls are spoken as well as shown; toasts are just information
  if (kind !== 'toast') say(text.replace('\n', '. '));
  const [head, sub] = text.split('\n');
  dom.callText.textContent = head ?? '';
  if (sub) {
    const small = document.createElement('small');
    small.textContent = sub;
    dom.callText.appendChild(small);
  }
  dom.call.className = '';
  void dom.call.offsetWidth;              // restart the keyframes
  dom.call.className = `show ${kind}`;
  window.clearTimeout(callTimer);
  window.clearTimeout(outTimer);
  if (kind === 'toast') {
    callTimer = window.setTimeout(() => {
      dom.call.className = '';
    }, ms);
  } else {
    callTimer = window.setTimeout(() => {
      dom.call.className = `show ${kind} out`;
      outTimer = window.setTimeout(() => {
        dom.call.className = '';
      }, 300);
    }, ms);
  }
}

/** Schedule a follow-up callout. Only one is ever pending; scheduling another replaces it. */
export function calloutAfter(ms: number, fn: () => void): void {
  window.clearTimeout(chainTimer);
  chainTimer = window.setTimeout(fn, ms);
}
