import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildPlan } from '../src/core/plan.js';
import { parseTenancy, applyTenancyEdits, fieldId } from '../src/core/tenancy.js';
import { validate } from '../src/core/validate.js';
import { patchExpectations, inspectMirror } from '../src/core/coupled.js';
import { unifiedDiff } from '../src/core/diff.js';
import { parseQuantity } from '../src/core/quantity.js';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../examples/gitops.json', import.meta.url), 'utf8'));
const files = {
  [config.tenancy]: read('tenancy.yaml'),
  [config.expectations.file]: read('env.sh'),
  'services/coder/manifests/workspace-quota.yaml': read('coder-workspace-quota.yaml'),
  'services/benchmarking/manifests/resource-quota.yaml': read('bench-resource-quota.yaml'),
};
const capacity = { 'rtx-pro-6000': { cards: 4 } };
const gpu = (kind, owner, queue, field) => fieldId(kind, owner, queue, 'gpu', field);
const codes = (findings, level) => findings.filter((f) => f.level === level).map((f) => f.code);
const planned = (edits) => parseTenancy(applyTenancyEdits(files[config.tenancy], edits).source);

test('quantities: what the live Queue status actually reports', () => {
  assert.ok(Math.abs(parseQuantity('119995506n') - 0.12) < 1e-4, 'a 1/8-card workspace');
  assert.equal(parseQuantity('16'), 16);
  assert.equal(parseQuantity('500m'), 0.5);
  assert.equal(parseQuantity('32Gi'), 32 * 2 ** 30);
  assert.equal(parseQuantity('11746Mi'), 11746 * 2 ** 20);
  assert.equal(parseQuantity('1e3'), 1000);
  assert.ok(Number.isNaN(parseQuantity('lots')));
});

test('the production layout is clean', () => {
  const f = validate(parseTenancy(files[config.tenancy]), { capacity });
  assert.deepEqual(codes(f, 'error'), []);
  assert.deepEqual(codes(f, 'warning'), []);
});

test('guarantees that add up to more than the department are an error', () => {
  // The cluster accepts this (dry-run 2026-10-07); only the planner catches it.
  const f = validate(planned([{ id: gpu('Project', 'kai-verify', 'kai-verify-rtx', 'deserved'), value: 1 }]), { capacity });
  assert.deepEqual(codes(f, 'error'), ['oversubscribed']);
  assert.match(f[0].message, /guaranteed 5 cards in total.*only has 4 cards.*1 card of those/);
});

test('deserved above limit, negatives, unlimited child, over capacity', () => {
  assert.deepEqual(codes(validate(planned([
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'limit'), value: 2 },
  ]), { capacity }), 'error'), ['deserved-over-limit']);

  assert.deepEqual(codes(validate(planned([
    { id: gpu('Project', 'kai-verify', 'kai-verify-rtx', 'deserved'), value: -2 },
  ]), { capacity }), 'error'), ['negative']);

  assert.ok(codes(validate(planned([
    { id: gpu('Project', 'benchmark', 'benchmark-rtx', 'deserved'), value: -1 },
    { id: gpu('Project', 'benchmark', 'benchmark-rtx', 'limit'), value: -1 },
  ]), { capacity }), 'error').includes('child-unlimited'));

  const over = validate(planned([
    { id: gpu('Department', 'platform', 'platform-rtx', 'deserved'), value: 8 },
    { id: gpu('Department', 'platform', 'platform-rtx', 'limit'), value: 8 },
  ]), { capacity });
  assert.deepEqual(codes(over, 'error'), ['over-capacity']);
  assert.ok(codes(over, 'warning').includes('limit-over-capacity'));
});

test('a child limit above the department is a warning, spare share is a note', () => {
  const f = validate(planned([
    { id: gpu('Project', 'benchmark', 'benchmark-rtx', 'limit'), value: 8 },
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'deserved'), value: 2 },
  ]), { capacity });
  assert.deepEqual(codes(f, 'error'), []);
  assert.deepEqual(codes(f, 'warning'), ['child-limit']);
  assert.deepEqual(codes(f, 'info'), ['unassigned']);
});

test('without the cluster, capacity is reported as unknown rather than assumed', () => {
  assert.deepEqual(codes(validate(parseTenancy(files[config.tenancy])), 'info'), ['capacity-unknown']);
});

test('live usage above the plan is a warning, not an error', () => {
  const f = validate(planned([
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'deserved'), value: 1 },
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'limit'), value: 1 },
  ]), { capacity, live: { 'workspace-rtx': { allocatedGpu: 2.12, allocatedNonPreemptibleGpu: 2.12 } } });
  assert.deepEqual(codes(f, 'error'), []);
  assert.deepEqual(codes(f, 'warning').sort(), ['running-over-deserved', 'running-over-limit']);
});

test('expectation variables follow the plan and nothing else on the line moves', () => {
  const model = planned([
    { id: gpu('Project', 'benchmark', 'benchmark-rtx', 'deserved'), value: 2 },
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'deserved'), value: 2 },
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'limit'), value: 2 },
  ]);
  const before = files[config.expectations.file];
  const r = patchExpectations(before, config.expectations.variables, model);
  assert.deepEqual(r.changes.map((c) => `${c.queue} ${c.from}→${c.to}`), ['workspace-rtx 3:3→2:2', 'benchmark-rtx 1:4→2:4']);
  const line = r.source.split('\n').find((l) => l.startsWith('TENANT_PROJECTS='));
  const old = before.split('\n').find((l) => l.startsWith('TENANT_PROJECTS='));
  assert.ok(line.startsWith('TENANT_PROJECTS="workspace:workspace:workspace-rtx:2:2 benchmark:benchmark:benchmark-rtx:2:4"'));
  assert.equal(line.slice(line.indexOf('#')), old.slice(old.indexOf('#')), 'trailing comment untouched');
  assert.equal(r.source.split('\n').filter((l, i) => l !== before.split('\n')[i]).length, 1);
  // Unrelated variables that merely look similar are left alone.
  assert.ok(r.source.includes('OLD_QUEUES="legacy-rtx workspace benchmark kai-verify"'));
});

test('ResourceQuota mirrors: suggestion is the limit in whole cards', () => {
  const cfg = config.resourceQuotaMirrors[0];
  const src = files[cfg.file];
  assert.equal(inspectMirror(cfg, src, parseTenancy(files[config.tenancy])).status, 'in-sync');
  const m = inspectMirror(cfg, src, planned([{ id: gpu('Project', 'workspace', 'workspace-rtx', 'limit'), value: 3.5 }]));
  assert.deepEqual([m.status, m.current, m.suggested, m.object], ['differs', 3, 4, 'ResourceQuota/workspace']);
  assert.equal(inspectMirror(cfg, undefined, parseTenancy(files[config.tenancy])).status, 'not-found');
});

test('plan includes display aggregates for the UI', () => {
  const p = buildPlan({ config, files, capacity });
  assert.ok(p.display.pools['rtx-pro-6000']);
  assert.ok(p.display.departments['platform-rtx']);
  assert.ok(p.display.queues['kai-verify-rtx']);
});

test('a plan with no edits changes no file', () => {
  const p = buildPlan({ config, files, capacity });
  assert.equal(p.diff, '');
  assert.deepEqual(p.files, []);
  assert.equal(p.canCommit, false);
  assert.equal(p.message, '');
});

test('recorded quota change replayed: one plan, three files, a diff git applies', () => {
  // Start from the layout before the recorded change and plan the same decision.
  const pre = { ...files };
  pre[config.tenancy] = applyTenancyEdits(files[config.tenancy], [
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'deserved'), value: 4 },
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'limit'), value: 4 },
    { id: gpu('Project', 'benchmark', 'benchmark-rtx', 'deserved'), value: 0 },
  ]).source;
  pre[config.expectations.file] = files[config.expectations.file].replace('workspace-rtx:3:3', 'workspace-rtx:4:4').replace('benchmark-rtx:1:4', 'benchmark-rtx:0:4');
  pre['services/coder/manifests/workspace-quota.yaml'] = files['services/coder/manifests/workspace-quota.yaml'].replace('requests.nvidia.com/gpu: "3"', 'requests.nvidia.com/gpu: "4"');

  const p = buildPlan({
    config, files: pre, capacity, today: '2026-10-07', base: { ref: 'origin/main', sha: 'a02f99f0000000000000000000000000000000000' },
    edits: [
      { id: gpu('Project', 'workspace', 'workspace-rtx', 'deserved'), value: 3 },
      { id: gpu('Project', 'workspace', 'workspace-rtx', 'limit'), value: 3 },
      { id: gpu('Project', 'benchmark', 'benchmark-rtx', 'deserved'), value: 1 },
    ],
  });

  assert.deepEqual(codes(p.findings, 'error'), []);
  assert.equal(p.canCommit, true);
  assert.deepEqual(p.files.map((f) => f.role), ['tenancy', 'expectations', 'mirror']);
  // The planner arrives at exactly what was merged by hand.
  assert.equal(p.files[0].content, files[config.tenancy]);
  assert.equal(p.files[1].content, files[config.expectations.file]);
  assert.equal(p.files[2].content, files['services/coder/manifests/workspace-quota.yaml']);
  assert.match(p.message, /^kai-scheduler: quota change — workspace-rtx gpu 4\/4 → 3\/3; benchmark-rtx gpu 0\/4 → 1\/4\n/);
  assert.match(p.message, /workspace-quota\.yaml: ResourceQuota\/workspace requests\.nvidia\.com\/gpu 4 → 3/);
  assert.match(p.message, /against origin\/main \(a02f99f\)/);
  assert.equal(p.branch, 'quota/20261007-rebalance');
  assert.equal(p.reminders.length, 2);

  // git must accept the diff against the pre-change tree and produce the same files.
  const repo = mkdtempSync(join(tmpdir(), 'planner-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init', '-q');
  for (const [path, content] of Object.entries(pre)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  writeFileSync(join(repo, 'plan.patch'), p.diff);
  git('apply', '--check', 'plan.patch');
  git('apply', 'plan.patch');
  for (const f of p.files) assert.equal(readFileSync(join(repo, f.path), 'utf8'), f.content, f.path);
});

test('a quota that already differed is shown but not changed unless asked', () => {
  const odd = { ...files };
  odd['services/benchmarking/manifests/resource-quota.yaml'] = files['services/benchmarking/manifests/resource-quota.yaml'].replace('"4"', '"2"');
  const edits = [{ id: gpu('Project', 'benchmark', 'benchmark-rtx', 'overQuotaWeight'), value: 2 }];
  const quiet = buildPlan({ config, files: odd, capacity, edits });
  const bench = quiet.mirrors.find((m) => m.queue === 'benchmark-rtx');
  assert.deepEqual([bench.status, bench.included, bench.differedBefore], ['differs', false, true]);
  assert.deepEqual(quiet.files.map((f) => f.role), ['tenancy']);

  const asked = buildPlan({ config, files: odd, capacity, edits, mirrors: { 'services/benchmarking/manifests/resource-quota.yaml': true } });
  assert.deepEqual(asked.files.map((f) => f.role), ['tenancy', 'mirror']);
});

test('errors block the commit but the diff is still produced', () => {
  const p = buildPlan({ config, files, capacity, edits: [{ id: gpu('Project', 'kai-verify', 'kai-verify-rtx', 'deserved'), value: 1 }] });
  assert.equal(p.canCommit, false);
  assert.ok(p.diff.includes('+        gpu:    {deserved: 1,  limit: 1,  overQuotaWeight: 1}'));
});

test('cpu and memory edits carry the verify.sh warning', () => {
  const p = buildPlan({ config, files, capacity, edits: [{ id: fieldId('Project', 'workspace', 'workspace-rtx', 'cpu', 'limit'), value: 64000 }] });
  assert.ok(codes(p.findings, 'warning').includes('cpu-memory'));
});

test('unifiedDiff: separate hunks, merged hunks, missing final newline', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const far = unifiedDiff('f.txt', a, a.replace('line 3\n', 'LINE 3\n').replace('line 25\n', 'LINE 25\n'));
  assert.equal(far.match(/^@@/gm).length, 2);
  assert.ok(far.includes('@@ -1,6 +1,6 @@') && far.includes('@@ -22,7 +22,7 @@'));
  const near = unifiedDiff('f.txt', a, a.replace('line 3\n', 'LINE 3\n').replace('line 8\n', 'LINE 8\n'));
  assert.equal(near.match(/^@@/gm).length, 1);
  assert.ok(unifiedDiff('f.txt', 'a\nb', 'a\nc').includes('\\ No newline at end of file'));
  assert.equal(unifiedDiff('f.txt', a, a), '');
});

test('git and the cluster disagreeing is reported, once per queue', () => {
  const live = { 'workspace-rtx': { deserved: 4, limit: 4 }, 'benchmark-rtx': { deserved: 1, limit: 4 } };
  const p = buildPlan({ config, files, capacity, live, base: { ref: 'origin/main', sha: 'a'.repeat(40) } });
  const notes = p.findings.filter((f) => f.code === 'live-differs');
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /workspace-rtx: the cluster is running 4\/4 .* origin\/main says 3\/3/);
});

test('comments that explain a changed number are pointed at, not rewritten', () => {
  const p = buildPlan({ config, files, capacity, edits: [
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'deserved'), value: 2 },
    { id: gpu('Project', 'workspace', 'workspace-rtx', 'limit'), value: 2 },
    { id: gpu('Project', 'benchmark', 'benchmark-rtx', 'deserved'), value: 2 },
  ] });
  const notes = p.findings.filter((f) => f.code === 'stale-comment').map((f) => f.message);
  assert.equal(notes.length, 3, 'tenancy, env.sh, the coder ResourceQuota');
  assert.match(notes[0], /tenancy\.yaml: the comment at lines \d+–\d+, \d+–\d+ explains/);
  // and the comment text itself is untouched
  assert.ok(p.files[0].content.includes('# 3 of the 4 cards (was 4/4)'));
});
