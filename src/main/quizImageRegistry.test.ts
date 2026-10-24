import { describe, it as test } from 'node:test';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { QuizImageRegistry } from './quizImageRegistry';

const tinyPng = () =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('QuizImageRegistry', () => {
  test('validates bytes and declared MIME, enforces ownership, and purges session files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storm-image-test-'));
    const registry = new QuizImageRegistry(join(root, 'owned'));
    const metadata = registry.add('session-a', {
      mimeType: 'image/png',
      data: tinyPng(),
    });
    assert.ok(metadata);
    assert.equal(metadata.size, 11);
    assert.equal(registry.get('session-b', metadata.id), null);
    assert.equal(
      registry.add('session-a', { mimeType: 'image/jpeg', data: tinyPng() }),
      null,
    );
    assert.equal(
      registry.add('session-a', {
        mimeType: 'image/png',
        data: new Uint8Array([1, 2]),
      }),
      null,
    );
    assert.deepEqual(
      await readFile(registry.get('session-a', metadata.id)!.path),
      Buffer.from(tinyPng()),
    );
    assert.equal(registry.remove('session-b', metadata.id), false);
    registry.purgeSession('session-a');
    assert.equal(registry.get('session-a', metadata.id), null);
    registry.dispose();
    await rm(root, { recursive: true, force: true });
  });

  test('uses private file modes and disposal removes only allocated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storm-image-dispose-'));
    const owned = join(root, 'owned');
    const registry = new QuizImageRegistry(owned);
    try {
      const unrelated = join(owned, 'keep.txt');
      const image = registry.add('session', {
        mimeType: 'image/png',
        data: tinyPng(),
      });
      assert.ok(image);
      await writeFile(unrelated, 'keep', { mode: 0o600 });
      assert.equal((await stat(owned)).mode & 0o777, 0o700);
      const imagePath = registry.get('session', image.id)!.path;
      assert.equal((await stat(imagePath)).mode & 0o777, 0o600);
      registry.dispose();
      await assert.rejects(stat(imagePath), { code: 'ENOENT' });
      assert.equal(await readFile(unrelated, 'utf8'), 'keep');
      registry.dispose();
      assert.equal(await readFile(unrelated, 'utf8'), 'keep');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('TTL pruning removes expired allocated files but leaves unrelated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'storm-image-ttl-'));
    const owned = join(root, 'owned');
    let now = 0;
    const registry = new QuizImageRegistry(owned, 100, () => now);
    try {
      const image = registry.add('session', {
        mimeType: 'image/png',
        data: tinyPng(),
      });
      assert.ok(image);
      const imagePath = registry.get('session', image.id)!.path;
      const unrelated = join(owned, 'keep.txt');
      await writeFile(unrelated, 'keep');
      now = 101;
      assert.equal(registry.get('session', image.id), null);
      await assert.rejects(stat(imagePath), { code: 'ENOENT' });
      assert.equal(await readFile(unrelated, 'utf8'), 'keep');
    } finally {
      registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
