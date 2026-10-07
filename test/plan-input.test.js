import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planInput } from '../src/plan-input.js';
import { buildPlan } from '../src/core/plan.js';

const config = JSON.parse(readFileSync(new URL('../examples/gitops.json', import.meta.url), 'utf8'));
const tenancy = readFileSync(new URL('./fixtures/tenancy.yaml', import.meta.url), 'utf8');

test('planInput maps session state and caps additions', () => {
  const state = {
    files: { [config.tenancy]: tenancy },
    notes: [],
    base: { ref: 'main', sha: 'abc', kind: 'git' },
    live: { ok: false, error: 'off', context: '', readAt: '', queues: {}, pools: {} },
  };
  const input = planInput(config, state, { additions: Array.from({ length: 120 }, () => ({ kind: 'NodePool', name: 'x' })) });
  assert.equal(input.additions.length, 100);
  assert.equal(input.live, undefined);
  const p = buildPlan(input);
  assert.ok(p.model.planned);
});
