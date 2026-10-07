// Quota arithmetic checks.
//
// Nothing on the cluster does this. Measured against KRM v0.18.2 / KAI
// v0.18.2 by server dry-run (2026-10-07): the KRM webhooks accept children
// that add up to more than their department, deserved above limit, a
// department above the pool's card count and negative quotas other than -1;
// the only thing they reject is an unknown node pool. KAI's own Queue
// webhook has a parent/child check that can only ever warn, and it said
// nothing for any of those cases here. A wrong split therefore syncs cleanly
// and silently stops being a guarantee. These rules are the guard.

import { RESOURCES, QUOTA_FIELDS, UNLIMITED, formatNumber } from './tenancy.js';

/**
 * @typedef {{ level: 'error'|'warning'|'info', code: string, message: string, queue?: string, pool?: string }} Finding
 */

const EPS = 1e-9;
const fmt = (n) => (n === UNLIMITED ? 'unlimited' : formatNumber(n));
const UNIT = { gpu: (n) => `${fmt(n)} ${n === 1 ? 'card' : 'cards'}`, cpu: (n) => `${fmt(n)} mCPU`, memory: (n) => `${fmt(n)} MB` };
const amount = (resource, n) => (n === UNLIMITED ? 'unlimited' : UNIT[resource](n));

/**
 * @param {import('./tenancy.js').Tenancy} model the tenancy AFTER the planned edits
 * @param {{
 *   capacity?: Record<string, { cards?: number, allocatable?: number, settled?: boolean, notReady?: string[] }>,
 *   live?: Record<string, { allocatedGpu?: number, allocatedNonPreemptibleGpu?: number }>
 * }} [context]
 * @returns {Finding[]}
 */
export function validate(model, context = {}) {
  /** @type {Finding[]} */
  const out = [];
  const add = (level, code, message, extra = {}) => out.push({ level, code, message, ...extra });
  const pools = new Set(model.pools.map((p) => p.name));
  const departments = new Map(model.departments.map((d) => [d.name, d]));

  for (const p of model.problems) add('error', 'file', p);

  const allQueues = [...model.departments.flatMap((d) => d.queues), ...model.projects.flatMap((p) => p.queues)];

  // --- names that must not be used twice ------------------------------------
  // Asked of the API server by dry-run (KRM v0.18.2, 2026-10-07): it rejects
  // two queues on one pool in one object, and a pool selecting the same label
  // pair as another. It ACCEPTS a queue name that another object already
  // uses, and a second project on a namespace — both are caught here only.
  const twice = (items) => [...new Set(items.filter((x, i) => x && items.indexOf(x) !== i))];
  for (const [kind, list] of [['NodePool', model.pools], ['Department', model.departments], ['Project', model.projects]]) {
    for (const name of twice(list.map((o) => o.name))) add('error', 'duplicate', `${kind} ${name} is defined twice`);
  }
  for (const name of twice(allQueues.map((q) => q.name))) {
    const owners = allQueues.filter((q) => q.name === name).map((q) => `${q.ownerKind.toLowerCase()} ${q.owner}`);
    add('error', 'duplicate-queue', `queue ${name} is used by ${owners.join(' and ')} — queue names are shared by the whole cluster, so they would be one queue (KRM does not refuse this)`, { queue: name });
  }
  for (const owner of [...model.departments, ...model.projects]) {
    for (const pool of twice(owner.queues.map((q) => q.nodepool))) {
      add('error', 'pool-twice', `${owner.name}: more than one queue on node pool ${pool} — KRM allows one per pool (it rejects the object)`, { pool });
    }
  }
  for (const namespace of twice(model.projects.map((p) => p.namespace))) {
    add('error', 'namespace-shared', `namespace ${namespace} is claimed by projects ${model.projects.filter((p) => p.namespace === namespace).map((p) => p.name).join(' and ')} — a namespace belongs to one project (KRM does not refuse this)`);
  }
  const selects = (p) => (p.labelKey ? `${p.labelKey}=${p.labelValue}` : '');
  for (const pair of twice(model.pools.map(selects))) {
    add('error', 'pool-overlap', `node pools ${model.pools.filter((p) => selects(p) === pair).map((p) => p.name).join(' and ')} both select ${pair} — a node belongs to one pool (KRM rejects the second)`);
  }

  // --- each queue on its own ------------------------------------------------
  for (const q of allQueues) {
    const where = { queue: q.name, pool: q.nodepool };
    if (!pools.has(q.nodepool)) {
      add('error', 'unknown-pool', `${q.name}: node pool "${q.nodepool}" is not defined (KRM rejects the object)`, where);
    }
    if (q.priority !== null && !Number.isInteger(q.priority)) {
      add('error', 'priority', `${q.name}: priority must be a whole number, got ${q.priority}`, where);
    }
    for (const resource of RESOURCES) {
      const r = q.resources[resource];
      if (!r) continue;
      if (QUOTA_FIELDS.some((f) => r[f] === null)) continue; // already reported as a file problem
      for (const f of ['deserved', 'limit']) {
        if (r[f] < 0 && r[f] !== UNLIMITED) {
          add('error', 'negative', `${q.name}: ${resource} ${f} is ${r[f]} — use 0 or more, or -1 for unlimited`, where);
        }
      }
      if (r.overQuotaWeight < 0) {
        add('error', 'weight', `${q.name}: ${resource} overQuotaWeight is ${r.overQuotaWeight} — it cannot be negative`, where);
      }
      if (r.limit !== UNLIMITED && (r.deserved === UNLIMITED || r.deserved > r.limit + EPS)) {
        add('error', 'deserved-over-limit',
          `${q.name}: ${resource} guarantee (${amount(resource, r.deserved)}) is above its limit (${amount(resource, r.limit)}) — the queue could never reach what it is promised`, where);
      }
    }
  }

  // --- projects against their department -------------------------------------
  for (const project of model.projects) {
    const parent = departments.get(project.parent);
    if (!parent) {
      add('error', 'unknown-parent', `project ${project.name}: parent department "${project.parent}" is not defined`);
      continue;
    }
    // KRM accepts this (dry-run, v0.18.2), and then there is no department
    // share on that pool for the guarantee to come out of, or to check it against.
    for (const q of project.queues) {
      if (pools.has(q.nodepool) && !parent.queues.some((dq) => dq.nodepool === q.nodepool)) {
        add('warning', 'no-department-queue',
          `${q.name}: department ${parent.name} has no queue on node pool ${q.nodepool} — this guarantee is not part of any department's share, and is not checked against one`, { queue: q.name, pool: q.nodepool });
      }
    }
  }

  for (const dept of model.departments) {
    for (const dq of dept.queues) {
      const children = model.projects
        .filter((p) => p.parent === dept.name)
        .flatMap((p) => p.queues.filter((q) => q.nodepool === dq.nodepool));
      const where = { queue: dq.name, pool: dq.nodepool };

      for (const resource of RESOURCES) {
        const d = dq.resources[resource];
        if (!d || d.deserved === null || d.limit === null) continue;
        const kids = children.filter((c) => c.resources[resource] && c.resources[resource].deserved !== null);

        if (d.deserved !== UNLIMITED) {
          const open = kids.filter((c) => c.resources[resource].deserved === UNLIMITED);
          for (const c of open) {
            add('error', 'child-unlimited',
              `${c.name}: ${resource} guarantee is unlimited, but its department queue ${dq.name} only has ${amount(resource, d.deserved)}`, { queue: c.name, pool: dq.nodepool });
          }
          const sum = kids.reduce((s, c) => s + Math.max(0, c.resources[resource].deserved), 0);
          if (sum > d.deserved + EPS) {
            add('error', 'oversubscribed',
              `${dq.name}: the projects are guaranteed ${amount(resource, sum)} in total, but the department only has ${amount(resource, d.deserved)} — ` +
              `${amount(resource, sum - d.deserved)} of those guarantees cannot be met`, where);
          } else if (resource === 'gpu' && !open.length && d.deserved - sum > EPS) {
            add('info', 'unassigned',
              `${dq.name}: ${amount('gpu', d.deserved - sum)} of the department's share ${d.deserved - sum === 1 ? 'is' : 'are'} not guaranteed to any project (shared by over-quota weight)`, where);
          }
        }

        if (d.limit !== UNLIMITED) {
          for (const c of kids) {
            const cl = c.resources[resource].limit;
            if (cl === null) continue;
            if (cl === UNLIMITED || cl > d.limit + EPS) {
              add('warning', 'child-limit',
                `${c.name}: ${resource} limit (${amount(resource, cl)}) is above the department's (${amount(resource, d.limit)}) — the department limit wins`, { queue: c.name, pool: dq.nodepool });
            }
          }
        }
      }
    }
  }

  // --- departments against the hardware ---------------------------------------
  for (const pool of model.pools) {
    const known = context.capacity?.[pool.name];
    const cards = known?.cards;
    const deptQueues = model.departments.flatMap((d) => d.queues.filter((q) => q.nodepool === pool.name && q.resources.gpu));
    if (!deptQueues.length) continue;
    if (!Number.isFinite(cards)) {
      add('info', 'capacity-unknown',
        `pool ${pool.name}: card count unknown (${known ? 'its nodes report no GPUs right now' : 'nodes not read'}) — guarantees are not checked against the hardware`, { pool: pool.name });
      continue;
    }
    // An unsettled pool (a node not ready, a device plugin or driver
    // restarting) may be showing fewer cards than it has. Say so, and do not
    // refuse a plan on that number.
    const settled = known.settled !== false;
    if (!settled) {
      const offered = Number.isFinite(known.allocatable) ? known.allocatable : 0;
      const down = known.notReady?.length ? `${known.notReady.join(', ')} not ready` : 'device plugin or driver restarting?';
      add('warning', 'cards-unavailable',
        `pool ${pool.name}: only ${amount('gpu', offered)} of ${fmt(cards)} schedulable right now (${down}) — the card count may be understated, so the capacity check below is advisory`, { pool: pool.name });
    }
    const promised = deptQueues.reduce((s, q) => s + Math.max(0, q.resources.gpu.deserved ?? 0), 0);
    if (promised > cards + EPS) {
      add(settled ? 'error' : 'warning', 'over-capacity',
        `pool ${pool.name}: departments are guaranteed ${amount('gpu', promised)}, the pool ${settled ? 'has' : 'currently shows'} ${amount('gpu', cards)}`, { pool: pool.name });
    }
    for (const q of deptQueues) {
      const l = q.resources.gpu.limit;
      if (settled && l !== null && l !== UNLIMITED && l > cards + EPS) {
        add('warning', 'limit-over-capacity', `${q.name}: limit of ${amount('gpu', l)} is more than the pool's ${amount('gpu', cards)}`, { queue: q.name, pool: pool.name });
      }
    }
  }

  // --- the plan against what is running right now ----------------------------
  for (const q of allQueues) {
    const gpu = q.resources.gpu;
    const live = context.live?.[q.name];
    if (!gpu || !live || gpu.limit === null || gpu.deserved === null) continue;
    const where = { queue: q.name, pool: q.nodepool };
    if (gpu.limit !== UNLIMITED && Number.isFinite(live.allocatedGpu) && live.allocatedGpu > gpu.limit + 1e-6) {
      add('warning', 'running-over-limit',
        `${q.name}: ${amount('gpu', round(live.allocatedGpu))} in use right now, above the planned limit of ${amount('gpu', gpu.limit)} — nothing is evicted, but nothing new starts until usage drops`, where);
    }
    if (gpu.deserved !== UNLIMITED && Number.isFinite(live.allocatedNonPreemptibleGpu) && live.allocatedNonPreemptibleGpu > gpu.deserved + 1e-6) {
      add('warning', 'running-over-deserved',
        `${q.name}: ${amount('gpu', round(live.allocatedNonPreemptibleGpu))} held by non-preemptible workloads right now, above the planned guarantee of ${amount('gpu', gpu.deserved)} — KAI does not evict them, so the share handed to others is not available until they stop`, where);
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}

const round = (n) => Math.round(n * 100) / 100;
