// Pool / department / queue numbers for the planner UI. Pure: no I/O.
// The server puts this on every plan; the browser recomputes with the same
// code while sliders move (pending edits override planned values).

export const UNLIMITED = -1;
export const GPU_STEP = 0.25;

const fid = (...parts) => parts.join('/');
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * @param {import('./tenancy.js').Tenancy & { values: Record<string, number|null> }} planned slim planned model
 * @param {{
 *   capacity?: Record<string, { cards: number }>,
 *   live?: Record<string, { allocatedGpu?: number }>,
 *   extraPools?: Record<string, { cards: number }>,
 *   liveRead?: boolean,
 * }} ctx
 * @param {(id: string) => number|null|undefined} [lookup] planned value plus any local edits
 */
export function buildDisplay(planned, { capacity = {}, live = {}, extraPools = {}, liveRead = false }, lookup) {
  const v = lookup ?? ((id) => planned.values[id]);

  /** @type {Record<string, {
   *   cards: number|null, promised: number, handed: number, used: number|null, overDepts: boolean, overProjects: boolean,
   *   over: number, spare: number|null, scale: number, capPct?: number, usedPct: number|null,
   *   depts: { queue: string, dept: string, share: number, flex: number, hidden: boolean }[],
   *   free: { flex: number, hidden: boolean },
   * }>} */
  const pools = {};
  /** @type {Record<string, {
   *   pool: string, dept: string, share: number, sum: number, spare: number, over: number, used: number|null, scale: number,
   *   overPool: boolean, overHanded: boolean, tickCount: number,
   *   children: Record<string, { flex: number, hidden: boolean }>,
   *   free: { flex: number, hidden: boolean },
   *   marks: { share?: number },
   *   usedPct: number|null,
   * }>} */
  const departments = {};
  /** @type {Record<string, { scale: number, des: number, lim: number|null, desPct: number, limPct: number, allocated: number|null }>} */
  const queues = {};

  for (const pool of planned.pools) {
    const cap = capacity[pool.name] ?? extraPools[pool.name];
    const cards = cap && cap.cards > 0 ? cap.cards : null;

    const mine = planned.departments.flatMap((dept) => dept.queues
      .filter((q) => q.nodepool === pool.name)
      .map((dq) => ({
        dept,
        dq,
        children: planned.projects.filter((p) => p.parent === dept.name)
          .flatMap((project) => project.queues.filter((q) => q.nodepool === pool.name).map((q) => ({ project, q }))),
      })));

    const promised = sum(mine.map((d) => v(fid('Department', d.dept.name, d.dq.name, 'gpu', 'deserved'))));
    const handed = sum(mine.flatMap((d) => d.children.map((c) => v(fid('Project', c.project.name, c.q.name, 'gpu', 'deserved')))));
    const used = liveRead ? round(sum(mine.flatMap((d) => d.children.map((c) => live[c.q.name]?.allocatedGpu)))) : null;

    // The pool's own bar: one segment per department, as wide as the pool or
    // as wide as what was promised, whichever is more.
    const poolScale = Math.max(cards ?? 0, promised, GPU_STEP);
    const unpromised = cards === null ? 0 : Math.max(0, cards - promised);

    pools[pool.name] = {
      cards,
      promised: round(promised),
      handed: round(handed),
      used,
      overDepts: cards !== null && promised > cards + 1e-9,
      overProjects: handed > promised + 1e-9,
      over: cards === null ? 0 : round(Math.max(0, promised - cards)),
      spare: cards === null ? null : round(unpromised),
      scale: poolScale,
      ...(cards !== null && cards < poolScale - 1e-9 ? { capPct: (cards / poolScale) * 100 } : {}),
      usedPct: used === null ? null : Math.min(100, (used / poolScale) * 100),
      depts: mine.map((d) => {
        const share = Math.max(0, v(fid('Department', d.dept.name, d.dq.name, 'gpu', 'deserved')) ?? 0);
        return { queue: d.dq.name, dept: d.dept.name, share: round(share), flex: (share / poolScale) * 100, hidden: share <= 0 };
      }),
      free: { flex: (unpromised / poolScale) * 100, hidden: unpromised <= 1e-9 },
    };

    for (const { dept, dq, children } of mine) {
      const childId = (c, field) => fid('Project', c.project.name, c.q.name, 'gpu', field);
      const id = (field) => fid('Department', dept.name, dq.name, 'gpu', field);
      const guaranteed = () => sum(children.map((c) => v(childId(c, 'deserved'))));
      const deptShare = () => {
        const d = v(id('deserved'));
        return d === UNLIMITED || d === null || d === undefined ? cards ?? guaranteed() : d;
      };
      const sumVal = guaranteed();
      const share = deptShare();
      const spare = Math.max(0, share - sumVal);
      // The split is drawn on the department's own scale, so its projects fill
      // the bar; the pool's bar is where the department is seen against the pool.
      const s = Math.max(share, sumVal, GPU_STEP);
      const allocated = (c) => (liveRead ? (live[c.q.name]?.allocatedGpu ?? 0) : 0);
      const used = liveRead ? round(sum(children.map(allocated))) : null;
      // One scale for every row of the department, so their gauges compare.
      const rowScale = Math.max(s, ...children.map((c) => Math.max(0, v(childId(c, 'limit')) ?? 0, allocated(c))));

      const childFlex = {};
      for (const c of children) {
        const d = Math.max(0, v(childId(c, 'deserved')) ?? 0);
        childFlex[c.q.name] = { flex: (d / s) * 100, hidden: d <= 0 };
        const des = Math.max(0, v(childId(c, 'deserved')) ?? 0);
        const lim = v(childId(c, 'limit'));
        queues[c.q.name] = {
          scale: rowScale,
          des,
          lim,
          desPct: Math.min(100, (des / rowScale) * 100),
          limPct: lim === UNLIMITED ? 100 : Math.min(100, (Math.max(0, lim ?? 0) / rowScale) * 100),
          allocated: liveRead ? (live[c.q.name]?.allocatedGpu ?? 0) : null,
        };
      }

      departments[dq.name] = {
        pool: pool.name,
        dept: dept.name,
        share,
        sum: round(sumVal),
        spare: round(spare),
        over: round(Math.max(0, sumVal - share)),
        used,
        usedPct: used === null ? null : Math.min(100, (used / s) * 100),
        scale: s,
        overPool: share > (cards ?? Infinity) + 1e-9,
        overHanded: sumVal > share + 1e-9,
        tickCount: Number.isInteger(s) && s <= 16 ? s : 0,
        children: childFlex,
        free: { flex: (spare / s) * 100, hidden: spare <= 1e-9 },
        marks: share < s - 1e-9 ? { share: (share / s) * 100 } : {},
      };
    }
  }

  return { pools, departments, queues };
}

function sum(nums) {
  return nums.reduce((s, n) => s + Math.max(0, n ?? 0), 0);
}
