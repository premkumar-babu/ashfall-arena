import { Sfx } from './sfx';
import { settings } from '../ui/settings';

/*
  The announcer's voice.

  A fighting game of this kind is half announcer: ROUND ONE, FIGHT, FINISH
  THEM, FATALITY. There is no recorded voice in this project, so the browser's
  own speech synthesiser reads the callouts, pitched down and slowed so it
  lands closer to a growl than a screen reader. Which voices exist depends on
  the machine; a deep English one is preferred when there is one, and with no
  speech support at all this is silent and nothing else notices.

  It follows the SFX mute and the ANNOUNCER setting, and only ever says the
  latest line: a new callout cuts the old one off rather than queueing behind it.
*/

let chosen: SpeechSynthesisVoice | null = null;
let looked = false;

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis);

function pickVoice(): SpeechSynthesisVoice | null {
  const s = synth();
  if (!s) return null;
  const all = s.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
  if (!all.length) return null;
  const prefer = [/david/i, /guy/i, /george/i, /daniel/i, /fred/i, /ryan/i, /male/i, /mark/i];
  for (const re of prefer) {
    const hit = all.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  return all[0] ?? null;
}

const s0 = synth();
if (s0) {
  s0.addEventListener?.('voiceschanged', () => {
    chosen = pickVoice();
    looked = true;
  });
}

/** Words the synthesiser mangles, spelled the way they should sound. */
const SAY_AS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^K\.O\.$/, ''],
  [/^DOUBLE K\.O\.$/, 'Double knockout'],
  [/^TIME UP$/, 'Time'],
  [/\bVS\b/, 'versus'],
];

export function say(text: string, pitch = 0.1, rate = 0.78): void {
  const s = synth();
  if (!s || !settings.voiceOn || !Sfx.on) return;
  let line = text;
  for (const [re, as] of SAY_AS) line = line.replace(re, as);
  line = line.replace(/[·•]/g, ' ').trim();
  if (!line) return;
  if (!looked) {
    chosen = pickVoice();
    looked = true;
  }
  s.cancel();
  const u = new SpeechSynthesisUtterance(line.charAt(0) + line.slice(1).toLowerCase());
  if (chosen) u.voice = chosen;
  u.pitch = pitch;
  u.rate = rate;
  u.volume = Math.min(1, 0.4 + Sfx.masterVol * Sfx.sfxVol);
  s.speak(u);
}

export function hush(): void {
  synth()?.cancel();
}
