import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableOperations } from './plan-operations.mjs';
test('reads actual table metrics by header, preserving missing and scaled values', () => {
  const plan = [
    '| Id | Operation | Name | A-Time | A-Rows | Buffers | Reads |',
    '|* 12 | TABLE ACCESS FULL | ORDERS |00:00:00.39|7000K|34378|0|',
    '| 13 | TABLE ACCESS FULL | CUSTOMERS ||12|| |',
    '| 1 | HASH JOIN | |00:00:00.44|100|12|0|',
  ].join(String.fromCharCode(10));
  const rows = tableOperations(plan);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ms, 390);
  assert.equal(rows[0].rows, 7000000);
  assert.equal(rows[0].reads, 0);
  assert.equal(rows[1].ms, null);
  assert.equal(rows[1].buffers, null);
  assert.deepEqual(tableOperations(null), []);
});
