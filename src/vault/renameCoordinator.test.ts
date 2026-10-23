import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coordinateRename,
  remapRenamedPath,
  remapRenamedTabAssignments,
  remapRenamedTabs,
} from './renameCoordinator';

test('rename coordinator flushes before mutation and remaps only after success', async () => {
  const calls: string[] = [];
  await coordinateRename({
    flushAllAffectedNotes: async () => {
      calls.push('flush');
      return true;
    },
    mutate: async () => {
      calls.push('mutate');
      return 'result';
    },
    remap: () => {
      calls.push('remap');
    },
  });
  assert.deepEqual(calls, ['flush', 'mutate', 'remap']);
});

test('rename coordinator stops when flush or mutation fails', async () => {
  let remapped = false;
  await assert.rejects(
    coordinateRename({
      flushAllAffectedNotes: async () => false,
      mutate: async () => 1,
      remap: () => {
        remapped = true;
      },
    }),
    /save/,
  );
  await assert.rejects(
    coordinateRename({
      flushAllAffectedNotes: async () => true,
      mutate: async () => {
        throw new Error('failed');
      },
      remap: () => {
        remapped = true;
      },
    }),
    /failed/,
  );
  assert.equal(remapped, false);
});

test('rename tab remap installs committed changed-note content and revision only where applicable', () => {
  const makeState = (content: string) => ({ doc: { toString: () => content } });
  const tabs = [
    {
      kind: 'note',
      note: { path: 'links.md', content: 'stale', revision: 'r1' },
      state: makeState('stale'),
    },
    {
      kind: 'note',
      note: { path: 'folder/child.md', content: 'old', revision: 'r2' },
      state: makeState('old'),
    },
    { kind: 'image', path: 'folder/image.png', filename: 'image.png' },
    { kind: 'pdf', relativePath: 'folder/guide.pdf' },
    {
      kind: 'note',
      note: { path: 'other.md', content: 'keep', revision: 'r3' },
      state: makeState('keep'),
    },
  ];
  const result = remapRenamedTabs(
    tabs,
    {
      oldPath: 'folder',
      newPath: 'renamed',
      kind: 'directory',
      changedNotes: [
        { path: 'links.md', content: 'rewritten link', revision: 'r4' },
      ],
    },
    makeState,
  );
  assert.equal(result[0].note?.content, 'rewritten link');
  assert.equal(result[0].note?.revision, 'r4');
  assert.equal(result[0].state?.doc.toString(), 'rewritten link');
  assert.equal(result[1].note?.path, 'renamed/child.md');
  assert.equal(result[1].state?.doc.toString(), 'old');
  assert.equal(result[2].path, 'renamed/image.png');
  assert.equal(result[3].relativePath, 'renamed/guide.pdf');
  assert.equal(result[4], tabs[4]);
});

test('renamed tab assignments retain groups for notes, descendants, and images', () => {
  const rename = {
    oldPath: 'folder',
    newPath: 'renamed',
    kind: 'directory' as const,
    changedNotes: [],
  };
  const imageId = JSON.stringify(['vault-1', 'folder/image.png']);
  const assignments = {
    'folder/note.md': 'group-a',
    'folder/sub/child.md': 'group-b',
    [imageId]: 'group-a',
    'else/untouched.md': 'group-b',
  };
  const remapped = remapRenamedTabAssignments(assignments, rename);
  assert.deepEqual(remapped, {
    'renamed/note.md': 'group-a',
    'renamed/sub/child.md': 'group-b',
    [JSON.stringify(['vault-1', 'renamed/image.png'])]: 'group-a',
    'else/untouched.md': 'group-b',
  });
  assert.deepEqual(remapRenamedTabAssignments(remapped, rename), remapped);
});

test('rename coordinator maps directory descendants only', () => {
  assert.equal(
    remapRenamedPath('folder/sub/note.md', 'folder', 'renamed'),
    'renamed/sub/note.md',
  );
  assert.equal(
    remapRenamedPath('else/note.md', 'folder', 'renamed'),
    'else/note.md',
  );
});
