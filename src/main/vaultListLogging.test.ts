import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyVaultListError,
  formatVaultListError,
  type ConsoleSeverity,
} from './vaultListLogging';

const severities: ConsoleSeverity[] = ['INFO', 'WARNING', 'MODERATE', 'SEVERE'];

test('formats each supported console severity with trace and error details', () => {
  for (const severity of severities) {
    const error = new Error('Vault unavailable');
    error.stack =
      'Error: Vault unavailable\n    at list (/tmp/vaultService.ts:14:2)';
    assert.equal(
      formatVaultListError(severity, 'abc12345', error),
      `[${severity}] [Trace abc12345] [vaultService.ts] [line 14] [Error: Vault unavailable]`,
    );
  }
});

test('uses the supplied stack source filename and line number', () => {
  const error = new Error('failed');
  error.stack = 'Error: failed\n    at list (/opt/storm/vaultService.js:87:12)';
  assert.equal(
    formatVaultListError('WARNING', 'trace1', error),
    '[WARNING] [Trace trace1] [vaultService.js] [line 87] [Error: failed]',
  );
});

test('uses unknown source fields when no stack location is available', () => {
  const error = new Error('failed');
  error.stack = 'Error: failed';
  assert.equal(
    formatVaultListError('SEVERE', 'trace2', error),
    '[SEVERE] [Trace trace2] [unknown] [line unknown] [Error: failed]',
  );
});

test('classifies permission errors as moderate and other failures as severe', () => {
  assert.equal(classifyVaultListError({ code: 'EACCES' }), 'MODERATE');
  assert.equal(classifyVaultListError({ code: 'EPERM' }), 'MODERATE');
  assert.equal(classifyVaultListError(new Error('broken')), 'SEVERE');
});
