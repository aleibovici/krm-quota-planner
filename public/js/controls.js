import { UNLIMITED, GPU_STEP } from './constants.js';
import { h } from './dom.js';
import {
  value, baseValue, edits, addedField,
} from './state.js';
import { paint } from './sync.js';

let replanFn = () => {};
let planTimer = 0;

export function bindReplan(fn) {
  replanFn = fn;
}

export function setEdit(id, v) {
  const added = addedField(id);
  if (added) added.set(v);
  else if (v === baseValue(id)) edits.delete(id);
  else edits.set(id, v);
  paint();
  clearTimeout(planTimer);
  planTimer = setTimeout(replanFn, 120);
}

export function numberControl({ id, label, slider = false, max = () => 8, unlimited = false, integer = false, title = '' }) {
  const isNew = addedField(id) !== null;
  if (baseValue(id) === undefined && !isNew) return null;
  const start = isNew ? value(id) : baseValue(id);
  let lastFinite = start !== UNLIMITED && start !== null ? start : null;

  const number = h('input', { type: 'number', name: id, step: integer ? '1' : 'any', min: integer ? null : '0', 'aria-label': `${label} for ${id.split('/')[2]}` });
  const range = slider ? h('input', { type: 'range', name: `${id}/slider`, min: '0', step: String(GPU_STEP), 'aria-label': `${label} slider for ${id.split('/')[2]}` }) : null;
  const box = unlimited ? h('input', { type: 'checkbox', name: `${id}/unlimited` }) : null;
  const was = h('span', { class: 'was' });
  const wrap = h('div', { class: 'ctl', title,
    'data-field-id': id,
    'data-is-new': isNew ? '1' : '0',
    'data-base-value': String(start ?? ''),
    'data-max-default': '8',
  }, h('span', { class: 'lbl' }, label),
  h('div', { class: 'inputs' }, range, number, box && h('label', { class: 'inf', title: 'No limit' }, box, h('span', { 'aria-hidden': 'true' }, '∞'), h('span', { class: 'sr' }, 'unlimited'))),
  was);

  wrap._maxFn = max;

  const commit = (v) => {
    if (!Number.isFinite(v)) return;
    if (v !== UNLIMITED) lastFinite = v;
    setEdit(id, v);
  };
  number.addEventListener('input', () => commit(number.value.trim() === '' ? NaN : Number(number.value)));
  range?.addEventListener('input', () => commit(Number(range.value)));
  box?.addEventListener('change', () => commit(box.checked ? UNLIMITED : lastFinite ?? max()));

  return wrap;
}
