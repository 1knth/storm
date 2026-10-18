import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import type { NoteData } from '../../shared/types';
import type { ImageTabSnapshot, NoteTabSnapshot, TabSnapshot } from './Editor';
import { serializeTabLayout } from './savedTabLayout';
import { getTabId } from './tabGroups';
import type { TabGroup } from './tabGroups';

test('round-trips tab order, active tab, group colors, collapse state, and assignments', () => {
  const first = {
    kind: 'empty',
    id: 'standalone',
  } as const;
  const note: NoteData = {
    path: 'notes/first.md',
    content: 'first note',
    revision: 'revision-1',
  };
  const second = {
    kind: 'note',
    note,
    vaultPath: '/vault',
    vaultId: 'vault',
    state: EditorState.create({ doc: note.content }),
    scrollTop: 0,
  } satisfies NoteTabSnapshot;
  const tabs: TabSnapshot[] = [first, second, { kind: 'empty', id: 'last' }];
  const groups = [
    { id: 'reading', name: 'Reading', collapsed: true, color: 'purple' },
    { id: 'writing', name: 'Writing', collapsed: false, color: 'orange' },
  ] satisfies TabGroup[];
  const layout = serializeTabLayout(
    tabs,
    'notes/first.md',
    groups,
    { 'notes/first.md': 'reading' },
    new Map(),
  );
  const restored = JSON.parse(JSON.stringify(layout));

  assert.deepEqual(restored.tabs, [
    { kind: 'empty', id: 'standalone' },
    { kind: 'note', path: 'notes/first.md', anchor: 0, head: 0, scrollTop: 0 },
    { kind: 'empty', id: 'last' },
  ]);
  assert.equal(restored.activeTab, 'notes/first.md');
  assert.deepEqual(restored.groups, groups);
  assert.deepEqual(restored.assignments, { 'notes/first.md': 'reading' });
});

test('round-trips image tabs with mixed tab groups and vault-scoped IDs', () => {
  const image: ImageTabSnapshot = {
    kind: 'image',
    vaultId: 'vault-1',
    path: 'assets/diagram.png',
    filename: 'diagram.png',
  };
  const noteData: NoteData = {
    path: 'notes/overview.md',
    content: 'overview',
    revision: 'revision-2',
  };
  const note: NoteTabSnapshot = {
    kind: 'note',
    note: noteData,
    vaultPath: '/vault',
    vaultId: 'vault-1',
    state: EditorState.create({ doc: noteData.content }),
    scrollTop: 12,
  };
  const tabs: TabSnapshot[] = [image, note, { kind: 'empty', id: 'blank' }];
  const groups = [
    { id: 'assets', name: 'Assets', collapsed: true, color: 'purple' },
    { id: 'notes', name: 'Notes', collapsed: false, color: 'green' },
  ] satisfies TabGroup[];
  const serialized = serializeTabLayout(
    tabs,
    getTabId(image),
    groups,
    { [getTabId(image)]: 'assets', [getTabId(note)]: 'notes' },
    new Map(),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(serialized)), {
    version: 1,
    tabs: [
      { kind: 'image', path: 'assets/diagram.png' },
      {
        kind: 'note',
        path: 'notes/overview.md',
        anchor: 0,
        head: 0,
        scrollTop: 12,
      },
      { kind: 'empty', id: 'blank' },
    ],
    activeTab: getTabId(image),
    groups,
    assignments: { [getTabId(image)]: 'assets', [getTabId(note)]: 'notes' },
  });
  assert.notEqual(getTabId(image), JSON.stringify(['vault-2', image.path]));
});

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
