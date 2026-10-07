import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../src/server.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const readFixture = (name) => readFileSync(join(fixtures, name), 'utf8');

export const gitopsConfig = JSON.parse(readFileSync(join(pkgRoot, 'examples', 'gitops.json'), 'utf8'));

/** @returns {string} absolute path to a fresh git repo with fixture tenancy */
export function createScratchGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'planner-e2e-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'E2E');
  git('config', 'user.email', 'e2e@example.invalid');
  const put = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  };
  put(gitopsConfig.tenancy, readFixture('tenancy.yaml'));
  put(gitopsConfig.expectations.file, readFixture('env.sh'));
  put('services/coder/manifests/workspace-quota.yaml', readFixture('coder-workspace-quota.yaml'));
  put('services/benchmarking/manifests/resource-quota.yaml', readFixture('bench-resource-quota.yaml'));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return repo;
}

/**
 * @param {{ port: number, cluster?: boolean }} options
 */
export async function startScratchServer(options) {
  const repo = createScratchGitRepo();
  const app = await startServer({
    source: 'git',
    repo,
    ref: 'main',
    port: options.port,
    config: gitopsConfig,
    fetch: false,
    cluster: options.cluster ?? false,
  });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  return { app, repo, git, config: gitopsConfig };
}
