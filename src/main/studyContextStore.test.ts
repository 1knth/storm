import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyContextStore } from './studyContextStore';
import type { StudySnapshot } from '../shared/studyContext';

test('snapshot retention protects the accepted question against failed and out-of-order pin cleanup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'study-store-'));
  try {
    const store = new StudyContextStore(join(dir, 'study.json'));
    const snapshot = (id: string): StudySnapshot => ({
      schemaVersion: 1,
      id,
      studyId: 'study',
      scope: {
        vaultId: 'v',
        notePath: 'note.md',
        folderPath: null,
        selectedNotePaths: [],
      },
      sources: [],
      createdAt: new Date().toISOString(),
    });
    await store.save(snapshot('accepted'));
    await store.save(snapshot('failed'));
    await store.pin('pending:one', 'accepted');
    await store.finalizeQuestion('quiz', 'accepted', 'pending:one', 5);
    await store.pin('pending:two', 'failed');
    await store.finalizeQuestion('quiz', 'accepted', 'pending:two', 5);
    await store.finalizeQuestion('quiz', 'failed', 'old-result', 4);
    for (let i = 0; i < 65; i++) await store.save(snapshot(`other-${i}`));
    assert.ok(await store.snapshot('accepted'));
    assert.equal(await store.snapshot('failed'), undefined);
    const copy = await store.snapshot('accepted');
    copy!.scope.notePath = 'mutated';
    assert.equal((await store.snapshot('accepted'))!.scope.notePath, 'note.md');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('unchanged binds, saves, and pins preserve the store file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'study-store-noop-'));
  try {
    const file = join(dir, 'study.json');
    const store = new StudyContextStore(file);
    const scope = {
      vaultId: 'v',
      notePath: 'note.md',
      folderPath: null,
      selectedNotePaths: [],
    };
    const snapshot: StudySnapshot = {
      schemaVersion: 1,
      id: 's',
      studyId: 'study',
      scope,
      sources: [],
      createdAt: 'now',
    };
    await store.bind('study', scope);
    await store.save(snapshot);
    await store.pin('question', 's');
    const before = await stat(file);
    await store.bind('study', scope);
    await store.save(snapshot);
    await store.pin('question', 's');
    const after = await stat(file);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
