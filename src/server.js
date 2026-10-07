// Local web server: the planner page plus a small JSON API behind it.
//
// Runs on the user's machine with the user's own access (their kubeconfig,
// their clone). It listens on loopback only, checks the Host header, and
// requires a per-process token on every API call, so another site open in
// the same browser cannot drive it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { buildPlan } from './core/plan.js';
import { normalizeConfig } from './core/config.js';
import { dependentRefusals } from './core/krm.js';
import { gitSource, clusterSource } from './sources.js';
import { currentContext, listContexts, readLive, dryRun } from './cluster.js';
import { planInput } from './plan-input.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const CORE = join(ROOT, 'src', 'core');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
const JS_MIME = 'text/javascript';

/**
 * @param {{
 *   source: 'cluster'|'git', port: number,
 *   context?: string, kubeconfig?: string,   which cluster to start on (default: the current context when the server starts)
 *   cluster?: boolean,                       git only: also read the cluster for card counts and usage
 *   repo?: string, ref?: string, fetch?: boolean, config?: any   git only
 * }} options
 */
export async function startServer(options) {
  const useCluster = options.source === 'cluster' || options.cluster !== false;
  const profile = options.config?.tenancy ? normalizeConfig(options.config) : options.config;
  let source = options.source === 'cluster'
    ? await clusterSource({ context: options.context, kubeconfig: options.kubeconfig })
    : await gitSource({ repo: options.repo, ref: options.ref, fetch: options.fetch, config: profile });
  // One cluster at a time, whichever source the objects come from, and it
  // changes only when the page asks for another (see /api/context).
  // Without a context of its own the overlay is still attempted, and says why it failed.
  let kube = source.target ?? { context: options.context || (useCluster ? await currentContext(options).catch(() => undefined) : undefined), kubeconfig: options.kubeconfig };
  const token = randomBytes(24).toString('hex');
  /** Everything read from the source and the cluster, replaced as a whole on reload. */
  let state = await load(source, kube);
  /** Goes up when the cluster changes, so a page still showing the old one can be told. */
  let epoch = 1;

  async function load(from, target) {
    const [loaded, live, contexts] = await Promise.all([
      from.load(),
      useCluster ? readLive(target) : { ok: false, error: 'cluster not read (--no-cluster)', context: '', readAt: '', queues: {}, pools: {} },
      useCluster ? listContexts(target).catch(() => []) : [],
    ]);
    return { ...loaded, live, contexts, loadedAt: new Date().toISOString() };
  }

  const planConfig = () => (profile?.tenancy ? profile : source.config);
  const plan = (body = {}) => buildPlan(planInput(planConfig(), state, body));

  // Has the source moved since this page's base was read (a new commit on the
  // ref, a quota changed on the cluster)? Every output is only as good as the
  // base it was planned against: the checks ran on it, and a whole file taken
  // from it would overwrite whatever landed since.
  async function freshness() {
    const now = await source.head();
    const moved = now.sha !== state.base.sha;
    return { moved, base: state.base, now, message: moved ? source.moved(state.base, now) : '' };
  }

  // The checks were run against the base loaded with this page. If it has
  // moved since, somebody else's change is not in them: two plans that are
  // each fine can land without a conflict into a split that is not (in git
  // their lines differ; on the cluster they are different objects). Refuse,
  // and have the user re-check against the new base — Reload keeps their edits.
  async function checkedPlan(body, verb) {
    const fresh = await freshness();
    if (fresh.moved) throw httpError(409, fresh.message);
    const p = plan(body);
    if (!p.canCommit) throw httpError(409, p.empty ? `there is nothing to ${verb === 'committing' ? 'commit' : 'apply'}` : `the plan has errors — fix them before ${verb}`);
    return p;
  }

  const describe = () => ({
    source: source.describe(state),
    cluster: { enabled: useCluster, ok: state.live.ok, error: state.live.error ?? null, context: state.live.context, contexts: state.contexts, readAt: state.live.readAt, pools: state.live.pools, queues: state.live.queues },
    loadedAt: state.loadedAt,
    epoch,
  });

  const api = {
    'GET /api/state': async () => ({ ...describe(), plan: plan() }),
    'POST /api/reload': async () => {
      state = await load(source, kube);
      return { ...describe(), plan: plan() };
    },
    // Point the session at another cluster from the kubeconfig. Everything is
    // read from it before anything is swapped, so a cluster that cannot be
    // read (unreachable, no KRM) leaves the session where it was.
    'POST /api/context': async (body) => {
      if (!useCluster) throw httpError(409, 'the cluster is switched off for this session (--no-cluster)');
      const context = String(body.context ?? '');
      if (!(await listContexts(kube)).includes(context)) throw httpError(400, `"${context}" is not a context in your kubeconfig`);
      if (context !== kube.context) {
        const target = { ...kube, context };
        const next = source.kind === 'cluster' ? await clusterSource(target) : source;
        state = await load(next, target);
        source = next;
        kube = target;
        epoch += 1;
      }
      return { ...describe(), plan: plan() };
    },
    'POST /api/plan': async (body) => plan(body),
    'POST /api/fresh': async () => freshness(),
    'POST /api/dry-run': async (body) => {
      if (!useCluster) throw httpError(409, 'the cluster is switched off for this session (--no-cluster)');
      const p = plan(body);
      const broken = p.findings.filter((f) => f.code === 'edit' || f.code === 'addition');
      if (broken.length) throw httpError(400, broken.map((f) => f.message).join('; '));
      const planned = p.files.find((f) => f.role === 'tenancy')?.content ?? state.files[source.config.tenancy];
      const result = await dryRun(planned, kube);
      // Nothing from a dry-run is stored, so what refers to a pool or department
      // this plan adds is refused. Those refusals say nothing against the plan.
      const { expected, other } = dependentRefusals(result.lines, p.additions);
      return { context: state.live.context, ...result, dependent: !result.ok && other === 0 ? expected : [] };
    },
    'POST /api/commit': async (body) => {
      if (!source.commit) throw httpError(409, 'this session reads the live cluster — there is no repository to commit to');
      const p = await checkedPlan(body, 'committing');
      const branch = String(body.branch || p.branch).trim();
      const message = String(body.message || p.message);
      const made = await source.commit(state, { branch, message, files: p.files.map(({ path, content }) => ({ path, content })) });
      return { ...made, repo: source.repo, base: state.base, files: p.files.map((f) => f.path) };
    },
    // The commands that make the plan true on the cluster. They are handed
    // back, not run: this server never writes to a cluster.
    'POST /api/apply': async (body) => {
      if (!source.commands) throw httpError(409, 'this session reads a git repository — the change goes in as a commit, not onto the cluster');
      const p = await checkedPlan(body, 'applying');
      return { context: kube.context, base: state.base, commands: source.commands(state, p) };
    },
  };

  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw httpError(403, 'this server only answers on localhost');
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        let body = await readFile(join(PUBLIC, file), 'utf8');
        if (file === 'index.html') body = body.replace('__PLANNER_TOKEN__', token);
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(body);
      }
      if (req.method === 'GET' && (url.pathname.startsWith('/js/') || url.pathname.startsWith('/core/'))) {
        const rel = normalize(url.pathname).replace(/^\/+/, '');
        if (rel.includes('..')) throw httpError(403, 'not found');
        const root = url.pathname.startsWith('/core/') ? CORE : PUBLIC;
        const file = url.pathname.startsWith('/core/') ? rel.replace(/^core\//, '') : rel;
        const body = await readFile(join(root, file), 'utf8');
        res.writeHead(200, { 'content-type': `${JS_MIME}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        return res.end(body);
      }

      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) throw httpError(404, 'not found');
      if (req.headers['x-planner-token'] !== token) throw httpError(403, 'missing or wrong session token — reload the page');
      // A page says which cluster it was drawn from. One left open while
      // another tab switched must not go on planning: its edits were made
      // against the other cluster's objects.
      const seen = req.headers['x-planner-epoch'];
      if (seen !== undefined && seen !== String(epoch)) throw httpError(409, `the planner was switched to ${kube.context} from another tab, so this page no longer shows what it would act on — reload the page in your browser`);
      const result = await handler(req.method === 'POST' ? await readJson(req) : {});
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const status = err.status ?? 500;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => reject(err.code === 'EADDRINUSE' ? new Error(`port ${options.port} is in use — pass --port`) : err));
    server.listen(options.port, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return { server, port, token, url: `http://localhost:${port}/`, describe, state: () => state };
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, 'request too large');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'request body is not JSON');
  }
}
