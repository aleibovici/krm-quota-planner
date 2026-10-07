#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startServer } from '../src/server.js';
import { normalizeConfig } from '../src/core/config.js';

const HELP = `quota-planner — plan KRM GPU quotas visually, get the commands or a local commit back

Usage: quota-planner [options]

Where the KRM objects (NodePools, Departments, Projects) are read from:

  --source <cluster|git>   default: cluster — or git, when a repository is named

  cluster: the live objects
  --context <name>         kubectl context to start on (default: your current context)
                           Another can be chosen in the page; a change of kubectl's
                           current context after start is not followed.
  --kubeconfig <file>      kubeconfig to use         (default: kubectl's own)

  git: a file in a clone of your GitOps repository
  --repo <path>            the clone                 (or $QUOTA_PLANNER_REPO)
  --tenancy <path>         the file, inside the repository, that holds the objects
  --ref <ref>              what counts as "current"  (default: origin/main)
  --no-fetch               do not run "git fetch" before reading the ref
  --no-cluster             do not read the cluster at all (no live usage, no card count, no dry-run)

  --config <file>          a JSON profile holding any of the above, plus the other
                           files a quota is written down in (see examples/)
  --port <n>               local port                (default: 4780)
  -h, --help

The cluster is only ever read: from a cluster the result is the kubectl
commands for you to run, from git it is a commit on a new local branch. That
holds for what you add (departments, projects, queues, node pools) as well.`;

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    context: { type: 'string' },
    kubeconfig: { type: 'string' },
    repo: { type: 'string' },
    tenancy: { type: 'string' },
    ref: { type: 'string' },
    config: { type: 'string' },
    port: { type: 'string', default: '4780' },
    'no-cluster': { type: 'boolean', default: false },
    'no-fetch': { type: 'boolean', default: false },
    demo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

if (values.demo) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const runDemo = join(dirname(fileURLToPath(import.meta.url)), 'run-demo.mjs');
  const child = spawn(process.execPath, [runDemo, 'large'], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  await new Promise(() => {});
}

try {
  const configPath = values.config ? resolve(values.config) : null;
  const raw = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : {};
  const merged = { ...raw, ...(values.tenancy ? { tenancy: values.tenancy } : {}) };
  const config = merged.tenancy ? normalizeConfig(merged) : merged;
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port ${values.port} is not a port number`);

  // A flag beats the environment, which beats the profile. A path written in
  // the profile is relative to the profile.
  const repo = values.repo ?? process.env.QUOTA_PLANNER_REPO ?? (config.repo ? resolve(dirname(configPath), config.repo) : undefined);
  const source = values.source ?? (values.repo ?? process.env.QUOTA_PLANNER_REPO ? 'git' : config.source ?? (repo ? 'git' : 'cluster'));
  if (!['cluster', 'git'].includes(source)) throw new Error(`--source ${source}: expected cluster or git`);
  if (source === 'git' && !repo) throw new Error('reading from git needs the clone — pass --repo <path>');
  if (source === 'cluster' && values['no-cluster']) throw new Error('--no-cluster leaves nothing to read: the cluster is the source. Name a repository with --repo, or drop --no-cluster');

  const kubeconfig = values.kubeconfig ?? (config.kubeconfig ? resolve(dirname(configPath), config.kubeconfig) : undefined);
  const { url, describe, state } = await startServer({
    source,
    port,
    context: values.context ?? config.context,
    kubeconfig: kubeconfig ? resolve(kubeconfig) : undefined,
    cluster: !values['no-cluster'],
    repo: repo ? resolve(repo) : undefined,
    ref: values.ref ?? config.ref ?? 'origin/main',
    fetch: !values['no-fetch'],
    config: config.tenancy ? normalizeConfig({ ...config, tenancy: values.tenancy ?? config.tenancy }) : config,
  });

  const from = describe().source;
  const s = state();
  console.log(`quota-planner  ${url}`);
  if (from.kind === 'git') {
    console.log(`  source       git — ${from.repo}`);
    console.log(`  current      ${from.ref} @ ${from.sha.slice(0, 7)}  ${from.subject.slice(0, 70)}`);
    console.log(`  fetch        ${from.fetched.ok ? 'up to date with the remote' : `not fetched — ${from.fetched.error}`}`);
    console.log(`  cluster      ${s.live.ok ? `${s.live.context} (read-only)` : `not available — ${s.live.error}`}`);
  } else {
    console.log(`  source       cluster — ${from.context} (read-only)`);
    const count = (kind) => s.objects.filter((o) => o.kind === kind).length;
    console.log(`  objects      NodePool ${count('NodePool')}, Department ${count('Department')}, Project ${count('Project')}`);
    if (!s.live.ok) console.log(`  usage        not available — ${s.live.error}`);
  }
  console.log('\nCtrl-C to stop.');
} catch (err) {
  console.error(`quota-planner: ${err.message}`);
  process.exit(1);
}
