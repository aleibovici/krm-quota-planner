import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTenancy } from '../src/core/tenancy.js';
import { applyTenancyEdits, fieldId } from '../src/core/tenancy.js';
import { buildDisplay } from '../src/core/display.js';

const tenancy = readFileSync(new URL('./fixtures/tenancy.yaml', import.meta.url), 'utf8');
const gpu = (kind, owner, queue, field) => fieldId(kind, owner, queue, 'gpu', field);

test('display flags department hand-out over guarantee', () => {
  const edited = applyTenancyEdits(tenancy, [{ id: gpu('Project', 'kai-verify', 'kai-verify-rtx', 'deserved'), value: 5 }]);
  const model = parseTenancy(edited.source);
  const slim = { ...model, values: Object.fromEntries(Object.values(model.fields).map((f) => [f.id, f.value])) };
  const d = buildDisplay(slim, { capacity: { 'rtx-pro-6000': { cards: 4 } }, liveRead: false });
  const dq = d.departments['platform-rtx'];
  assert.ok(dq.overHanded || d.pools['rtx-pro-6000'].overProjects);
});

test('display shows a pool promised more than it holds, department by department', () => {
  const edited = applyTenancyEdits(tenancy, [{ id: gpu('Department', 'platform', 'platform-rtx', 'deserved'), value: 6 }]);
  const model = parseTenancy(edited.source);
  const slim = { ...model, values: Object.fromEntries(Object.values(model.fields).map((f) => [f.id, f.value])) };
  const pool = buildDisplay(slim, { capacity: { 'rtx-pro-6000': { cards: 4 } }, liveRead: false }).pools['rtx-pro-6000'];
  assert.equal(pool.overDepts, true);
  assert.equal(pool.over, 2);
  assert.equal(pool.spare, 0);
  assert.equal(pool.scale, 6);
  assert.ok(Math.abs(pool.capPct - (4 / 6) * 100) < 1e-9);
  assert.deepEqual(pool.depts.map((d) => [d.dept, d.queue, d.share]), [['platform', 'platform-rtx', 6]]);
  assert.equal(pool.depts[0].flex, 100);
  assert.equal(pool.free.hidden, true);
});

test('display leaves room in a pool that is not fully promised, and adds up live usage', () => {
  const model = parseTenancy(tenancy);
  const slim = { ...model, values: Object.fromEntries(Object.values(model.fields).map((f) => [f.id, f.value])) };
  const queues = model.projects.flatMap((p) => p.queues.map((q) => q.name));
  const live = Object.fromEntries(queues.map((name) => [name, { allocatedGpu: 0.5 }]));
  const d = buildDisplay(slim, { capacity: { 'rtx-pro-6000': { cards: 16 } }, live, liveRead: true });
  const pool = d.pools['rtx-pro-6000'];
  assert.equal(pool.overDepts, false);
  assert.equal(pool.over, 0);
  assert.equal(pool.capPct, undefined);
  assert.equal(pool.spare, 16 - pool.promised);
  assert.equal(pool.free.hidden, false);
  assert.equal(d.departments['platform-rtx'].used, queues.length * 0.5);
  assert.equal(d.departments['platform-rtx'].dept, 'platform');
});
