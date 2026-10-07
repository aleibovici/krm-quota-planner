#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] || 'large';
const demo = join(root, 'examples', 'demo', name);
const config = join(demo, 'demo.config.json');

if (!existsSync(config)) {
  console.error(`quota-planner demo: missing ${config}`);
  console.error('Run: npm run demo:generate');
  process.exit(1);
}

if (!existsSync(join(demo, '.git'))) {
  const git = (...args) => execFileSync('git', ['-C', demo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Demo');
  git('config', 'user.email', 'demo@example.invalid');
  git('add', '-A');
  git('commit', '-q', '-m', 'Demo fixture for offline screenshots');
}

const fakeKubectl = join(root, 'test', 'fixtures', 'bin');
const env = {
  ...process.env,
  FAKE_CLUSTER: join(demo, 'cluster'),
  PATH: `${fakeKubectl}${delimiter}${process.env.PATH}`,
};

const planner = join(root, 'bin', 'quota-planner.js');
const forward = process.argv.slice(3);
const portArgs = forward.some((a) => a === '--port' || a.startsWith('--port=')) ? [] : ['--port', '4781'];
const child = spawn(
  process.execPath,
  [planner, '--repo', demo, '--config', config, '--ref', 'main', '--context', 'demo', '--no-fetch', ...portArgs, ...forward],
  { env, stdio: 'inherit' },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
