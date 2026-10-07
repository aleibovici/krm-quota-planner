// Which nodes make up a pool, and how many cards they hold — from a list of
// nodes and the pool's label pair. Works the same for a pool that exists and
// for one that is only planned.
//
// Pure: the cluster layer turns `kubectl get nodes` into the node records.

/**
 * @typedef {{ name: string, labels: Record<string, string>, cards: number, allocatable: number, product: string, memoryMiB: number|null, ready: boolean }} Node
 */

/**
 * @param {Node[]} nodes
 * @param {string} labelKey
 * @param {string} labelValue
 */
export function poolOf(nodes, labelKey, labelValue) {
  const mine = nodes.filter((n) => n.labels?.[labelKey] === labelValue);
  const cards = mine.reduce((s, n) => s + n.cards, 0);
  const allocatable = mine.reduce((s, n) => s + n.allocatable, 0);
  return {
    cards,
    allocatable,
    // An unsettled count may be too low, and must not be used to refuse a plan.
    settled: mine.length > 0 && cards > 0 && allocatable >= cards && mine.every((n) => n.ready),
    nodes: mine.map(({ labels, ...rest }) => rest),
  };
}

/** What validation may rely on, for one pool described by poolOf. */
export function capacityOfPool(pool) {
  return {
    cards: pool.cards > 0 ? pool.cards : undefined, // no node reports a GPU: unknown, not zero
    allocatable: pool.allocatable,
    settled: pool.settled,
    notReady: pool.nodes.filter((n) => !n.ready).map((n) => n.name),
  };
}

/**
 * Does a node pass a ManagedNodesConfig whitelist? Terms are alternatives,
 * the expressions inside a term must all hold.
 *
 * @param {Record<string, string>} labels
 * @param {{ key: string, operator: string, values: string[] }[][]} terms
 * @returns {boolean|null} null when it depends on something not known here (a field selector)
 */
export function whitelisted(labels, terms) {
  let unknown = false;
  for (const term of terms) {
    if (!term.length) continue; // an empty term selects nothing
    const results = term.map(({ key, operator, values }) => {
      const has = Object.hasOwn(labels, key);
      switch (operator) {
        case 'In': return has && values.includes(labels[key]);
        case 'NotIn': return !has || !values.includes(labels[key]);
        case 'Exists': return has;
        case 'DoesNotExist': return !has;
        case 'Gt': return has && Number(labels[key]) > Number(values[0]);
        case 'Lt': return has && Number(labels[key]) < Number(values[0]);
        default: return null;
      }
    });
    if (results.every((r) => r === true)) return true;
    if (!results.includes(false)) unknown = true;
  }
  return unknown ? null : false;
}
