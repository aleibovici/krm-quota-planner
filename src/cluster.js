// Read-only view of the live cluster, through kubectl.
//
// Two things are read here: the KRM objects themselves, when the cluster is
// where the plan starts from (see sources.js), and what is true right now
// whatever the source — the cards in each pool and what each queue is using.
// The cluster is never written to: every call is a `get`, or an
// `apply --dry-run=server`, which the API server evaluates and discards.

import { exec, run } from './exec.js';
import { parseQuantity } from './core/quantity.js';
import { poolOf, capacityOfPool } from './core/pools.js';

const GPU = 'nvidia.com/gpu';

const KRM_KINDS = ['nodepools.kai.resources', 'departments.kai.resources', 'projects.kai.resources'];

/** @typedef {{ context?: string, kubeconfig?: string }} Target which cluster, as kubectl names it */

const flags = ({ context, kubeconfig } = {}) => [...(kubeconfig ? ['--kubeconfig', kubeconfig] : []), ...(context ? ['--context', context] : [])];

function kubectl(args, { context, kubeconfig, input, timeoutMs = 15_000 } = {}) {
  return run('kubectl', [...flags({ context, kubeconfig }), ...args], { input, timeoutMs }).catch((err) => {
    // Silence is nearly always the road to the cluster, not the cluster: say where to look.
    if (/no answer after/.test(err.message)) err.message = `${context || 'the cluster'} did not answer (${err.message}) — check the VPN or network, and that your login has not expired`;
    throw err;
  });
}

/** @param {Target} [target] */
export async function currentContext({ kubeconfig } = {}) {
  return (await kubectl(['config', 'current-context'], { kubeconfig })).trim();
}

/** Every context the kubeconfig offers, by name. @param {Target} [target] */
export async function listContexts({ kubeconfig } = {}) {
  return (await kubectl(['config', 'get-contexts', '-o', 'name'], { kubeconfig })).split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * The NodePools, Departments and Projects as the API server has them.
 * @param {Target} [target]
 * @returns {Promise<any[]>}
 */
export async function readKrmObjects(target = {}) {
  let out;
  try {
    out = await kubectl(['get', KRM_KINDS.join(','), '-o', 'json'], target);
  } catch (err) {
    if (/doesn't have a resource type/.test(err.message)) {
      throw new Error(`${target.context || 'this cluster'} has no KAI Resource Management objects (the kai.resources CRDs are not installed) — pass --context for another cluster, or --repo to plan from a repository`);
    }
    throw err;
  }
  // The whitelist is read on its own: not being allowed to see it must not
  // stop someone planning quotas. Without it, new pools are not checked against it.
  const whitelist = await kubectl(['get', 'managednodesconfigs.kai.resources', '-o', 'json'], target).then((o) => JSON.parse(o).items ?? [], () => []);
  return [...(JSON.parse(out).items ?? []), ...whitelist];
}

/**
 * @param {Target} [target]
 * @returns {Promise<{
 *   ok: boolean, error?: string, context: string, readAt: string,
 *   queues: Record<string, { deserved: number|null, limit: number|null, allocatedGpu: number, allocatedNonPreemptibleGpu: number, parent: string }>,
 *   pools: Record<string, { cards: number, allocatable: number, settled: boolean, nodes: { name: string, cards: number, allocatable: number, product: string, memoryMiB: number|null, ready: boolean }[] }>,
 *   nodes: import('./core/pools.js').Node[],
 *   namespaces: Record<string, Record<string, string>>|null,   name -> labels; null when they could not be listed
 *   krm: { createNamespaces: boolean|null, namespaceLabelKey: string }|null   what KRM does about a project's namespace; null when its config could not be read
 * }>}
 */
export async function readLive(target = {}) {
  const result = { ok: false, context: target.context ?? '', readAt: new Date().toISOString(), queues: {}, pools: {}, nodes: [], namespaces: null, krm: null };
  try {
    if (!target.context) result.context = await currentContext(target);
    const [queues, pools, nodes] = await Promise.all([
      kubectl(['get', 'queues.scheduling.run.ai', '-o', 'json'], target),
      kubectl(['get', 'nodepools.kai.resources', '-o', 'json'], target),
      kubectl(['get', 'nodes', '-o', 'json'], target),
    ]);

    for (const q of JSON.parse(queues).items ?? []) {
      const gpu = q.spec?.resources?.gpu ?? {};
      const gpuOf = (bag) => {
        const n = parseQuantity(bag?.[GPU]);
        return Number.isFinite(n) ? n : 0;
      };
      result.queues[q.metadata.name] = {
        deserved: typeof gpu.quota === 'number' ? gpu.quota : null, // live Queues say "quota", the KRM objects say "deserved"
        limit: typeof gpu.limit === 'number' ? gpu.limit : null,
        allocatedGpu: gpuOf(q.status?.allocated),
        allocatedNonPreemptibleGpu: gpuOf(q.status?.allocatedNonPreemptible),
        parent: q.spec?.parentQueue ?? '',
      };
    }

    result.nodes = (JSON.parse(nodes).items ?? []).map(describeNode);
    result.pools = poolsOf(JSON.parse(pools).items ?? [], result.nodes);
    result.ok = true;

    // Only needed to say whether a new project's namespace is ready for it;
    // either may be off limits to someone who can still plan quotas.
    const [namespaces, config] = await Promise.all([
      kubectl(['get', 'namespaces', '-o', 'json'], target).then(JSON.parse, () => null),
      kubectl(['get', 'krmconfigs.kai.resources', '-o', 'json'], target).then(JSON.parse, () => null),
    ]);
    if (namespaces) result.namespaces = Object.fromEntries((namespaces.items ?? []).map((n) => [n.metadata.name, n.metadata.labels ?? {}]));
    const spec = config?.items?.[0]?.spec;
    if (spec) {
      const creates = spec.projectController?.features?.createNamespaces;
      result.krm = { createNamespaces: typeof creates === 'boolean' ? creates : null, namespaceLabelKey: spec.global?.namespaceProjectLabelKey || 'kai/project' };
    }
  } catch (err) {
    result.error = err.message;
  }
  return result;
}

/**
 * Which nodes make up each KRM NodePool, and how many cards they hold.
 *
 * No single field is the truth about the hardware:
 *   - `allocatable` is what the device plugin offers this minute. It is right
 *     when everything is up and drops to nothing while a plugin or driver
 *     restarts — exactly when someone may be replanning.
 *   - `capacity` follows the plugin too.
 *   - the `nvidia.com/gpu.count` label survives a plugin restart, but GPU
 *     Feature Discovery counts ONE model: on the mixed RTX server (2 Server
 *     Edition + 2 Max-Q) it says 2 where nvidia-smi shows 4 (seen 2026-10-07).
 * So a node's cards are the largest of the three, and the pool is `settled`
 * only when every node is ready and offering all of them. An unsettled count
 * may be too low, and must not be used to refuse a plan.
 */
export function describePools(pools, nodes) {
  return poolsOf(pools, nodes.map(describeNode));
}

function poolsOf(pools, nodes) {
  const out = {};
  for (const pool of pools) {
    const { labelKey, labelValue } = pool.spec ?? {};
    if (!labelKey) continue; // KRM's built-in "default" pool has no selector and no queues here
    out[pool.metadata.name] = poolOf(nodes, labelKey, labelValue);
  }
  return out;
}

/** @returns {import('./core/pools.js').Node} */
function describeNode(n) {
  const finite = (x) => (Number.isFinite(x) && x > 0 ? x : 0);
  const labels = n.metadata.labels ?? {};
  const allocatable = finite(parseQuantity(n.status?.allocatable?.[GPU]));
  const capacity = finite(parseQuantity(n.status?.capacity?.[GPU]));
  const labelled = finite(Number(labels['nvidia.com/gpu.count']));
  const memory = Number(labels['nvidia.com/gpu.memory']);
  return {
    name: n.metadata.name,
    labels,
    cards: Math.max(allocatable, capacity, labelled),
    allocatable,
    product: labels['nvidia.com/gpu.product'] ?? '',
    memoryMiB: Number.isFinite(memory) ? memory : null,
    ready: (n.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True') && !n.spec?.unschedulable,
  };
}

/** pool -> what validation may rely on. Undefined when the cluster was not read. */
export function capacityOf(live) {
  if (!live?.ok) return undefined;
  return Object.fromEntries(Object.entries(live.pools).map(([name, p]) => [name, capacityOfPool(p)]));
}

/**
 * Ask the API server whether it would accept the planned objects.
 * Evaluated by admission and discarded; nothing is persisted.
 */
export async function dryRun(yaml, target = {}) {
  const r = await exec('kubectl', [...flags(target), 'apply', '--dry-run=server', '-f', '-'], { input: yaml, timeoutMs: 30_000 });
  const lines = (r.stdout + r.stderr).split('\n').filter((l) => l.trim() && !l.includes('last-applied-configuration'));
  return { ok: r.code === 0, lines };
}
