import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFieldId, fieldId } from '../src/core/tenancy.js';

test('parseFieldId round-trips fieldId', () => {
  const id = fieldId('Project', 'benchmark', 'benchmark-rtx', 'gpu', 'deserved');
  assert.deepEqual(parseFieldId(id), { kind: 'Project', owner: 'benchmark', queue: 'benchmark-rtx', rest: ['gpu', 'deserved'] });
});
