import { $ } from './constants.js';
import { h, icon } from './dom.js';
import { api } from './api.js';
import { paint } from './sync.js';
import { setEdit } from './controls.js';
import {
  session, plan, edits, typed, payload, pending, fromCluster,
  setSession, baseValue, clearAdditions,
} from './state.js';
import { buildPools } from './pools-view.js';
import { removeAddition } from './add-form.js';
import { renderStatus } from './status.js';
import { banner, replan, renderPlan } from './plan-view.js';
import { hooks } from './hooks.js';

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function flash(button, work) {
  const label = [...button.childNodes];
  button.disabled = true;
  try {
    await work();
    button.replaceChildren(icon('check'), 'Done');
  } catch (err) {
    banner(err.message);
    window.scrollTo({ top: 0 });
  }
  button.disabled = false;
  setTimeout(() => button.replaceChildren(...label), 1200);
}

export async function draw(data) {
  setSession(data);
  for (const id of [...edits.keys()]) if (baseValue(id) === undefined || baseValue(id) === edits.get(id)) edits.delete(id);
  renderStatus();
  buildPools();
  if (pending()) await replan();
  else renderPlan();
}

async function open(method = 'GET', path = '/api/state') {
  $('main').classList.add('busy');
  try {
    await draw(await api(method, path));
  } finally {
    $('main').classList.remove('busy');
  }
}

const baseTag = () => session.source.sha.slice(0, 7);
async function movedSince() {
  const fresh = await api('POST', '/api/fresh');
  return fresh.moved ? fresh.message : '';
}

export function initActions() {
  hooks.draw = draw;
  hooks.afterStructuralChange = () => { buildPools(); renderPlan(); };
  hooks.replan = replan;
  hooks.removeAddition = removeAddition;
  hooks.undoChange = (id) => setEdit(id, baseValue(id));

  $('reload').addEventListener('click', (e) => flash(e.currentTarget, () => open('POST', '/api/reload')));
  $('reset-all').addEventListener('click', () => {
    edits.clear();
    clearAdditions();
    paint();
    replan();
  });

  $('copy-diff').addEventListener('click', (e) => flash(e.currentTarget, async () => {
    const moved = await movedSince();
    await navigator.clipboard.writeText(plan.diff);
    banner(moved ? `Copied, but note: ${moved}. The checks did not see the newer commit.` : '');
  }));
  $('download-patch').addEventListener('click', (e) => flash(e.currentTarget, async () => {
    const moved = await movedSince();
    download(`${plan.branch.replaceAll('/', '-') || 'quota'}@${baseTag()}.patch`, plan.diff);
    banner(moved ? `Downloaded, but note: ${moved}. The checks did not see the newer commit.` : '');
  }));
  $('download-tenancy').addEventListener('click', (e) => flash(e.currentTarget, async () => {
    const moved = await movedSince();
    if (moved) throw new Error(`Not downloaded: ${moved}. A whole file from the old base would overwrite what landed since.`);
    const file = plan.files.find((f) => f.role === 'tenancy');
    if (file) download(`${fromCluster() ? `krm-${session.source.context.replace(/[^\w.-]+/g, '-')}` : 'tenancy'}@${baseTag()}.yaml`, file.content);
    banner('');
  }));
  $('message').addEventListener('input', () => { typed.message = $('message').value !== plan.message; });
  $('branch').addEventListener('input', () => { typed.branch = $('branch').value !== plan.branch; });

  $('dry-run').addEventListener('click', async () => {
    const out = $('dry-run-output');
    out.hidden = false;
    out.className = 'output';
    out.textContent = 'asking…';
    try {
      const r = await api('POST', '/api/dry-run', payload());
      const waived = r.dependent.length > 0;
      out.classList.toggle('bad', !r.ok && !waived);
      const verdict = r.ok ? 'Accepted' : waived ? 'Accepted, except for what refers to something this plan adds,' : 'Rejected';
      const why = waived ? '\nA dry-run stores nothing, so the API server cannot see a pool or department this plan adds when it looks at what refers to it. The refusals below are all of that kind and are expected: they go away once the new object exists.\n' : '';
      out.textContent = `${verdict} by ${r.context} (dry-run, nothing stored)\n${why}\n${r.lines.join('\n')}`;
    } catch (err) {
      out.classList.add('bad');
      out.textContent = err.message;
    }
  });

  $('apply').addEventListener('click', async () => {
    const out = $('apply-output');
    $('apply-dialog').showModal();
    out.hidden = false;
    out.className = 'output';
    out.textContent = 'checking the cluster…';
    try {
      const r = await api('POST', '/api/apply', payload());
      const commands = r.commands.join('\n');
      const copy = (text) => (e) => flash(e.currentTarget, () => navigator.clipboard.writeText(text));
      const about = (command) => {
        const patch = / patch (\w+?)s\.kai\.resources (\S+)/.exec(command);
        if (patch) return `Change ${patch[1]} ${patch[2]}`;
        const kind = /^kind: (\w+)$/m.exec(command)?.[1] ?? 'object';
        return `Create ${kind === 'NodePool' ? 'node pool' : kind.toLowerCase()} ${/^  name: (\S+)$/m.exec(command)?.[1] ?? ''}`;
      };
      out.replaceChildren(
        h('p', {}, `${r.commands.length} command${r.commands.length === 1 ? '' : 's'} for `, h('code', {}, r.context), '. Nothing has been changed yet — run them yourself, in this order.'),
        h('ol', { class: 'steps' }, r.commands.map((command, i) => h('li', {},
          h('div', { class: 'step-head' }, h('span', { class: 'n' }, String(i + 1)), h('strong', {}, about(command)),
            h('button', { type: 'button', class: 'btn small quiet', onclick: copy(command) }, 'Copy')),
          h('pre', {}, command)))),
        h('p', { class: 'hint' }, 'What a later command relies on comes first, and objects that give cards up come before objects that gain them. If kubectl answers "The request is invalid" or "already exists", something changed after this page read it — press Reload and look again.'),
        h('div', { class: 'actions end' }, h('button', { type: 'button', class: 'btn primary', onclick: copy(commands) }, 'Copy all commands')));
    } catch (err) {
      out.classList.add('bad');
      out.textContent = err.message;
    }
  });

  $('commit').addEventListener('click', async () => {
    const out = $('commit-output');
    out.hidden = false;
    out.className = 'output';
    out.textContent = 'creating…';
    try {
      const r = await api('POST', '/api/commit', { ...payload(), message: $('message').value, branch: $('branch').value });
      const push = `git -C ${r.repo} push -u origin ${r.branch}`;
      const commands = `${push}\ncd ${r.repo} && gh pr create --head ${r.branch} --fill`;
      out.replaceChildren(
        h('p', {}, 'Branch ', h('code', {}, r.branch), ' created at ', h('code', {}, r.sha.slice(0, 7)), ` on top of ${r.base.ref} (${r.base.sha.slice(0, 7)}). ${r.files.length} file${r.files.length === 1 ? '' : 's'}; nothing checked out, nothing pushed.`),
        h('p', {}, 'To publish it:'),
        h('pre', {}, commands),
        h('div', { class: 'actions end' }, h('button', { type: 'button', class: 'btn primary', onclick: (e) => flash(e.currentTarget, () => navigator.clipboard.writeText(commands)) }, 'Copy commands')));
    } catch (err) {
      out.classList.add('bad');
      out.textContent = err.message;
    }
  });

  open().catch((err) => banner(`Could not load: ${err.message}`));
}
