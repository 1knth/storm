import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createFolder, createMarkdownNote } from './vaultCreation';

test('creates notes and folders safely inside a vault', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'storm-vault-create-'));
  const root = path.join(temp, 'vault');
  const outside = path.join(temp, 'outside');
  try {
    await mkdir(path.join(root, 'nested', 'deeper'), { recursive: true });
    await mkdir(outside);
    const rootNote = await createMarkdownNote(root, '', 'root');
    assert.equal(rootNote.path, 'root.md');
    assert.equal(rootNote.isDirectory, false);
    const nestedNote = await createMarkdownNote(root, 'nested/deeper', 'readme.MD');
    assert.equal(nestedNote.path, 'nested/deeper/readme.MD');
    assert.equal(await readFile(path.join(root, nestedNote.path), 'utf8'), '');
    const folder = await createFolder(root, 'nested', 'new-folder');
    assert.equal(folder.path, 'nested/new-folder');
    await symlink(outside, path.join(root, 'escape'));

    await writeFile(path.join(root, 'existing.md'), 'keep me');
    await assert.rejects(createMarkdownNote(root, '', 'existing'), { code: 'EEXIST' });
    assert.equal(await readFile(path.join(root, 'existing.md'), 'utf8'), 'keep me');
    await assert.rejects(createFolder(root, '', 'nested'));
    for (const name of ['', '.', '..', 'bad/name', 'bad\\name', '../escape', 'trailing.', 'CON', 'node_modules', '.obsidian']) {
      await assert.rejects(createFolder(root, '', name));
    }
    for (const parent of ['../outside', 'nested/../../outside', '/tmp']) {
      await assert.rejects(createFolder(root, parent, 'x'));
    }
    await assert.rejects(createFolder(root, 'missing', 'x'));
    await assert.rejects(createFolder(root, 'existing.md', 'x'));
    await assert.rejects(createFolder(root, 'escape', 'x'));
    await assert.rejects(createFolder(root, 'escape/..', 'x'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
