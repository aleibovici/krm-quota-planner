import { parseFieldId } from './field-id.js';

/** @type {any} source (a cluster or a git ref) + cluster overlay, from /api/state */
export let session = null;
/** @type {any} latest plan from the server */
export let plan = null;
/** id -> planned value, only for values that differ from the file */
export const edits = new Map();
/** Objects and queues to add, in the order they were added. */
export let additions = [];
/** What the pools were last drawn from; when it changes they are drawn again. */
export let drawnShape = '';
/** ResourceQuota file -> include it (only set once the user ticks or unticks) */
export const mirrorChoice = {};
export const typed = { message: false, branch: false };
export let planSeq = 0;

export const fid = (...parts) => parts.join('/');
export const baseValue = (id) => plan.model.base.values[id];
export const value = (id) => {
  const added = addedField(id);
  return added ? added.get() : edits.has(id) ? edits.get(id) : baseValue(id);
};
export const payload = (extra = []) => ({ edits: [...edits].map(([id, v]) => ({ id, value: v })), additions: [...additions, ...extra], mirrors: mirrorChoice });
export const pending = () => edits.size + additions.length;
export const fromCluster = () => session.source.kind === 'cluster';

export function setSession(data) {
  session = data;
  plan = data.plan;
}

export function setPlan(next) {
  plan = next;
}

export function setDrawnShape(shape) {
  drawnShape = shape;
}

export function getDrawnShape() {
  return drawnShape;
}

/** @returns {number} the new sequence number */
export function bumpPlanSeq() {
  planSeq += 1;
  return planSeq;
}

export function getPlanSeq() {
  return planSeq;
}

export function clearAdditions() {
  additions.length = 0;
}

export function pushAddition(item) {
  additions.push(item);
}

export function setAdditions(items) {
  additions.length = 0;
  additions.push(...items);
}

/**
 * A number that belongs to something being added. Null for anything already there.
 */
export function addedField(id) {
  const { kind, owner, queue, rest } = parseFieldId(id);
  for (const a of additions) {
    const q = a.kind === 'Queue'
      ? (a.ownerKind === kind && a.owner === owner && a.queue.name === queue ? a.queue : null)
      : (a.kind === kind && a.name === owner ? a.queues?.find((x) => x.name === queue) : null);
    if (!q) continue;
    if (rest.length === 1 && rest[0] === 'priority') return Number.isInteger(q.priority) ? { get: () => q.priority, set: (v) => { if (Number.isInteger(v)) q.priority = v; } } : null;
    if (rest[0] === 'gpu') return { get: () => q.gpu[rest[1]] ?? 1, set: (v) => { q.gpu[rest[1]] = v; } };
    return null;
  }
  return null;
}
