// The KRM tenancy file as an editable model.
//
// Parsing keeps, for every number a planner may change, the byte range of
// that scalar in the source text. Edits are addressed by a stable id
// (kind / owner / queue / resource / field) and never by line number, and are
// applied by splicing the original text (see splice.js), so the result differs
// from the input only where a value changed.

import { parseAllDocuments, isMap, isSeq, isScalar } from 'yaml';
import { applySplices } from './splice.js';

export const RESOURCES = ['gpu', 'cpu', 'memory'];
export const QUOTA_FIELDS = ['deserved', 'limit', 'overQuotaWeight'];
export const UNLIMITED = -1;

/** Document order used when rendering or inserting KRM objects. */
export const KRM_DOC_ORDER = ['NodePool', 'ManagedNodesConfig', 'Department', 'Project'];

export const fieldId = (kind, owner, queue, ...rest) => [kind, owner, queue, ...rest].join('/');

/** @param {string} id stable field id from {@link fieldId} */
export function parseFieldId(id) {
  const [kind, owner, queue, ...rest] = id.split('/');
  return { kind, owner, queue, rest };
}

/** @param {import('./tenancy.js').Tenancy} model */
export function queuesOf(model) {
  return [...model.departments.flatMap((d) => d.queues), ...model.projects.flatMap((p) => p.queues)];
}

/**
 * @typedef {{ id: string, value: number|null, start: number, end: number, problem?: string }} Field
 * @typedef {{ deserved: number|null, limit: number|null, overQuotaWeight: number|null }} Quota
 * @typedef {{
 *   name: string, nodepool: string, priority: number|null,
 *   ownerKind: 'Department'|'Project', owner: string,
 *   resources: Record<string, Quota>
 * }} Queue
 * @typedef {{
 *   pools: { name: string, labelKey: string, labelValue: string }[],
 *   departments: { name: string, queues: Queue[] }[],
 *   projects: { name: string, namespace: string, parent: string, enforceKaiScheduler: boolean|null, defaultNodePools: string[], queues: Queue[] }[],
 *   managedNodes: { key: string, operator: string, values: string[] }[][] | null,   the ManagedNodesConfig whitelist: terms (any of) of expressions (all of); null when there is none
 *   fields: Record<string, Field>,
 *   problems: string[]
 * }} Tenancy
 */

/**
 * @param {string} source multi-document YAML
 * @returns {Tenancy}
 */
export function parseTenancy(source) {
  /** @type {Tenancy} */
  const model = { pools: [], departments: [], projects: [], managedNodes: null, fields: {}, problems: [] };

  for (const doc of parseAllDocuments(source)) {
    if (doc.errors.length) {
      model.problems.push(...doc.errors.map((e) => `YAML: ${e.message}`));
      continue;
    }
    const root = doc.contents;
    if (!isMap(root)) continue; // empty document between separators
    const kind = text(root.get('kind'));
    const name = text(root.getIn(['metadata', 'name']));
    const spec = root.get('spec');

    if (kind === 'NodePool') {
      model.pools.push({
        name,
        labelKey: text(isMap(spec) ? spec.get('labelKey') : ''),
        labelValue: text(isMap(spec) ? spec.get('labelValue') : ''),
      });
    } else if (kind === 'ManagedNodesConfig') {
      // Nodes outside this whitelist go to a pool no scheduler shard serves.
      const terms = doc.toJS()?.spec?.inclusion_criteria?.nodeSelectorTerms;
      if (Array.isArray(terms)) {
        model.managedNodes = terms.map((t) => [...(t?.matchExpressions ?? []), ...(t?.matchFields ?? []).map((f) => ({ ...f, operator: 'Field' }))]
          .map((e) => ({ key: text(e?.key), operator: text(e?.operator), values: Array.isArray(e?.values) ? e.values.map(text) : [] })));
      }
    } else if (kind === 'Department') {
      model.departments.push({ name, queues: readQueues(model, kind, name, spec) });
    } else if (kind === 'Project') {
      const pools = isMap(spec) ? spec.get('defaultNodePools') : null;
      model.projects.push({
        name,
        namespace: text(isMap(spec) ? spec.get('namespace') : '') || name,
        parent: text(isMap(spec) ? spec.get('parent') : ''),
        enforceKaiScheduler: isMap(spec) && typeof spec.get('enforceKaiScheduler') === 'boolean' ? spec.get('enforceKaiScheduler') : null,
        defaultNodePools: isSeq(pools) ? pools.items.map((i) => text(isScalar(i) ? i.value : i)) : [],
        queues: readQueues(model, kind, name, spec),
      });
    }
  }
  return model;
}

function readQueues(model, kind, owner, spec) {
  const list = isMap(spec) ? spec.get('queues', true) : null;
  if (!isSeq(list)) return [];
  const queues = [];
  for (const item of list.items) {
    if (!isMap(item)) continue;
    const name = text(item.get('name'));
    /** @type {Queue} */
    const queue = { name, nodepool: text(item.get('nodepool')), priority: null, ownerKind: kind, owner, resources: {} };

    const priority = item.get('priority', true);
    if (priority !== undefined) {
      queue.priority = recordNumber(model, fieldId(kind, owner, name, 'priority'), priority);
    }
    const resources = item.get('resources', true);
    for (const resource of RESOURCES) {
      const node = isMap(resources) ? resources.get(resource, true) : null;
      if (!isMap(node)) continue;
      const quota = { deserved: null, limit: null, overQuotaWeight: null };
      for (const f of QUOTA_FIELDS) {
        const scalar = node.get(f, true);
        if (scalar !== undefined) quota[f] = recordNumber(model, fieldId(kind, owner, name, resource, f), scalar);
      }
      queue.resources[resource] = quota;
    }
    queues.push(queue);
  }
  return queues;
}

function recordNumber(model, id, node) {
  if (!isScalar(node) || !node.range) {
    model.problems.push(`${id}: not a plain value, cannot be edited here`);
    return null;
  }
  const [start, end] = node.range;
  const value = typeof node.value === 'number' && Number.isFinite(node.value) ? node.value : null;
  model.fields[id] = { id, value, start, end };
  if (value === null) {
    model.fields[id].problem = `expected a number, found ${JSON.stringify(node.value)}`;
    model.problems.push(`${id}: ${model.fields[id].problem}`);
  }
  return value;
}

const text = (v) => (v === undefined || v === null ? '' : String(v));

/** Shortest text that round-trips; quotas are floats but people write 3, 0.5, -1. */
export function formatNumber(n) {
  return String(Math.round(n * 1e4) / 1e4);
}

/**
 * Apply value edits to the tenancy source.
 *
 * @param {string} source
 * @param {{ id: string, value: number }[]} edits
 * @returns {{ source: string, changes: { id: string, from: number|null, to: number }[], errors: string[] }}
 */
export function applyTenancyEdits(source, edits) {
  const model = parseTenancy(source);
  const errors = [];
  const changes = [];
  const splices = [];
  const seen = new Set();

  for (const edit of edits) {
    if (seen.has(edit.id)) {
      errors.push(`${edit.id}: edited twice`);
      continue;
    }
    seen.add(edit.id);
    const field = model.fields[edit.id];
    if (!field) {
      errors.push(`${edit.id}: not present in the file — add the key by hand first, this tool only changes existing values`);
      continue;
    }
    if (typeof edit.value !== 'number' || !Number.isFinite(edit.value)) {
      errors.push(`${edit.id}: ${JSON.stringify(edit.value)} is not a number`);
      continue;
    }
    if (field.value === edit.value) continue; // no-op edits must not touch the file
    splices.push({ start: field.start, end: field.end, text: formatNumber(edit.value) });
    changes.push({ id: edit.id, from: field.value, to: edit.value });
  }

  return { source: errors.length ? source : applySplices(source, splices), changes, errors };
}
