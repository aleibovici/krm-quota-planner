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
 * @typedef {{ file: string, key: string, queue: string }} MirrorConfig
 * @typedef {MirrorConfig & {
 *   object: string, current: number|null, suggested: number|null,
 *   status: 'in-sync'|'differs'|'no-suggestion'|'not-found', note: string,
 *   start?: number, end?: number
 * }} Mirror
 */

/**
 * Compare a ResourceQuota's hard GPU count with the queue it mirrors.
 * The suggestion is the queue's limit rounded up to whole cards: a
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
  const queue = queuesOf(model).find((q) => q.name === cfg.queue);
  const limit = queue?.resources.gpu?.limit;
  const common = { ...base, object: found.object, current, start, end };

  if (limit === undefined || limit === null) {
    return { ...common, status: 'no-suggestion', note: `queue ${cfg.queue} is not in the tenancy file` };
  }
  if (limit === UNLIMITED) {
    return { ...common, status: 'no-suggestion', note: `queue ${cfg.queue} has no GPU limit — the ResourceQuota (${current}) is the only whole-card ceiling here` };
  }
  const suggested = Math.ceil(limit - 1e-9);
  return suggested === current
    ? { ...common, suggested, status: 'in-sync', note: `matches ${cfg.queue}'s limit` }
    : { ...common, suggested, status: 'differs', note: `${cfg.queue}'s limit is ${formatNumber(limit)}; the quota says ${current}` };
}

/** Write the suggested value into the manifest, keeping its quoting and comment. */
export function applyMirror(source, mirror) {
  if (mirror.status !== 'differs' || mirror.start === undefined) return source;
  const quote = source[mirror.start];
  const text = quote === '"' || quote === "'" ? `${quote}${mirror.suggested}${quote}` : String(mirror.suggested);
  return spliceAligned(source, mirror.start, mirror.end, text);
}
