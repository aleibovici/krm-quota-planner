import { UNLIMITED } from './constants.js';
import { h, icon } from './dom.js';
import { round, show, cards } from './format.js';
import { buildDisplay } from '/core/display.js';
import {
  value, baseValue, edits, plan, session, fid,
} from './state.js';

export function paint() {
  if (!plan) return;
  syncControls();
  applyDisplay(liveDisplay());
}

function liveDisplay() {
  const capacity = {};
  for (const pool of plan.model.planned.pools) {
    const live = session.cluster.ok ? session.cluster.pools[pool.name] ?? plan.pools[pool.name] : plan.pools[pool.name];
    if (live?.cards > 0) capacity[pool.name] = { cards: live.cards };
  }
  const liveRead = session.cluster.ok;
  const live = liveRead ? session.cluster.queues : {};
  return buildDisplay(plan.model.planned, { capacity, live, extraPools: plan.pools, liveRead }, value);
}

function syncControls() {
  for (const wrap of document.querySelectorAll('.ctl')) {
    const id = wrap.dataset.fieldId;
    if (!id) continue;
    const isNew = wrap.dataset.isNew === '1';
    const start = Number(wrap.dataset.baseValue);
    const number = wrap.querySelector(`input[type=number][name="${CSS.escape(id)}"]`);
    const range = wrap.querySelector(`input[type=range][name="${CSS.escape(id)}/slider"]`);
    const box = wrap.querySelector(`input[type=checkbox][name="${CSS.escape(id)}/unlimited"]`);
    const was = wrap.querySelector('.was');
    const unlimited = Boolean(box);
    const max = () => Number(wrap.dataset.maxFn ? wrap._maxFn?.() : wrap.dataset.maxDefault) || 8;

    const v = value(id);
    const open = unlimited && v === UNLIMITED;
    if (number) {
      number.disabled = open;
      number.placeholder = open ? '∞' : '';
      if (document.activeElement !== number) number.value = open || v === null ? '' : String(v);
    }
    if (range) {
      range.disabled = open;
      range.max = String(Math.max(max(), open || v === null ? 0 : v, 1));
      if (document.activeElement !== range) range.value = open || v === null ? range.max : String(v);
      range.style.setProperty('--fill', `${(Number(range.value) / Number(range.max)) * 100}%`);
    }
    if (box) box.checked = open;
    wrap.classList.toggle('changed', !isNew && edits.has(id));
    if (was) was.textContent = !isNew && edits.has(id) ? `was ${show(start)}` : '';
  }
}

/**
 * What the checks found, by where it shows. The plan is a moment behind a
 * moving slider; the over/under colours come from the display, which is not.
 */
function issueIndex() {
  const queues = new Map();
  const pools = new Map();
  for (const f of plan.findings) {
    if (f.level !== 'error' && f.level !== 'warning') continue;
    if (f.queue) {
      const at = queues.get(f.queue) ?? { error: [], warning: [] };
      at[f.level].push(f.message);
      queues.set(f.queue, at);
    }
    if (f.pool) {
      const at = pools.get(f.pool) ?? { error: 0, warning: 0 };
      at[f.level] += 1;
      pools.set(f.pool, at);
    }
  }
  return { queues, pools };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const flag = (tone, text, title) => h('span', { class: `flag ${tone}`, title }, tone === 'bad' ? icon('error') : tone === 'warn' ? icon('warning') : null, text);
const fact = (label, n, of, over) => h('span', { class: over ? 'over' : '' }, over ? icon('warning') : null, `${label} `, h('b', {}, n), of ? ` ${of}` : '');

function poolState(p) {
  if (p.cards === null) return ['', 'Size unknown', 'The nodes of this pool were not read, so nothing can be checked against its size'];
  if (p.overDepts) return ['bad', `${show(p.over)} over`, `Departments are guaranteed ${cards(p.promised)}; the pool has ${cards(p.cards)}`];
  if (p.spare > 0) return ['', `${show(p.spare)} spare`, `${cards(p.spare)} not guaranteed to any department`];
  return ['ok', 'Fully guaranteed', 'Every card is guaranteed to a department, and no more than that'];
}

/** @param {ReturnType<typeof buildDisplay>} display */
function applyDisplay(display) {
  const issues = issueIndex();
  const troubled = new Set();
  // "Only issues" keeps what it showed until it is switched off: a department
  // must not vanish from under the cursor the moment the number being typed fits.
  const keep = (el, hasIssue) => {
    el.classList.toggle('has-issue', hasIssue);
    if (hasIssue && document.body.classList.contains('only-issues')) el.classList.add('issue-kept');
  };
  /** Department queue -> something in it does not fit; its segment on the pool's bar says so. */
  const broken = new Set();

  for (const section of document.querySelectorAll('.dept[data-dept-dq]')) {
    const d = display.departments[section.dataset.deptDq];
    if (!d) continue;
    const pool = display.pools[d.pool];
    const open = section.classList.contains('open');

    // --- the header: always on screen, so it carries the verdict ---
    const rows = [...section.querySelectorAll('.row[data-queue]')];
    const below = { error: 0, warning: 0 };
    for (const row of rows) {
      const at = issues.queues.get(row.dataset.queue);
      below.error += at?.error.length ?? 0;
      below.warning += at?.warning.length ?? 0;
    }
    const own = issues.queues.get(section.dataset.deptDq);
    section.querySelector('.dept-flags').replaceChildren(...[
      d.overHanded ? flag('bad', `${show(d.over)} over`, `Its projects are guaranteed ${cards(d.sum)}; the department has ${cards(d.share)}`) : null,
      d.overPool ? flag('bad', 'bigger than the pool', `It is guaranteed ${cards(d.share)}; the pool has ${cards(pool.cards)}`) : null,
      pool?.overDepts && !d.overPool ? flag('warn', 'pool over', `The pool is promised ${cards(pool.over)} more than it holds, so this guarantee cannot be relied on`) : null,
      own?.error.length && !d.overHanded ? flag('bad', plural(own.error.length, 'error'), own.error.join('\n')) : null,
      own?.warning.length && !own.error.length ? flag('warn', plural(own.warning.length, 'warning'), own.warning.join('\n')) : null,
      below.error ? flag('bad', plural(below.error, 'project error'), 'Open the department to see which projects') : null,
      !below.error && below.warning ? flag('warn', plural(below.warning, 'project warning'), 'Open the department to see which projects') : null,
    ].filter(Boolean));
    const hasIssue = d.overHanded || d.overPool || Boolean(pool?.overDepts) || below.error + below.warning > 0 || Boolean(own);
    keep(section, hasIssue);
    section.classList.toggle('over', d.overHanded || d.overPool);
    if (hasIssue) troubled.add(d.pool);
    if (d.overHanded || d.overPool || below.error || own?.error.length) broken.add(section.dataset.deptDq);

    const meter = section.querySelector('.meter');
    if (meter) {
      meter.querySelector('.fill').style.width = `${(d.sum / d.scale) * 100}%`;
      const use = meter.querySelector('.use');
      use.hidden = d.usedPct === null;
      if (d.usedPct !== null) use.style.width = `${d.usedPct}%`;
      setOver(meter.querySelector('.bar-over'), d.marks.share);
      meter.querySelector('.meter-text').replaceChildren(...[
        h('span', { class: d.overHanded ? 'over' : '' }, h('b', {}, show(d.sum)), ` of ${show(d.share)} to ${plural(rows.length, 'project')}`),
        d.used === null ? null : h('span', {}, h('b', {}, show(d.used)), ' in use'),
      ].filter(Boolean));
    }

    // --- the body: the split, and why it is red ---
    const callout = section.querySelector('[data-callout="dept"]');
    callout.hidden = !d.overHanded;
    if (d.overHanded) {
      callout.replaceChildren(icon('error'), h('span', {}, `These projects are guaranteed ${cards(d.sum)} between them, but the department only has ${cards(d.share)}. `,
        h('b', {}, `${cards(d.over)} of those guarantees cannot be met`), ' — lower a project, or raise what the department is guaranteed.'));
    }
    const split = section.querySelector('.split');
    const segs = [...split.querySelectorAll('.seg:not(.free)')];
    const free = split.querySelector('.seg.free');
    Object.keys(d.children).forEach((name, i) => {
      const c = d.children[name];
      if (!segs[i]) return;
      segs[i].hidden = c.hidden;
      segs[i].style.flexBasis = `${c.flex}%`;
      const project = plan.model.planned.projects.find((p) => p.queues.some((q) => q.name === name));
      const deserved = show(Math.max(0, (project ? value(fid('Project', project.name, name, 'gpu', 'deserved')) : 0) ?? 0));
      if (open && project) fitLabel(segs[i], `${project.name} · ${deserved}`, deserved);
    });
    free.hidden = d.free.hidden;
    free.style.flexBasis = `${d.free.flex}%`;
    if (open) fitLabel(free, `not assigned · ${show(d.spare)}`, show(d.spare));
    section.querySelector('.ticks').replaceChildren(...(d.tickCount ? Array.from({ length: d.tickCount }, () => h('i')) : []));
    setOver(section.querySelector('.split-wrap > .bar-over'), d.marks.share);

    for (const row of rows) {
      const q = display.queues[row.dataset.queue];
      if (!q) continue;
      row.querySelector('.des').style.width = `${q.desPct}%`;
      row.querySelector('.lim').style.width = `${q.limPct}%`;
      const use = row.querySelector('.use');
      if (use && q.allocated !== null) use.style.left = `clamp(5px, ${Math.min(100, (q.allocated / q.scale) * 100)}%, calc(100% - 5px))`;
      const above = q.allocated !== null && q.lim !== UNLIMITED && q.lim !== null && q.allocated > q.lim + 1e-9;
      const text = row.querySelector('.usage .text');
      text.title = above ? 'More than the planned limit is in use right now' : '';
      text.replaceChildren(...(q.allocated !== null ? [h('b', { class: above ? 'above' : '' }, show(round(q.allocated))), ' in use'] : ['usage not read']));
      const at = issues.queues.get(row.dataset.queue);
      const mark = row.querySelector('.row-flag');
      row._issues = at ? [...at.error, ...at.warning] : [];
      mark.hidden = !at;
      if (at) {
        mark.className = `row-flag ${at.error.length ? 'bad' : 'warn'}`;
        mark.replaceChildren(icon(at.error.length ? 'error' : 'warning'));
      }
      row.classList.toggle('has-warning', Boolean(at?.warning.length) && !at.error.length);
    }
  }

  for (const article of document.querySelectorAll('.pool[data-pool]')) {
    const p = display.pools[article.dataset.pool];
    if (!p) continue;
    const found = issues.pools.get(article.dataset.pool) ?? { error: 0, warning: 0 };
    const [tone, text, title] = poolState(p);
    article.querySelector('.pool-flags').replaceChildren(...[
      found.error ? flag('bad', plural(found.error, 'error'), 'Listed under Checks in the plan') : null,
      found.warning ? flag('warn', plural(found.warning, 'warning'), 'Listed under Checks in the plan') : null,
      h('span', { class: `pill ${tone === 'ok' && found.error ? '' : tone}`, title }, tone === 'bad' ? icon('error') : null, text),
    ].filter(Boolean));
    article.classList.toggle('over', p.overDepts);
    keep(article, p.overDepts || p.overProjects || found.error + found.warning > 0 || troubled.has(article.dataset.pool));

    const use = article.querySelector('.bar-use');
    use.hidden = p.usedPct === null;
    if (p.usedPct !== null) use.firstElementChild.style.width = `${p.usedPct}%`;
    article.querySelector('.facts').replaceChildren(...[
      fact('Guaranteed to departments', show(p.promised), p.cards === null ? '' : `of ${show(p.cards)}`, p.overDepts),
      fact('Guaranteed to projects', show(p.handed), `of ${show(p.promised)}`, p.overProjects),
      p.used === null ? h('span', {}, 'Live usage not read') : h('span', { class: 'in-use' }, h('i', { class: 'key' }), 'In use right now ', h('b', {}, show(p.used))),
    ]);
    const callout = article.querySelector('[data-callout="pool"]');
    callout.hidden = !p.overDepts;
    if (p.overDepts) {
      callout.replaceChildren(icon('error'), h('span', {}, `Departments are guaranteed ${cards(p.promised)} between them, but this pool has ${cards(p.cards)}. `,
        h('b', {}, `${cards(p.over)} too many`), ' — until it fits, no department here can count on its full guarantee. Lower the guarantees below.'));
    }
  }

  for (const bar of document.querySelectorAll('[data-bar-pool]')) {
    const p = display.pools[bar.dataset.barPool];
    if (!p) continue;
    const labelled = bar.classList.contains('pool-bar');
    for (const seg of bar.querySelectorAll('.seg[data-seg]')) {
      const d = p.depts.find((x) => x.queue === seg.dataset.seg);
      seg.hidden = !d || d.hidden;
      if (!d) continue;
      seg.style.flexBasis = `${d.flex}%`;
      seg.classList.toggle('bad', broken.has(d.queue));
      // A department this plan moves is coloured and says by how much, so the cause of an overflow is on the bar.
      const was = baseValue(fid('Department', d.dept, d.queue, 'gpu', 'deserved'));
      const moved = Number.isFinite(was) && was !== UNLIMITED ? round(d.share - Math.max(0, was)) : 0;
      const amount = moved ? `${show(d.share)} (${moved > 0 ? '+' : '−'}${show(Math.abs(moved))})` : show(d.share);
      seg.classList.toggle('moved', moved !== 0);
      if (!labelled) continue;
      fitLabel(seg, `${d.dept} · ${amount}`, `${d.dept} · ${show(d.share)}`, amount, show(d.share));
    }
    const free = bar.querySelector('.seg.free');
    free.hidden = p.free.hidden;
    free.style.flexBasis = `${p.free.flex}%`;
    if (labelled) fitLabel(free, `not guaranteed · ${show(p.spare)}`, show(p.spare));
    setOver(bar.querySelector('.bar-over'), p.capPct);
    const cap = bar.querySelector('.bar-cap');
    cap.hidden = p.capPct === undefined;
    if (p.capPct !== undefined) cap.style.left = `calc(${p.capPct}% - 1px)`;
  }

  for (const ov of document.querySelectorAll('.ov[data-ov]')) {
    const p = display.pools[ov.dataset.ov];
    if (!p) continue;
    const found = issues.pools.get(ov.dataset.ov) ?? { error: 0, warning: 0 };
    const [tone, text] = poolState(p);
    const worst = tone === 'bad' || found.error ? 'bad' : found.warning ? 'warn' : tone;
    ov.classList.toggle('over', p.overDepts);
    ov.querySelector('.ov-nums').textContent = p.cards === null ? `${show(p.promised)} guaranteed` : `${show(p.promised)} of ${show(p.cards)} guaranteed`;
    ov.querySelector('.ov-state').replaceChildren(h('span', { class: `pill ${worst}` },
      worst === 'bad' ? icon('error') : worst === 'warn' ? icon('warning') : null,
      tone === 'bad' || !(found.error + found.warning) ? text : found.error ? plural(found.error, 'error') : plural(found.warning, 'warning')));
  }
}

/** The stretch of a bar past what there is to give: from `at` percent to its end. */
function setOver(el, at) {
  if (!el) return;
  el.hidden = at === undefined;
  if (at !== undefined) el.style.left = `${at}%`;
}

/** The longest of the forms that fits the segment, or nothing. */
function fitLabel(seg, ...forms) {
  const label = seg.querySelector('span');
  if (!label) return;
  for (const text of [...forms, '']) {
    label.textContent = text;
    if (label.offsetWidth + 14 <= seg.clientWidth) return;
  }
}
