// Adding objects to the tenancy: a NodePool, a Department, a Project, or one
// more queue on a Department or Project that already exists.
//
// Like a value edit, an addition is an insertion into the original text and
// nothing else moves: a new object goes in as a document of its own after the
// last one of its kind, a new queue as one more item at the end of its list.
//
// A queue always states gpu, cpu and memory. KRM takes a resource that is not
// written down as 0, and 0 is a ceiling of zero: a queue created with only a
// GPU quota could not start a pod that asks for any CPU. cpu and memory are
// written as unlimited, which is what leaving them out looks like it means.
//
// Pure: no git, no cluster, no clock.

import { parseAllDocuments, isMap, isSeq, stringify } from 'yaml';
import { parseTenancy, formatNumber, UNLIMITED, KRM_DOC_ORDER } from './tenancy.js';
import { whitelisted } from './pools.js';

const API_VERSION = 'kai.resources/v1alpha1';
const ORDER = KRM_DOC_ORDER;
// Annotations that tell a GitOps controller HOW to sync an object, which a
// new object of the same kind needs as much as its neighbours do. Never the
// ones that say WHO owns it.
const SYNC_ANNOTATION = /^(argocd\.argoproj\.io\/(sync-wave|sync-options|compare-options)|kustomize\.toolkit\.fluxcd\.io\/(prune|ssa|force)|helm\.sh\/resource-policy)$/;

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const LABEL_KEY = /^([a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\/)?[A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;
const LABEL_VALUE = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/;

/**
 * @typedef {{ name: string, nodepool: string, priority?: number|null, gpu: { deserved: number, limit: number, overQuotaWeight?: number } }} NewQueue
 * @typedef {(
 *   { kind: 'NodePool', name: string, labelKey: string, labelValue: string } |
 *   { kind: 'Department', name: string, queues: NewQueue[] } |
 *   { kind: 'Project', name: string, namespace?: string, parent: string, enforceKaiScheduler?: boolean|null, queues: NewQueue[] } |
 *   { kind: 'Queue', ownerKind: 'Department'|'Project', owner: string, queue: NewQueue }
 * )} Addition
 * @typedef {{
 *   index: number, kind: string, name: string, label: string, queues: string[],
 *   error?: string,
 *   manifest?: string,   a new object, as YAML that `kubectl create` takes
 *   owner?: { kind: string, name: string }, queue?: any   a new queue on an existing object
 * }} Added
 */

/**
 * Put the additions into the tenancy text, in order. One that cannot go in
 * (a name already taken, an owner that is not there) is reported and left
 * out; the rest still apply.
 *
 * @param {string} source
 * @param {Addition[]} additions
 * @returns {{ source: string, added: Added[] }}
 */
export function applyAdditions(source, additions) {
  let text = source;
  const added = additions.map((addition, index) => {
    const kind = String(addition?.kind ?? '');
    const queues = (kind === 'Queue' ? [addition.queue] : Array.isArray(addition?.queues) ? addition.queues : []).filter((q) => q && typeof q === 'object');
    const name = kind === 'Queue' ? String(queues[0]?.name ?? '') : String(addition?.name ?? '');
    const entry = { index, kind, name, label: describe(addition, queues), queues: queues.map((q) => String(q.name ?? '')) };
    try {
      text = kind === 'Queue' ? insertQueue(text, addition, entry) : insertObject(text, addition, queues);
    } catch (err) {
      entry.error = err.message;
    }
    return entry;
  });
  // A new object as it ends up — including a queue added to it afterwards.
  const final = parseAllDocuments(text).map((d) => d.toJS()).filter(Boolean);
  for (const entry of added) {
    if (entry.error || entry.kind === 'Queue') continue;
    entry.manifest = stringify(final.find((o) => o.kind === entry.kind && o.metadata?.name === entry.name), { lineWidth: 0 });
  }
  return { source: text, added };
}

function describe(addition, queues) {
  const cards = (q) => `${show(q.gpu?.deserved)}/${show(q.gpu?.limit)} on ${q.nodepool}`;
  const list = queues.map((q) => `${q.name} ${cards(q)}`).join(', ');
  switch (addition?.kind) {
    case 'NodePool': return `new node pool ${addition.name} (${addition.labelKey}=${addition.labelValue})`;
    case 'Department': return `new department ${addition.name}: ${list}`;
    case 'Project': return `new project ${addition.name} in ${addition.parent}: ${list}`;
    case 'Queue': return `new queue for ${String(addition.ownerKind).toLowerCase()} ${addition.owner}: ${list}`;
    default: return `unknown addition ${JSON.stringify(addition?.kind)}`;
  }
}

const show = (n) => (typeof n !== 'number' || !Number.isFinite(n) ? '?' : n === UNLIMITED ? 'unlimited' : formatNumber(n));

// --- checks that decide whether an addition can go in at all -----------------

function checkName(what, value) {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new Error(`${what} ${JSON.stringify(value ?? '')} is not a valid name — lower-case letters, digits and "-", starting and ending with a letter or digit, at most 63`);
  }
}

function checkQueue(model, queue, taken) {
  checkName('queue name', queue.name);
  checkName('node pool', queue.nodepool);
  const everyQueue = [...model.departments, ...model.projects].flatMap((o) => o.queues.map((q) => ({ q, o })));
  const clash = everyQueue.find(({ q }) => q.name === queue.name);
  if (clash) throw new Error(`queue ${queue.name} already exists (${clash.q.ownerKind.toLowerCase()} ${clash.o.name}) — queue names are shared by the whole cluster`);
  if (taken.has(queue.name)) throw new Error(`queue ${queue.name} is named twice`);
  taken.add(queue.name);
  const { deserved, limit, overQuotaWeight = 1 } = queue.gpu ?? {};
  for (const [field, n] of [['guarantee', deserved], ['limit', limit], ['weight', overQuotaWeight]]) {
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${queue.name}: the GPU ${field} is not a number`);
  }
  if (queue.priority !== undefined && queue.priority !== null && !Number.isInteger(queue.priority)) throw new Error(`${queue.name}: priority must be a whole number`);
}

// --- a new object -------------------------------------------------------------

function insertObject(text, addition, queues) {
  const { kind } = addition;
  if (!['NodePool', 'Department', 'Project'].includes(kind)) throw new Error(`cannot add a ${JSON.stringify(kind)} — a NodePool, a Department, a Project or a Queue`);
  const model = parseTenancy(text);
  checkName(`${kind} name`, addition.name);
  const existing = { NodePool: model.pools, Department: model.departments, Project: model.projects }[kind];
  if (existing.some((o) => o.name === addition.name)) throw new Error(`${kind} ${addition.name} already exists`);

  let spec;
  if (kind === 'NodePool') {
    if (typeof addition.labelKey !== 'string' || !LABEL_KEY.test(addition.labelKey)) throw new Error(`${JSON.stringify(addition.labelKey ?? '')} is not a valid node label key`);
    if (typeof addition.labelValue !== 'string' || !addition.labelValue || !LABEL_VALUE.test(addition.labelValue)) throw new Error(`${JSON.stringify(addition.labelValue ?? '')} is not a valid node label value`);
    const twin = model.pools.find((p) => p.labelKey === addition.labelKey && p.labelValue === addition.labelValue);
    if (twin) throw new Error(`node pool ${twin.name} already selects ${addition.labelKey}=${addition.labelValue} — KRM rejects a second pool on the same nodes`);
    spec = [`  labelKey: ${scalar(addition.labelKey)}`, `  labelValue: ${scalar(addition.labelValue)}`];
  } else {
    if (!queues.length) throw new Error(`a ${kind} needs at least one queue`);
    const taken = new Set();
    const onPool = new Set();
    for (const q of queues) {
      checkQueue(model, q, taken);
      if (onPool.has(q.nodepool)) throw new Error(`two queues on node pool ${q.nodepool} — KRM allows one queue per pool in a ${kind}`);
      onPool.add(q.nodepool);
    }
    spec = [];
    if (kind === 'Project') {
      const namespace = addition.namespace || addition.name;
      checkName('namespace', namespace);
      checkName('parent department', addition.parent);
      // Stated even when it equals the name: KRM derives a namespace when the field is missing.
      spec.push(`  namespace: ${scalar(namespace)}`, `  parent: ${scalar(addition.parent)}`);
      if (typeof addition.enforceKaiScheduler === 'boolean') spec.push(`  enforceKaiScheduler: ${addition.enforceKaiScheduler}`);
      // Without this a workload that names no pool goes to KRM's default pool, which may have no queue for it.
      spec.push(`  defaultNodePools: [${queues.map((q) => scalar(q.nodepool)).join(', ')}]`);
    }
    spec.push('  queues:', ...queues.flatMap((q) => queueLines(q, '    ')));
  }

  const docs = documents(text);
  const annotations = syncAnnotations(docs, kind);
  const lines = [
    '---',
    `apiVersion: ${docs.find((d) => String(d.apiVersion).startsWith('kai.resources/'))?.apiVersion ?? API_VERSION}`,
    `kind: ${kind}`,
    'metadata:',
    `  name: ${scalar(addition.name)}`,
    ...(annotations.length ? ['  annotations:', ...annotations.map(([k, v]) => `    ${scalar(k)}: ${JSON.stringify(String(v))}`)] : []),
    'spec:',
    ...spec,
  ];
  const body = `${lines.join('\n')}\n`;

  // After the last object of the same kind; failing that, after the kinds
  // that come before it (a Project after the Departments), else at the end.
  const rank = ORDER.indexOf(kind);
  const anchor = docs.findLast((d) => d.kind === kind) ?? docs.findLast((d) => ORDER.includes(d.kind) && ORDER.indexOf(d.kind) < rank);
  const at = anchor ? anchor.end : text.length;
  const lead = at > 0 && text[at - 1] !== '\n' ? '\n' : '';
  return `${text.slice(0, at)}${lead}${body}${text.slice(at)}`;
}

// --- one more queue on an object that is already there -----------------------

function insertQueue(text, addition, entry) {
  const { ownerKind, owner, queue } = addition;
  if (!['Department', 'Project'].includes(ownerKind)) throw new Error('a queue belongs to a Department or a Project');
  if (!queue || typeof queue !== 'object') throw new Error('the queue is missing');
  const model = parseTenancy(text);
  const home = (ownerKind === 'Department' ? model.departments : model.projects).find((o) => o.name === owner);
  if (!home) throw new Error(`${ownerKind} ${owner} is not there to add a queue to`);
  checkQueue(model, queue, new Set());
  const same = home.queues.find((q) => q.nodepool === queue.nodepool);
  if (same) throw new Error(`${ownerKind.toLowerCase()} ${owner} already has a queue on ${queue.nodepool} (${same.name}) — KRM allows one per pool`);

  const doc = parseAllDocuments(text).find((d) => isMap(d.contents) && d.contents.get('kind') === ownerKind && String(d.contents.getIn(['metadata', 'name'])) === owner);
  const list = doc.contents.getIn(['spec', 'queues'], true);
  const last = isSeq(list) && !list.flow ? list.items.at(-1) : null;
  const first = last?.range?.[0];
  const indent = first === undefined ? null : /^(\s*)-\s+$/.exec(text.slice(text.lastIndexOf('\n', first - 1) + 1, first))?.[1];
  if (indent === null || indent === undefined) throw new Error(`the queues of ${ownerKind.toLowerCase()} ${owner} are not written as a plain list — add this one by hand`);

  let at = last.range[1];
  if (at > 0 && text[at - 1] !== '\n') at = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at) + 1;
  const lead = at > 0 && text[at - 1] !== '\n' ? '\n' : '';
  const body = `${queueLines(queue, indent).join('\n')}\n`;
  entry.owner = { kind: ownerKind, name: owner };
  entry.queue = parseAllDocuments(body)[0].toJS()[0];
  return `${text.slice(0, at)}${lead}${body}${text.slice(at)}`;
}

// --- text ---------------------------------------------------------------------

function queueLines(q, indent) {
  const quota = (deserved, limit, weight) => `{deserved: ${formatNumber(deserved)}, limit: ${formatNumber(limit)}, overQuotaWeight: ${formatNumber(weight)}}`;
  return [
    `${indent}- name: ${scalar(q.name)}`,
    `${indent}  nodepool: ${scalar(q.nodepool)}`,
    ...(Number.isInteger(q.priority) ? [`${indent}  priority: ${q.priority}`] : []),
    `${indent}  resources:`,
    `${indent}    gpu:    ${quota(q.gpu.deserved, q.gpu.limit, q.gpu.overQuotaWeight ?? 1)}`,
    `${indent}    cpu:    ${quota(UNLIMITED, UNLIMITED, 1)}`,
    `${indent}    memory: ${quota(UNLIMITED, UNLIMITED, 1)}`,
  ];
}

/** A string as YAML reads it back: plain when that is unambiguous, quoted otherwise ("true", "123", "on"). */
function scalar(value) {
  const s = String(value);
  const plain = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n|~)$/i.test(s) && !/^[-+.0-9]/.test(s) && !/^0[xo]/i.test(s);
  return plain ? s : JSON.stringify(s);
}

/** Every document: its kind, apiVersion, annotations, and where it ends (the next `---`, or the end of the text). */
function documents(text) {
  return parseAllDocuments(text).filter((d) => !d.errors.length && isMap(d.contents)).map((d) => {
    const js = d.toJS() ?? {};
    return { kind: js.kind, apiVersion: js.apiVersion, annotations: js.metadata?.annotations ?? {}, end: d.range[1] };
  });
}

function syncAnnotations(docs, kind) {
  const sibling = docs.findLast((d) => d.kind === kind);
  return Object.entries(sibling?.annotations ?? {}).filter(([key]) => SYNC_ANNOTATION.test(key));
}

/**
 * What adding these objects sets in motion beyond the numbers.
 *
 * @param {import('./additions.js').Addition[]} added
 * @param {import('./tenancy.js').Tenancy} model
 */
export function additionNotes(added, model, { nodes, namespaces, krm, expectations }) {
  /** @type {import('./validate.js').Finding[]} */
  const out = [];
  const add = (level, code, message, extra = {}) => out.push({ level, code, message, ...extra });

  for (const a of added.filter((x) => x.kind === 'NodePool')) {
    const pool = model.pools.find((p) => p.name === a.name);
    const pair = `${pool.labelKey}=${pool.labelValue}`;
    const where = { pool: pool.name };
    add('info', 'new-pool',
      `node pool ${pool.name}: KRM writes its pool label onto every node labelled ${pair}, starts a scheduler shard of that name, and cordons a node still running a KAI-scheduled pod of another pool. The label pair cannot be changed once the pool exists — to change it, make a new pool`, where);
    if (!nodes) {
      add('info', 'pool-unchecked', `node pool ${pool.name}: the cluster's nodes were not read, so which nodes carry ${pair}${model.managedNodes ? ', and whether the ManagedNodesConfig whitelist covers them,' : ''} is not checked`, where);
      continue;
    }
    const mine = nodes.filter((n) => n.labels?.[pool.labelKey] === pool.labelValue);
    if (!mine.length) {
      add('warning', 'pool-empty', `node pool ${pool.name}: no node is labelled ${pair} — the pool would be empty, and nothing guaranteed on it could run`, where);
      continue;
    }
    if (model.managedNodes) {
      const outside = mine.filter((n) => whitelisted(n.labels, model.managedNodes) === false).map((n) => n.name);
      if (outside.length) {
        add('warning', 'not-whitelisted',
          `node pool ${pool.name}: ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not covered by the ManagedNodesConfig whitelist — KRM keeps nodes outside it in a pool no scheduler serves. Extend the whitelist as well (this tool does not edit it)`, where);
      }
    }
  }

  const newQueues = added.filter((a) => a.kind !== 'NodePool').flatMap((a) => a.queues);
  if (expectations?.source !== undefined) {
    const missing = newQueues.filter((q) => !expectations.source.includes(q));
    if (missing.length) {
      add('info', 'expectations-new', `${expectations.file} has no entry for ${missing.join(', ')} — add ${missing.length === 1 ? 'it' : 'them'} by hand in the same PR, or the script that reads it does not check the new queue${missing.length === 1 ? '' : 's'}`);
    }
  }

  for (const a of added.filter((x) => x.kind === 'Project')) {
    const project = model.projects.find((p) => p.name === a.name);
    const key = krm?.namespaceLabelKey ?? 'kai/project';
    const ns = project.namespace;
    if (!namespaces) {
      add('info', 'namespace-unchecked',
        `project ${project.name}: namespace ${ns} was not looked up. Unless KRM is set to create namespaces it must already exist, labelled ${key}=${project.name}; and from then on KRM's admission webhooks stand in front of every pod created there`);
      continue;
    }
    const labels = namespaces[ns];
    if (!labels) {
      if (krm?.createNamespaces === true) add('info', 'namespace-created', `project ${project.name}: namespace ${ns} does not exist yet — KRM is set to create it`);
      else {
        add('warning', 'namespace-missing',
          `project ${project.name}: namespace ${ns} does not exist${krm ? ', and KRM here is not set to create namespaces (projectController.features.createNamespaces)' : ''} — KRM accepts the project anyway. Create the namespace, labelled ${key}=${project.name}, before workloads can use the queue`);
      }
      continue;
    }
    if (labels[key] && labels[key] !== project.name) {
      add('warning', 'namespace-taken', `project ${project.name}: namespace ${ns} is labelled ${key}=${labels[key]} — it already belongs to project ${labels[key]}`);
    } else if (!labels[key] && krm?.createNamespaces !== true) {
      add('warning', 'namespace-unlabelled', `project ${project.name}: namespace ${ns} exists but is not labelled ${key}=${project.name} — add the label so KRM ties the namespace to the project`);
    }
    add('info', 'namespace-adopted', `project ${project.name}: adopting the existing namespace ${ns} puts KRM's admission webhooks in front of every pod created there from then on`);
  }
  return out;
}
