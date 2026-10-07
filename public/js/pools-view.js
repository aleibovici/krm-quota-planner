import { $, UNLIMITED } from './constants.js';
import { h, icon, tip } from './dom.js';
import { show, round, cards } from './format.js';
import { paint } from './sync.js';
import { numberControl } from './controls.js';
import { plan, session, fid, value, fromCluster, setDrawnShape } from './state.js';
import { shapeOf } from '/core/ui-helpers.js';
import { openAddForm, buildAddButtons } from './add-form.js';
import {
  poolShouldOpen, deptShouldOpen, watchDisclosure, applyBrowseFilter, setDeptOpen, reveal,
} from './browse.js';

const isNewObject = (kind, name) => plan.additions.some((a) => !a.error && a.kind === kind && a.name === name);
const isNewQueue = (name) => plan.additions.some((a) => !a.error && a.kind !== 'NodePool' && a.queues.includes(name));
const badge = (yes) => (yes ? h('span', { class: 'new' }, 'new') : null);

const SERIES = 8;
function seriesOf(indexInDept) {
  const key = indexInDept >= 0 && indexInDept < SERIES ? `s${indexInDept + 1}` : 's-other';
  return `--series: var(--${key}); --on-series: var(--on-${key})`;
}

const poolEl = (name) => document.querySelector(`.pool[data-pool="${CSS.escape(name)}"]`);
const deptEl = (queue) => document.querySelector(`.dept[data-dept-dq="${CSS.escape(queue)}"]`);

/** A department or project with a queue on another pool as well: one link per such queue, to where it is drawn. */
function alsoOn(owner, here) {
  return owner.queues.filter((q) => q.name !== here.name).map((q) => h('button', {
    type: 'button',
    class: 'link also',
    title: `Show its queue on ${q.nodepool}: ${q.name}`,
    onclick: (e) => {
      e.stopPropagation();
      const el = document.querySelector(`[data-queue="${CSS.escape(q.name)}"]`);
      if (el) reveal(el);
    },
  }, `also on ${q.nodepool}`));
}

/** What each department on a pool is, and which projects of it have a queue there. */
function departmentsOn(model, poolName) {
  return model.departments.flatMap((dept) => dept.queues.filter((q) => q.nodepool === poolName).map((dq) => ({
    dept,
    dq,
    children: model.projects.filter((p) => p.parent === dept.name)
      .flatMap((project) => project.queues.filter((q) => q.nodepool === poolName).map((q) => ({ project, q })))
      .map((c, i) => ({ ...c, series: seriesOf(i) })),
  })));
}

export function buildPools() {
  const model = plan.model.planned;
  setDrawnShape(shapeOf(model));
  const pools = model.pools.map((pool) => ({ pool, mine: departmentsOn(model, pool.name) }));
  $('overview').replaceChildren(...pools.map(buildOverviewPool));
  $('overview').hidden = !pools.length;
  const root = $('pools');
  root.replaceChildren(...pools.map(({ pool, mine }, index) => buildPool(pool, mine, index, pools.length)));
  applyBrowseFilter();
  if (!model.pools.length) {
    root.append(h('div', { class: 'card' }, h('h2', {}, 'No node pools yet'),
      h('p', { class: 'hint' }, fromCluster() ? `There is no NodePool with queues on ${session.source.context}. Start by adding one below.` : `There is no NodePool in ${session.source.tenancy}. Start by adding one below.`)));
  }
  buildAddButtons();
  paint();
}

/**
 * The pool's cards cut into what each department is guaranteed. The same bar
 * is drawn small in the overview and large on the pool; sync.js fills both.
 */
function poolBar(poolName, mine, { labelled = false } = {}) {
  const track = h('div', { class: 'bar-track' });
  for (const { dept, dq } of mine) {
    const seg = h('div', { class: 'seg', 'data-seg': dq.name }, labelled ? h('span', {}) : null);
    if (labelled) {
      tip(seg, () => [h('div', {}, h('b', {}, cards(Math.max(0, value(fid('Department', dept.name, dq.name, 'gpu', 'deserved')) ?? 0))), ' guaranteed'), h('div', {}, `Department ${dept.name}`)]);
      seg.addEventListener('click', (e) => {
        e.preventDefault();
        const el = deptEl(dq.name);
        if (el) reveal(el.querySelector('.dept-head'));
      });
      seg.addEventListener('pointerenter', () => deptEl(dq.name)?.classList.add('lit'));
      seg.addEventListener('pointerleave', () => deptEl(dq.name)?.classList.remove('lit'));
    }
    track.append(seg);
  }
  track.append(h('div', { class: 'seg free' }, labelled ? h('span', {}) : null));
  return h('div', { class: labelled ? 'bar pool-bar' : 'bar', 'data-bar-pool': poolName },
    track, h('i', { class: 'bar-over', hidden: true }), h('i', { class: 'bar-cap', hidden: true }));
}

function buildOverviewPool({ pool, mine }) {
  return h('button', {
    type: 'button',
    class: 'ov',
    'data-ov': pool.name,
    title: `Show ${pool.name}`,
    onclick: () => { const el = poolEl(pool.name); if (el) reveal(el.querySelector('summary')); },
  },
  h('span', { class: 'ov-top' }, h('b', {}, pool.name), h('span', { class: 'ov-nums' }), h('span', { class: 'ov-state' })),
  poolBar(pool.name, mine));
}

function nodeSummary(live, count) {
  if (count === null) {
    return live ? 'Its nodes report no GPUs right now, so the card count is unknown' : 'Its nodes were not read, so the card count is unknown';
  }
  const list = live.nodes ?? [];
  const headline = `${list.length || 'No'} node${list.length === 1 ? '' : 's'} · ${cards(count)}`;
  const unsettled = live.settled ? '' : ` · ${show(live.allocatable)} schedulable right now`;
  if (list.length > 3) return `${headline}${unsettled}`;
  const names = list.map((n) => `${n.name}${n.product ? ` (${n.product.replaceAll('-', ' ')}${n.memoryMiB ? `, ${Math.round(n.memoryMiB / 1024)} GB` : ''})` : ''}${n.ready ? '' : ' — not ready'}`).join(', ');
  return `${live.settled ? '' : `${show(live.allocatable)} of ${cards(count)} schedulable right now · `}${names || 'no nodes carry this label'}`;
}

function buildPool(pool, mine, index, poolCount) {
  const live = session.cluster.ok ? session.cluster.pools[pool.name] ?? plan.pools[pool.name] : null;
  const count = live && live.cards > 0 ? live.cards : null;

  const details = h('details', {
    class: 'pool',
    'data-pool': pool.name,
    open: poolShouldOpen(pool.name, index, poolCount),
  },
  h('summary', {},
    h('div', { class: 'pool-top' },
      icon('chevron'),
      h('h2', {}, pool.name, badge(isNewObject('NodePool', pool.name))),
      h('span', { class: 'chip', title: 'The node label that puts a node in this pool' }, `${pool.labelKey}=${pool.labelValue}`),
      h('span', { class: 'nodes' }, nodeSummary(live, count)),
      h('span', { class: 'flags pool-flags' })),
    poolBar(pool.name, mine, { labelled: true }),
    h('div', { class: 'bar-use', title: 'Cards in use right now, on the same scale', hidden: true }, h('i', {})),
    h('div', { class: 'facts' })),
  h('div', { class: 'pool-body' },
    h('p', { class: 'callout', 'data-callout': 'pool', hidden: true }),
    mine.length ? mine.map((d) => buildDepartment(pool.name, d.dept, d.dq, d.children, count)) : h('p', { class: 'empty' }, 'No department has a queue on this pool yet.'),
    h('div', { class: 'pool-actions' },
      h('button', { type: 'button', class: 'btn small quiet', onclick: () => openAddForm('Department', { pool: pool.name }) }, icon('plus'), 'Department'))));
  watchDisclosure(details, 'pool', pool.name);
  // The labels on a bar are fitted to its width, which a closed pool does not have.
  details.addEventListener('toggle', () => paint());
  return details;
}

function buildDepartment(poolName, dept, dq, children, count) {
  const id = (field) => fid('Department', dept.name, dq.name, 'gpu', field);
  const childId = (c, field) => fid('Project', c.project.name, c.q.name, 'gpu', field);
  const guaranteed = () => children.reduce((s, c) => s + Math.max(0, value(childId(c, 'deserved')) ?? 0), 0);
  const deptShare = () => {
    const d = value(id('deserved'));
    return d === UNLIMITED || d === null || d === undefined ? count ?? guaranteed() : d;
  };
  const top = () => Math.max(count ?? 0, deptShare(), 1);

  const split = h('div', { class: 'split' });
  const current = (c) => Math.max(0, value(childId(c, 'deserved')) ?? 0);
  for (const c of children) {
    const seg = h('div', { class: 'seg', style: c.series, 'data-seg': c.q.name }, h('span', {}));
    tip(seg, () => [h('div', {}, h('span', { class: 'key' }), h('b', {}, cards(current(c))), ' guaranteed'), h('div', {}, `${c.project.name} · ${c.q.name}`)]);
    split.append(seg);
  }
  const free = h('div', { class: 'seg free' }, h('span', {}));
  tip(free, () => [h('div', {}, h('b', {}, cards(Math.max(0, deptShare() - guaranteed()))), ' not guaranteed to any project'), h('div', {}, 'Shared out by weight when projects want more')]);
  split.append(free);

  const deptKey = `${poolName}/${dept.name}/${dq.name}`;
  const bodyId = `dept-body-${poolName}-${dq.name}`.replace(/[^\w-]+/g, '-');
  const search = [dept.name, dq.name, ...children.map((c) => `${c.project.name} ${c.project.namespace} ${c.q.name}`)].join(' ');
  const toggle = h('button', { type: 'button', class: 'dept-toggle', 'aria-controls': bodyId },
    icon('chevron'), h('span', { class: 'kind' }, 'Department '), dept.name);
  const head = h('div', { class: 'dept-head', 'data-queue': dq.name },
    h('div', { class: 'dept-title' },
      h('h3', {}, toggle),
      badge(isNewObject('Department', dept.name) || isNewQueue(dq.name)),
      h('span', { class: 'flags dept-flags' }),
      h('div', { class: 'sub' }, h('span', { class: 'qname', title: 'The department\'s queue on this pool' }, dq.name), alsoOn(dept, dq))),
    h('div', { class: 'meter', title: 'What the projects are guaranteed, out of what the department has. The inner line is what they hold right now.' },
      h('div', { class: 'meter-bar' }, h('i', { class: 'fill' }), h('i', { class: 'use', hidden: true }), h('i', { class: 'bar-over', hidden: true })),
      h('div', { class: 'meter-text' })),
    h('div', { class: 'controls' },
      numberControl({ id: id('deserved'), label: 'Guaranteed', max: top, title: 'deserved — what the department as a whole is guaranteed on this pool' }),
      numberControl({ id: id('limit'), label: 'Limit', max: top, unlimited: true, title: 'limit — the most the department may ever hold on this pool' })));

  const section = h('section', {
    class: 'dept',
    'data-dept-dq': dq.name,
    'data-pool': dq.nodepool,
    'data-dept': dept.name,
    'data-dept-key': deptKey,
    'data-search': search,
  },
  head,
  h('div', { class: 'dept-body', id: bodyId },
    h('p', { class: 'callout', 'data-callout': 'dept', hidden: true }),
    h('div', { class: 'split-wrap' }, split, h('div', { class: 'ticks' }), h('i', { class: 'bar-over', hidden: true })),
    children.length
      ? h('div', { class: 'rows' },
        h('div', { class: 'row head', 'aria-hidden': 'true' },
          h('span', {}, 'Project'), h('span', {}, 'In use'), h('span', {}, 'Guaranteed'), h('span', {}, 'Limit'),
          h('span', { class: 'advanced' }, 'Weight'), h('span', { class: 'advanced' }, 'Priority')),
        children.map((c) => buildProjectRow(c, top)))
      : h('p', { class: 'empty' }, 'No project of this department has a queue on this pool yet.'),
    h('div', { class: 'dept-tools' },
      h('button', { type: 'button', class: 'btn small quiet', onclick: () => openAddForm('Project', { parent: dept.name, pool: dq.nodepool }) }, icon('plus'), 'Project'))));

  setDeptOpen(section, deptShouldOpen(deptKey, children.length), { remember: false });
  // The whole header opens the department, except where it is being edited.
  head.addEventListener('click', (e) => {
    if (e.target.closest('.controls')) return;
    setDeptOpen(section, !section.classList.contains('open'));
    paint();
  });
  const light = (on) => () => document.querySelectorAll(`.pool-bar [data-seg="${CSS.escape(dq.name)}"]`).forEach((seg) => seg.classList.toggle('lit', on));
  head.addEventListener('pointerenter', light(true));
  head.addEventListener('pointerleave', light(false));
  return section;
}

function buildProjectRow({ project, q, series }, top) {
  const id = (...rest) => fid('Project', project.name, q.name, ...rest);
  const live = session.cluster.ok ? session.cluster.queues[q.name] : null;
  const des = h('div', { class: 'des' });
  const lim = h('div', { class: 'lim' });
  const use = live ? h('span', { class: 'use' }) : null;
  const text = h('span', { class: 'text' });
  const gauge = h('div', { class: 'gauge-wrap' }, h('div', { class: 'gauge' }, lim, des), use);
  const flag = h('span', { class: 'row-flag', hidden: true });
  const cell = (control) => h('div', { class: 'cell' }, control);
  const other = otherResources(q);
  const where = [q.name, project.namespace === project.name ? null : `namespace ${project.namespace}`, other.open ? null : other.text].filter(Boolean).join(' · ');
  const row = h('div', {
    class: 'row',
    'data-queue': q.name,
    'data-search': `${project.name} ${project.namespace} ${q.name}`,
    style: series,
  },
    h('div', { class: 'who' },
      h('span', { class: 'name' }, h('span', { class: 'swatch' }), h('span', { class: 'nm' }, project.name), badge(isNewObject('Project', project.name) || isNewQueue(q.name)), flag),
      h('div', { class: 'sub' }, h('span', { class: 'qname', title: `Queue ${q.name} · namespace ${project.namespace} · ${other.text}` }, where), alsoOn(project, q))),
    h('div', { class: 'cell usage' }, gauge, text),
    cell(numberControl({ id: id('gpu', 'deserved'), label: 'Guaranteed', slider: true, max: top, title: 'deserved — cards this project always gets, even when others want them' })),
    cell(numberControl({ id: id('gpu', 'limit'), label: 'Limit', slider: true, max: top, unlimited: true, title: 'limit — the most it may hold when cards are idle; anything above the guarantee can be reclaimed' })),
    h('div', { class: 'cell advanced' }, numberControl({ id: id('gpu', 'overQuotaWeight'), label: 'Weight', title: 'overQuotaWeight — its share of idle cards relative to the other projects' })),
    h('div', { class: 'cell advanced' }, numberControl({ id: id('priority'), label: 'Priority', integer: true, title: 'queue priority — which queue is served first when several are waiting' })));

  const now = () => ({ d: Math.max(0, value(id('gpu', 'deserved')) ?? 0), l: value(id('gpu', 'limit')) });
  tip(gauge, () => {
    const { d, l } = now();
    return [h('div', {}, h('span', { class: 'key' }), h('b', {}, cards(d)), ' guaranteed'), h('div', {}, h('b', {}, l === UNLIMITED ? 'No' : cards(l)), ' limit'),
      live ? h('div', {}, h('b', {}, cards(round(live.allocatedGpu))), ' in use right now') : null].filter(Boolean);
  });
  // What the checks say about this queue; sync.js keeps the list on the row.
  tip(flag, () => (row._issues ?? []).map((message) => h('div', {}, message)));
  const lightSeg = (on) => () => row.closest('.dept')?.querySelector(`.split [data-seg="${CSS.escape(q.name)}"]`)?.classList.toggle('lit', on);
  row.addEventListener('pointerenter', lightSeg(true));
  row.addEventListener('pointerleave', lightSeg(false));
  return row;
}

function otherResources(q) {
  const { cpu, memory } = q.resources;
  const open = (r) => !r || (r.deserved === UNLIMITED && r.limit === UNLIMITED);
  if (open(cpu) && open(memory)) return { open: true, text: 'CPU and memory unlimited' };
  const pair = (r, unit) => (r ? `${show(r.deserved)}/${show(r.limit)} ${unit}` : 'not set');
  return { open: false, text: `CPU ${pair(cpu, 'mCPU')} · memory ${pair(memory, 'MB')} (guaranteed/limit — not editable here)` };
}
