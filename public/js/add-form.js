import { $, UNLIMITED } from './constants.js';
import { h, icon } from './dom.js';
import { api } from './api.js';
import {
  plan, additions, payload, pushAddition, setAdditions, setPlan, bumpPlanSeq,
} from './state.js';
import { queueSuffix, cascadeRemoveAdditions } from '/core/ui-helpers.js';
import { hooks } from './hooks.js';

export function closeAddForm() {
  if ($('add-dialog').open) $('add-dialog').close();
  $('add-form').replaceChildren();
}

export function removeAddition(index) {
  setAdditions(cascadeRemoveAdditions(additions, index));
  hooks.replan();
}

export function buildAddButtons() {
  const m = plan.model.planned;
  const owners = [...m.departments, ...m.projects];
  const kinds = [
    ['Department', 'Department', m.pools.length ? '' : 'Add a node pool first: a department is a guarantee on a pool'],
    ['Project', 'Project', m.departments.length ? '' : 'Add a department first: a project belongs to one'],
    ['Queue', 'Queue on another pool', owners.some((o) => m.pools.some((p) => !o.queues.some((q) => q.nodepool === p.name))) ? '' : 'Every department and project already has a queue on every pool'],
    ['NodePool', 'Node pool', ''],
  ];
  $('add-kinds').replaceChildren(...kinds.map(([kind, label, why]) =>
    h('button', { type: 'button', class: 'btn', 'data-add': kind, disabled: Boolean(why), title: why, onclick: () => openAddForm(kind) }, icon('plus'), label)));
}

/** @param {ReturnType<typeof formKit>} kit */
const ADD_SPECS = {
  NodePool: (kit) => {
    const keys = kit.m.pools.map((p) => p.labelKey).filter(Boolean);
    const name = kit.input('name', { required: true, placeholder: 'h200' });
    const labelValue = kit.input('labelValue', { required: true });
    const sync = [kit.follow(labelValue, () => name.value)];
    name.addEventListener('input', () => sync.forEach((s) => s()));
    return {
      title: 'New node pool',
      note: 'A pool is whole nodes, picked by one label pair that cannot be changed afterwards. It does nothing until a department has a queue on it — add that next.',
      fields: [
        kit.field('Name', name),
        kit.field('Node label key', kit.input('labelKey', { required: true, value: keys[0] ?? '', placeholder: 'example.com/gpu-class' })),
        kit.field('Node label value', labelValue, 'the pool is every node carrying this label'),
      ],
      sync,
      make: (f) => ({ kind: 'NodePool', name: f.name.value.trim(), labelKey: f.labelKey.value.trim(), labelValue: f.labelValue.value.trim() }),
    };
  },
  Department: (kit) => {
    const name = kit.input('name', { required: true });
    const pool = kit.select('pool', kit.m.pools.map((p) => [p.name, p.name]));
    const queue = kit.input('queue', { required: true });
    const sync = [kit.follow(queue, () => (name.value ? `${name.value}-${queueSuffix(kit.m, pool.value)}` : ''))];
    for (const el of [name, pool]) el.addEventListener('input', () => sync.forEach((s) => s()));
    return {
      title: 'New department',
      note: 'A department holds the guarantee on a pool; its projects share it out. More pools can be added to it afterwards.',
      fields: [kit.field('Name', name), kit.field('Node pool', pool), kit.field('Queue name', queue, 'unique across the cluster'), ...kit.quota()],
      sync,
      make: (f) => ({ kind: 'Department', name: f.name.value.trim(), queues: [kit.queueOf(f, f.queue.value.trim(), f.pool.value, false)] }),
    };
  },
  Project: (kit) => {
    const name = kit.input('name', { required: true });
    const namespace = kit.input('namespace', { required: true });
    const parent = kit.select('parent', kit.m.departments.map((d) => [d.name, d.name]));
    const pool = kit.select('pool', []);
    const queue = kit.input('queue', { required: true });
    const enforce = kit.select('enforce', [['', 'not set (KRM decides)'], ['false', 'no — only pods that ask for it'], ['true', 'yes — every pod in the namespace']]);
    const pickPools = () => kit.fill(pool, kit.poolsOf(kit.m.departments.find((d) => d.name === parent.value)).map((p) => [p.name, p.name]));
    const likeSiblings = () => {
      const set = new Set(kit.m.projects.filter((p) => p.parent === parent.value).map((p) => p.enforceKaiScheduler));
      return set.size === 1 && typeof [...set][0] === 'boolean' ? String([...set][0]) : '';
    };
    const sync = [kit.follow(namespace, () => name.value), kit.follow(queue, () => (name.value && pool.value ? `${name.value}-${queueSuffix(kit.m, pool.value)}` : '')), kit.follow(enforce, likeSiblings)];
    parent.addEventListener('input', () => { pickPools(); sync.forEach((s) => s()); });
    for (const el of [name, pool]) el.addEventListener('input', () => sync.forEach((s) => s()));
    pickPools();
    return {
      title: 'New project',
      note: 'Its guarantee comes out of the department\'s share on that pool. The namespace is not created or labelled by this tool — the checks say what it needs.',
      fields: [
        kit.field('Name', name),
        kit.field('Namespace', namespace, 'the namespace this project governs'),
        kit.field('Department', parent),
        kit.field('Node pool', pool, 'pools its department has a queue on'),
        kit.field('Queue name', queue, 'unique across the cluster'),
        ...kit.quota(),
        kit.field('Queue priority', h('input', { type: 'number', name: 'priority', step: '1', placeholder: 'not set' }), 'empty = leave it to KRM'),
        kit.field('KAI scheduler enforced', enforce, 'pre-filled when the department\'s projects agree'),
      ],
      sync,
      make: (f) => ({
        kind: 'Project',
        name: f.name.value.trim(),
        namespace: f.namespace.value.trim(),
        parent: f.parent.value,
        ...(f.enforce.value ? { enforceKaiScheduler: f.enforce.value === 'true' } : {}),
        queues: [kit.queueOf(f, f.queue.value.trim(), f.pool.value, true)],
      }),
    };
  },
  Queue: (kit) => {
    const free = (o) => kit.m.pools.filter((p) => !o.queues.some((q) => q.nodepool === p.name));
    const owners = [...kit.m.departments.map((d) => ['Department', d]), ...kit.m.projects.map((p) => ['Project', p])].filter(([, o]) => free(o).length);
    const owner = kit.select('owner', owners.map(([k, o]) => [`${k}/${o.name}`, `${k} ${o.name}`]));
    const pool = kit.select('pool', []);
    const queue = kit.input('queue', { required: true });
    const priority = h('input', { type: 'number', name: 'priority', step: '1', placeholder: 'not set' });
    const priorityField = kit.field('Queue priority', priority, 'empty = leave it to KRM');
    const chosen = () => owners.find(([k, o]) => `${k}/${o.name}` === owner.value) ?? [];
    const pick = () => {
      const [k, o] = chosen();
      kit.fill(pool, o ? free(o).map((p) => [p.name, p.name]) : []);
      priorityField.hidden = k !== 'Project';
    };
    const sync = [kit.follow(queue, () => (chosen()[1] && pool.value ? `${chosen()[1].name}-${queueSuffix(kit.m, pool.value)}` : ''))];
    owner.addEventListener('input', () => { pick(); sync.forEach((s) => s()); });
    pool.addEventListener('input', () => sync.forEach((s) => s()));
    pick();
    return {
      title: 'One more queue, on another pool',
      note: 'KRM allows one queue per pool in a department or a project. Give the department its queue on a pool before its projects.',
      fields: [kit.field('For', owner), kit.field('Node pool', pool, 'pools it has no queue on yet'), kit.field('Queue name', queue, 'unique across the cluster'), ...kit.quota(), priorityField],
      sync,
      make: (f) => {
        const [ownerKind, o] = chosen();
        return { kind: 'Queue', ownerKind, owner: o.name, queue: kit.queueOf(f, f.queue.value.trim(), f.pool.value, ownerKind === 'Project') };
      },
    };
  },
};

function formKit(m) {
  const input = (name, attrs = {}) => h('input', { type: 'text', name, spellcheck: 'false', ...attrs });
  const number = (name, attrs = {}) => h('input', { type: 'number', name, step: 'any', min: '0', ...attrs });
  const select = (name, options) => h('select', { name }, options.map(([v, text]) => h('option', { value: v }, text)));
  const field = (label, control, hint) => h('label', { class: 'field' }, label, control, hint ? h('small', {}, hint) : null);
  const fill = (el, options) => el.replaceChildren(...options.map(([v, text]) => h('option', { value: v }, text)));
  const follow = (el, compute) => {
    let typed = false;
    el.addEventListener('input', () => { typed = true; });
    return () => { if (!typed) el.value = compute(); };
  };
  const poolsOf = (owner) => m.pools.filter((p) => owner?.queues.some((q) => q.nodepool === p.name));
  const quota = () => [
    field('Guaranteed (cards)', number('deserved', { value: '0', required: true })),
    field('Limit (cards)', number('limit', { placeholder: 'unlimited' }), 'empty = unlimited'),
  ];
  const queueOf = (f, name, pool, withPriority) => ({
    name,
    nodepool: pool,
    ...(withPriority && f.priority.value.trim() !== '' ? { priority: Number(f.priority.value) } : {}),
    gpu: { deserved: Number(f.deserved.value), limit: f.limit.value.trim() === '' ? UNLIMITED : Number(f.limit.value), overQuotaWeight: 1 },
  });
  return { m, input, number, select, field, fill, follow, poolsOf, quota, queueOf };
}

export function openAddForm(kind, preset = {}) {
  const spec = ADD_SPECS[kind] ?? ADD_SPECS.Queue;
  const built = spec(formKit(plan.model.planned));
  const form = $('add-form');
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary' }, 'Add to the plan');
  form.replaceChildren(h('h2', {}, built.title), h('p', { class: 'hint' }, built.note), h('div', { class: 'add-grid' }, built.fields), error,
    h('div', { class: 'actions end' }, h('button', { type: 'button', class: 'btn', onclick: closeAddForm }, 'Cancel'), submit));
  built.sync.forEach((s) => s());
  for (const [name, v] of Object.entries(preset)) {
    const el = form.elements[name];
    if (!el || ![...(el.options ?? [{ value: v }])].some((o) => o.value === v)) continue;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  $('add-dialog').showModal();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const addition = built.make(form.elements);
    submit.disabled = true;
    try {
      const next = await api('POST', '/api/plan', payload([addition]));
      const mine = next.additions.at(-1);
      if (mine.error) {
        error.textContent = mine.error;
        error.hidden = false;
        return;
      }
      pushAddition(addition);
      setPlan(next);
      bumpPlanSeq();
      closeAddForm();
      hooks.afterStructuralChange();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  };
  form.querySelector('input, select')?.focus();
}
