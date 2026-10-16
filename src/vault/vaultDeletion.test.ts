import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  assertDeletionTargetUnchanged,
  resolveDeletionTarget,
} from './vaultDeletion';

test('accepts nested Markdown and folders, rejects roots, unsafe paths and protected entries', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'storm-delete-'));
  try {
    const root = path.join(temp, 'vault');
    await mkdir(path.join(root, 'sub', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'sub', 'note.MD'), 'note');
    await mkdir(path.join(root, '.git'));
    assert.equal(
      (await resolveDeletionTarget(root, 'sub/note.MD')).kind,
      'note',
    );
    assert.equal(
      (await resolveDeletionTarget(root, 'sub/nested')).kind,
      'folder',
    );
    for (const unsafe of [
      '',
      '.',
      '..',
      '../outside.md',
      'sub/../../outside.md',
      '/tmp/file.md',
      '.git',
    ])
      await assert.rejects(resolveDeletionTarget(root, unsafe));
    await assert.rejects(resolveDeletionTarget(root, ''));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('rejects symlink traversal and detects target mutation without deleting', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'storm-delete-'));
  try {
    const root = path.join(temp, 'vault');
    await mkdir(root);
    const file = path.join(root, 'note.md');
    await writeFile(file, 'original');
    await symlink(temp, path.join(root, 'link'));
    await assert.rejects(resolveDeletionTarget(root, 'link/outside.md'));
    const target = await resolveDeletionTarget(root, 'note.md');
    await writeFile(file, 'changed');
    await assert.rejects(assertDeletionTargetUnchanged(target), /changed/);
    assert.equal(
      await (await import('node:fs/promises')).readFile(file, 'utf8'),
      'changed',
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
