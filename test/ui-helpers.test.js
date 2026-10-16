import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeRemoveAdditions, queueSuffix, poolChoices } from '../src/core/ui-helpers.js';

test('cascadeRemoveAdditions drops dependent projects when a department goes', () => {
  const additions = [
    { kind: 'Department', name: 'lab', queues: [{ name: 'lab-rtx', nodepool: 'rtx' }] },
    { kind: 'Project', name: 'app', parent: 'lab', queues: [{ name: 'app-rtx', nodepool: 'rtx' }] },
    { kind: 'Department', name: 'other', queues: [{ name: 'other-rtx', nodepool: 'rtx' }] },
  ];
  const kept = cascadeRemoveAdditions(additions, 0);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].name, 'other');
});

test('queueSuffix follows an existing queue name on the pool', () => {
  const model = {
    departments: [{ name: 'platform', queues: [{ name: 'platform-rtx', nodepool: 'rtx-pro-6000' }] }],
    projects: [],
  };
  assert.equal(queueSuffix(model, 'rtx-pro-6000'), 'rtx');
});

test('poolChoices tells source, planned and possible pools apart', () => {
  const pools = [{ name: 'rtx' }, { name: 'h100' }, { name: 'h200' }];
  const model = {
    pools,
    departments: [{ name: 'platform', queues: [{ name: 'platform-rtx', nodepool: 'rtx' }, { name: 'platform-h100', nodepool: 'h100' }] }],
    projects: [{ name: 'app', parent: 'platform', queues: [{ name: 'app-rtx', nodepool: 'rtx' }, { name: 'app-h100', nodepool: 'h100' }] }],
  };
  const additions = [{ kind: 'Queue', ownerKind: 'Project', owner: 'app', queue: { name: 'app-h100', nodepool: 'h100' } }];
  const choices = poolChoices(model, additions, 'Project', model.projects[0]);
  assert.deepEqual(choices.map((c) => [c.pool.name, c.state]), [['rtx', 'source'], ['h100', 'added'], ['h200', 'blocked']]);
  assert.equal(choices[1].index, 0);
  assert.match(choices[2].why, /platform has no queue on h200/);
});

test('poolChoices keeps the queue a new project was created with', () => {
  const model = {
    pools: [{ name: 'rtx' }, { name: 'h100' }],
    departments: [{ name: 'platform', queues: [{ name: 'platform-rtx', nodepool: 'rtx' }, { name: 'platform-h100', nodepool: 'h100' }] }],
    projects: [{ name: 'app', parent: 'platform', queues: [{ name: 'app-rtx', nodepool: 'rtx' }] }],
  };
  const additions = [{ kind: 'Project', name: 'app', parent: 'platform', queues: [{ name: 'app-rtx', nodepool: 'rtx' }] }];
  const choices = poolChoices(model, additions, 'Project', model.projects[0]);
  assert.deepEqual(choices.map((c) => [c.pool.name, c.state]), [['rtx', 'first'], ['h100', 'free']]);
});
