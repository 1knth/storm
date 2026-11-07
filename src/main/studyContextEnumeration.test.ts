import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enumerateStudyScope } from './studyContextEnumeration';

test('enumerates the scope folder before the namespace limit and reuses unchanged tree pages', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'study-enumerate-'));
  const root = await realpath(temporary);
  await mkdir(path.join(root, 'Zebra'));
  let calls = 0;
  try {
    const scope = {
      vaultId: 'v',
      notePath: null,
      folderPath: 'Zebra',
      selectedNotePaths: [],
    };
    const enumerate = async (folder: string) => {
      calls++;
      // A root enumeration would exhaust the limit before reaching Zebra.
      return Array.from({ length: folder === root ? 10001 : 1 }, (_, i) => ({
        path: folder === root ? `A/${i}.md` : 'answer.md',
        name: 'answer.md',
        kind: 'note' as const,
        isDirectory: false,
        peek: '',
      }));
    };
    assert.equal(
      (await enumerateStudyScope(root, scope, enumerate))[0].path,
      'Zebra/answer.md',
    );
    await enumerateStudyScope(root, scope, enumerate);
    assert.equal(calls, 1);
    await mkdir(path.join(root, 'Zebra', 'new'));
    await enumerateStudyScope(root, scope, enumerate);
    assert.equal(calls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
