/** @import { Plan } from '../../src/api-schema.js' */

import { $ } from './constants.js';
import { h, icon } from './dom.js';
import { api } from './api.js';
import { bindReplan } from './controls.js';
import {
  plan, session, mirrorChoice, typed, payload, fromCluster,
  setPlan, getDrawnShape, bumpPlanSeq, getPlanSeq,
} from './state.js';
import { shapeOf } from '/core/ui-helpers.js';
import { hooks } from './hooks.js';
import { paint } from './sync.js';
import { reveal } from './browse.js';

export function banner(message, kind = 'error') {
  $('banner').hidden = !message;
  $('banner').className = kind === 'info' ? 'banner info' : 'banner';
  $('banner').textContent = message;
}

export async function replan() {
  const seq = bumpPlanSeq();
  try {
    const next = await api('POST', '/api/plan', payload());
    if (seq !== getPlanSeq()) return;
    setPlan(next);
    banner('');
    if (shapeOf(plan.model.planned) !== getDrawnShape()) hooks.afterStructuralChange();
    renderPlan();
  } catch (err) {
    banner(err.message);
  }
}

bindReplan(replan);

/** Where a finding is on the page: its queue's row or header, else its pool. */
function placeOf(f) {
  return (f.queue && document.querySelector(`[data-queue="${CSS.escape(f.queue)}"]`))
    || (f.pool && document.querySelector(`.pool[data-pool="${CSS.escape(f.pool)}"] > summary`))
    || null;
}

export function renderPlan() {
  const levels = { error: 'error', warning: 'warning', info: 'note' };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const finding = (f) => {
    const li = h('li', { class: f.level }, icon(f.level), h('span', {}, h('span', { class: 'sr' }, `${levels[f.level]}: `), f.message));
    if (placeOf(f)) {
      li.classList.add('goto');
      li.title = `Show ${f.queue ?? f.pool}`;
      li.addEventListener('click', () => { const el = placeOf(f); if (el) reveal(el); });
    }
    return li;
  };
  const errors = plan.findings.filter((f) => f.level === 'error');
  const warnings = plan.findings.filter((f) => f.level === 'warning');
  const notes = plan.findings.filter((f) => f.level === 'info');
  $('findings').replaceChildren(...(errors.length || warnings.length
    ? [...errors, ...warnings].map(finding)
    : [h('li', { class: 'clear' }, icon('check'), h('span', {}, 'Nothing in the way: every guarantee fits its limit, its department and the pool.'))]));
  $('notes-box').hidden = !notes.length;
  $('notes-summary').replaceChildren(icon('chevron'), plural(notes.length, 'note'));
  $('notes').replaceChildren(...notes.map(finding));
  $('findings-count').textContent = errors.length || warnings.length ? `${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}` : 'all clear';

  const bad = new Set(errors.map((f) => f.queue).filter(Boolean));
  document.querySelectorAll('[data-queue]').forEach((el) => el.classList.toggle('has-error', bad.has(el.dataset.queue)));
  // The pools show the same findings as counts and marks.
  paint();

  const rows = [
    ...plan.additions.map((a) => h('li', { class: a.error ? 'added failed' : 'added', title: a.error ?? '' }, icon('plus'), h('span', {}, a.label), h('button', { type: 'button', class: 'link', onclick: () => hooks.removeAddition(a.index) }, 'remove'))),
    ...plan.changes.map((c) => h('li', {}, icon('arrow'), h('span', {}, c.label), h('button', { type: 'button', class: 'link', onclick: () => hooks.undoChange(c.id) }, 'undo'))),
  ];
  $('changes').replaceChildren(...(rows.length ? rows : [h('li', { class: 'empty' }, h('span', {}, 'No changes yet. Move a slider, type a number, or add something.'))]));
  $('reset-all').hidden = !rows.length;

  const state = $('plan-state');
  const [tone, label, mark] = errors.length ? ['bad', plural(errors.length, 'error'), 'error']
    : plan.empty ? ['', 'No changes', null]
      : warnings.length ? ['warn', `Ready · ${plural(warnings.length, 'warning')}`, 'warning'] : ['ok', 'Ready', 'check'];
  state.className = `pill ${tone}`;
  state.replaceChildren(...[mark && icon(mark), label].filter(Boolean));
  $('plan-summary').textContent = plan.empty ? 'Nothing to apply yet'
    : `${plural(rows.length, 'change')}${errors.length ? ` · fix ${plural(errors.length, 'error')} first` : ''}`;

  renderCoupled();

  const diff = $('diff');
  diff.replaceChildren(...(plan.diff
    ? plan.diff.split('\n').slice(0, -1).map((line) => h('span', { class: line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'file' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '' }, `${line}\n`))
    : [h('span', { class: 'empty' }, fromCluster() ? 'The objects are unchanged.' : 'The files are unchanged.')]));
  for (const id of ['copy-diff', 'download-patch', 'download-tenancy']) $(id).disabled = !plan.diff;
  $('dry-run').disabled = !session.cluster.ok;

  const blocked = plan.canCommit ? '' : plan.empty ? 'Nothing to change' : 'Fix the errors under Checks first';
  $('commit-panel').hidden = fromCluster();
  $('apply-panel').hidden = !fromCluster();
  if (fromCluster()) {
    $('apply').disabled = !plan.canCommit;
    $('apply').title = blocked;
    $('apply-output').hidden = true;
  } else {
    if (!typed.message) $('message').value = plan.message;
    if (!typed.branch) $('branch').value = plan.branch;
    for (const id of ['commit', 'commit-open']) {
      $(id).disabled = !plan.canCommit;
      $(id).title = blocked;
    }
  }
}

function renderCoupled() {
  const items = [];
  const exp = plan.expectations;
  if (exp.file) {
    items.push(h('div', { class: 'coupled-item' }, icon('check'), h('span', {},
      h('code', {}, exp.file),
      h('span', { class: 'note' }, exp.changes.length
        ? `${[...new Set(exp.changes.map((c) => c.variable))].join(', ')} updated automatically (${exp.changes.map((c) => `${c.queue} ${c.from} → ${c.to}`).join('; ')}) — verify.sh compares the live queues with these`
        : 'no change needed — its expected numbers already match'))));
  }
  for (const m of plan.mirrors) {
    const box = h('input', { type: 'checkbox', name: `mirror/${m.file}`, disabled: m.status !== 'differs', 'aria-label': `include ${m.file}` });
    box.checked = m.included;
    box.addEventListener('change', () => {
      mirrorChoice[m.file] = box.checked;
      replan();
    });
    const what = m.status === 'differs'
      ? `${m.object} ${m.key}: ${m.current} → ${m.suggested}. ${m.note}${m.differedBefore ? ' — it already differed before this plan, so it is left alone unless you tick it' : ''}. A ResourceQuota only counts whole-card pods.`
      : m.note;
    items.push(h('div', { class: 'coupled-item' }, box, h('span', {}, h('code', {}, m.file), h('span', { class: 'note' }, what))));
  }
  if (plan.reminders.length) {
    items.push(h('h3', {}, 'Not written by this tool — add to the same PR'));
    items.push(h('ul', { class: 'plain' }, plan.reminders.map((r) => h('li', { class: 'coupled-item' }, h('span', { class: 'empty' }, '•'), h('span', {}, r)))));
  }
  $('coupled').replaceChildren(...items);
  $('coupled-panel').hidden = !items.length;
}
