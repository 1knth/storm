import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runDirectoryPathAction } from './directoryPathAction';

test('ordinary directory path click copies the path without opening it', async () => {
  const calls: string[] = [];
  await runDirectoryPathAction(false, '/vault', {
    openDirectory: async () => {
      calls.push('open');
    },
    copyPath: async (path) => {
      calls.push(`copy:${path}`);
    },
    onCopied: () => {
      calls.push('copied');
    },
    onError: (error) => {
      calls.push(`error:${error}`);
    },
  });
  assert.deepEqual(calls, ['copy:/vault', 'copied']);
});

test('Command-click opens the directory without copying the path', async () => {
  const calls: string[] = [];
  await runDirectoryPathAction(true, '/vault', {
    openDirectory: async () => {
      calls.push('open');
    },
    copyPath: async (path) => {
      calls.push(`copy:${path}`);
    },
    onCopied: () => {
      calls.push('copied');
    },
    onError: (error) => {
      calls.push(`error:${error}`);
    },
  });
  assert.deepEqual(calls, ['open']);
});
