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
