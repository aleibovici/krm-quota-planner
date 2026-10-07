#!/usr/bin/env node
/**
 * Build an offline demo tree under examples/demo/<name>/:
 *   - git repo with a large tenancy.yaml (+ coupled files)
 *   - cluster/<context>/*.json for the fake kubectl (usage, nodes, queues)
 *
 * Usage: node scripts/generate-demo-fixture.mjs [name]
 * Default name: large
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const name = process.argv[2] || 'large';
const out = join(root, 'examples', 'demo', name);

// 160 GPUs across 20 nodes (8 GPUs per node): one H100 pool + one A100 pool.
const POOLS = [
  { name: 'h100-80gb', labelValue: 'h100', nodes: 12, cards: 8, product: 'NVIDIA H100 80GB HBM3', memory: 81559 },
  { name: 'a100-80gb', labelValue: 'a100', nodes: 8, cards: 8, product: 'NVIDIA A100 80GB PCIe', memory: 81920 },
];
const DEPTS_PER_POOL = 4;
const PROJECTS_PER_DEPT = 6;
// Some departments are not confined to one pool: the first `departments` of
// `from` also hold a small queue on `to`, and so do their first `projects`.
// The cards come out of what the departments at home on `to` would have had.
const GUESTS = { from: 'h100-80gb', to: 'a100-80gb', departments: 2, projects: 2, cardsEach: 4 };

const LABEL = 'example.com/gpu-class';

function yamlHeader() {
  const nodes = POOLS.reduce((n, p) => n + p.nodes, 0);
  const gpus = POOLS.reduce((n, p) => n + p.nodes * p.cards, 0);
  return `# Demo tenancy — ${gpus} GPUs on ${nodes} nodes (offline fixture).
# Regenerate: npm run demo:generate`;
}

function nodePoolDoc(pool) {
  return `apiVersion: kai.resources/v1alpha1
kind: NodePool
metadata:
  name: ${pool.name}
  annotations:
    argocd.argoproj.io/sync-options: SkipDryRunOnMissingResource=true
    argocd.argoproj.io/sync-wave: "1"
spec:
  labelKey: ${LABEL}
  labelValue: ${pool.labelValue}
  schedulingShardConfig:
    placementStrategy:
      gpu: binpack
      cpu: spread
`;
}

function queueDoc(q) {
  return `    - name: ${q.name}
      nodepool: ${q.pool}${q.priority === undefined ? '' : `\n      priority: ${q.priority}`}
      resources:
        gpu:    {deserved: ${q.deserved},  limit: ${q.limit},  overQuotaWeight: 1}
        cpu:    {deserved: -1, limit: -1, overQuotaWeight: 1}
        memory: {deserved: -1, limit: -1, overQuotaWeight: 1}
`;
}

function departmentDoc(dept) {
  return `apiVersion: kai.resources/v1alpha1
kind: Department
metadata:
  name: ${dept.name}
  annotations:
    argocd.argoproj.io/sync-options: SkipDryRunOnMissingResource=true
    argocd.argoproj.io/sync-wave: "2"
spec:
  queues:
${dept.queues.map(queueDoc).join('')}`;
}

function projectDoc(proj) {
  return `apiVersion: kai.resources/v1alpha1
kind: Project
metadata:
  name: ${proj.name}
  annotations:
    argocd.argoproj.io/sync-options: SkipDryRunOnMissingResource=true
    argocd.argoproj.io/sync-wave: "3"
spec:
  namespace: ${proj.namespace}
  parent: ${proj.parent}
  enforceKaiScheduler: false
  defaultNodePools: [${proj.queues[0].pool}]
  queues:
${proj.queues.map(queueDoc).join('')}`;
}

function splitInteger(total, parts) {
  const base = Math.floor(total / parts);
  const rem = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

function buildTenancy() {
  const departments = [];
  const projects = [];
  const capacity = (pool) => pool.nodes * pool.cards;
  const guestCards = GUESTS.departments * GUESTS.cardsEach;
  for (const pool of POOLS) {
    const cap = capacity(pool);
    const deptShares = splitInteger(pool.name === GUESTS.to ? cap - guestCards : cap, DEPTS_PER_POOL);
    for (let d = 0; d < DEPTS_PER_POOL; d++) {
      const perDept = deptShares[d];
      const deptName = `team-${pool.name.replace(/\./g, '-')}-${d + 1}`;
      departments.push({
        name: deptName,
        queues: [{ name: `${deptName}-gpu`, pool: pool.name, deserved: perDept, limit: cap }],
      });
      const projShares = splitInteger(perDept, PROJECTS_PER_DEPT);
      for (let p = 0; p < PROJECTS_PER_DEPT; p++) {
        const deserved = projShares[p];
        const proj = `${deptName}-proj-${p + 1}`;
        projects.push({
          name: proj,
          namespace: proj,
          parent: deptName,
          queues: [{
            name: `${proj}-q`,
            pool: pool.name,
            priority: 100 - p * 5,
            deserved,
            limit: Math.min(perDept, deserved + Math.max(2, Math.floor(perDept / 4))),
          }],
        });
      }
    }
  }

  // The guests' second queues, named after the pool they are on.
  const to = POOLS.find((pool) => pool.name === GUESTS.to);
  const guests = departments.filter((dept) => dept.queues[0].pool === GUESTS.from).slice(0, GUESTS.departments);
  for (const dept of guests) {
    dept.queues.push({ name: `${dept.name}-gpu-${to.labelValue}`, pool: to.name, deserved: GUESTS.cardsEach, limit: Math.floor(capacity(to) / 4) });
    const shares = splitInteger(GUESTS.cardsEach, GUESTS.projects);
    projects.filter((proj) => proj.parent === dept.name).slice(0, GUESTS.projects).forEach((proj, i) => {
      proj.queues.push({ name: `${proj.name}-q-${to.labelValue}`, pool: to.name, priority: proj.queues[0].priority, deserved: shares[i], limit: GUESTS.cardsEach });
    });
  }
  const yaml = [yamlHeader(), ...POOLS.map(nodePoolDoc), ...departments.map(departmentDoc), ...projects.map(projectDoc)].join('\n---\n');
  return { yaml, departments, projects, pools: POOLS };
}

function buildNodes(pool, prefix) {
  const items = [];
  for (let i = 0; i < pool.nodes; i++) {
    items.push({
      metadata: {
        name: `${prefix}-${String(i + 1).padStart(2, '0')}`,
        labels: {
          [LABEL]: pool.labelValue,
          'nvidia.com/gpu.product': pool.product,
          'nvidia.com/gpu.memory': String(pool.memory),
          'nvidia.com/gpu.count': String(pool.cards),
        },
      },
      spec: {},
      status: {
        allocatable: { 'nvidia.com/gpu': String(pool.cards) },
        capacity: { 'nvidia.com/gpu': String(pool.cards) },
        conditions: [{ type: 'Ready', status: 'True' }],
      },
    });
  }
  return items;
}

function buildQueues(projects, usageScale) {
  const items = [];
  for (const p of projects) {
    for (const q of p.queues) {
      const alloc = Math.min(q.limit, Math.round(q.deserved * usageScale * 10) / 10);
      items.push({
        metadata: { name: q.name },
        spec: {
          parentQueue: p.parent,
          resources: { gpu: { quota: q.deserved, limit: q.limit } },
        },
        status: {
          allocated: { 'nvidia.com/gpu': String(alloc) },
          allocatedNonPreemptible: { 'nvidia.com/gpu': String(Math.min(alloc, q.deserved)) },
        },
      });
    }
  }
  return items;
}

const krmQueue = (q) => ({ name: q.name, nodepool: q.pool, resources: { gpu: { deserved: q.deserved, limit: q.limit } } });

function buildKrmJson(departments, projects) {
  const poolItems = POOLS.map((pool) => ({
    apiVersion: 'kai.resources/v1alpha1',
    kind: 'NodePool',
    metadata: { name: pool.name },
    spec: { labelKey: LABEL, labelValue: pool.labelValue },
  }));
  const deptItems = departments.map((d) => ({
    apiVersion: 'kai.resources/v1alpha1',
    kind: 'Department',
    metadata: { name: d.name },
    spec: { queues: d.queues.map(krmQueue) },
  }));
  const projItems = projects.map((p) => ({
    apiVersion: 'kai.resources/v1alpha1',
    kind: 'Project',
    metadata: { name: p.name },
    spec: {
      namespace: p.namespace,
      parent: p.parent,
      queues: p.queues.map(krmQueue),
    },
  }));
  return { apiVersion: 'v1', kind: 'List', items: [...poolItems, ...deptItems, ...projItems] };
}

function writeClusterContext(dir, { departments, projects, pools }, usageScale) {
  mkdirSync(dir, { recursive: true });
  const nodes = pools.flatMap((pool) => buildNodes(pool, pool.name.replace(/\./g, '-')));
  writeFileSync(join(dir, 'krm.json'), JSON.stringify(buildKrmJson(departments, projects), null, 2));
  writeFileSync(join(dir, 'nodes.json'), JSON.stringify({ items: nodes }, null, 2));
  writeFileSync(join(dir, 'queues.json'), JSON.stringify({ items: buildQueues(projects, usageScale) }, null, 2));
  writeFileSync(join(dir, 'namespaces.json'), JSON.stringify({
    items: projects.map((p) => ({ metadata: { name: p.namespace, labels: { 'kai/project': p.name } } })),
  }, null, 2));
  writeFileSync(join(dir, 'krmconfig.json'), JSON.stringify({
    items: [{ spec: { projectController: { features: { createNamespaces: false } }, global: { namespaceProjectLabelKey: 'kai/project' } } }],
  }, null, 2));
}

function tenantLine(projects) {
  return projects.flatMap((p) => p.queues.map((q) => `${p.namespace}:${p.namespace}:${q.name}:${q.deserved}:${q.limit}`)).join(' ');
}

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const { yaml, departments, projects, pools } = buildTenancy();
const tenancyPath = 'tenancy.yaml';
writeFileSync(join(out, tenancyPath), yaml);
writeFileSync(join(out, 'env.sh'), `# Demo expectations (offline)\nDEPARTMENT=platform\nTENANT_PROJECTS="${tenantLine(projects)}"\n`);

const clusterRoot = join(out, 'cluster');
writeClusterContext(join(clusterRoot, 'demo'), { departments, projects, pools }, 0.85);
writeClusterContext(join(clusterRoot, 'demo-busy'), { departments, projects, pools }, 1.15);

const config = {
  displayName: 'Research cloud (demo)',
  ref: 'main',
  tenancy: tenancyPath,
  expectations: { file: 'env.sh', variables: ['TENANT_PROJECTS'] },
  commitPrefix: 'demo-quota',
};
writeFileSync(join(out, 'demo.config.json'), `${JSON.stringify(config, null, 2)}\n`);

const git = (...args) => execFileSync('git', ['-C', out, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Demo');
git('config', 'user.email', 'demo@example.invalid');
git('add', '-A');
git('commit', '-q', '-m', 'Demo fixture for offline screenshots');

const nodes = pools.reduce((n, p) => n + p.nodes, 0);
const gpus = pools.reduce((n, p) => n + p.nodes * p.cards, 0);
console.log(`Wrote ${out}`);
const queues = [...departments, ...projects].reduce((n, o) => n + o.queues.length, 0);
console.log(`  ${gpus} GPUs on ${nodes} nodes · ${pools.length} pools · ${departments.length} departments · ${projects.length} projects · ${queues} queues`);
console.log('Start: npm run demo');
