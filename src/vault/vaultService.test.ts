import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultService } from './vaultService';

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
