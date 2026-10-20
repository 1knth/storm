import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actualPathForOptimisticRename,
  reconcileOptimisticRename,
  remapOptimisticPath,
} from './optimisticRename';

const committed = { oldPath: 'folder', newPath: 'renamed', committed: true };

test('copy path uses original path while pending and renamed path once committed', () => {
  const pending = { ...committed, committed: false };
  assert.equal(
    actualPathForOptimisticRename('renamed/a.md', pending),
    'folder/a.md',
  );
  assert.equal(
    actualPathForOptimisticRename('renamed/a.md', committed),
    'renamed/a.md',
  );
});

test('successful rename alias remains until old root and descendants disappear', () => {
  assert.deepEqual(
    reconcileOptimisticRename(committed, ['folder/a.md', 'other.md']),
    committed,
  );
  assert.deepEqual(
    reconcileOptimisticRename(committed, [
      'renamed/a.md',
      'folder/stale.md',
      'other.md',
    ]),
    committed,
  );
  assert.equal(
    reconcileOptimisticRename(committed, [
      'renamed',
      'renamed/a.md',
      'other.md',
    ]),
    null,
  );
});

test('equivalent rename state returned as a new object remains structurally equal', () => {
  assert.deepEqual(
    reconcileOptimisticRename(committed, ['folder/a.md', 'other.md']),
    { ...committed },
  );
});

test('failed rename rolls back immediately and maps only folder descendants', () => {
  assert.deepEqual(
    reconcileOptimisticRename({ ...committed, committed: false }, [
      'folder/a.md',
    ]),
    {
      ...committed,
      committed: false,
    },
  );
  assert.equal(
    remapOptimisticPath('folder/sub/a.md', committed),
    'renamed/sub/a.md',
  );
  assert.equal(
    remapOptimisticPath('unrelated/a.md', committed),
    'unrelated/a.md',
  );
});
