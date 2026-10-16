// Which node pools a project is on, as one tick box per pool. Ticking a pool
// adds a queue there (a Queue addition, like "Queue on another pool" makes);
// unticking a pool that was only planned takes that addition back. A queue
// that is in the source stays ticked: this tool adds, it does not delete.

import { $, UNLIMITED } from './constants.js';
import { h } from './dom.js';
import { api } from './api.js';
import {
  plan, additions, payload, setAdditions, setPlan, bumpPlanSeq,
} from './state.js';
import { queueSuffix, poolChoices, cascadeRemoveAdditions } from '/core/ui-helpers.js';
import { closeAddForm } from './add-form.js';
import { hooks } from './hooks.js';
import { reveal } from './browse.js';

export function openPoolPicker(ownerKind, ownerName) {
  const m = plan.model.planned;
  const owner = (ownerKind === 'Project' ? m.projects : m.departments).find((o) => o.name === ownerName);
  if (!owner) return;
  const choices = poolChoices(m, additions, ownerKind, owner);
  const form = $('add-form');
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Update the plan');

  const rows = choices.map((c) => {
    const box = h('input', { type: 'checkbox', name: `pool/${c.pool.name}`, 'aria-label': `${ownerName} on ${c.pool.name}` });
    box.checked = c.state !== 'free' && c.state !== 'blocked';
    box.disabled = c.state === 'source' || c.state === 'first' || c.state === 'blocked';
    const detail = h('div', { class: 'pick-detail' });
    const inputs = c.state === 'free' ? {
      queue: h('input', { type: 'text', name: `queue/${c.pool.name}`, spellcheck: 'false', 'aria-label': `queue name on ${c.pool.name}`, value: `${ownerName}-${queueSuffix(m, c.pool.name)}` }),
      deserved: h('input', { type: 'number', name: `deserved/${c.pool.name}`, step: 'any', min: '0', value: '0', 'aria-label': `guaranteed cards on ${c.pool.name}` }),
      limit: h('input', { type: 'number', name: `limit/${c.pool.name}`, step: 'any', min: '0', placeholder: 'unlimited', 'aria-label': `limit on ${c.pool.name}` }),
    } : null;
    const sync = () => {
      if (c.state === 'free') {
        detail.replaceChildren(box.checked
          ? h('div', { class: 'pick-fields' },
            h('label', { class: 'field' }, 'Queue name', inputs.queue),
            h('label', { class: 'field' }, 'Guaranteed (cards)', inputs.deserved),
            h('label', { class: 'field' }, 'Limit (cards)', inputs.limit, h('small', {}, 'empty = unlimited')))
          : h('span', { class: 'note' }, 'not on this pool'));
        inputs.queue.required = box.checked;
        inputs.deserved.required = box.checked;
      } else if (c.state === 'added') {
        detail.replaceChildren(h('span', { class: 'note' }, box.checked ? `${c.queue.name} — planned, not yet applied` : `${c.queue.name} will be taken out of the plan`));
      } else {
        detail.replaceChildren(h('span', { class: 'note' }, c.why));
      }
    };
    box.addEventListener('change', sync);
    sync();
    return { c, box, inputs, el: h('label', { class: 'pick-row', 'data-pick': c.pool.name }, box, h('span', { class: 'pick-body' }, h('b', {}, c.pool.name), detail)) };
  });

  form.replaceChildren(
    h('h2', {}, `Node pools of ${ownerKind.toLowerCase()} ${ownerName}`),
    h('p', { class: 'hint' }, ownerKind === 'Project'
      ? 'A project has one queue per pool, on pools its department has a queue on. Tick a pool to give it a queue there; the numbers can be moved with the sliders afterwards.'
      : 'A department has one queue per pool. Tick a pool to give it a queue there; the numbers can be moved with the sliders afterwards.'),
    h('div', { class: 'pick-list' }, rows.map((r) => r.el)),
    error,
    h('div', { class: 'actions end' }, h('button', { type: 'button', class: 'btn', onclick: closeAddForm }, 'Cancel'), submit));
  $('add-dialog').showModal();

  form.onsubmit = async (event) => {
    event.preventDefault();
    const dropped = rows.filter((r) => r.c.state === 'added' && !r.box.checked).map((r) => r.c.index);
    let kept = [...additions];
    for (const index of [...dropped].sort((a, b) => b - a)) kept = cascadeRemoveAdditions(kept, index);
    const fresh = rows.filter((r) => r.c.state === 'free' && r.box.checked).map((r) => ({
      kind: 'Queue',
      ownerKind,
      owner: ownerName,
      queue: {
        name: r.inputs.queue.value.trim(),
        nodepool: r.c.pool.name,
        gpu: { deserved: Number(r.inputs.deserved.value), limit: r.inputs.limit.value.trim() === '' ? UNLIMITED : Number(r.inputs.limit.value), overQuotaWeight: 1 },
      },
    }));
    if (!dropped.length && !fresh.length) { closeAddForm(); return; }
    const next = [...kept, ...fresh];
    submit.disabled = true;
    try {
      const result = await api('POST', '/api/plan', { ...payload(), additions: next });
      const failed = result.additions.slice(kept.length).find((a) => a.error);
      if (failed) {
        error.textContent = failed.error;
        error.hidden = false;
        return;
      }
      setAdditions(next);
      setPlan(result);
      bumpPlanSeq();
      closeAddForm();
      hooks.afterStructuralChange();
      const first = fresh[0] && document.querySelector(`[data-queue="${CSS.escape(fresh[0].queue.name)}"]`);
      if (first) reveal(first);
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  };
  form.querySelector('input:not(:disabled)')?.focus();
}
