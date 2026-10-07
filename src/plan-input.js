// Turn loaded session state plus an API body into buildPlan() arguments.

import { capacityOf } from './cluster.js';

/**
 * @param {import('./core/config.js').PlannerConfig} config
 * @param {{
 *   files: Record<string, string|undefined>,
 *   notes: import('./core/validate.js').Finding[],
 *   base: { ref: string, sha: string, kind?: 'cluster'|'git' },
 *   live: import('./cluster.js').LiveRead,
 * }} state
 * @param {{ edits?: unknown, additions?: unknown, mirrors?: unknown }} [body]
 * @returns {Parameters<typeof import('./core/plan.js').buildPlan>[0]}
 */
export function planInput(config, state, body = {}) {
  const { live } = state;
  const clusterOk = live.ok;
  return {
    config,
    files: state.files,
    edits: Array.isArray(body.edits) ? body.edits : [],
    additions: Array.isArray(body.additions) ? body.additions.slice(0, 100) : [],
    mirrors: body.mirrors && typeof body.mirrors === 'object' ? body.mirrors : {},
    capacity: capacityOf(live),
    live: clusterOk ? live.queues : undefined,
    nodes: clusterOk ? live.nodes : undefined,
    namespaces: clusterOk ? live.namespaces : undefined,
    krm: clusterOk ? live.krm : undefined,
    notes: state.notes,
    base: state.base,
    today: new Date().toLocaleDateString('en-CA'),
  };
}
