// Small helpers shared by the UI and its tests (no I/O).

/** When the pool DOM must be rebuilt (structure changed). */
export function shapeOf(model) {
  return JSON.stringify([
    model.pools,
    model.departments.map((d) => [d.name, d.queues.map((q) => [q.name, q.nodepool])]),
    model.projects.map((p) => [p.name, p.parent, p.namespace, p.queues.map((q) => [q.name, q.nodepool, q.priority === null])]),
  ]);
}

/** Suffix for auto-generated queue names on a pool. */
export function queueSuffix(model, pool) {
  for (const owner of [...model.departments, ...model.projects]) {
    const q = owner.queues.find((x) => x.nodepool === pool && x.name.startsWith(`${owner.name}-`));
    if (q) return q.name.slice(owner.name.length + 1);
  }
  return pool;
}

/** Remove one addition and anything that only existed because of it. */
export function cascadeRemoveAdditions(additions, index) {
  const gone = [additions[index]];
  let kept = additions.filter((a, i) => i !== index);
  for (const g of gone) {
    const needs = (a) => {
      if (g.kind === 'NodePool') return a.kind === 'Queue' ? a.queue.nodepool === g.name : (a.queues ?? []).some((q) => q.nodepool === g.name);
      if (g.kind === 'Queue') return false;
      return (a.kind === 'Queue' && a.ownerKind === g.kind && a.owner === g.name) || (g.kind === 'Department' && a.kind === 'Project' && a.parent === g.name);
    };
    gone.push(...kept.filter(needs));
    kept = kept.filter((a) => !needs(a));
  }
  return kept;
}

/**
 * Which pools an owner (a project or a department) is on, and what each tick
 * box in the pool picker may do. A queue that is in the source stays: this
 * tool adds, it does not delete. The queue a new object was created with
 * stays too, because an object needs at least one. A queue added on its own
 * can be taken back.
 *
 * @returns {{ pool: any, state: 'source'|'first'|'added'|'free'|'blocked', queue?: any, index?: number, why?: string }[]}
 */
export function poolChoices(model, additions, ownerKind, owner) {
  const parent = ownerKind === 'Project' ? model.departments.find((d) => d.name === owner.parent) : null;
  return model.pools.map((pool) => {
    const queue = owner.queues.find((q) => q.nodepool === pool.name);
    if (queue) {
      const index = additions.findIndex((a) => a.kind === 'Queue' && a.ownerKind === ownerKind && a.owner === owner.name && a.queue.nodepool === pool.name);
      if (index !== -1) return { pool, state: 'added', queue, index };
      const own = additions.some((a) => a.kind === ownerKind && a.name === owner.name && a.queues.some((q) => q.nodepool === pool.name));
      return own
        ? { pool, state: 'first', queue, why: `${queue.name} is the queue it is being created with — an object needs at least one` }
        : { pool, state: 'source', queue, why: `${queue.name} is already there — this tool adds queues, it does not remove them` };
    }
    if (parent && !parent.queues.some((q) => q.nodepool === pool.name)) {
      return { pool, state: 'blocked', why: `department ${parent.name} has no queue on ${pool.name} — give it one first` };
    }
    return { pool, state: 'free' };
  });
}
