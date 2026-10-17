import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { savePastedImage } from './pasteImage';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'storm-paste-'));
  await writeFile(path.join(root, 'note.md'), '');
  return root;
}
function request(root: string, bytes = png) {
  return {
    vaultId: 'vault',
    notePath: 'note.md',
    mimeType: 'image/png',
    base64: bytes.toString('base64'),
  };
}

test('creates and reuses adjacent images directory with collision-safe files', async () => {
  const root = await fixture();
  try {
    const first = await savePastedImage(root, request(root));
    await mkdir(path.join(root, 'images'), { recursive: true });
    const second = await savePastedImage(root, request(root));
    assert.match(first.imagePath, /^images\/Pasted-image-.*\.png$/);
    assert.notEqual(first.imagePath, second.imagePath);
    assert.deepEqual(await readFile(path.join(root, first.imagePath)), png);
  } finally {
    await import('node:fs/promises').then(({ rm }) =>
      rm(root, { recursive: true, force: true }),
    );
  }
});

test('rejects unsafe note paths, invalid image bytes, and an images symlink', async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'storm-outside-'));
  try {
    await assert.rejects(
      savePastedImage(root, { ...request(root), notePath: '../outside.md' }),
      /saved Markdown note/i,
    );
    await assert.rejects(
      savePastedImage(root, request(root, Buffer.from('not png'))),
      /invalid|unsupported/i,
    );
    await symlink(outside, path.join(root, 'images'));
    await assert.rejects(savePastedImage(root, request(root)), /unsafe path/i);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
