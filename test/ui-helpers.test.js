import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cascadeRemoveAdditions, queueSuffix } from '../src/core/ui-helpers.js';

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
