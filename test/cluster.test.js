import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describePools, capacityOf } from '../src/cluster.js';
import { parseTenancy } from '../src/core/tenancy.js';
import { validate } from '../src/core/validate.js';

const tenancy = parseTenancy(readFileSync(new URL('./fixtures/tenancy.yaml', import.meta.url), 'utf8'));
const pools = [
  { metadata: { name: 'default' }, spec: {} },
  { metadata: { name: 'rtx-pro-6000' }, spec: { labelKey: 'example.com/gpu-class', labelValue: 'rtx-pro-6000' } },
];
const node = ({ allocatable, capacity = allocatable, count, ready = true, cordoned = false, cls = 'rtx-pro-6000' }) => ({
  metadata: { name: 'gpu-01', labels: { 'example.com/gpu-class': cls, 'nvidia.com/gpu.memory': '97887', ...(count ? { 'nvidia.com/gpu.count': String(count) } : {}) } },
  spec: cordoned ? { unschedulable: true } : {},
  status: {
    allocatable: allocatable === undefined ? {} : { 'nvidia.com/gpu': String(allocatable) },
    capacity: capacity === undefined ? {} : { 'nvidia.com/gpu': String(capacity) },
    conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
  },
});
const check = (nodes) => {
  const live = { ok: true, pools: describePools(pools, nodes) };
  return { pool: live.pools['rtx-pro-6000'], findings: validate(tenancy, { capacity: capacityOf(live) }) };
};
const codes = (findings, level) => findings.filter((f) => f.level === level).map((f) => f.code);

test('a mixed-model node: the GFD label under-counts, allocatable is right', () => {
  // The production RTX server: 2 Server Edition + 2 Max-Q; the label says 2.
  const { pool, findings } = check([node({ allocatable: 4, count: 2 })]);
  assert.deepEqual([pool.cards, pool.allocatable, pool.settled], [4, 4, true]);
  assert.deepEqual(codes(findings, 'error'), []);
  assert.deepEqual(codes(findings, 'warning'), []);
  assert.equal(describePools(pools, [])['default'], undefined, 'the selector-less default pool is skipped');
});

test('device plugin down: an understated count warns, it never blocks', () => {
  // Seen on a real cluster while the device plugin restarted: allocatable 0 for ~8 minutes.
  const { pool, findings } = check([node({ allocatable: 0, capacity: 0, count: 2 })]);
  assert.deepEqual([pool.cards, pool.allocatable, pool.settled], [2, 0, false]);
  assert.deepEqual(codes(findings, 'error'), [], 'a 4-card guarantee must not be refused because 2 are visible');
  assert.deepEqual(codes(findings, 'warning').sort(), ['cards-unavailable', 'over-capacity']);
  assert.match(findings.find((f) => f.code === 'cards-unavailable').message, /only 0 cards of 2 schedulable right now/);
});

test('a cordoned or not-ready node unsettles the pool even when its cards are listed', () => {
  for (const n of [node({ allocatable: 4, cordoned: true }), node({ allocatable: 4, ready: false })]) {
    const { pool, findings } = check([n]);
    assert.equal(pool.settled, false);
    assert.deepEqual(codes(findings, 'error'), []);
    assert.match(findings.find((f) => f.code === 'cards-unavailable').message, /gpu-01 not ready/);
  }
});

test('no node reports a GPU at all: capacity is unknown, not zero', () => {
  const { pool, findings } = check([node({ allocatable: undefined })]);
  assert.equal(pool.cards, 0);
  assert.deepEqual(codes(findings, 'error'), []);
  assert.deepEqual(codes(findings, 'info'), ['capacity-unknown']);
  assert.match(findings[0].message, /its nodes report no GPUs right now/);
});

test('a settled pool that really is too small is still an error', () => {
  const { findings } = check([node({ allocatable: 2, count: 2 })]);
  assert.deepEqual(codes(findings, 'error'), ['over-capacity']);
});

// --- fractions of a card ------------------------------------------------------
// The tenancy fixture is whole cards; give one project half a card.
const halved = () => {
  const model = structuredClone(tenancy);
  model.projects.find((p) => p.name === 'benchmark').queues[0].resources.gpu.deserved = 0.5;
  return model;
};
const fractionCheck = (nodes, sharing) => {
  const live = { ok: true, pools: describePools(pools, nodes) };
  return validate(halved(), { capacity: capacityOf(live), sharing });
};
const fractionNode = (extra) => {
  const n = node({ allocatable: 4 });
  if (extra.condition) n.status.conditions.push({ type: 'gpu-fractioning.nvidia.com/Ready', status: extra.condition });
  if (extra.migStrategy) n.metadata.labels['nvidia.com/mig.strategy'] = extra.migStrategy;
  if (extra.migResource) n.status.allocatable['nvidia.com/mig-1g.10gb'] = '7';
  return n;
};

test('a fraction with sharing Disabled is an error; without the Config read it says nothing', () => {
  assert.deepEqual(codes(fractionCheck([fractionNode({})], { gpuSharingMode: 'Disabled' }), 'error'), ['fraction-disabled']);
  for (const sharing of [undefined, null, { gpuSharingMode: null }, { gpuSharingMode: 'NonMemoryEnforced' }]) {
    const findings = fractionCheck([fractionNode({})], sharing);
    assert.ok(!findings.some((f) => f.code.startsWith('fraction-')), `nothing to say for ${JSON.stringify(sharing)}`);
  }
});

test('NvFractions: a pool whose nodes are not marked ready for fractions warns, a ready one does not', () => {
  const notReady = fractionCheck([fractionNode({ condition: 'False' })], { gpuSharingMode: 'NvFractions' });
  assert.deepEqual(codes(notReady, 'warning'), ['fraction-not-ready']);
  assert.match(notReady.find((f) => f.code === 'fraction-not-ready').message, /benchmark-rtx: guarantee of 0.5 cards is a fraction/);
  const ready = fractionCheck([fractionNode({ condition: 'True' })], { gpuSharingMode: 'NvFractions' });
  assert.ok(!ready.some((f) => f.code.startsWith('fraction-')));
  // No node carries the condition at all: the operator is not there yet, or the nodes were not read — not a verdict.
  const unknown = fractionCheck([fractionNode({})], { gpuSharingMode: 'NvFractions' });
  assert.ok(!unknown.some((f) => f.code.startsWith('fraction-')));
});

test('a MIG-partitioned node has no whole card to share: a warning, by label or by resource', () => {
  for (const extra of [{ migStrategy: 'single' }, { migStrategy: 'mixed' }, { migResource: true }]) {
    const findings = fractionCheck([fractionNode(extra)], { gpuSharingMode: 'NonMemoryEnforced' });
    assert.deepEqual(codes(findings, 'warning'), ['fraction-mig'], JSON.stringify(extra));
    assert.match(findings.find((f) => f.code === 'fraction-mig').message, /gpu-01 in pool rtx-pro-6000 exposes its GPUs as MIG slices/);
  }
  assert.ok(!fractionCheck([fractionNode({ migStrategy: 'none' })], { gpuSharingMode: 'NonMemoryEnforced' }).some((f) => f.code === 'fraction-mig'));
  // Whole cards never trigger it, whatever the node.
  const live = { ok: true, pools: describePools(pools, [fractionNode({ migStrategy: 'single' })]) };
  assert.ok(!validate(tenancy, { capacity: capacityOf(live), sharing: { gpuSharingMode: 'Disabled' } }).some((f) => f.code.startsWith('fraction-')));
});
