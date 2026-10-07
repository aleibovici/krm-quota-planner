// Git access to the GitOps repository.
//
// Reads come from a ref (origin/main by default), never from the working
// tree: a clone that is behind, dirty or on a feature branch must not change
// what the planner shows as "current".
//
// The one write is a commit on a NEW local branch, built with plumbing
// against a temporary index. The user's checkout, index and current branch
// are not touched, and nothing is pushed.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec, run } from './exec.js';

const git = (repo, args, options) => run('git', ['-C', repo, ...args], options);

export async function repoRoot(path) {
  try {
    return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    throw new Error(`${path} is not a git repository — pass the clone of the GitOps repo with --repo`);
  }
}

/** Update the remote-tracking ref behind `ref` ("origin/main" -> fetch origin main). Never fatal. */
export async function fetchRef(repo, ref) {
  const [remote, ...branch] = ref.split('/');
  if (!branch.length) return { ok: false, skipped: true, error: `${ref} is not a remote-tracking ref` };
  const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
  if (!remotes.includes(remote)) return { ok: false, skipped: true, error: `no remote named ${remote}` };
  try {
    await git(repo, ['fetch', '--quiet', remote, branch.join('/')], { timeoutMs: 25_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function describeRef(repo, ref) {
  const out = await git(repo, ['log', '-1', '--format=%H%x00%cI%x00%s', ref]);
  const [sha, date, subject] = out.trim().split('\0');
  return { ref, sha, date, subject };
}

/** @returns {Promise<string|undefined>} undefined when the path does not exist at that commit */
export async function showFile(repo, sha, path) {
  const r = await exec('git', ['-C', repo, 'show', `${sha}:${path}`]);
  return r.code === 0 ? r.stdout : undefined;
}

/**
 * Create `branch` pointing at a new commit: `baseSha` plus the given files.
 *
 * @param {string} repo
 * @param {{ baseSha: string, branch: string, message: string, files: { path: string, content: string }[] }} input
 * @returns {Promise<{ branch: string, sha: string }>}
 */
export async function createCommit(repo, { baseSha, branch, message, files }) {
  if (!files.length) throw new Error('nothing to commit');
  if (!message.trim()) throw new Error('the commit message is empty');
  if ((await exec('git', ['-C', repo, 'check-ref-format', '--branch', branch])).code !== 0) {
    throw new Error(`"${branch}" is not a valid branch name`);
  }
  if ((await exec('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
    throw new Error(`branch ${branch} already exists in ${repo} — choose another name, or delete it first`);
  }

  const scratch = await mkdtemp(join(tmpdir(), 'quota-planner-'));
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  try {
    await git(repo, ['read-tree', baseSha], { env });
    for (const file of files) {
      const blob = (await git(repo, ['hash-object', '-w', '--stdin'], { input: file.content })).trim();
      // Keep the file's existing mode (env.sh may be executable).
      const entry = (await git(repo, ['ls-tree', baseSha, '--', file.path])).trim();
      const mode = entry ? entry.split(/\s+/)[0] : '100644';
      await git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${file.path}`], { env });
    }
    const tree = (await git(repo, ['write-tree'], { env })).trim();
    const sha = (await git(repo, ['commit-tree', tree, '-p', baseSha, '-F', '-'], { input: message })).trim();
    await git(repo, ['branch', branch, sha]);
    return { branch, sha };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
