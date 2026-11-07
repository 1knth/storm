import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizService } from './quizService';
import { QuizStore } from './quizStore';
import { createTutorNotesFile, tutorNotesPath } from './tutorNotesFile';

const scope = (fields: Partial<Parameters<typeof tutorNotesPath>[0]> = {}) => ({
  vaultId: 'vault',
  notePath: null,
  selectedNotePaths: [],
  folderPath: null,
  ...fields,
});

async function vault() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'storm-notes-')));
  const root = join(dir, 'vault');
  await mkdir(join(root, 'Course/Week 1'), { recursive: true });
  const exclusive: string[] = [];
  const file = createTutorNotesFile({
    vaults: async () => [{ id: 'vault', path: root }],
    exclusive: async (vaultRoot, operation) => {
      exclusive.push(vaultRoot);
      return operation();
    },
  });
  return { dir, root, file, exclusive };
}

describe('tutor notes file', () => {
  test('lives in a storm folder inside the selected folder or beside the note', () => {
    assert.equal(
      tutorNotesPath(scope({ folderPath: 'Course/Week 1' }), 's-1'),
      'Course/Week 1/storm/tutor-notes-s-1.md',
    );
    assert.equal(
      tutorNotesPath(scope({ folderPath: '.' }), 's-1'),
      'storm/tutor-notes-s-1.md',
    );
    assert.equal(
      tutorNotesPath(scope({ notePath: 'Course/Week 1/Loops.md' }), 's-1'),
      'Course/Week 1/storm/tutor-notes-s-1.md',
    );
    assert.equal(
      tutorNotesPath(scope(), 'a/../b'),
      'storm/tutor-notes-a----b.md',
    );
  });

  test('writes atomically under the vault lifecycle and reads back edits', async () => {
    const f = await vault();
    try {
      const relative = await f.file.write(
        scope({ folderPath: 'Course/Week 1' }),
        's-1',
        'Plan: loops.',
      );
      assert.equal(relative, 'Course/Week 1/storm/tutor-notes-s-1.md');
      assert.deepEqual(f.exclusive, [f.root]);
      assert.equal(
        await readFile(join(f.root, relative), 'utf8'),
        'Plan: loops.\n',
      );
      assert.deepEqual(await readdir(join(f.root, 'Course/Week 1/storm')), [
        'tutor-notes-s-1.md',
      ]);
      await writeFile(join(f.root, relative), 'Edited by the learner.\n');
      assert.equal(
        await f.file.read('vault', relative),
        'Edited by the learner.',
      );
      assert.equal(await f.file.read('vault', 'missing.md'), null);
      assert.equal(await f.file.read('other', relative), null);
      await assert.rejects(
        f.file.write({ ...scope(), vaultId: 'other' }, 's', 'x'),
      );
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('refuses a storm folder that links outside the vault', async () => {
    const f = await vault();
    try {
      const outside = join(f.dir, 'outside');
      await mkdir(outside);
      await symlink(outside, join(f.root, 'storm'));
      await assert.rejects(f.file.write(scope({ folderPath: '.' }), 's', 'x'));
      assert.deepEqual(await readdir(outside), []);
      await writeFile(join(outside, 'tutor-notes-s.md'), 'secret');
      assert.equal(await f.file.read('vault', 'storm/tutor-notes-s.md'), null);
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });

  test('the service saves notes to the vault and prefers the file on recovery', async () => {
    const f = await vault();
    try {
      const store = new QuizStore(join(f.dir, 'sessions.json'));
      const service = new QuizService(
        store,
        () => true,
        undefined,
        undefined,
        undefined,
        undefined,
        f.file,
      );
      const created = await service.createSession(
        scope({ folderPath: 'Course/Week 1' }),
      );
      assert.equal(created.ok, true);
      if (!created.ok) return;
      const attached = await service.attachSession(created.value.id);
      assert.equal(attached.ok, true);
      if (!attached.ok) return;
      const saved = await service.request({
        type: 'tutor-notes',
        sessionId: created.value.id,
        agentToken: attached.value.agentToken,
        expectedRevision: attached.value.snapshot.session.revision,
        idempotencyKey: 'n-1',
        text: 'Plan: loops.',
      });
      assert.equal(saved.ok, true);
      if (!saved.ok) return;
      const relative = `Course/Week 1/storm/tutor-notes-${created.value.id}.md`;
      assert.equal(saved.value.tutorNotes?.path, relative);
      assert.equal(
        await readFile(join(f.root, relative), 'utf8'),
        'Plan: loops.\n',
      );

      await writeFile(join(f.root, relative), 'Plan: skip proofs.\n');
      const recovered = await service.withTutorNotesFile(saved.value);
      assert.equal(recovered.tutorNotes?.text, 'Plan: skip proofs.');
      await rm(join(f.root, relative));
      const fallback = await service.withTutorNotesFile(saved.value);
      assert.equal(fallback.tutorNotes?.text, 'Plan: loops.');
    } finally {
      await rm(f.dir, { recursive: true, force: true });
    }
  });
});
