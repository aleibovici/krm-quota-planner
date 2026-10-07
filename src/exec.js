// Run a program with an argument array (never a shell string), optional
// stdin, and a timeout. Used for git and kubectl.

import { spawn } from 'node:child_process';

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ input?: string, env?: Record<string, string>, timeoutMs?: number, cwd?: string }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function exec(command, args, { input, env, timeoutMs = 20_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command}: no answer after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${command} is not installed or not on PATH`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // the child may exit before reading stdin
    child.stdin.end(input ?? '');
  });
}

/** Like exec, but a non-zero exit is an error carrying stderr. */
export async function run(command, args, options) {
  const r = await exec(command, args, options);
  if (r.code !== 0) {
    throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `${command} exited ${r.code}`);
  }
  return r.stdout;
}
