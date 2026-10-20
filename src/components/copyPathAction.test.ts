import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyPathAction } from './copyPathAction';

test('awaits clipboard write before reporting success with absolute path', async () => {
  const events: string[] = [];
  await copyPathAction('/vault/nested/file.md', {
    writeText: async (path) => {
      events.push(`write:${path}`);
    },
    onCopied: () => events.push('success'),
    onError: (message) => events.push(`error:${message}`),
  });
  assert.deepEqual(events, ['write:/vault/nested/file.md', 'success']);
});

test('routes clipboard rejection to error feedback', async () => {
  const errors: string[] = [];
  let succeeded = false;
  await copyPathAction('/vault/file.md', {
    writeText: async () => {
      throw new Error('permission denied');
    },
    onCopied: () => {
      succeeded = true;
    },
    onError: (message) => errors.push(message),
  });
  assert.equal(succeeded, false);
  assert.deepEqual(errors, ['Could not copy file path: permission denied']);
});
