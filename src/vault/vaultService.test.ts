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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import NotePeek from '../components/NotePeek';

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

test('renames PDFs as opaque binary files, preserving their extension and note contents', async () => {
  const { root, service } = await fixture();
  const bytes = Buffer.from([0, 1, 2, 255, 37, 80, 68, 70]);
  await writeFile(path.join(root, 'Guide.PDF'), bytes);

  const result = await service.renameEntryAndUpdateLinks(
    'Guide.PDF',
    'Manual.PDF',
  );

  assert.equal(result.kind, 'pdf');
  assert.deepEqual(result.changedNotes, []);
  assert.deepEqual(await readFile(path.join(root, 'Manual.PDF')), bytes);
  assert.equal(
    await readFile(path.join(root, 'note.md'), 'utf8'),
    'original note',
  );
  await assert.rejects(service.renameEntry('Manual.PDF', 'NoExtension'));
  assert.deepEqual(await readFile(path.join(root, 'Manual.PDF')), bytes);
});

test('renames supported entries and folders atomically within the selected vault', async () => {
  const { root, service } = await fixture();
  await mkdir(path.join(root, 'folder'));
  await writeFile(path.join(root, 'folder', 'child.md'), 'child contents');
  await writeFile(path.join(root, 'picture.png'), Buffer.from([1, 2, 3]));

  assert.deepEqual(await service.renameEntry('note.md', 'renamed.md'), {
    oldPath: 'note.md',
    newPath: 'renamed.md',
    kind: 'note',
  });
  assert.equal(
    await readFile(path.join(root, 'renamed.md'), 'utf8'),
    'original note',
  );
  assert.deepEqual(await service.renameEntry('picture.png', 'renamed.png'), {
    oldPath: 'picture.png',
    newPath: 'renamed.png',
    kind: 'image',
  });
  assert.deepEqual(await service.renameEntry('folder', 'renamed-folder'), {
    oldPath: 'folder',
    newPath: 'renamed-folder',
    kind: 'directory',
  });
  assert.equal(
    await readFile(path.join(root, 'renamed-folder', 'child.md'), 'utf8'),
    'child contents',
  );
});

test('rejects unsafe or colliding renames without modifying source entries', async () => {
  const { root, service } = await fixture();
  await writeFile(path.join(root, 'taken.md'), 'destination');
  await assert.rejects(
    service.renameEntry('note.md', 'taken.md'),
    /already exists/,
  );
  for (const name of [
    '',
    '.',
    '..',
    '../escape',
    'a/b',
    'a\\\\b',
    'bad\\0name',
  ])
    await assert.rejects(service.renameEntry('note.md', name));
  await assert.rejects(service.renameEntry('.', 'new-root'));
  assert.equal(
    await readFile(path.join(root, 'note.md'), 'utf8'),
    'original note',
  );
  assert.equal(
    await readFile(path.join(root, 'taken.md'), 'utf8'),
    'destination',
  );
  assert.deepEqual(await service.renameEntry('note.md', 'note.md'), {
    oldPath: 'note.md',
    newPath: 'note.md',
    kind: 'note',
  });
});

test('rejects symlink sources and symlink ancestors', async () => {
  const { root, service } = await fixture();
  const outside = await mkdtemp(
    path.join(os.tmpdir(), 'storm-rename-outside-'),
  );
  fixtureRoots.push(outside);
  await writeFile(path.join(outside, 'secret.md'), 'outside');
  await symlink(path.join(outside, 'secret.md'), path.join(root, 'linked.md'));
  await symlink(outside, path.join(root, 'linked-dir'));
  await assert.rejects(service.renameEntry('linked.md', 'moved.md'));
  await assert.rejects(service.renameEntry('linked-dir/secret.md', 'moved.md'));
  assert.equal(
    await readFile(path.join(outside, 'secret.md'), 'utf8'),
    'outside',
  );
});

test('lists images as lightweight entries while preserving notes and excluding SVG/symlinks', async () => {
  const { root, service } = await fixture();
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'Photo.PNG'), signature);
  await writeFile(path.join(root, 'Manual.PDF'), '%PDF-1.7');
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
  assert.deepEqual(
    entries.find((entry) => entry.name === 'Manual.PDF'),
    {
      path: 'Manual.PDF',
      name: 'Manual.PDF',
      kind: 'pdf',
      isDirectory: false,
      peek: '',
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

test('sidebar peeks omit fenced delimiters and retain visible content', async () => {
  const { root, service } = await fixture();
  const cases = [
    ['```mermaid\ngraph TD; A-->B\n```', 'graph TD; A-->B'],
    ['  ~~~~ts\nconst answer = 42;\n  ~~~~~\n', 'const answer = 42;'],
    ['```ts\nconst value = `literal`;\n```', 'const value = `literal`;'],
    ['Inline `code` remains visible.', 'Inline `code` remains visible.'],
    ['~~~\n\n~~~\nA later sentence.', 'A later sentence.'],
    [' \n\t ', ''],
  ];

  for (const [markdown, expectedPeek] of cases) {
    await writeFile(path.join(root, 'note.md'), markdown);
    const entry = (await service.listNotes()).find(
      (candidate) => candidate.name === 'note.md',
    );
    assert.equal(entry?.peek, expectedPeek, markdown);
    const markup = renderToStaticMarkup(
      createElement(NotePeek, { markdown: entry?.peek ?? '' }),
    );
    if (expectedPeek) {
      const renderedText = markup
        .replace(/<[^>]*>/g, '')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
      assert.ok(renderedText.trim(), markdown);
      assert.doesNotMatch(markup, /<pre|<code[^>]*>```/);
    } else {
      assert.match(markup, /<span class="italic text-white\/40">empty<\/span>/);
    }
  }
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

test('rename-link planning failures leave the source untouched', async () => {
  const { root, service } = await fixture();
  await writeFile(path.join(root, 'ref.md'), '[target](target.md)');
  await writeFile(path.join(root, 'target.md'), 'target');
  // An invalid source is rejected before the rename mutation begins.
  await assert.rejects(
    service.renameEntryAndUpdateLinks('missing.md', 'moved.md'),
  );
  assert.equal(await readFile(path.join(root, 'target.md'), 'utf8'), 'target');
  assert.equal(
    await readFile(path.join(root, 'ref.md'), 'utf8'),
    '[target](target.md)',
  );
});

test('rename aborts on a revision conflict before moving or rewriting anything', async () => {
  const { root } = await fixture();
  await writeFile(path.join(root, 'target.md'), 'target');
  await writeFile(path.join(root, 'ref.md'), '[target](target.md)');
  class ConflictingVaultService extends VaultService {
    reads = 0;
    override async readNote(relativePath: unknown) {
      this.reads++;
      if (this.reads === 4)
        await writeFile(path.join(root, 'ref.md'), 'new external content');
      return super.readNote(relativePath);
    }
  }
  const service = new ConflictingVaultService();
  await service.selectVault(root);
  await assert.rejects(
    service.renameEntryAndUpdateLinks('target.md', 'renamed.md'),
    /changed during link planning/,
  );
  assert.equal(await readFile(path.join(root, 'target.md'), 'utf8'), 'target');
  assert.equal(
    await readFile(path.join(root, 'ref.md'), 'utf8'),
    'new external content',
  );
  await assert.rejects(readFile(path.join(root, 'renamed.md'), 'utf8'), {
    code: 'ENOENT',
  });
});

test('rename link rewrites roll back the move and prior writes on first or second save failure', async () => {
  for (const failAt of [1, 2]) {
    const { root } = await fixture();
    await writeFile(path.join(root, 'target.md'), 'target');
    await writeFile(path.join(root, 'one.md'), '[target](target.md)');
    await writeFile(path.join(root, 'two.md'), '[target](target.md)');
    class FailingVaultService extends VaultService {
      saves = 0;
      override async saveNote(request: unknown) {
        this.saves++;
        if (this.saves === failAt)
          throw new Error(`injected save failure ${failAt}`);
        return super.saveNote(request);
      }
    }
    const service = new FailingVaultService();
    await service.selectVault(root);
    await assert.rejects(
      service.renameEntryAndUpdateLinks('target.md', 'renamed.md'),
      /injected save failure/,
    );
    assert.equal(
      await readFile(path.join(root, 'target.md'), 'utf8'),
      'target',
    );
    await assert.rejects(readFile(path.join(root, 'renamed.md'), 'utf8'), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(path.join(root, 'one.md'), 'utf8'),
      '[target](target.md)',
    );
    assert.equal(
      await readFile(path.join(root, 'two.md'), 'utf8'),
      '[target](target.md)',
    );
  }
});

test('rename rollback never overwrites newer external content and reports recovery paths', async () => {
  const { root } = await fixture();
  await writeFile(path.join(root, 'target.md'), 'target');
  await writeFile(path.join(root, 'one.md'), '[target](target.md)');
  await writeFile(path.join(root, 'two.md'), '[target](target.md)');
  class ConflictingVaultService extends VaultService {
    saves = 0;
    override async saveNote(request: unknown) {
      this.saves++;
      if (this.saves === 2) throw new Error('injected second save failure');
      if (this.saves === 3)
        await writeFile(path.join(root, 'one.md'), 'newer external content');
      return super.saveNote(request);
    }
  }
  const service = new ConflictingVaultService();
  await service.selectVault(root);
  await assert.rejects(
    service.renameEntryAndUpdateLinks('target.md', 'renamed.md'),
    /rollback incomplete.*one\.md/i,
  );
  assert.equal(
    await readFile(path.join(root, 'one.md'), 'utf8'),
    'newer external content',
  );
  assert.equal(await readFile(path.join(root, 'renamed.md'), 'utf8'), 'target');
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
