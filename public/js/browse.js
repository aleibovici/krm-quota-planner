import { $ } from './constants.js';
import { icon } from './dom.js';
import { paint } from './sync.js';

const PLAN_KEY = 'planner-plan-collapsed';
const ADVANCED_KEY = 'planner-show-advanced';

const openPools = new Map();
const openDepts = new Map();

export function poolShouldOpen(name, index, count) {
  if (openPools.has(name)) return openPools.get(name);
  return count <= 1 || index === 0;
}

export function deptShouldOpen(key, childCount) {
  if (openDepts.has(key)) return openDepts.get(key);
  return childCount <= 4;
}

export function watchDisclosure(el, kind, key) {
  el.addEventListener('toggle', () => {
    const map = kind === 'pool' ? openPools : openDepts;
    map.set(key, el.open);
  });
}

/**
 * A department is not a <details>: its header carries the numbers that fix an
 * over-committed pool, and those have to stay editable while it is closed.
 */
export function setDeptOpen(section, open, { remember = true } = {}) {
  section.classList.toggle('open', open);
  section.querySelector('.dept-body').hidden = !open;
  section.querySelector('.dept-toggle').setAttribute('aria-expanded', String(open));
  if (remember && section.dataset.deptKey) openDepts.set(section.dataset.deptKey, open);
}

/** Open whatever is closed around an element, bring it on screen, and flash it. */
export function reveal(el) {
  const pool = el.closest('.pool');
  const dept = el.closest('.dept');
  if (pool && !pool.open) pool.open = true;
  if (dept && !dept.classList.contains('open')) setDeptOpen(dept, true);
  paint();
  el.scrollIntoView({ behavior: 'smooth', block: el.closest('.row') ? 'center' : 'start' });
  const target = el.closest('.row, .dept-head, .pool > summary') ?? el;
  target.classList.remove('flash');
  requestAnimationFrame(() => target.classList.add('flash'));
}

function setPlanCollapsed(collapsed) {
  $('main').classList.toggle('plan-collapsed', collapsed);
  try { localStorage.setItem(PLAN_KEY, collapsed ? '1' : '0'); } catch { /* private window */ }
  paint();
}

function setAdvanced(on) {
  document.body.classList.toggle('show-advanced', on);
  const btn = $('toggle-advanced');
  if (btn) btn.setAttribute('aria-pressed', String(on));
  try { localStorage.setItem(ADVANCED_KEY, on ? '1' : '0'); } catch { /* private window */ }
}

function setOnlyIssues(on) {
  document.body.classList.toggle('only-issues', on);
  $('only-issues')?.setAttribute('aria-pressed', String(on));
  // What is left on screen is what needs attention, so show it opened.
  if (on) {
    for (const pool of document.querySelectorAll('#pools .pool.has-issue')) pool.open = true;
    for (const dept of document.querySelectorAll('#pools .dept.over, #pools .dept:has(.row.has-error, .row.has-warning)')) setDeptOpen(dept, true);
  } else {
    for (const el of document.querySelectorAll('#pools .issue-kept')) el.classList.remove('issue-kept');
  }
  paint();
}

export function applyBrowseFilter() {
  const q = ($('browse-filter')?.value ?? '').trim().toLowerCase();
  let any = false;
  for (const pool of document.querySelectorAll('#pools .pool')) {
    const poolName = (pool.dataset.pool ?? '').toLowerCase();
    let visible = false;
    for (const dept of pool.querySelectorAll('.dept')) {
      const blob = (dept.dataset.search ?? '').toLowerCase();
      const deptName = (dept.dataset.dept ?? '').toLowerCase();
      const deptMatch = !q || deptName.includes(q) || poolName.includes(q);
      dept.hidden = Boolean(q) && !blob.includes(q) && !poolName.includes(q);
      if (!dept.hidden) visible = true;
      let rowMatch = false;
      for (const row of dept.querySelectorAll('.row:not(.head)')) {
        const text = (row.dataset.search ?? '').toLowerCase();
        row.hidden = Boolean(q) && !deptMatch && !text.includes(q);
        if (q && !row.hidden && text.includes(q)) rowMatch = true;
      }
      // Only a match on a project needs the department opened to be seen.
      if (rowMatch && !dept.hidden) setDeptOpen(dept, true);
    }
    pool.hidden = Boolean(q) && !poolName.includes(q) && !visible;
    if (!pool.hidden) any = true;
    if (q && !pool.hidden) pool.open = true;
  }
  const note = $('no-match');
  if (note) note.hidden = !q || any;
  if (q) paint();
}

function setAll(open) {
  for (const el of document.querySelectorAll('#pools .pool')) {
    el.open = open;
    if (el.dataset.pool) openPools.set(el.dataset.pool, open);
  }
  for (const el of document.querySelectorAll('#pools .dept')) setDeptOpen(el, open);
  paint();
}

export function initBrowse() {
  try {
    if (localStorage.getItem(PLAN_KEY) === '1') setPlanCollapsed(true);
    if (localStorage.getItem(ADVANCED_KEY) === '1') setAdvanced(true);
  } catch { /* private window */ }

  $('hide-plan')?.addEventListener('click', () => setPlanCollapsed(true));
  $('show-plan')?.addEventListener('click', () => setPlanCollapsed(false));
  $('show-plan')?.prepend(icon('chevron'));
  $('browse-filter')?.addEventListener('input', applyBrowseFilter);
  $('only-issues')?.addEventListener('click', () => setOnlyIssues(!document.body.classList.contains('only-issues')));
  $('expand-all')?.addEventListener('click', () => setAll(true));
  $('collapse-all')?.addEventListener('click', () => setAll(false));
  $('toggle-advanced')?.addEventListener('click', () => setAdvanced(!document.body.classList.contains('show-advanced')));
}
