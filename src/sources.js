// Where the KRM objects being planned come from, and what a finished plan
// can be turned into there.
//
//   cluster  the live objects, read with kubectl. The result is the commands
//            that make the change; this tool does not run them.
//   git      a file in a clone of a GitOps repository, read at a ref. The
//            result is a commit on a new local branch.
//
// Both hand the server the same thing: a base (what was read, and an id that
// changes when it does) and the files the core plans against. Everything
// after that — parsing, checks, the diff — does not know which one it was.

import { createHash } from 'node:crypto';
import { renderTenancy, patchCommands } from './core/krm.js';
import { repoRoot, fetchRef, describeRef, showFile, createCommit } from './git.js';
import { currentContext, readKrmObjects } from './cluster.js';

/** The name the objects read from a cluster go by in the plan and the diff. */
const CLUSTER_FILE = 'krm-tenancy.yaml';

/**
 * @typedef {{ kind: 'cluster'|'git', ref: string, sha: string, date: string, subject: string }} Base
 * @typedef {{ base: Base, files: Record<string, string|undefined>, notes: import('./core/validate.js').Finding[] }} Loaded
 */

/**
 * @param {{ repo: string, ref: string, fetch: boolean, config: any }} options
 */
export async function gitSource({ repo: path, ref, fetch, config }) {
  if (!config?.tenancy) throw new Error('reading from git needs to know which file holds the KRM objects — pass --tenancy <path in the repository>, or a --config file that names it');
  const repo = await repoRoot(path);
  const head = async () => ({ kind: 'git', ...(await describeRef(repo, ref)) });

  return {
    kind: 'git',
    config,
    repo,
    async load() {
      const fetched = fetch ? await fetchRef(repo, ref) : { ok: false, skipped: true, error: 'fetch disabled (--no-fetch)' };
      const base = await head();
      const paths = [config.tenancy, config.expectations?.file, ...(config.resourceQuotaMirrors ?? []).map((m) => m.file)].filter(Boolean);
      const files = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await showFile(repo, base.sha, p)])));
      return { base, files, notes: [], fetched };
    },
    /** What the ref points at right now. */
    async head() {
      if (fetch) await fetchRef(repo, ref);
      return head();
    },
    moved: (base, now) => `${ref} moved ${base.sha.slice(0, 7)} → ${now.sha.slice(0, 7)} since this page loaded ("${now.subject.slice(0, 60)}") — press Reload (your edits are kept) and check the plan against it`,
    describe: (loaded) => ({
      kind: 'git',
      repo,
      ...loaded.base,
      fetched: loaded.fetched,
      tenancy: config.tenancy,
      displayName: config.displayName,
    }),
    commit: (loaded, { branch, message, files }) => createCommit(repo, { baseSha: loaded.base.sha, branch, message, files }),
  };
}

/**
 * @param {{ context?: string, kubeconfig?: string }} options
 */
export async function clusterSource({ context, kubeconfig }) {
  // Named once, here: `kubectl config use-context` in another terminal must
  // not move a page that is open on one cluster onto another. Choosing another
  // cluster in the page makes a new source.
  const target = { context: context || await currentContext({ kubeconfig }), kubeconfig };

  /** Last full read; head() re-hashes tenancy only for freshness. */
  let snapshot = null;

  async function read() {
    const { source, objects, managed } = renderTenancy(await readKrmObjects(target));
    const sha = createHash('sha256').update(source).digest('hex');
    const base = { kind: 'cluster', ref: target.context, sha, date: new Date().toISOString(), subject: '' };
    snapshot = { base, source, objects, managed };
    return snapshot;
  }

  return {
    kind: 'cluster',
    config: { tenancy: CLUSTER_FILE },
    target,
    async load() {
      const { base, source, objects, managed } = await read();
      return { base, files: { [CLUSTER_FILE]: source }, notes: managedNotes(managed), objects };
    },
    async head() {
      const { source } = renderTenancy(await readKrmObjects(target));
      const sha = createHash('sha256').update(source).digest('hex');
      const base = snapshot?.base ?? (await read()).base;
      return { ...base, sha, date: new Date().toISOString() };
    },
    moved: () => `the KRM objects on ${target.context} changed since this page loaded — press Reload (your edits are kept) and check the plan against them`,
    describe: (loaded) => ({ kind: 'cluster', ...loaded.base, context: target.context, tenancy: CLUSTER_FILE, displayName: undefined }),
    commands: (loaded, plan) => patchCommands(loaded.objects, plan.changes, target, plan.additions),
  };
}

function managedNotes(managed) {
  const owners = [...new Set(managed.map((m) => m.by))];
  return owners.map((by) => {
    const names = managed.filter((m) => m.by === by).map((m) => m.name);
    return {
      level: 'warning',
      code: 'gitops-managed',
      message: `${list(names)} ${names.length === 1 ? 'is' : 'are'} managed by ${by} — a change made on the cluster is put back by its next sync, or shows up as drift. Change ${names.length === 1 ? 'it' : 'them'} where ${names.length === 1 ? 'it is' : 'they are'} defined: start this tool with --repo <clone> --tenancy <file>`,
    };
  });
}

const list = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);
