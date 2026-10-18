import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkpointErrorMessage } from './checkpointError';

test('maps known checkpoint failures to safe actionable messages', () => {
  assert.equal(
    checkpointErrorMessage(
      new Error(
        "Error invoking remote method 'vault:tab-layout-save': Invalid saved tab layout",
      ),
    ),
    'Saved tab layout was rejected',
  );
  assert.equal(
    checkpointErrorMessage(new Error('Unknown vault')),
    'Vault is no longer available',
  );
  assert.equal(
    checkpointErrorMessage(
      new Error('No handler registered for vault:tab-layout-save'),
    ),
    'Restart Storm to load updated tab support',
  );
  assert.equal(
    checkpointErrorMessage(new Error('EACCES')),
    'Cannot write Storm settings',
  );
});

test('does not expose paths, stacks, or unknown IPC error details', () => {
  const message = checkpointErrorMessage(
    new Error(
      'Error invoking remote method: /Users/private/vault/settings.json: unexpected failure',
    ),
  );
  assert.equal(
    message,
    'Unable to save tabs; check that Storm settings are writable',
  );
  assert.equal(message.includes('/Users/private'), false);
});
