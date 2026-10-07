import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyAdditions } from '../src/core/additions.js';
import { parseTenancy } from '../src/core/tenancy.js';
import { validate } from '../src/core/validate.js';
import { buildPlan } from '../src/core/plan.js';
import { renderTenancy, patchCommands, dependentRefusals } from '../src/core/krm.js';
import { whitelisted } from '../src/core/pools.js';
import { unifiedDiff } from '../src/core/diff.js';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const tenancy = read('tenancy.yaml');
const live = () => JSON.parse(read('live-krm.json')).items;
const queue = (name, nodepool, deserved, limit, extra = {}) => ({ name, nodepool, gpu: { deserved, limit, overQuotaWeight: 1 }, ...extra });
const H200 = { kind: 'NodePool', name: 'h200', labelKey: 'example.com/gpu-class', labelValue: 'h200' };
const PLATFORM_H200 = { kind: 'Queue', ownerKind: 'Department', owner: 'platform', queue: queue('platform-h200', 'h200', 16, 16) };
const LAB = { kind: 'Project', name: 'lab', namespace: 'lab', parent: 'platform', enforceKaiScheduler: false, queues: [queue('lab-rtx', 'rtx-pro-6000', 0, 2, { priority: 50 })] };
const LAB_H200 = { kind: 'Queue', ownerKind: 'Project', owner: 'lab', queue: queue('lab-h200', 'h200', 4, -1) };
const errors = (source, additions) => applyAdditions(source, additions).added.map((a) => a.error ?? '');
const codes = (findings, level) => findings.filter((f) => f.level === level).map((f) => f.code);
const plan = (input) => buildPlan({ config: { tenancy: 't.yaml' }, files: { 't.yaml': tenancy }, base: { ref: 'main', sha: 'abcdef1234' }, today: '2026-10-07', ...input });

test('a new object is one inserted document; every other line of the file is as it was', () => {
  const { source, added } = applyAdditions(tenancy, [LAB]);
  assert.deepEqual(added.map((a) => a.error), [undefined]);
  const was = tenancy.split('\n');
  const now = source.split('\n');
  const inserted = now.length - was.length;
  const at = now.findIndex((line, i) => line !== was[i]);
  assert.equal(inserted, 21);
  assert.deepEqual([...now.slice(0, at), ...now.slice(at + inserted)], was, 'take the new lines out and the file is byte-identical');
  assert.deepEqual(now.slice(at, at + 9), [
    '---',
    'apiVersion: kai.resources/v1alpha1',
    'kind: Project',
    'metadata:',
    '  name: lab',
    '  annotations:',
    '    argocd.argoproj.io/sync-options: "SkipDryRunOnMissingResource=true"',
    '    argocd.argoproj.io/sync-wave: "3"',
    'spec:',
  ], "it syncs the way the other Projects do: their sync options and wave, nobody's ownership");

  const project = parseTenancy(source).projects.at(-1);
  assert.deepEqual([project.name, project.namespace, project.parent, project.enforceKaiScheduler, project.defaultNodePools], ['lab', 'lab', 'platform', false, ['rtx-pro-6000']]);
  assert.equal(project.queues[0].priority, 50);
});

test('a new queue states cpu and memory: left out they are 0, and 0 is a ceiling of zero', () => {
  const model = parseTenancy(applyAdditions(tenancy, [LAB]).source);
  const q = model.projects.at(-1).queues[0];
  assert.deepEqual(q.resources.gpu, { deserved: 0, limit: 2, overQuotaWeight: 1 });
  assert.deepEqual(q.resources.cpu, { deserved: -1, limit: -1, overQuotaWeight: 1 });
  assert.deepEqual(q.resources.memory, { deserved: -1, limit: -1, overQuotaWeight: 1 });
});

test('objects go after the last of their kind; a queue goes at the end of its list, in the list\'s own indentation', () => {
  const { source, added } = applyAdditions(tenancy, [H200, PLATFORM_H200, LAB, LAB_H200]);
  assert.deepEqual(added.map((a) => a.error), [undefined, undefined, undefined, undefined]);
  const kinds = [...source.matchAll(/^kind: (\w+)|^  name: (\S+)$/gm)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(kinds, ['NodePool', 'rtx-pro-6000', 'NodePool', 'h200', 'ManagedNodesConfig', 'kai-managed-nodes-config', 'Department', 'platform', 'Project', 'kai-verify', 'Project', 'workspace', 'Project', 'benchmark', 'Project', 'lab']);
  assert.match(source, /\n        memory: \{deserved: -1, limit: -1, overQuotaWeight: 1\}\n    - name: platform-h200\n      nodepool: h200\n      resources:\n        gpu: {4}\{deserved: 16, limit: 16, overQuotaWeight: 1\}\n/);

  const model = parseTenancy(source);
  assert.deepEqual(model.problems, []);
  assert.deepEqual(model.departments[0].queues.map((q) => [q.name, q.nodepool]), [['platform-rtx', 'rtx-pro-6000'], ['platform-h200', 'h200']]);
  assert.deepEqual(model.projects.at(-1).queues.map((q) => q.name), ['lab-rtx', 'lab-h200']);
  // What gets created is the object as it ended up, with the queue added afterwards in it.
  assert.match(added[2].manifest, /name: lab-h200/);
  assert.doesNotMatch(applyAdditions(renderTenancy(live()).source, [LAB]).added[0].manifest, /annotations/, 'from a cluster there is nothing to copy');
});

test('the diff of a plan that only inserts lines is one git can apply', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'planner-additions-'));
  const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', input });
  git(['init', '-q']);
  writeFileSync(join(repo, 't.yaml'), tenancy);
  const p = plan({ additions: [H200, PLATFORM_H200, LAB, LAB_H200] });
  assert.deepEqual(codes(p.findings, 'error'), []);
  git(['apply', '--check', '-'], p.diff);
  git(['apply', '-'], p.diff);
  assert.equal(readFileSync(join(repo, 't.yaml'), 'utf8'), p.files[0].content);
  assert.equal(unifiedDiff('t.yaml', tenancy, p.files[0].content), p.diff);
});

test('from nothing: a pool, then a department on it, then a project', () => {
  const { source, added } = applyAdditions('', [
    { kind: 'NodePool', name: 'a100', labelKey: 'example.com/gpu', labelValue: 'true' },
    { kind: 'Department', name: 'research', queues: [queue('research-a100', 'a100', 8, 8)] },
    { kind: 'Project', name: 'vision', parent: 'research', queues: [queue('vision-a100', 'a100', 4, -1)] },
  ]);
  assert.deepEqual(added.map((a) => a.error), [undefined, undefined, undefined]);
  const model = parseTenancy(source);
  assert.deepEqual(model.pools, [{ name: 'a100', labelKey: 'example.com/gpu', labelValue: 'true' }], 'a label value that reads as a boolean is quoted');
  assert.equal(model.projects[0].namespace, 'vision', 'the namespace is written even when it is the name');
  assert.equal(model.projects[0].enforceKaiScheduler, null, 'not stated unless asked for');
  assert.deepEqual(codes(validate(model), 'error'), []);
});

test('an addition that cannot go in is refused, and the others still apply', () => {
  assert.match(errors(tenancy, [{ ...LAB, name: 'workspace' }])[0], /Project workspace already exists/);
  assert.match(errors(tenancy, [{ ...LAB, queues: [queue('workspace-rtx', 'rtx-pro-6000', 0, 1)] }])[0], /queue workspace-rtx already exists \(project workspace\)/);
  assert.match(errors(tenancy, [{ ...LAB, name: 'Lab_1' }])[0], /not a valid name/);
  assert.match(errors(tenancy, [{ ...LAB, queues: [] }])[0], /at least one queue/);
  assert.match(errors(tenancy, [{ ...LAB, queues: [queue('lab-a', 'rtx-pro-6000', 0, 1), queue('lab-b', 'rtx-pro-6000', 0, 1)] }])[0], /two queues on node pool rtx-pro-6000/);
  assert.match(errors(tenancy, [{ ...H200, labelValue: 'rtx-pro-6000' }])[0], /rtx-pro-6000 already selects .* KRM rejects/);
  assert.match(errors(tenancy, [{ ...H200, labelKey: 'not a key' }])[0], /not a valid node label key/);
  assert.match(errors(tenancy, [{ kind: 'Queue', ownerKind: 'Project', owner: 'workspace', queue: queue('workspace-2', 'rtx-pro-6000', 0, 1) }])[0], /already has a queue on rtx-pro-6000 \(workspace-rtx\)/);
  assert.match(errors(tenancy, [{ kind: 'Queue', ownerKind: 'Project', owner: 'nobody', queue: queue('x', 'h200', 0, 1) }])[0], /Project nobody is not there/);
  assert.match(errors(tenancy, [{ kind: 'Secret', name: 'x' }])[0], /cannot add/);
  assert.match(errors(tenancy.replace(/queues:\n    - name: platform-rtx[^]*?memory: .*\n/, 'queues: [{name: platform-rtx, nodepool: rtx-pro-6000}]\n'), [H200, PLATFORM_H200])[1], /not written as a plain list — add this one by hand/);

  const mixed = applyAdditions(tenancy, [{ ...LAB, name: 'workspace' }, H200, LAB]);
  assert.deepEqual(mixed.added.map((a) => Boolean(a.error)), [true, false, false]);
  assert.deepEqual(parseTenancy(mixed.source).projects.map((p) => p.name), ['kai-verify', 'workspace', 'benchmark', 'lab']);

  const p = plan({ additions: [{ ...LAB, name: 'workspace' }] });
  assert.equal(p.canCommit, false);
  assert.deepEqual(p.findings.filter((f) => f.code === 'addition').map((f) => f.addition), [0]);
  assert.equal(p.diff, '');
});

test('what KRM accepts and should not: caught in a file written by hand as well', () => {
  // Asked of KRM v0.18.2 by server dry-run, 2026-10-07: all four are accepted.
  const second = (name, body) => `${tenancy}---\napiVersion: kai.resources/v1alpha1\nkind: Project\nmetadata:\n  name: ${name}\nspec:\n${body}`;
  const q = (name, pool) => `  queues:\n    - name: ${name}\n      nodepool: ${pool}\n      resources:\n        gpu: {deserved: 0, limit: 1, overQuotaWeight: 1}\n`;
  const found = (source) => validate(parseTenancy(source)).map((f) => `${f.level} ${f.code}`);

  assert.ok(found(second('twin', `  namespace: twin\n  parent: platform\n${q('workspace-rtx', 'rtx-pro-6000')}`)).includes('error duplicate-queue'));
  assert.ok(found(second('twin', `  namespace: workspace\n  parent: platform\n${q('twin-rtx', 'rtx-pro-6000')}`)).includes('error namespace-shared'));
  assert.ok(found(second('workspace', `  namespace: other\n  parent: platform\n${q('twin-rtx', 'rtx-pro-6000')}`)).includes('error duplicate'));
  const pool = '---\napiVersion: kai.resources/v1alpha1\nkind: NodePool\nmetadata:\n  name: h200\nspec:\n  labelKey: example.com/gpu-class\n  labelValue: ';
  assert.ok(found(`${tenancy}${pool}rtx-pro-6000\n`).includes('error pool-overlap'));
  // A project queue on a pool its department has no queue on: nothing to take the guarantee out of.
  const orphan = found(second('twin', `  namespace: twin\n  parent: platform\n${q('twin-h200', 'h200')}`).replace(/$/, `${pool}h200\n`));
  assert.ok(orphan.includes('warning no-department-queue'));
  assert.deepEqual(found(tenancy).filter((f) => !f.startsWith('info')), [], 'the file as it is trips none of them');
});

test('a plan that only adds: checked, committable, and named for what it adds', () => {
  const p = plan({ additions: [LAB] });
  assert.equal(p.empty, false);
  assert.equal(p.canCommit, true);
  assert.deepEqual(p.changes, []);
  assert.equal(p.branch, 'quota/20261007-add-lab');
  assert.match(p.message, /^tenancy — new project lab in platform: lab-rtx 0\/2 on rtx-pro-6000\n/);
  assert.equal(p.model.planned.values['Project/lab/lab-rtx/gpu/limit'], 2);
  assert.equal(p.model.base.values['Project/lab/lab-rtx/gpu/limit'], undefined);

  // Its guarantee counts against the department like any other project's.
  const over = plan({ additions: [{ ...LAB, queues: [queue('lab-rtx', 'rtx-pro-6000', 1, 2)] }] });
  assert.deepEqual(codes(over.findings, 'error'), ['oversubscribed']);
  const fits = plan({ additions: [{ ...LAB, queues: [queue('lab-rtx', 'rtx-pro-6000', 1, 2)] }], edits: [{ id: 'Project/workspace/workspace-rtx/gpu/deserved', value: 2 }] });
  assert.deepEqual(codes(fits.findings, 'error'), []);
  assert.ok(fits.findings.some((f) => f.code === 'stale-comment'), 'inserting lines does not hide the comment on a value that changed');
  assert.equal(fits.branch, 'quota/20261007-rebalance');
});

test('a new pool is sized from the nodes that carry its label, and checked against the whitelist', () => {
  const node = (name, cls, cards) => ({ name, labels: { 'example.com/gpu-class': cls }, cards, allocatable: cards, product: '', memoryMiB: null, ready: true });
  const nodes = [node('gpu-01', 'rtx-pro-6000', 4), node('h200-01', 'h200', 8), node('h200-02', 'h200', 8)];
  const capacity = { 'rtx-pro-6000': { cards: 4, allocatable: 4, settled: true, notReady: [] } };

  const p = plan({ additions: [H200, { ...PLATFORM_H200, queue: queue('platform-h200', 'h200', 17, 17) }], nodes, capacity });
  assert.equal(p.pools.h200.cards, 16);
  assert.deepEqual(codes(p.findings, 'error'), ['over-capacity'], '17 guaranteed on 16 cards');
  // The file's whitelist names rtx-pro-6000 only: the H200 nodes would sit in a pool no scheduler serves.
  assert.match(p.findings.find((f) => f.code === 'not-whitelisted').message, /h200-01, h200-02 are not covered/);
  assert.ok(p.findings.some((f) => f.code === 'new-pool'));

  const nowhere = plan({ additions: [{ ...H200, name: 'a100', labelValue: 'a100' }], nodes, capacity });
  assert.ok(codes(nowhere.findings, 'warning').includes('pool-empty'));
  const unread = plan({ additions: [H200] });
  assert.ok(codes(unread.findings, 'info').includes('pool-unchecked'));

  const terms = [[{ key: 'class', operator: 'In', values: ['a', 'b'] }, { key: 'spot', operator: 'DoesNotExist', values: [] }], [{ key: 'zone', operator: 'Field', values: [] }]];
  assert.equal(whitelisted({ class: 'a' }, terms), true);
  assert.equal(whitelisted({ class: 'a', spot: 'yes' }, terms), null, 'the second term depends on a field this tool cannot see');
  assert.equal(whitelisted({ class: 'c' }, [terms[0]]), false);
  assert.equal(whitelisted({ class: 'a' }, []), false);
});

test('a new project and its namespace: what KRM will not tell you', () => {
  const note = (namespaces, krm) => plan({ additions: [LAB], namespaces, krm }).findings.filter((f) => f.code.startsWith('namespace-')).map((f) => `${f.level} ${f.code}`);
  const off = { createNamespaces: false, namespaceLabelKey: 'kai/project' };
  assert.deepEqual(note(undefined, undefined), ['info namespace-unchecked']);
  assert.deepEqual(note({}, off), ['warning namespace-missing']);
  assert.deepEqual(note({}, { ...off, createNamespaces: true }), ['info namespace-created']);
  assert.deepEqual(note({ lab: {} }, off), ['warning namespace-unlabelled', 'info namespace-adopted']);
  assert.deepEqual(note({ lab: { 'kai/project': 'lab' } }, off), ['info namespace-adopted']);
  assert.deepEqual(note({ lab: { 'kai/project': 'other' } }, off), ['warning namespace-taken', 'info namespace-adopted']);
  assert.deepEqual(note({ lab: { 'team/project': 'lab' } }, { createNamespaces: false, namespaceLabelKey: 'team/project' }), ['info namespace-adopted']);

  // In a repository, the script that checks the live queues does not know the new one.
  const files = { 't.yaml': tenancy, 'env.sh': read('env.sh') };
  const p = buildPlan({ config: { tenancy: 't.yaml', expectations: { file: 'env.sh', variables: ['TENANT_PROJECTS'] } }, files, additions: [LAB] });
  assert.match(p.findings.find((f) => f.code === 'expectations-new').message, /env\.sh has no entry for lab-rtx/);
});

test('commands for a cluster: create what is new, in an order the API server accepts', () => {
  const { objects, source } = renderTenancy(live());
  const { added } = applyAdditions(source, [LAB, LAB_H200, { kind: 'Department', name: 'eng', queues: [queue('eng-rtx', 'rtx-pro-6000', 0, 2)] }, PLATFORM_H200, H200]);
  // Asked for in an order no API server would take: a queue before its pool, a project before its department's queue.
  assert.deepEqual(added.map((a) => Boolean(a.error)), [false, false, false, false, false]);
  const commands = patchCommands(objects, [
    { id: 'Project/workspace/workspace-rtx/gpu/deserved', from: 3, to: 2 },
    { id: 'Department/platform/platform-rtx/gpu/limit', from: 4, to: 5 },
  ], { context: 'prod' }, added);
  const first = (c) => c.split('\n')[0] + (c.includes('<<') ? ` ${/kind: (\w+)/.exec(c)[1]}/${/name: (\S+)/.exec(c)[1]}` : '');
  assert.deepEqual(commands.map((c) => first(c).replace(/ --type=json.*/, '')), [
    "kubectl --context prod create -f - <<'EOF' NodePool/h200",
    'kubectl --context prod patch projects.kai.resources workspace',
    "kubectl --context prod create -f - <<'EOF' Department/eng",
    'kubectl --context prod patch departments.kai.resources platform',
    "kubectl --context prod create -f - <<'EOF' Project/lab",
  ]);
  assert.match(commands[0], /<<'EOF'\napiVersion: kai\.resources\/v1alpha1\nkind: NodePool\nmetadata:\n  name: h200\nspec:\n  labelKey: example\.com\/gpu-class\n  labelValue: h200\nEOF$/);
  assert.match(commands[4], /name: lab-rtx[^]*name: lab-h200[^]*\nEOF$/, 'the queue added to a new project is created with it, not patched in');

  // One patch for platform: its value change tested against the queue as read, then the new queue appended after a test of the one it follows.
  const ops = JSON.parse(commands[3].slice(commands[3].indexOf("-p '") + 4, -1));
  assert.deepEqual(ops.map((o) => `${o.op} ${o.path}`), [
    'test /spec/queues/0/name', 'test /spec/queues/0/resources/gpu/limit', 'replace /spec/queues/0/resources/gpu/limit',
    'test /spec/queues/0/name', 'add /spec/queues/-',
  ]);
  assert.deepEqual(ops.at(-1).value, { name: 'platform-h200', nodepool: 'h200', resources: { gpu: { deserved: 16, limit: 16, overQuotaWeight: 1 }, cpu: { deserved: -1, limit: -1, overQuotaWeight: 1 }, memory: { deserved: -1, limit: -1, overQuotaWeight: 1 } } });
});

test('a dry-run refuses what refers to something the plan adds — told apart from a real refusal', () => {
  // kubectl apply --dry-run=server of a plan adding pool h200, a queue for platform on it, department eng and a project in it (KRM v0.18.2, 2026-10-07).
  const lines = [
    'nodepool.kai.resources/h200 created (server dry run)',
    'department.kai.resources/eng created (server dry run)',
    'Error from server (Forbidden): error when applying patch:',
    'to:',
    'Resource: "kai.resources/v1alpha1, Resource=departments", GroupVersionKind: "kai.resources/v1alpha1, Kind=Department"',
    'Name: "platform", Namespace: ""',
    'for: "STDIN": error when patching "STDIN": admission webhook "project-controller-department.kai-scheduler.svc" denied the request: 1 error occurred:',
    '\t* queue "platform-h200": node pool "h200" does not exist',
    'Error from server (Forbidden): error when creating "STDIN": admission webhook "project-controller-project.kai-scheduler.svc" denied the request: 1 error occurred:',
    '\t* parent department "eng" does not exist',
  ];
  const added = [{ kind: 'NodePool', name: 'h200' }, { kind: 'Department', name: 'eng' }];
  assert.deepEqual(dependentRefusals(lines, added), { expected: ['queue "platform-h200": node pool "h200" does not exist', 'parent department "eng" does not exist'], other: 0 });
  assert.equal(dependentRefusals(lines, [added[0]]).other, 1, 'department eng is not something this plan adds: a real refusal');
  assert.equal(dependentRefusals([...lines, 'Error from server (Forbidden): error when creating "STDIN": admission webhook "nodepool-controller.kai-scheduler.svc" denied the request: nodepool "x" labelKey "k" / labelValue "v" duplicates existing nodepool "y"'], added).other, 1);
  assert.equal(dependentRefusals([...lines, 'The Project "lab" is invalid: spec.queues: Required value'], added).other, 1);
  assert.deepEqual(dependentRefusals(['project.kai.resources/workspace configured (server dry run)'], added), { expected: [], other: 0 });
});
