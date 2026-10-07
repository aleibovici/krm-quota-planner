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
