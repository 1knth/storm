import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STARTUP_VAULT_ERROR,
  shouldNotifyVaultError,
} from './startupVaultError';

test('startup vault failures use actionable friendly guidance without raw details', () => {
  assert.match(STARTUP_VAULT_ERROR, /vault folder is available/);
  assert.doesNotMatch(STARTUP_VAULT_ERROR, /Error:|ENOENT|EACCES|\bat /i);
});

test('duplicate consecutive vault errors do not issue another notification', () => {
  assert.equal(shouldNotifyVaultError(null, STARTUP_VAULT_ERROR), true);
  assert.equal(
    shouldNotifyVaultError(STARTUP_VAULT_ERROR, STARTUP_VAULT_ERROR),
    false,
  );
  assert.equal(shouldNotifyVaultError(STARTUP_VAULT_ERROR, null), false);
});
