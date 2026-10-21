import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repairDarwinBundleSignatures } from './scripts/darwinSignatures';

test('repairs and verifies each macOS app bundle when signing is not configured', async () => {
  const calls: Array<[string, string[]]> = [];
  const runCommand = async (command: string, args: string[]) => {
    calls.push([command, args]);
    return { stdout: '', stderr: '' };
  };

  await repairDarwinBundleSignatures(
    'darwin',
    ['/tmp/package/Storm.app'],
    false,
    runCommand,
  );

  assert.deepEqual(calls, [
    [
      'codesign',
      [
        '--force',
        '--deep',
        '--sign',
        '-',
        '--identifier',
        'com.electron.storm',
        '/tmp/package/Storm.app',
      ],
    ],
    ['codesign', ['--verify', '--deep', '--strict', '/tmp/package/Storm.app']],
  ]);
});

test('does not touch non-macOS packages or configured signing', async () => {
  let called = false;
  const runCommand = async () => {
    called = true;
    return { stdout: '', stderr: '' };
  };

  await repairDarwinBundleSignatures(
    'linux',
    ['/tmp/package'],
    false,
    runCommand,
  );
  await repairDarwinBundleSignatures(
    'darwin',
    ['/tmp/package/Storm.app'],
    true,
    runCommand,
  );

  assert.equal(called, false);
});

test('propagates codesign verification failures', async () => {
  let calls = 0;
  const failure = new Error('signature verification failed');
  const runCommand = async () => {
    calls += 1;
    if (calls === 2) throw failure;
    return { stdout: '', stderr: '' };
  };

  await assert.rejects(
    repairDarwinBundleSignatures(
      'darwin',
      ['/tmp/package/Storm.app'],
      false,
      runCommand,
    ),
    failure,
  );
  assert.equal(calls, 2);
});
