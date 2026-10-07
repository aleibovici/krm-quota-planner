import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderTenancy, patchCommands } from '../src/core/krm.js';
import { parseTenancy, applyTenancyEdits } from '../src/core/tenancy.js';
import { buildPlan } from '../src/core/plan.js';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// `kubectl get nodepools,departments,projects -o json` from the cluster the
// tenancy.yaml fixture was synced to (2026-10-07), uids replaced.
const live = () => JSON.parse(read('live-krm.json')).items;
const CODER = 'Project/workspace/workspace-rtx/gpu/deserved';
const BENCH = 'Project/benchmark/benchmark-rtx/gpu/deserved';

test('live objects render to a text the tenancy model reads exactly as it reads the file in git', () => {
  const fromCluster = parseTenancy(renderTenancy(live()).source);
  const fromGit = parseTenancy(read('tenancy.yaml'));
  const values = (model) => Object.fromEntries(Object.values(model.fields).map((f) => [f.id, f.value]));
  assert.deepEqual(fromCluster.problems, []);
  assert.deepEqual(values(fromCluster), values(fromGit));
  assert.deepEqual(fromCluster.pools, fromGit.pools, 'the selector-less built-in "default" pool is left out');
  assert.deepEqual(fromCluster.projects.map((p) => [p.name, p.parent, p.namespace]), fromGit.projects.map((p) => [p.name, p.parent, p.namespace]).sort());
});

test('only the decision is kept: status, uid and resourceVersion never reach the text', () => {
  const { source } = renderTenancy(live());
  assert.doesNotMatch(source, /status:|uid:|resourceVersion|finalizers|tracking-id|allocated/);

  // A pod starting moves a Project's status and resourceVersion. That is not a
  // change to the plan's base, and must not read as one.
  const busier = live();
  for (const item of busier) {
    item.metadata.resourceVersion = '99999999';
    if (item.status?.quotaStatus?.allocated) item.status.quotaStatus.allocated['nvidia.com/gpu'] = '2';
  }
  assert.equal(renderTenancy(busier.reverse()).source, source);

  const changed = live();
  changed.find((i) => i.metadata.name === 'kai-verify').spec.queues[0].resources.gpu.deserved = 1;
  assert.notEqual(renderTenancy(changed).source, source);
});

test('a pool without a selector is shown only when a queue is on it', () => {
  const items = live();
  items.find((i) => i.metadata.name === 'kai-verify').spec.queues[0].nodepool = 'default';
  assert.deepEqual(parseTenancy(renderTenancy(items).source).pools.map((p) => p.name), ['default', 'rtx-pro-6000']);
});

test('objects a GitOps controller owns are reported, and become a warning on the plan', () => {
  const { source, managed } = renderTenancy(live());
  assert.deepEqual(
    managed.map((m) => `${m.kind}/${m.name}`).sort(),
    ['Department/platform', 'Project/benchmark', 'Project/kai-verify', 'Project/workspace'].sort(),
  );
  assert.ok(managed.every((m) => m.by === 'Argo CD application kai-scheduler'));

  const unmanaged = live();
  for (const item of unmanaged) delete item.metadata.annotations;
  assert.deepEqual(renderTenancy(unmanaged).managed, []);

  const note = { level: 'warning', code: 'gitops-managed', message: 'managed elsewhere' };
  const plan = buildPlan({ config: { tenancy: 'krm.yaml' }, files: { 'krm.yaml': source }, notes: [note], base: { kind: 'cluster', ref: 'ctx', sha: 'abc' } });
  assert.deepEqual(plan.findings.filter((f) => f.level !== 'info'), [note]);
});

test('edits to the rendered text stay one line each', () => {
  const { source } = renderTenancy(live());
  const edited = applyTenancyEdits(source, [{ id: BENCH, value: 0.5 }]);
  assert.deepEqual(edited.errors, []);
  const was = source.split('\n');
  const now = edited.source.split('\n');
  assert.equal(now.length, was.length);
  assert.deepEqual(now.filter((line, i) => line !== was[i]), ['          deserved: 0.5']);
});

test('patch commands: one per object, every replace guarded, givers before takers', () => {
  const { objects } = renderTenancy(live());
  const commands = patchCommands(objects, [
    { id: BENCH, from: 1, to: 2 },
    { id: 'Project/benchmark/benchmark-rtx/priority', from: 50, to: 60 },
    { id: CODER, from: 3, to: 2 },
  ], { context: 'prod east' });

  assert.equal(commands.length, 2);
  assert.match(commands[0], /^kubectl --context 'prod east' patch projects\.kai\.resources workspace --type=json -p '\[/, 'workspace gives a card up, so it goes first');
  assert.match(commands[1], / patch projects\.kai\.resources benchmark /);
  const ops = (command) => JSON.parse(command.slice(command.indexOf("-p '") + 4, -1));
  assert.deepEqual(ops(commands[1]), [
    { op: 'test', path: '/spec/queues/0/name', value: 'benchmark-rtx' },
    { op: 'test', path: '/spec/queues/0/resources/gpu/deserved', value: 1 },
    { op: 'replace', path: '/spec/queues/0/resources/gpu/deserved', value: 2 },
    { op: 'test', path: '/spec/queues/0/priority', value: 50 },
    { op: 'replace', path: '/spec/queues/0/priority', value: 60 },
  ]);
  assert.match(patchCommands(objects, [{ id: 'Department/platform/platform-rtx/gpu/limit', from: 4, to: -1 }])[0], /^kubectl patch departments\.kai\.resources platform /);

  // A department and its project move together: the department grows before
  // the project does and shrinks after it, whichever was edited first.
  const who = (list) => list.map((c) => c.match(/patch \S+ (\S+)/)[1]);
  const PLATFORM = 'Department/platform/platform-rtx/gpu/deserved';
  assert.deepEqual(who(patchCommands(objects, [{ id: CODER, from: 3, to: 4 }, { id: PLATFORM, from: 4, to: 5 }])), ['platform', 'workspace']);
  assert.deepEqual(who(patchCommands(objects, [{ id: PLATFORM, from: 4, to: 2 }, { id: CODER, from: 3, to: 2 }, { id: BENCH, from: 1, to: 0 }])), ['workspace', 'benchmark', 'platform']);
  assert.throws(() => patchCommands(objects, [{ id: 'Project/gone/gone-rtx/gpu/deserved', from: 1, to: 2 }]), /not among the objects read/);
});
