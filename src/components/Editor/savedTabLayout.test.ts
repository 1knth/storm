import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import type { NoteData } from '../../shared/types';
import type { NoteTabSnapshot, TabSnapshot } from './Editor';
import { serializeTabLayout } from './savedTabLayout';

test('serializes bounded view metadata without note content or editor history', () => {
  const note: NoteData = {
    path: 'notes/example.md',
    content: 'private note body',
    revision: 'revision',
  };
  const state = EditorState.create({
    doc: note.content,
    selection: { anchor: 3, head: 8 },
  });
  const tab: NoteTabSnapshot = {
    kind: 'note',
    note,
    vaultPath: '/vault',
    vaultId: 'vault',
    state,
    scrollTop: 240,
  };
  const tabs: TabSnapshot[] = [tab, { kind: 'empty', id: 'empty-tab' }];
  const layout = serializeTabLayout(
    tabs,
    'notes/example.md',
    [{ id: 'group', name: 'Reading', collapsed: true, color: 'blue' }],
    { 'notes/example.md': 'group' },
    new Map(),
  );
  assert.deepEqual(layout.tabs, [
    {
      kind: 'note',
      path: 'notes/example.md',
      anchor: 3,
      head: 8,
      scrollTop: 240,
    },
    { kind: 'empty', id: 'empty-tab' },
  ]);
  assert.deepEqual(layout.groups, [
    { id: 'group', name: 'Reading', collapsed: true, color: 'blue' },
  ]);
  assert.deepEqual(layout.assignments, { 'notes/example.md': 'group' });
  const serialized = JSON.stringify(layout);
  assert.equal(serialized.includes(note.content), false);
  assert.equal(serialized.includes('history'), false);
  assert.equal(layout.tabs[0].kind === 'note' && layout.tabs[0].scrollTop, 240);
});
