// Files that must move with a quota change.
//
// In a typical GitOps layout a queue's numbers are written down in more than
// one place (a small quota move can touch several files):
//
//   - the tenancy file itself;
//   - shell variables that the package's verify.sh compares the live queues
//     against — leave them stale and verify goes red on a correct change;
//   - namespace ResourceQuotas that mirror a queue's whole-card limit.
//
// The first is the edit. The second is derived here, mechanically. The third
// is a suggestion the planner can include or leave out, because a
// ResourceQuota is a separate decision (it does not see fractions).

import { parseAllDocuments, isMap, isScalar } from 'yaml';
import { formatNumber, UNLIMITED, queuesOf } from './tenancy.js';
import { spliceAligned } from './splice.js';

const gpuOf = (model) => new Map(queuesOf(model).filter((q) => q.resources.gpu).map((q) => [q.name, q.resources.gpu]));

/**
 * Rewrite `VAR="…"` expectation lines so each entry carries the planned GPU
 * deserved:limit of its queue. Entries are `project:namespace:queue:D:L` or
 * `queue:D:L`; anything else on the line (other entries, the trailing
 * comment) is left exactly as it was.
 *
 * @param {string} source shell file
 * @param {string[]} variables names to look at
 * @param {import('./tenancy.js').Tenancy} model tenancy after the edits
 * @returns {{ source: string, changes: { variable: string, queue: string, from: string, to: string }[] }}
 */
/**
 * @param {string} source shell file
 * @param {string[]} variables names to look at
 * @param {import('./tenancy.js').Tenancy} baseModel tenancy at the base
 * @param {import('./tenancy.js').Tenancy} plannedModel tenancy after edits
 * @returns {{ source: string, changes: { variable: string, queue: string, from: string, to: string }[], drift: { variable: string, queue: string, from: string, to: string }[] }}
 */
export function patchExpectationsForModels(source, variables, baseModel, plannedModel) {
  const baseGpu = gpuOf(baseModel);
  const plannedGpu = gpuOf(plannedModel);
  const changes = [];
  const drift = [];
  const lines = source.split('\n').map((line) => {
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"(.*)$/.exec(line);
    if (!m || !variables.includes(m[2])) return line;
    const [, lead, variable, value, rest] = m;
    const next = value.replace(/\S+/g, (entry) => {
      const parts = entry.split(':');
      const queue = parts.length === 5 ? parts[2] : parts.length === 3 ? parts[0] : null;
      if (!queue) return entry;
      const sync = (gpu, bucket) => {
        if (!gpu || gpu.deserved === null || gpu.limit === null) return;
        const updated = [...parts.slice(0, -2), formatNumber(gpu.deserved), formatNumber(gpu.limit)].join(':');
        if (updated !== entry) {
          bucket.push({ variable, queue, from: parts.slice(-2).join(':'), to: updated.split(':').slice(-2).join(':') });
        }
        return updated;
      };
      sync(baseGpu.get(queue), drift);
      return sync(plannedGpu.get(queue), changes) ?? entry;
    });
    return `${lead}${variable}="${next}"${rest}`;
  });
  return { source: lines.join('\n'), changes, drift };
}

export function patchExpectations(source, variables, model) {
  const { source: out, changes } = patchExpectationsForModels(source, variables, model, model);
  return { source: out, changes };
}

/**
 * A mirror follows one queue (listed in the profile), or a whole project
 * (discovered by namespace): a ResourceQuota bounds the namespace, and a
 * project with a queue on more than one pool may hold the sum of them.
 *
 * @typedef {{ file: string, key: string, queue?: string, project?: string, discovered?: boolean }} MirrorConfig
 * @typedef {MirrorConfig & {
 *   object: string, current: number|null, suggested: number|null,
 *   status: 'in-sync'|'differs'|'no-suggestion'|'not-found', note: string,
 *   start?: number, end?: number
 * }} Mirror
 */

/** The hard keys a ResourceQuota may count whole cards under, most specific first. */
export const GPU_QUOTA_KEYS = ['requests.nvidia.com/gpu', 'nvidia.com/gpu'];

/**
 * The most whole cards a project's namespace could hold at once: its queues'
 * limits across every pool, each rounded up to whole cards. Open when any
 * queue has no limit.
 *
 * @param {import('./tenancy.js').Tenancy} model
 * @param {string} project
 * @returns {{ cards: number|null, parts: { queue: string, pool: string, limit: number }[], missing: boolean }}
 */
export function namespaceCeiling(model, project) {
  const p = model.projects.find((x) => x.name === project);
  if (!p) return { cards: null, parts: [], missing: true };
  const parts = p.queues.filter((q) => q.resources.gpu && q.resources.gpu.limit !== null).map((q) => ({ queue: q.name, pool: q.nodepool, limit: q.resources.gpu.limit }));
  const open = parts.some((x) => x.limit === UNLIMITED);
  return { cards: open || !parts.length ? null : parts.reduce((s, x) => s + Math.ceil(x.limit - 1e-9), 0), parts, missing: false };
}

/** What a mirror follows, and the whole-card ceiling it should show. */
function target(cfg, model) {
  if (cfg.project) {
    const c = namespaceCeiling(model, cfg.project);
    const sum = c.parts.length > 1 ? ` (${c.parts.map((x) => `${formatNumber(x.limit)} on ${x.pool}`).join(' + ')})` : '';
    return {
      name: `project ${cfg.project}`,
      missing: c.missing,
      open: !c.missing && c.cards === null,
      suggested: c.cards,
      limit: c.parts.length === 1 ? formatNumber(c.parts[0].limit) : `${c.cards === null ? 'unlimited' : c.cards}${sum}`,
      what: c.parts.length > 1 ? 'limits across its pools add up to' : 'limit is',
    };
  }
  const queue = queuesOf(model).find((q) => q.name === cfg.queue);
  const limit = queue?.resources.gpu?.limit;
  const missing = limit === undefined || limit === null;
  return { name: `queue ${cfg.queue}`, missing, open: !missing && limit === UNLIMITED, suggested: missing || limit === UNLIMITED ? null : Math.ceil(limit - 1e-9), limit: missing ? '' : formatNumber(limit), what: 'limit is' };
}

/**
 * Compare a ResourceQuota's hard GPU count with the queue or project it
 * mirrors. The suggestion is the limit rounded up to whole cards: a
 * ResourceQuota counts `nvidia.com/gpu` requests, which fractional pods do
 * not make, so it only ever bounds whole-card pods.
 *
 * @param {MirrorConfig} cfg
 * @param {string|undefined} source the ResourceQuota manifest
 * @param {import('./tenancy.js').Tenancy} model tenancy after the edits
 * @returns {Mirror}
 */
export function inspectMirror(cfg, source, model) {
  const base = { ...cfg, object: '', current: null, suggested: null };
  if (source === undefined) return { ...base, status: 'not-found', note: `${cfg.file} is not in the repository at this ref` };

  let found = null;
  for (const doc of parseAllDocuments(source)) {
    const root = doc.contents;
    if (!isMap(root) || root.get('kind') !== 'ResourceQuota') continue;
    const node = root.getIn(['spec', 'hard', cfg.key], true);
    if (isScalar(node) && node.range) {
      found = { node, object: `ResourceQuota/${root.getIn(['metadata', 'name']) ?? '?'}` };
      break;
    }
  }
  if (!found) return { ...base, status: 'not-found', note: `no ResourceQuota with spec.hard["${cfg.key}"] in ${cfg.file}` };

  const current = Number(found.node.value);
  const [start, end] = found.node.range;
  const common = { ...base, object: found.object, current, start, end };
  return { ...common, ...verdict(target(cfg, model), current) };
}

function verdict(t, current) {
  if (t.missing) return { status: 'no-suggestion', note: `${t.name} is not in the tenancy file` };
  if (t.open) return { status: 'no-suggestion', note: `${t.name} has no GPU limit — the ResourceQuota (${current}) is the only whole-card ceiling here` };
  return t.suggested === current
    ? { suggested: t.suggested, status: 'in-sync', note: `matches ${t.name}'s ${t.what === 'limit is' ? 'limit' : 'limits'}` }
    : { suggested: t.suggested, status: 'differs', note: `${t.name}'s ${t.what} ${t.limit}; the quota says ${current}` };
}

/**
 * ResourceQuota manifests the repository holds for a project's namespace,
 * found by namespace rather than listed in the profile. One per file: the
 * first ResourceQuota in it with a whole-card key. A file the profile
 * already lists is left to that entry.
 *
 * @param {Record<string, string|undefined>} files path -> content
 * @param {import('./tenancy.js').Tenancy} model
 * @param {MirrorConfig[]} listed
 * @returns {MirrorConfig[]}
 */
export function discoverQuotaManifests(files, model, listed = []) {
  const byNamespace = new Map(model.projects.map((p) => [p.namespace, p.name]));
  const taken = new Set(listed.map((m) => m.file));
  const out = [];
  for (const [file, source] of Object.entries(files)) {
    if (taken.has(file) || typeof source !== 'string' || !source.includes('ResourceQuota')) continue;
    let docs;
    try { docs = parseAllDocuments(source); } catch { continue; }
    for (const doc of docs) {
      const root = doc.contents;
      if (!isMap(root) || root.get('kind') !== 'ResourceQuota') continue;
      const project = byNamespace.get(String(root.getIn(['metadata', 'namespace']) ?? ''));
      const key = GPU_QUOTA_KEYS.find((k) => isScalar(root.getIn(['spec', 'hard', k], true)));
      if (!project || !key) continue;
      out.push({ file, key, project, discovered: true });
      break;
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * The cluster's own ResourceQuotas against the plan: one entry per quota in
 * a project's namespace that counts whole cards. Same shape as a mirror, so
 * the UI and the commit message treat them alike; `file` names the object
 * since there is no file.
 *
 * @param {Record<string, { name: string, key: string, value: number, raw: string }[]>|null|undefined} quotas namespace -> its GPU quotas
 * @param {import('./tenancy.js').Tenancy} baseModel
 * @param {import('./tenancy.js').Tenancy} plannedModel
 * @param {Record<string, boolean>} choice file -> include, as the user ticked
 * @returns {(Mirror & { namespace: string, name: string, raw: string, included: boolean, differedBefore: boolean })[]}
 */
export function liveQuotaMirrors(quotas, baseModel, plannedModel, choice = {}) {
  if (!quotas) return [];
  const out = [];
  for (const project of plannedModel.projects) {
    for (const q of quotas[project.namespace] ?? []) {
      const cfg = { file: `${project.namespace}/${q.name}`, key: q.key, project: project.name, discovered: true, namespace: project.namespace, name: q.name, raw: q.raw };
      const now = verdict(target(cfg, plannedModel), q.value);
      const was = baseModel.projects.some((p) => p.name === project.name) ? verdict(target(cfg, baseModel), q.value) : { status: 'in-sync' };
      const causedByPlan = now.status === 'differs' && was.status === 'in-sync';
      const included = now.status === 'differs' && (choice[cfg.file] ?? causedByPlan);
      out.push({ ...cfg, object: `ResourceQuota/${q.name} in namespace ${project.namespace}`, current: q.value, suggested: null, ...now, included, differedBefore: was.status === 'differs' });
    }
  }
  return out;
}

/** Write the suggested value into the manifest, keeping its quoting and comment. */
export function applyMirror(source, mirror) {
  if (mirror.status !== 'differs' || mirror.start === undefined) return source;
  const quote = source[mirror.start];
  const text = quote === '"' || quote === "'" ? `${quote}${mirror.suggested}${quote}` : String(mirror.suggested);
  return spliceAligned(source, mirror.start, mirror.end, text);
}
