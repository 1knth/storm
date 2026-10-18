import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  mkdir,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultService } from './vaultService';
import { readVaultAsset } from './vaultAssets';

const fixtureRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    fixtureRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'storm-vault-safety-'));
  fixtureRoots.push(root);
  await writeFile(path.join(root, 'note.md'), 'original note');
  const service = new VaultService();
  await service.selectVault(root);
  const note = await service.readNote('note.md');
  return { root, service, note, vaultPath: service.getSelectedVaultPath()! };
}

test('lists images as lightweight entries while preserving notes and excluding SVG/symlinks', async () => {
  const { root, service } = await fixture();
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'Photo.PNG'), signature);
  await writeFile(path.join(root, 'vector.svg'), '<svg/>');
  await symlink(path.join(root, 'Photo.PNG'), path.join(root, 'linked.png'));
  const entries = await service.listNotes();
  assert.deepEqual(
    entries.find((entry) => entry.name === 'note.md'),
    {
      path: 'note.md',
      name: 'note.md',
      kind: 'note',
      isDirectory: false,
      peek: 'original note',
    },
  );
  assert.deepEqual(
    entries.find((entry) => entry.name === 'Photo.PNG'),
    {
      path: 'Photo.PNG',
      name: 'Photo.PNG',
      kind: 'image',
      isDirectory: false,
      peek: '',
      mimeType: 'image/png',
    },
  );
  assert.equal(
    entries.some((entry) => /svg|linked/.test(entry.name)),
    false,
  );
  assert.equal(
    entries.some((entry) => entry.name === '.git'),
    false,
  );
});

test('reads assets with signature, path, MIME, and size validation', async () => {
  const { root } = await fixture();
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  await writeFile(path.join(root, 'ok.png'), signature);
  const image = await readVaultAsset(root, 'ok.png');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(image.base64, 'base64'), signature);
  await writeFile(path.join(root, 'fake.png'), Buffer.from('not an image'));
  await assert.rejects(readVaultAsset(root, 'fake.png'), /does not match/i);
  await assert.rejects(readVaultAsset(root, '../outside.png'));
  await symlink(
    path.join(os.tmpdir(), 'outside-image.png'),
    path.join(root, 'escape.png'),
  );
  await assert.rejects(readVaultAsset(root, 'escape.png'));
  await assert.rejects(readVaultAsset(root, 'nope.svg'), /Unsupported/);
  await writeFile(
    path.join(root, 'large.png'),
    Buffer.alloc(10 * 1024 * 1024 + 1),
  );
  await assert.rejects(readVaultAsset(root, 'large.png'), /10 MB/);
});

test('reads and saves valid updates and intentional empty content', async () => {
  const { root, service, note, vaultPath } = await fixture();
  const saved = await service.saveNote({
    vaultPath,
    path: note.path,
    content: 'updated note',
    revision: note.revision,
  });
  assert.equal(saved.revision, (await service.readNote('note.md')).revision);
  assert.equal(
    await readFile(path.join(root, 'note.md'), 'utf8'),
    'updated note',
  );
  const latest = await service.readNote('note.md');
  await service.saveNote({
    vaultPath,
    path: note.path,
    content: '',
    revision: latest.revision,
  });
  assert.equal((await service.readNote('note.md')).content, '');
});

test('rejects stale revisions and preserves the externally updated original', async () => {
  const { root, service, note, vaultPath } = await fixture();
  await writeFile(path.join(root, 'note.md'), 'external update');
  await assert.rejects(
    service.saveNote({
      vaultPath,
      path: note.path,
      content: 'lost update',
      revision: note.revision,
    }),
    /changed outside/i,
  );
  assert.equal(
    await readFile(path.join(root, 'note.md'), 'utf8'),
    'external update',
  );
});

test('rejects vault identity mismatch without changing the note', async () => {
  const { root, service, note } = await fixture();
  await assert.rejects(
    service.saveNote({
      vaultPath: `${root}-other`,
      path: note.path,
      content: 'wrong vault',
      revision: note.revision,
    }),
    /vault changed/i,
  );
  assert.equal(
    await readFile(path.join(root, 'note.md'), 'utf8'),
    'original note',
  );
});

test('failed stale save leaves original and no temporary files behind', async () => {
  const { root, service, note, vaultPath } = await fixture();
  await writeFile(path.join(root, 'note.md'), 'newer original');
  await assert.rejects(
    service.saveNote({
      vaultPath,
      path: note.path,
      content: 'stale overwrite',
      revision: note.revision,
    }),
  );
  assert.equal(
    await readFile(path.join(root, 'note.md'), 'utf8'),
    'newer original',
  );
  assert.deepEqual(
    (await readdir(root)).filter((entry) => entry.endsWith('.tmp')),
    [],
  );
});
