import { ROSTER } from '../config/roster';
import { storageGetJSON, storageSetJSON } from '../core/platform';
import { Sfx } from '../audio/sfx';
import type { Fighter } from '../game/fighter';

/*
  Playtest notes, taken on the results screen while the match is fresh. Nothing
  leaves the browser: answers are kept in localStorage and COPY ALL puts every
  saved answer on the clipboard as plain text, ready to paste into notes. The
  questions are about feel, because feel is what a playtest can tell you that
  the code cannot.
*/

interface Answer {
  at: string;
  played: string;
  best: string;
  worst: string;
  movement: number;
  hits: number;
  note: string;
}

const STORE = 'ashfall.feedback';
let root: HTMLElement | null = null;
let lastPair = '';

function saved(): Answer[] {
  return storageGetJSON<Answer[]>(STORE) ?? [];
}

function options(): string {
  return ROSTER.map((d) => `<option value="${d.name}">${d.name}</option>`).join('');
}

function scale(name: string): string {
  return `<div class="fb-scale" data-name="${name}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}">${n}</button>`).join('')}</div>`;
}

function build(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'feedback';
  el.innerHTML = `
    <div class="fb-box beam" role="dialog" aria-label="Playtest feedback">
      <h3>PLAYTEST NOTES</h3>
      <p class="fb-sub">Thirty seconds, while the match is fresh. Saved on this browser only.</p>
      <label>Which fighter felt <b>best</b> to move? <select id="fb-best"><option value="">pick one</option>${options()}</select></label>
      <label>Which felt <b>worst</b>? <select id="fb-worst"><option value="">pick one</option>${options()}</select></label>
      <div class="fb-row">Movement feel (1 stiff, 5 great) ${scale('movement')}</div>
      <div class="fb-row">Did hits feel heavy? (1 no, 5 yes) ${scale('hits')}</div>
      <label>One thing that confused or annoyed you<textarea id="fb-note" rows="2" maxlength="400"></textarea></label>
      <div class="fb-actions">
        <button type="button" class="tbtn primary" id="fb-save">SAVE</button>
        <button type="button" class="tbtn" id="fb-copy">COPY ALL (<span id="fb-count">0</span>)</button>
        <button type="button" class="tbtn ghost" id="fb-close">CLOSE</button>
      </div>
      <p class="fb-msg" id="fb-msg"></p>
    </div>`;
  document.body.appendChild(el);
  const values: Record<string, number> = { movement: 0, hits: 0 };
  el.querySelectorAll<HTMLElement>('.fb-scale').forEach((row) => {
    row.addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest('button');
      if (!b) return;
      values[row.dataset.name!] = Number(b.dataset.v);
      row.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      Sfx.ui();
    });
  });
  const msg = el.querySelector<HTMLElement>('#fb-msg')!;
  const count = el.querySelector<HTMLElement>('#fb-count')!;
  const refresh = (): void => { count.textContent = String(saved().length); };
  el.querySelector('#fb-save')!.addEventListener('click', () => {
    const best = (el.querySelector('#fb-best') as HTMLSelectElement).value;
    const worst = (el.querySelector('#fb-worst') as HTMLSelectElement).value;
    const note = (el.querySelector('#fb-note') as HTMLTextAreaElement).value.trim();
    if (!best && !worst && !values.movement && !values.hits && !note) { msg.textContent = 'Nothing to save yet.'; return; }
    const list = saved();
    list.push({ at: new Date().toISOString().slice(0, 16).replace('T', ' '), played: lastPair, best, worst, movement: values.movement, hits: values.hits, note });
    storageSetJSON(STORE, list);
    msg.textContent = 'Saved. Thanks for playing.';
    Sfx.ui();
    refresh();
  });
  el.querySelector('#fb-copy')!.addEventListener('click', () => {
    const text = saved().map((a, i) => `#${i + 1}  ${a.at}  ${a.played}\n  best: ${a.best || '-'}  worst: ${a.worst || '-'}  movement: ${a.movement || '-'}/5  hits: ${a.hits || '-'}/5\n  note: ${a.note || '-'}`).join('\n\n');
    if (!text) { msg.textContent = 'No saved notes yet.'; return; }
    void navigator.clipboard?.writeText(text).then(
      () => { msg.textContent = 'Copied every saved note to the clipboard.'; },
      () => { msg.textContent = 'The browser blocked the clipboard.'; },
    );
  });
  el.querySelector('#fb-close')!.addEventListener('click', closeFeedback);
  el.addEventListener('keydown', (ev) => {
    ev.stopPropagation();                // typing a note must not drive the fighters or the menus
    if (ev.key === 'Escape') closeFeedback();
  });
  refresh();
  return el;
}

export function openFeedback(p1: Fighter, p2: Fighter): void {
  lastPair = `${p1.def.name} vs ${p2.def.name}`;
  root ??= build();
  root.classList.add('on');
  const count = root.querySelector<HTMLElement>('#fb-count');
  if (count) count.textContent = String(saved().length);
  root.querySelector<HTMLElement>('#fb-best')?.focus();
}

export function closeFeedback(): void {
  root?.classList.remove('on');
  document.getElementById('rfeedback')?.focus();
}
