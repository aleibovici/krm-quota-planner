import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const config = JSON.parse(readFileSync(new URL('../examples/gitops.json', import.meta.url), 'utf8'));
const BENCH = 'Project/benchmark/benchmark-rtx/gpu/deserved';
const VERIFY = 'Project/kai-verify/kai-verify-rtx/gpu/deserved';

const caller = (app) => async (method, path, body, headers = {}) => {
  const res = await fetch(`${app.url}${path.slice(1)}`, { method, headers: { 'x-planner-token': app.token, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

async function scratch(options = { cluster: false }) {
  const repo = mkdtempSync(join(tmpdir(), 'planner-server-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const put = (path, content) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); };
  put(config.tenancy, read('tenancy.yaml'));
  put(config.expectations.file, read('env.sh'));
  put('services/coder/manifests/workspace-quota.yaml', read('coder-workspace-quota.yaml'));
  put('services/benchmarking/manifests/resource-quota.yaml', read('bench-resource-quota.yaml'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const app = await startServer({ source: 'git', repo, ref: 'main', port: 0, config, fetch: false, ...options });
  return { repo, git, put, app, call: caller(app) };
}

// The fixture kubectl answers from files: fake-cluster holds the recorded
// read, other-cluster the same tenants with benchmark guaranteed nothing,
// and broken-cluster cannot be read at all.
function fakeKubectl() {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cluster-'));
  const file = join(dir, 'krm.json');
  writeFileSync(file, read('live-krm.json'));
  const other = JSON.parse(read('live-krm.json'));
  other.items.find((i) => i.metadata.name === 'benchmark').spec.queues[0].resources.gpu.deserved = 0;
  mkdirSync(join(dir, 'other-cluster'));
  writeFileSync(join(dir, 'other-cluster', 'krm.json'), JSON.stringify(other));
  mkdirSync(join(dir, 'broken-cluster'));
  process.env.FAKE_CLUSTER = dir;
  const bin = fileURLToPath(new URL('./fixtures/bin', import.meta.url));
  if (!process.env.PATH.startsWith(bin)) process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  return file;
}

// A session whose source is a cluster; `change` rewrites what fake-cluster
// holds the way someone else's kubectl would.
async function onCluster() {
  const file = fakeKubectl();
  const change = (mutate) => {
    const list = JSON.parse(readFileSync(file, 'utf8'));
    mutate((name) => list.items.find((i) => i.metadata.name === name));
    writeFileSync(file, JSON.stringify(list));
  };
  const app = await startServer({ source: 'cluster', port: 0 });
  return { app, call: caller(app), change };
}

test('the API needs the page token', async (t) => {
  const { app, call } = await scratch();
  t.after(() => app.server.close());
  assert.equal((await call('GET', '/api/state', null, { 'x-planner-token': 'nope' })).status, 403);
  const ok = await call('GET', '/api/state');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.cluster.ok, false);
  assert.match(await (await fetch(app.url)).text(), new RegExp(`planner-token" content="${app.token}"`));
});

test('commit: a branch with the planned files; errors and empty plans are refused', async (t) => {
  const { git, app, call } = await scratch();
  t.after(() => app.server.close());
  assert.equal((await call('POST', '/api/commit', { edits: [] })).status, 409);
  const bad = await call('POST', '/api/commit', { edits: [{ id: VERIFY, value: 1 }] });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /has errors/);

  const made = await call('POST', '/api/commit', { edits: [{ id: BENCH, value: 0.5 }], branch: 'quota/test' });
  assert.equal(made.status, 200);
  assert.equal(git('rev-parse', 'quota/test'), made.body.sha);
  assert.match(git('show', `quota/test:${config.tenancy}`), /gpu: {4}\{deserved: 0\.5, limit: 4, {2}overQuotaWeight: 1\}/);
  assert.match(git('show', `quota/test:${config.expectations.file}`), /benchmark-rtx:0\.5:4/);
  assert.equal(git('status', '--porcelain'), '');
});

test('commit is refused when the base moved since the page loaded', async (t) => {
  // This page plans workspace 3 -> 2 and benchmark 1 -> 2: fine, 4 of 4.
  // Meanwhile someone else merges kai-verify 0 -> 1: also fine alone, 4 of 4.
  // The two touch different lines, so git merges them without a conflict —
  // into 5 guaranteed cards out of 4. Only a re-check on the new base sees it.
  const { git, put, app, call } = await scratch();
  t.after(() => app.server.close());
  const edits = [{ id: 'Project/workspace/workspace-rtx/gpu/deserved', value: 2 }, { id: BENCH, value: 2 }];
  assert.equal((await call('POST', '/api/plan', { edits })).body.canCommit, true);
  assert.equal((await call('POST', '/api/fresh')).body.moved, false);

  put(config.tenancy, read('tenancy.yaml').replace('gpu:    {deserved: 0,  limit: 1,', 'gpu:    {deserved: 1,  limit: 1,'));
  git('commit', '-q', '-am', 'someone else: kai-verify gets a card');

  // the same check guards the copy/download outputs
  const fresh = await call('POST', '/api/fresh');
  assert.equal(fresh.body.moved, true);
  assert.match(fresh.body.message, /main moved [0-9a-f]{7} → [0-9a-f]{7} .*someone else: kai-verify gets a card.*Reload/);

  const refused = await call('POST', '/api/commit', { edits, branch: 'quota/stale' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /main moved [0-9a-f]{7} → [0-9a-f]{7} since this page loaded .*Reload/);
  assert.equal(git('branch', '--list', 'quota/stale'), '', 'nothing was created');

  const reloaded = await call('POST', '/api/reload');
  assert.equal(reloaded.status, 200);
  assert.equal((await call('POST', '/api/fresh')).body.moved, false, 'after Reload the page is on the new base');
  const replanned = await call('POST', '/api/plan', { edits });
  assert.equal(replanned.body.canCommit, false, 'against the new base the same edits oversubscribe the department');
  assert.ok(replanned.body.findings.some((f) => f.code === 'oversubscribed'));
});

test('from a cluster: the live objects are the base, and the result is commands, not a commit', async (t) => {
  const { app, call } = await onCluster();
  t.after(() => app.server.close());

  const state = (await call('GET', '/api/state')).body;
  assert.equal(state.source.kind, 'cluster');
  assert.equal(state.source.context, 'fake-cluster');
  assert.equal(state.plan.model.base.values[BENCH], 1);
  assert.deepEqual(state.plan.mirrors, []);
  assert.ok(state.plan.findings.some((f) => f.code === 'gitops-managed' && f.level === 'warning'));

  const edits = [{ id: BENCH, value: 2 }, { id: 'Project/workspace/workspace-rtx/gpu/deserved', value: 2 }];
  assert.equal((await call('POST', '/api/commit', { edits })).status, 409, 'there is no repository in this session');
  assert.equal((await call('POST', '/api/apply', { edits: [] })).status, 409);
  const bad = await call('POST', '/api/apply', { edits: [{ id: VERIFY, value: 1 }] });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /has errors/);

  const made = await call('POST', '/api/apply', { edits });
  assert.equal(made.status, 200);
  assert.equal(made.body.commands.length, 2);
  assert.match(made.body.commands[0], /^kubectl --context fake-cluster patch projects\.kai\.resources workspace --type=json /);
  assert.match(made.body.commands[1], /"op":"test","path":"\/spec\/queues\/0\/resources\/gpu\/deserved","value":1\},\{"op":"replace",.*"value":2/);
});

test('from a cluster: usage moving is not a new base, a changed quota is', async (t) => {
  // The same race as the git test above, with kubectl in place of a merge.
  const { app, call, change } = await onCluster();
  t.after(() => app.server.close());
  const edits = [{ id: 'Project/workspace/workspace-rtx/gpu/deserved', value: 2 }, { id: BENCH, value: 2 }];
  assert.equal((await call('POST', '/api/plan', { edits })).body.canCommit, true);

  change((object) => {
    object('workspace').metadata.resourceVersion = '50000000';
    object('workspace').status.quotaStatus.allocated['nvidia.com/gpu'] = '2';
  });
  assert.equal((await call('POST', '/api/fresh')).body.moved, false, 'a pod started; nobody changed a quota');
  assert.equal((await call('POST', '/api/apply', { edits })).status, 200);

  change((object) => { object('kai-verify').spec.queues[0].resources.gpu.deserved = 1; });
  assert.equal((await call('POST', '/api/fresh')).body.moved, true);
  const refused = await call('POST', '/api/apply', { edits });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /KRM objects on fake-cluster changed since this page loaded .*Reload/);

  assert.equal((await call('POST', '/api/reload')).status, 200);
  const replanned = await call('POST', '/api/plan', { edits });
  assert.equal(replanned.body.canCommit, false, 'against the new base the same edits oversubscribe the department');
  assert.ok(replanned.body.findings.some((f) => f.code === 'oversubscribed'));
});

test('from git, the cluster is not where the change goes', async (t) => {
  const { app, call } = await scratch();
  t.after(() => app.server.close());
  assert.equal((await call('GET', '/api/state')).body.source.kind, 'git');
  const refused = await call('POST', '/api/apply', { edits: [{ id: BENCH, value: 0.5 }] });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /goes in as a commit/);
});

test('choosing another cluster in the page: read first, then switched, and commands name it', async (t) => {
  const { app, call } = await onCluster();
  t.after(() => app.server.close());
  const before = (await call('GET', '/api/state')).body;
  assert.deepEqual(before.cluster.contexts, ['fake-cluster', 'other-cluster', 'broken-cluster']);
  assert.equal(before.source.context, 'fake-cluster');

  assert.equal((await call('POST', '/api/context', { context: 'not-in-kubeconfig' })).status, 400);
  const broken = await call('POST', '/api/context', { context: 'broken-cluster' });
  assert.ok(broken.status >= 400, 'a cluster that cannot be read is not switched to');
  const still = (await call('GET', '/api/state')).body;
  assert.equal(still.source.context, 'fake-cluster');
  assert.equal(still.epoch, before.epoch);

  const switched = await call('POST', '/api/context', { context: 'other-cluster' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.source.context, 'other-cluster');
  assert.equal(switched.body.cluster.context, 'other-cluster');
  assert.equal(switched.body.plan.model.base.values[BENCH], 0, "the other cluster's numbers");
  assert.notEqual(switched.body.source.sha, before.source.sha);
  const made = await call('POST', '/api/apply', { edits: [{ id: BENCH, value: 1 }] });
  assert.match(made.body.commands[0], /^kubectl --context other-cluster patch /);
  assert.match(made.body.commands[0], /"op":"test","path":"\/spec\/queues\/0\/resources\/gpu\/deserved","value":0\}/);

  // A tab still drawn from fake-cluster planned 1 -> 2 there. Here that would
  // read as 0 -> 2; it is turned away instead, on every call it makes.
  const stale = { 'x-planner-epoch': String(before.epoch) };
  for (const path of ['/api/plan', '/api/apply', '/api/reload', '/api/dry-run']) {
    const refused = await call('POST', path, { edits: [{ id: BENCH, value: 2 }] }, stale);
    assert.equal(refused.status, 409, path);
    assert.match(refused.body.error, /switched to other-cluster from another tab.*reload the page/);
  }
  assert.equal((await call('POST', '/api/plan', { edits: [] }, { 'x-planner-epoch': String(switched.body.epoch) })).status, 200);
});

test('from git, the picker changes which cluster the usage comes from — not the plan', async (t) => {
  fakeKubectl();
  const { app, call } = await scratch({ cluster: true });
  t.after(() => app.server.close());
  const before = (await call('GET', '/api/state')).body;
  assert.equal(before.cluster.context, 'fake-cluster');
  assert.deepEqual(before.cluster.contexts, ['fake-cluster', 'other-cluster', 'broken-cluster']);

  const switched = (await call('POST', '/api/context', { context: 'other-cluster' })).body;
  assert.equal(switched.cluster.context, 'other-cluster');
  assert.equal(switched.source.kind, 'git');
  assert.equal(switched.source.sha, before.source.sha);
  assert.equal(switched.plan.model.base.values[BENCH], 1, 'still the file in git');
});

test('with --no-cluster there is no cluster to choose', async (t) => {
  const { app, call } = await scratch();
  t.after(() => app.server.close());
  assert.deepEqual((await call('GET', '/api/state')).body.cluster.contexts, []);
  assert.equal((await call('POST', '/api/context', { context: 'other-cluster' })).status, 409);
});

const LAB = { kind: 'Project', name: 'lab', namespace: 'lab', parent: 'platform', queues: [{ name: 'lab-rtx', nodepool: 'rtx-pro-6000', priority: 50, gpu: { deserved: 1, limit: 2, overQuotaWeight: 1 } }] };
const CODER_DOWN = { id: 'Project/workspace/workspace-rtx/gpu/deserved', value: 2 };

test('adding a project, from a cluster: checked with the rest, and created after the card it takes is released', async (t) => {
  const { app, call } = await onCluster();
  t.after(() => app.server.close());

  const alone = await call('POST', '/api/plan', { additions: [LAB] });
  assert.ok(alone.body.findings.some((f) => f.code === 'oversubscribed'), 'a fifth guaranteed card on a department of four');
  assert.equal((await call('POST', '/api/apply', { additions: [LAB] })).status, 409);

  const made = await call('POST', '/api/apply', { additions: [LAB], edits: [CODER_DOWN] });
  assert.equal(made.status, 200);
  assert.equal(made.body.commands.length, 2);
  assert.match(made.body.commands[0], /^kubectl --context fake-cluster patch projects\.kai\.resources workspace /);
  assert.match(made.body.commands[1], /^kubectl --context fake-cluster create -f - <<'EOF'\napiVersion: kai\.resources\/v1alpha1\nkind: Project\nmetadata:\n  name: lab\nspec:\n  namespace: lab\n  parent: platform\n/);
  assert.doesNotMatch(made.body.commands[1], /annotations|tracking-id/, "a new object does not inherit Argo's claim on its neighbours");

  const taken = await call('POST', '/api/plan', { additions: [{ ...LAB, name: 'workspace' }] });
  assert.match(taken.body.additions[0].error, /Project workspace already exists/);
  assert.equal(taken.body.canCommit, false);
});

test('adding a project, from git: one commit holding the new document', async (t) => {
  const { git, app, call } = await scratch();
  t.after(() => app.server.close());
  const made = await call('POST', '/api/commit', { additions: [LAB], edits: [CODER_DOWN], branch: 'quota/add-lab' });
  assert.equal(made.status, 200);
  const file = git('show', `quota/add-lab:${config.tenancy}`);
  assert.match(file, /\nkind: Project\nmetadata:\n  name: lab\n  annotations:\n    argocd\.argoproj\.io\/sync-options: "SkipDryRunOnMissingResource=true"\n    argocd\.argoproj\.io\/sync-wave: "3"\nspec:\n  namespace: lab\n  parent: platform\n/);
  assert.match(git('log', '-1', '--format=%B', 'quota/add-lab'), /new project lab in platform: lab-rtx 1\/2 on rtx-pro-6000/);
  assert.equal(git('diff', '--stat', 'main', 'quota/add-lab', '--', config.tenancy).includes('tenancy.yaml'), true);
  assert.equal(git('status', '--porcelain'), '');
});
