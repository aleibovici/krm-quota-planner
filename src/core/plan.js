// A plan: the files as they are, a set of value edits and of objects to add,
// and everything that follows from them — patched files, a diff git can
// apply, findings, the coupled files, and a commit message.
//
// Pure: no git, no cluster, no clock. The server feeds it file contents (read
// at a git ref, or rendered from the live objects) and optionally live queue
// usage; tests feed it fixtures.

import { parseTenancy, applyTenancyEdits, formatNumber, UNLIMITED, queuesOf } from './tenancy.js';
import { validate } from './validate.js';
import { patchExpectationsForModels, inspectMirror, applyMirror } from './coupled.js';
import { unifiedDiff } from './diff.js';
import { applyAdditions, additionNotes } from './additions.js';
import { poolOf, capacityOfPool } from './pools.js';
import { buildDisplay } from './display.js';

const show = (n) => (n === null ? '?' : formatNumber(n));

/**
 * @param {{
 *   config: any,
 *   files: Record<string, string|undefined>,   path -> content at the base
 *   edits?: { id: string, value: number }[],
 *   additions?: import('./additions.js').Addition[],   objects and queues to add, in order
 *   mirrors?: Record<string, boolean>,         file -> include in the plan (overrides the default)
 *   capacity?: Record<string, { cards: number }>,
 *   live?: Record<string, { deserved?: number|null, limit?: number|null, allocatedGpu?: number, allocatedNonPreemptibleGpu?: number }>,
 *   nodes?: import('./pools.js').Node[],        the cluster's nodes, to size a pool that does not exist yet
 *   namespaces?: Record<string, Record<string, string>>|null,   name -> labels, when the cluster's namespaces were listed
 *   krm?: { createNamespaces: boolean|null, namespaceLabelKey: string }|null,
 *   notes?: import('./validate.js').Finding[], findings the source has about itself
 *   base?: { ref: string, sha: string, kind?: 'cluster'|'git' },
 *   today?: string                             YYYY-MM-DD, for the branch name
 * }} input
 */
export function buildPlan({ config, files, edits = [], additions = [], mirrors = {}, capacity, live, nodes, namespaces, krm, notes = [], base, today = '' }) {
  const tenancyPath = config.tenancy;
  const before = files[tenancyPath];
  if (before === undefined) throw new Error(`${tenancyPath} not found at ${base?.ref ?? 'the base ref'}`);
  const fromCluster = base?.kind === 'cluster';

  const baseModel = parseTenancy(before);
  // Values first, on the text as it was read; then the new objects go in.
  const edited = applyTenancyEdits(before, edits);
  const staged = applyAdditions(edited.source, additions);
  const plannedModel = parseTenancy(staged.source);
  const added = staged.added.filter((a) => !a.error);

  // A pool the cluster does not have yet (planned here, or in git and not
  // synced) is sized from the nodes that carry its label.
  const newPools = {};
  if (nodes) {
    capacity = { ...capacity };
    for (const pool of plannedModel.pools) {
      if (capacity[pool.name] || !pool.labelKey) continue;
      newPools[pool.name] = poolOf(nodes, pool.labelKey, pool.labelValue);
      capacity[pool.name] = capacityOfPool(newPools[pool.name]);
    }
  }

  /** @type {import('./validate.js').Finding[]} */
  const findings = edited.errors.map((message) => ({ level: 'error', code: 'edit', message }));
  findings.push(...staged.added.filter((a) => a.error).map((a) => ({ level: 'error', code: 'addition', addition: a.index, message: `${a.label} — ${a.error}` })));
  findings.push(...notes, ...validate(plannedModel, { capacity, live }));
  findings.push(...additionNotes(added, plannedModel, { nodes, namespaces, krm, expectations: config.expectations?.file ? { file: config.expectations.file, source: files[config.expectations.file] } : null }));

  // What the objects say versus what the scheduler is running. From git: Argo
  // has not synced yet, or someone changed a Queue outside git (self-heal will
  // put it back). From the cluster: KRM has not turned the object into its
  // Queue yet, or the Queue was edited directly.
  for (const q of queuesOf(baseModel)) {
    const now = live?.[q.name];
    const gpu = q.resources.gpu;
    if (!now || !gpu || now.deserved === null || now.deserved === undefined) continue;
    if (now.deserved !== gpu.deserved || now.limit !== gpu.limit) {
      findings.push({ level: 'info', code: 'live-differs', queue: q.name,
        message: fromCluster
          ? `${q.name}: the scheduler's Queue has ${show(now.deserved)}/${show(now.limit)} (deserved/limit) but its ${q.ownerKind} says ${show(gpu.deserved)}/${show(gpu.limit)} — KRM has not reconciled it yet, or the Queue was edited directly`
          : `${q.name}: the cluster is running ${show(now.deserved)}/${show(now.limit)} (deserved/limit) but ${base?.ref ?? 'git'} says ${show(gpu.deserved)}/${show(gpu.limit)} — not synced yet, or changed outside git` });
    }
  }

  if (edited.changes.some((c) => /\/(cpu|memory)\//.test(c.id)) && config.cpuMemoryNote) {
    findings.push({ level: 'warning', code: 'cpu-memory', message: config.cpuMemoryNote });
  }

  /** @type {{ path: string, role: string, before: string, after: string }[]} */
  const outputs = [{ path: tenancyPath, role: 'tenancy', before, after: staged.source }];

  // --- expectation variables (derived, always) -------------------------------
  const expectations = { file: config.expectations?.file ?? null, changes: [], drift: [] };
  if (expectations.file) {
    const source = files[expectations.file];
    if (source === undefined) {
      findings.push({ level: 'warning', code: 'expectations-missing', message: `${expectations.file} not found — its expectation variables were not updated` });
    } else {
      const vars = config.expectations.variables ?? [];
      const patched = patchExpectationsForModels(source, vars, baseModel, plannedModel);
      expectations.drift = patched.drift;
      expectations.changes = patched.changes;
      outputs.push({ path: expectations.file, role: 'expectations', before: source, after: patched.source });
      for (const d of expectations.drift) {
        findings.push({ level: 'info', code: 'expectations-drift',
          message: `${expectations.file}: ${d.variable} already disagreed with the tenancy file for ${d.queue} (${d.from}, file says ${d.to}) — this plan brings it back in line` });
      }
    }
  }

  // --- ResourceQuota mirrors (suggested, optional) ----------------------------
  const mirrorResults = (config.resourceQuotaMirrors ?? []).map((cfg) => {
    const source = files[cfg.file];
    const now = inspectMirror(cfg, source, plannedModel);
    const was = inspectMirror(cfg, source, baseModel);
    // Include by default only when THIS plan is what made it differ; a quota
    // that was already different is somebody's deliberate choice.
    const causedByPlan = now.status === 'differs' && was.status === 'in-sync';
    const included = now.status === 'differs' && (mirrors[cfg.file] ?? causedByPlan);
    if (included) outputs.push({ path: cfg.file, role: 'mirror', before: source, after: applyMirror(source, now) });
    const { start, end, ...rest } = now;
    return { ...rest, included, differedBefore: was.status === 'differs' };
  });

  const changed = outputs.filter((o) => o.before !== o.after);

  // The reasoning for a number lives in the comment beside it, and this tool
  // changes numbers only. Point at every comment that now describes an old value.
  for (const o of changed) {
    // For the tenancy file, look at the value edits alone: an inserted object
    // shifts every line after it, and has no old comment to go stale.
    const lines = commentsOnChangedLines(o.before, o.role === 'tenancy' ? edited.source : o.after);
    if (lines.length) {
      findings.push({ level: 'info', code: 'stale-comment',
        message: `${o.path}: the comment at line${lines.length > 1 ? 's' : ''} ${spans(lines)} explains a value this plan changes — the number is updated, the wording is not; rewrite it in the same PR` });
    }
  }
  const changes = edited.changes.map((c) => ({ ...c, label: changeLabel(c) }));
  const empty = !changes.length && !added.length;
  const hasErrors = findings.some((f) => f.level === 'error');
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);

  const plannedSlim = slim(plannedModel);
  const display = buildDisplay(plannedSlim, { capacity, live: live ?? {}, extraPools: newPools, liveRead: live !== undefined });

  return {
    base: base ?? null,
    model: { base: slim(baseModel), planned: plannedSlim },
    display,
    changes,
    additions: staged.added,
    pools: newPools,
    findings,
    expectations,
    mirrors: mirrorResults,
    reminders: empty ? [] : config.reminders ?? [],
    files: changed.map(({ path, role, after }) => ({ path, role, content: after })),
    diff: changed.map((o) => unifiedDiff(o.path, o.before, o.after)).join(''),
    empty,
    canCommit: !empty && !hasErrors,
    message: empty ? '' : commitMessage(config, baseModel, plannedModel, changes, added, expectations, mirrorResults, base),
    branch: empty ? '' : branchName(changes, added, today),
  };
}

/** 1-based line numbers of comments attached to a changed line: trailing on it, or the block directly above. */
function commentsOnChangedLines(before, after) {
  const was = before.split('\n');
  const now = after.split('\n');
  if (was.length !== now.length) return [];
  const hits = new Set();
  now.forEach((line, i) => {
    if (line === was[i]) return;
    if (/\s#\s?\S/.test(line)) hits.add(i + 1);
    for (let j = i - 1; j >= 0 && now[j].trim().startsWith('#'); j--) hits.add(j + 1);
  });
  return [...hits].sort((a, b) => a - b);
}

/** [150, 151, 152, 174] -> "150–152, 174" */
function spans(numbers) {
  const out = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (numbers[j + 1] === numbers[j] + 1) j++;
    out.push(j > i ? `${numbers[i]}–${numbers[j]}` : String(numbers[i]));
    i = j;
  }
  return out.join(', ');
}

/** The model without byte ranges: what a UI needs. */
function slim(model) {
  const { fields, ...rest } = model;
  return { ...rest, values: Object.fromEntries(Object.values(fields).map((f) => [f.id, f.value])) };
}

function changeLabel({ id, from, to }) {
  const parts = id.split('/');
  const queue = parts[2];
  const what = parts.length === 4 ? parts[3] : `${parts[3]} ${parts[4]}`;
  return `${queue} ${what} ${show(from)} → ${show(to)}`;
}

function commitMessage(config, baseModel, plannedModel, changes, added, expectations, mirrors, base) {
  const was = new Map(queuesOf(baseModel).map((q) => [q.name, q]));
  const now = new Map(queuesOf(plannedModel).map((q) => [q.name, q]));
  const pair = (q) => `${show(q.resources.gpu.deserved)}/${show(q.resources.gpu.limit)}`;

  const parts = added.map((a) => a.label);
  for (const name of [...new Set(changes.map((c) => c.id.split('/')[2]))]) {
    const mine = changes.filter((c) => c.id.split('/')[2] === name);
    if (mine.some((c) => /\/gpu\/(deserved|limit)$/.test(c.id))) {
      parts.push(`${name} gpu ${pair(was.get(name))} → ${pair(now.get(name))}`);
    }
    for (const c of mine.filter((c) => !/\/gpu\/(deserved|limit)$/.test(c.id))) parts.push(c.label);
  }

  const prefix = config.commitPrefix ? `${config.commitPrefix}: ` : '';
  const what = !changes.length ? 'tenancy' : 'quota change';
  let subject = `${prefix}${what} — ${parts.join('; ')}`;
  if (subject.length > 110) subject = `${prefix}${what} — ${parts.length} ${changes.length ? 'adjustments' : 'additions'} (see body)`;

  const body = ['GPU numbers are deserved/limit in cards; -1 = unlimited.', '', ...parts.map((p) => `- ${p}`)];
  const coupled = [];
  if (expectations.changes.length) coupled.push(`${expectations.file}: ${[...new Set(expectations.changes.map((c) => c.variable))].join(', ')} updated to match`);
  for (const m of mirrors.filter((m) => m.included)) coupled.push(`${m.file}: ${m.object} ${m.key} ${m.current} → ${m.suggested} (mirrors ${m.queue})`);
  if (coupled.length) body.push('', ...coupled.map((c) => `- ${c}`));
  if (base?.sha) body.push('', `Planned with krm-quota-planner against ${base.ref} (${base.sha.slice(0, 7)}).`);
  return `${subject}\n\n${body.join('\n')}\n`;
}

function branchName(changes, added, today) {
  const queues = [...new Set(changes.map((c) => c.id.split('/')[2]))];
  const only = !added.length && queues.length === 1 ? queues[0] : !changes.length && added.length === 1 ? `add-${added[0].name}` : null;
  const slug = (only ?? (changes.length ? 'rebalance' : 'additions')).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `quota/${today ? `${today.replaceAll('-', '')}-` : ''}${slug}`;
}

export { UNLIMITED };
