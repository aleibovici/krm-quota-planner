import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTenancy, applyTenancyEdits, fieldId } from '../src/core/tenancy.js';
import { spliceAligned } from '../src/core/splice.js';

const fixture = readFileSync(new URL('./fixtures/tenancy.yaml', import.meta.url), 'utf8');

const changedLines = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  assert.equal(x.length, y.length, 'an edit must not add or remove lines');
  return x.flatMap((line, i) => (line === y[i] ? [] : [{ line: i + 1, before: line, after: y[i] }]));
};

test('parses the production tenancy file', () => {
  const m = parseTenancy(fixture);
  assert.deepEqual(m.problems, []);
  assert.deepEqual(m.pools.map((p) => p.name), ['rtx-pro-6000']);
  assert.deepEqual(m.departments.map((d) => d.name), ['platform']);
  assert.deepEqual(m.projects.map((p) => p.name), ['kai-verify', 'workspace', 'benchmark']);

  const bench = m.projects.find((p) => p.name === 'benchmark');
  assert.equal(bench.parent, 'platform');
  assert.equal(bench.namespace, 'benchmark');
  assert.equal(bench.enforceKaiScheduler, false);
  assert.equal(bench.queues[0].priority, 50);
  assert.deepEqual(bench.queues[0].resources.gpu, { deserved: 1, limit: 4, overQuotaWeight: 1 });
  assert.deepEqual(bench.queues[0].resources.cpu, { deserved: -1, limit: -1, overQuotaWeight: 1 });

  // Department queues carry no priority key; it must be absent, not 0.
  assert.equal(m.departments[0].queues[0].priority, null);
});

test('every recorded range points at the text of its value', () => {
  const m = parseTenancy(fixture);
  assert.ok(Object.keys(m.fields).length >= 39, 'four queues × nine quota numbers + three priorities');
  for (const f of Object.values(m.fields)) {
    assert.equal(Number(fixture.slice(f.start, f.end)), f.value, f.id);
  }
});

test('no edits: byte-identical output', () => {
  assert.equal(applyTenancyEdits(fixture, []).source, fixture);
});

test('an edit to the current value does not touch the file', () => {
  const r = applyTenancyEdits(fixture, [{ id: fieldId('Project', 'benchmark', 'benchmark-rtx', 'gpu', 'deserved'), value: 1 }]);
  assert.equal(r.source, fixture);
  assert.deepEqual(r.changes, []);
});

test('one edit: a one-line diff, comments and alignment intact', () => {
  const id = fieldId('Project', 'benchmark', 'benchmark-rtx', 'gpu', 'deserved');
  const r = applyTenancyEdits(fixture, [{ id, value: 2 }]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changes, [{ id, from: 1, to: 2 }]);
  const diff = changedLines(fixture, r.source);
  assert.equal(diff.length, 1);
  assert.equal(diff[0].before, '        gpu:    {deserved: 1,  limit: 4,  overQuotaWeight: 1}');
  assert.equal(diff[0].after, '        gpu:    {deserved: 2,  limit: 4,  overQuotaWeight: 1}');
  assert.equal(parseTenancy(r.source).projects[2].queues[0].resources.gpu.deserved, 2);
});

test('a wider value eats padding so the next column does not move', () => {
  const id = fieldId('Project', 'workspace', 'workspace-rtx', 'gpu', 'limit');
  const r = applyTenancyEdits(fixture, [{ id, value: -1 }]);
  const [d] = changedLines(fixture, r.source);
  assert.equal(d.after, '        gpu:    {deserved: 3,  limit: -1, overQuotaWeight: 1}');
});

test('a narrower value in an aligned table is padded back out', () => {
  const id = fieldId('Project', 'workspace', 'workspace-rtx', 'cpu', 'deserved');
  const r = applyTenancyEdits(fixture, [{ id, value: 8 }]);
  const [d] = changedLines(fixture, r.source);
  assert.equal(d.after, '        cpu:    {deserved: 8,  limit: -1, overQuotaWeight: 1}');
});

test('fractions and several edits at once, each on its own line', () => {
  const r = applyTenancyEdits(fixture, [
    { id: fieldId('Project', 'workspace', 'workspace-rtx', 'gpu', 'deserved'), value: 2.5 },
    { id: fieldId('Project', 'workspace', 'workspace-rtx', 'gpu', 'limit'), value: 2.5 },
    { id: fieldId('Project', 'benchmark', 'benchmark-rtx', 'gpu', 'deserved'), value: 1.5 },
    { id: fieldId('Project', 'benchmark', 'benchmark-rtx', 'priority'), value: 60 },
    { id: fieldId('Department', 'platform', 'platform-rtx', 'gpu', 'limit'), value: 8 },
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.changes.length, 5);
  assert.equal(changedLines(fixture, r.source).length, 4, 'two edits share the workspace gpu line');
  const m = parseTenancy(r.source);
  assert.deepEqual(m.problems, []);
  assert.deepEqual(m.projects[1].queues[0].resources.gpu, { deserved: 2.5, limit: 2.5, overQuotaWeight: 1 });
  assert.equal(m.projects[2].queues[0].resources.gpu.deserved, 1.5);
  assert.equal(m.projects[2].queues[0].priority, 60);
  assert.equal(m.departments[0].queues[0].resources.gpu.limit, 8);
  // Every comment survives.
  const comments = (s) => s.split('\n').filter((l) => l.trim().startsWith('#'));
  assert.deepEqual(comments(r.source), comments(fixture));
});

test('rejects edits it cannot make, and then changes nothing', () => {
  const r = applyTenancyEdits(fixture, [
    { id: fieldId('Department', 'platform', 'platform-rtx', 'priority'), value: 10 }, // key absent in the file
    { id: fieldId('Project', 'nope', 'nope-rtx', 'gpu', 'limit'), value: 1 },
    { id: fieldId('Project', 'workspace', 'workspace-rtx', 'gpu', 'limit'), value: Number.NaN },
    { id: fieldId('Project', 'benchmark', 'benchmark-rtx', 'gpu', 'limit'), value: 2 },
  ]);
  assert.equal(r.errors.length, 3);
  assert.equal(r.source, fixture, 'a partly valid batch is not half-applied');
});

test('spliceAligned keeps a trailing comment in its column', () => {
  const src = 'priority: 50   # reclaimable\n';
  assert.equal(spliceAligned(src, 10, 12, '100'), 'priority: 100  # reclaimable\n');
  assert.equal(spliceAligned(src, 10, 12, '5'), 'priority: 5    # reclaimable\n');
  assert.equal(spliceAligned('a: {x: 10, y: 2}\n', 7, 9, '5'), 'a: {x: 5, y: 2}\n', 'no table, no padding invented');
});
