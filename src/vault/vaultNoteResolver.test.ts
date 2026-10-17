import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resolveVaultNote } from './vaultNoteResolver';

test('resolves wiki notes in context, root, and unique basename order safely', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'storm-note-resolver-'));
  const root = path.join(temp, 'vault');
  try {
    await mkdir(path.join(root, 'folder', 'sub'), { recursive: true });
    await mkdir(path.join(root, 'other'), { recursive: true });
    for (const file of [
      'folder/sub/note.md',
      'folder/sub/local.md',
      'note.md',
      'folder/nested.md',
      'folder/Space name ☃.md',
      'other/unique.md',
      'folder/dup.md',
      'other/dup.md',
    ]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), '');
    }
    await symlink(temp, path.join(root, 'escape'));
    const resolve = (target: string) =>
      resolveVaultNote(root, 'folder/sub/current.md', target);
    assert.equal(await resolve('note'), 'folder/sub/note.md');
    assert.equal(await resolve('local.md'), 'folder/sub/local.md');
    assert.equal(await resolve('nested'), 'folder/nested.md');
    assert.equal(
      await resolve('Space%20name%20%E2%98%83'),
      'folder/Space name ☃.md',
    );
    assert.equal(await resolve('unique'), 'other/unique.md');
    assert.equal(await resolve('folder/nested.md'), 'folder/nested.md');
    await assert.rejects(resolve('absent'), /not found/i);
    await assert.rejects(resolve('dup'), /ambiguous/i);
    await assert.rejects(resolve('../outside'), /invalid/i);
    await assert.rejects(resolve('escape/outside'), /not found/i);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
