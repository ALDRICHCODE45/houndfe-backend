'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateProofPath } = require('./launch.cjs');
const { ROOT } = require('../supplier-runtime/verify-delete-migration.cjs');
test('launcher admits only a proof directory immediately beneath this worktree .tmp', () => {
  assert.doesNotThrow(() =>
    validateProofPath(`${ROOT}/.tmp/po-migration-proof.Abc123`),
  );
  for (const directory of [
    '/tmp/po-migration-proof.Abc123',
    `${ROOT}/.tmp/delete-migration-proof.Abc123`,
    `${ROOT}/.tmp/po-migration-proof.Abc123/subdir`,
    `${ROOT}/.tmp/po-migration-proof.`,
    `${ROOT}/.tmp/po-migration-proof.Abc_123`,
  ])
    assert.throws(() => validateProofPath(directory));
});
