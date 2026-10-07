import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot, describeRef, showFile, createCommit, fetchRef } from '../src/git.js';

function scratchRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'planner-git-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  mkdirSync(join(repo, 'svc'), { recursive: true });
  writeFileSync(join(repo, 'svc/tenancy.yaml'), 'deserved: 3\n');
  writeFileSync(join(repo, 'svc/env.sh'), 'Q="q:3:3"\n');
  chmodSync(join(repo, 'svc/env.sh'), 0o755);
  writeFileSync(join(repo, 'other.txt'), 'untouched\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { repo, git };
}

test('reads come from a commit, not from the working tree', async () => {
  const { repo, git } = scratchRepo();
  const base = await describeRef(repo, 'main');
  writeFileSync(join(repo, 'svc/tenancy.yaml'), 'deserved: 99   # uncommitted local edit\n');
  assert.equal(await showFile(repo, base.sha, 'svc/tenancy.yaml'), 'deserved: 3\n');
  assert.equal(await showFile(repo, base.sha, 'svc/missing.yaml'), undefined);
  assert.equal(base.subject, 'base');
  assert.equal(await repoRoot(join(repo, 'svc')), git('rev-parse', '--show-toplevel'));
});

test('createCommit adds a branch and leaves the checkout, index and HEAD alone', async () => {
  const { repo, git } = scratchRepo();
  const base = await describeRef(repo, 'main');
  writeFileSync(join(repo, 'other.txt'), 'dirty working tree\n'); // must survive
  writeFileSync(join(repo, 'staged.txt'), 'staged by the user\n');
  git('add', 'staged.txt');
  const before = { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), status: git('status', '--porcelain') };

  const made = await createCommit(repo, {
    baseSha: base.sha, branch: 'quota/20261007-test', message: 'quota change\n\nbody\n',
    files: [{ path: 'svc/tenancy.yaml', content: 'deserved: 2\n' }, { path: 'svc/env.sh', content: 'Q="q:2:2"\n' }],
  });

  assert.equal(git('rev-parse', 'quota/20261007-test'), made.sha);
  assert.equal(git('rev-parse', `${made.sha}^`), base.sha, 'one commit on top of the base');
  assert.equal(git('show', `${made.sha}:svc/tenancy.yaml`), 'deserved: 2');
  assert.equal(git('log', '-1', '--format=%s', made.sha), 'quota change');
  assert.deepEqual(git('diff', '--name-only', base.sha, made.sha).split('\n'), ['svc/env.sh', 'svc/tenancy.yaml']);
  assert.match(git('ls-tree', made.sha, 'svc/env.sh'), /^100755 /, 'the executable bit is kept');
  // the user's state is exactly as it was
  assert.deepEqual({ head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), status: git('status', '--porcelain') }, before);
  assert.equal(readFileSync(join(repo, 'other.txt'), 'utf8'), 'dirty working tree\n');
  assert.equal(readFileSync(join(repo, 'svc/tenancy.yaml'), 'utf8'), 'deserved: 3\n');
});

test('createCommit refuses an existing branch, a bad name, an empty message', async () => {
  const { repo, git } = scratchRepo();
  const base = await describeRef(repo, 'main');
  const files = [{ path: 'svc/tenancy.yaml', content: 'deserved: 2\n' }];
  await assert.rejects(createCommit(repo, { baseSha: base.sha, branch: 'main', message: 'm', files }), /already exists/);
  await assert.rejects(createCommit(repo, { baseSha: base.sha, branch: 'bad..name', message: 'm', files }), /not a valid branch name/);
  await assert.rejects(createCommit(repo, { baseSha: base.sha, branch: 'ok', message: '  \n', files }), /message is empty/);
  await assert.rejects(createCommit(repo, { baseSha: base.sha, branch: 'ok', message: 'm', files: [] }), /nothing to commit/);
  assert.equal(git('branch', '--list', 'ok'), '');
});

test('fetchRef is never fatal', async () => {
  const { repo } = scratchRepo();
  assert.deepEqual(await fetchRef(repo, 'main'), { ok: false, skipped: true, error: 'main is not a remote-tracking ref' });
  assert.equal((await fetchRef(repo, 'origin/main')).skipped, true);
});
