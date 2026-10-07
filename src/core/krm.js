// KRM objects as the API server returns them, turned into what the rest of
// the core works on: one multi-document YAML text.
//
// A live object carries a great deal that is not the decision (status with
// the current allocation, uid, resourceVersion, finalizers, tool
// annotations). Only apiVersion, kind, name and spec are kept, in a fixed
// order, so the text changes when somebody changes a quota and at no other
// time — a Project's status moves every time a pod starts.
//
// Pure: no cluster, no clock. The source layer feeds it `kubectl get -o json`.

import { stringify } from 'yaml';
import { KRM_DOC_ORDER } from './tenancy.js';

const ORDER = KRM_DOC_ORDER;
const PLURAL = { Department: 'departments.kai.resources', Project: 'projects.kai.resources' };

/**
 * @param {any[]} items NodePools, the ManagedNodesConfig, Departments and Projects, in any order
 * @returns {{
 *   source: string,
 *   objects: { apiVersion: string, kind: string, metadata: { name: string }, spec: any }[],
 *   managed: { kind: string, name: string, by: string }[]   objects a GitOps controller owns
 * }}
 */
export function renderTenancy(items) {
  const known = items.filter((i) => ORDER.includes(i?.kind) && i.metadata?.name);
  const queuesOf = (i) => (Array.isArray(i.spec?.queues) ? i.spec.queues : []);
  const used = new Set(known.flatMap((i) => queuesOf(i).map((q) => q?.nodepool)));

  const kept = known
    // KRM's built-in "default" pool has no selector; show it only if a queue is on it.
    .filter((i) => i.kind !== 'NodePool' || i.spec?.labelKey || used.has(i.metadata.name))
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.metadata.name < b.metadata.name ? -1 : a.metadata.name > b.metadata.name ? 1 : 0));

  const objects = kept.map((i) => ({ apiVersion: i.apiVersion, kind: i.kind, metadata: { name: i.metadata.name }, spec: i.spec ?? {} }));
  const managed = kept
    .filter((i) => PLURAL[i.kind])
    .map((i) => ({ kind: i.kind, name: i.metadata.name, by: managedBy(i.metadata) }))
    .filter((m) => m.by);

  return { source: objects.map((o) => `---\n${stringify(o, { lineWidth: 0 })}`).join(''), objects, managed };
}

/** Which GitOps controller, if any, will put this object back the way its repository has it. */
function managedBy(metadata) {
  const annotations = metadata.annotations ?? {};
  const labels = metadata.labels ?? {};
  const argo = annotations['argocd.argoproj.io/tracking-id']?.split(':')[0] || labels['argocd.argoproj.io/instance'];
  if (argo) return `Argo CD application ${argo}`;
  const flux = labels['kustomize.toolkit.fluxcd.io/name'] || labels['helm.toolkit.fluxcd.io/name'];
  if (flux) return `Flux ${flux}`;
  return '';
}

/**
 * The commands that make a plan true on the cluster: one `kubectl patch` per
 * changed object, as JSON Patch, and one `kubectl create` per new object.
 *
 * Every replace is preceded by a test of the value it replaces (and of the
 * queue's name at that index), so a command built from an old read fails
 * instead of overwriting whatever changed since; a new queue is appended
 * after a test of the queue it follows; `create` fails if the name has been
 * taken. The commands are separate requests, so they are ordered so that
 * each one is acceptable when it runs, and a guarantee is released before it
 * is handed on: new pools; objects that give cards up (projects, then their
 * department); new departments and departments that gain; new projects and
 * projects that gain.
 *
 * @param {{ kind: string, metadata: { name: string }, spec: any }[]} objects as read (before the plan)
 * @param {{ id: string, from: number|null, to: number }[]} changes
 * @param {{ context?: string, kubeconfig?: string }} [target]
 * @param {import('./additions.js').Added[]} [additions]
 * @returns {string[]}
 */
export function patchCommands(objects, changes, { context, kubeconfig } = {}, additions = []) {
  /** @type {Map<string, { kind: string, name: string, guarded: Set<number>, gained: number, grows?: boolean, manifest?: string, ops: any[] }>} */
  const perObject = new Map();
  const added = additions.filter((a) => !a.error);
  for (const a of added.filter((x) => x.manifest)) {
    perObject.set(`${a.kind}/${a.name}`, { kind: a.kind, name: a.name, guarded: new Set(), gained: 1, manifest: a.manifest, ops: [] });
  }
  for (const a of added.filter((x) => x.owner)) {
    const key = `${a.owner.kind}/${a.owner.name}`;
    if (perObject.get(key)?.manifest) continue; // its owner is new too: the queue is already in what gets created
    const object = objects.find((o) => o.kind === a.owner.kind && o.metadata.name === a.owner.name);
    const queues = Array.isArray(object?.spec?.queues) ? object.spec.queues : null;
    if (!queues?.length || !PLURAL[a.owner.kind]) throw new Error(`${key}: not among the objects read from the cluster`);
    if (!perObject.has(key)) perObject.set(key, { kind: a.owner.kind, name: a.owner.name, guarded: new Set(), gained: 0, ops: [] });
    const entry = perObject.get(key);
    if (!entry.grows) entry.ops.push({ op: 'test', path: `/spec/queues/${queues.length - 1}/name`, value: queues.at(-1).name });
    entry.grows = true;
    entry.ops.push({ op: 'add', path: '/spec/queues/-', value: a.queue });
  }
  for (const change of changes) {
    const [kind, owner, queue, ...rest] = change.id.split('/');
    const object = objects.find((o) => o.kind === kind && o.metadata.name === owner);
    const index = Array.isArray(object?.spec?.queues) ? object.spec.queues.findIndex((q) => q?.name === queue) : -1;
    if (index < 0 || !PLURAL[kind]) throw new Error(`${change.id}: not among the objects read from the cluster`);

    const key = `${kind}/${owner}`;
    if (!perObject.has(key)) perObject.set(key, { kind, name: owner, guarded: new Set(), gained: 0, ops: [] });
    const entry = perObject.get(key);
    const at = `/spec/queues/${index}`;
    // Values go before a queue is appended, so the indexes they test are the ones that were read.
    const values = entry.grows ? entry.ops.findIndex((o) => o.op === 'add') - 1 : entry.ops.length;
    const ops = [];
    if (!entry.guarded.has(index)) {
      entry.guarded.add(index);
      ops.push({ op: 'test', path: `${at}/name`, value: queue });
    }
    const path = rest.length === 1 ? `${at}/${rest[0]}` : `${at}/resources/${rest.join('/')}`;
    if (change.from !== null) ops.push({ op: 'test', path, value: change.from });
    ops.push({ op: 'replace', path, value: change.to });
    entry.ops.splice(values, 0, ...ops);
    if (rest.join('/') === 'gpu/deserved') entry.gained += cardsOf(change.to) - cardsOf(change.from);
  }

  const kubectl = ['kubectl', ...(kubeconfig ? ['--kubeconfig', kubeconfig] : []), ...(context ? ['--context', context] : [])];
  return [...perObject.values()].sort((a, b) => turn(a) - turn(b)).map(({ kind, name, ops, manifest }) => (manifest
    ? `${[...kubectl, 'create', '-f', '-'].map(shellWord).join(' ')} <<'EOF'\n${manifest}EOF`
    : [...kubectl, 'patch', PLURAL[kind], name, '--type=json', '-p', JSON.stringify(ops)].map(shellWord).join(' ')));
}

/**
 * Which refusals in a dry-run's output are only there because the dry-run
 * stores nothing: an object that refers to a pool or a department the same
 * plan adds is turned away, since the API server cannot see the new one.
 *
 * @param {string[]} lines kubectl's output
 * @param {import('./additions.js').Added[]} additions
 * @returns {{ expected: string[], other: number }} the refusals explained that way, and how many are not
 */
export function dependentRefusals(lines, additions) {
  const names = (kind) => additions.filter((a) => !a.error && a.kind === kind).map((a) => a.name);
  const pools = names('NodePool');
  const departments = names('Department');
  const explained = (reason) => pools.some((n) => reason.includes(`node pool "${n}" does not exist`)) || departments.some((n) => reason.includes(`parent department "${n}" does not exist`));
  const expected = [];
  let other = 0;
  for (const line of lines) {
    // KRM's webhooks list their reasons one per line; other refusals carry theirs on the line itself.
    const reason = /^\s*\* (.+)$/.exec(line)?.[1] ?? /denied the request: (?!\d+ errors? occurred:)(.+)$/.exec(line)?.[1];
    if (reason !== undefined) {
      if (explained(reason)) expected.push(reason.trim());
      else other += 1;
    } else if (/^(error:|The |Error from server)/.test(line) && !/(\d+ errors? occurred|error when applying patch):\s*$/.test(line)) {
      other += 1;
    }
  }
  return { expected, other };
}

/**
 * When an object's command runs: new pools; shrinking projects, shrinking
 * departments; the rest; new departments, growing departments; new projects,
 * growing projects.
 */
function turn({ kind, gained, grows, manifest }) {
  if (manifest) return { NodePool: 0, Department: 4, Project: 6 }[kind];
  if (gained < 0 && !grows) return kind === 'Project' ? 1 : 2;
  if (gained > 0 || grows) return kind === 'Department' ? 5 : 7;
  return 3;
}
/** A guarantee as a number that orders correctly: -1 is unlimited, the most there is. */
const cardsOf = (n) => (n === -1 ? Number.MAX_SAFE_INTEGER : n ?? 0);
const shellWord = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);
