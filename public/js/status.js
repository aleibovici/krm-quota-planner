import { $ } from './constants.js';
import { h, ask } from './dom.js';
import { ago } from './format.js';
import { api } from './api.js';
import {
  session, edits, pending, fromCluster, clearAdditions,
} from './state.js';
import { closeAddForm } from './add-form.js';
import { banner } from './plan-view.js';
import { hooks } from './hooks.js';

export function renderStatus() {
  const { source, cluster } = session;
  const item = (label, title, ...content) => h('div', { title }, h('dt', {}, label), h('dd', {}, content));
  const dot = (ok) => h('span', { class: `dot ${ok ? 'ok' : 'warn'}` });
  if (fromCluster()) {
    $('status').replaceChildren(
      item('Source', `The live objects on ${source.context}, read ${ago(source.date)}. Nothing is written to the cluster.`, dot(true), 'Live cluster', contextPicker(), `· read-only · ${ago(source.date)}`),
      item('Usage', cluster.ok ? 'Card counts and what each queue holds right now' : cluster.error, dot(cluster.ok), cluster.ok ? 'Card counts and live usage' : 'Not read'));
  } else {
    $('status').replaceChildren(
      item('Current', `${source.subject}${source.fetched.ok ? '' : ` — not fetched: ${source.fetched.error}`}`, dot(source.fetched.ok), h('code', {}, `${source.ref} @ ${source.sha.slice(0, 7)}`),
        `· committed ${ago(source.date)}${source.fetched.ok ? '' : ' · not fetched'}`),
      item('Cluster', cluster.ok ? 'Card counts and live usage come from this cluster. Nothing is written to it.' : cluster.error, dot(cluster.ok),
        ...(cluster.enabled ? [contextPicker(), cluster.ok ? '· read-only' : '· not read'] : ['Not read'])),
      item('Repository', source.repo, h('code', {}, source.repo.split('/').filter(Boolean).at(-1) ?? source.repo)));
  }
  $('download-patch').hidden = fromCluster();
  $('download-tenancy').textContent = fromCluster() ? 'Download planned objects' : 'Download tenancy.yaml';
  document.title = `GPU quota planner — ${source.displayName || source.ref}`;
}

function contextPicker() {
  const { contexts, context } = session.cluster;
  if (contexts.length < 2 && contexts.includes(context)) return h('code', {}, context);
  const names = contexts.includes(context) ? contexts : [context, ...contexts];
  const select = h('select', { id: 'context', name: 'context', 'aria-label': 'Cluster (kubectl context)', title: 'Contexts from your kubeconfig. Choosing one reads that cluster; nothing is written.' },
    names.map((name) => h('option', { value: name }, name || '(none)')));
  select.value = context;
  select.addEventListener('change', () => switchContext(select, context));
  return select;
}

async function switchContext(select, from) {
  const to = select.value;
  const discard = fromCluster() && pending() > 0;
  if (discard && !(await ask(`Switch to ${to}?`, `The ${pending()} change${pending() === 1 ? '' : 's'} planned here ${pending() === 1 ? 'was' : 'were'} made against ${from} and will be discarded.`, 'Discard and switch'))) {
    select.value = from;
    return;
  }
  select.disabled = true;
  banner(`Reading ${to}…`, 'info');
  $('main').classList.add('busy');
  try {
    const data = await api('POST', '/api/context', { context: to });
    if (fromCluster()) {
      edits.clear();
      clearAdditions();
    }
    closeAddForm();
    for (const id of ['dry-run-output', 'apply-output', 'commit-output']) $(id).hidden = true;
    banner('');
    await hooks.draw(data);
  } catch (err) {
    banner(`Still on ${from}: ${err.message}`);
    select.value = from;
    select.disabled = false;
  } finally {
    $('main').classList.remove('busy');
  }
}
