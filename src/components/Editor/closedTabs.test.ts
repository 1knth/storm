import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import type { NoteData } from '../../shared/types';
import type { TabSnapshot } from './Editor';
import {
  captureClosedTab,
  prepareClosedTabForReopen,
  restoreClosedTab,
} from './closedTabs';
import { serializeTabLayout } from './savedTabLayout';
import { getTabId, normalizeTabGroupState } from './tabGroups';

const note: NoteData = { path: 'n.md', content: 'unsaved', revision: 'r1' };
const tab: TabSnapshot = {
  kind: 'note',
  note,
  vaultPath: '/vault',
  vaultId: 'v1',
  state: EditorState.create({ doc: 'unsaved edit' }),
  scrollTop: 12,
};
const image: TabSnapshot = {
  kind: 'image',
  vaultId: 'v1',
  path: 'a.png',
  filename: 'a.png',
};
const group = {
  id: 'g',
  name: 'Keep',
  color: 'purple' as const,
  collapsed: true,
};

test('captures identity, original tab index, group definition and group order', () => {
  const tabs: TabSnapshot[] = [image, tab];
  const groups = [{ id: 'other', name: 'Other', collapsed: false }, group];
  const record = captureClosedTab(
    tabs,
    groups,
    { [getTabId(tab)]: 'g' },
    getTabId(tab),
    'v1',
  );
  assert.ok(record);
  assert.equal(record.tab, tab);
  assert.equal(record.index, 1);
  assert.deepEqual(record.group, group);
  assert.equal(record.groupIndex, 1);
  assert.equal(captureClosedTab(tabs, groups, {}, 'missing', 'v1'), null);
  assert.equal(
    captureClosedTab(tabs, groups, {}, getTabId(tab), 'other'),
    null,
  );
});

test('restores after last group member cleanup and preserves metadata and order', () => {
  const assignment = { [getTabId(tab)]: 'g' };
  const record = captureClosedTab(
    [image, tab],
    [group],
    assignment,
    getTabId(tab),
    'v1',
  )!;
  const cleaned = normalizeTabGroupState([image], [group], assignment);
  const afterClose = normalizeTabGroupState(
    [],
    cleaned.groups,
    cleaned.assignments,
  );
  const restored = restoreClosedTab(
    { tabs: [], ...afterClose, activeID: null },
    record,
    'v1',
  );
  assert.deepEqual(restored.tabs, [tab]);
  assert.strictEqual(restored.tabs[0], tab);
  assert.equal(restored.groups[0].name, 'Keep');
  assert.equal(restored.groups[0].color, 'purple');
  assert.equal(restored.groups[0].collapsed, true);
  assert.deepEqual(restored.assignments, { [getTabId(tab)]: 'g' });
  assert.equal(restored.activeID, getTabId(tab));
});

test('restores image tabs, avoids duplicates, and rejects another vault', () => {
  const record = captureClosedTab([image], [], {}, getTabId(image), 'v1')!;
  const base = {
    tabs: [] as TabSnapshot[],
    groups: [] as (typeof group)[],
    assignments: {},
    activeID: null,
  };
  assert.equal(restoreClosedTab(base, record, 'v2'), base);
  const once = restoreClosedTab(base, record, 'v1');
  assert.equal(once.tabs[0], image);
  assert.equal(restoreClosedTab(once, record, 'v1').tabs.length, 1);
});

test('preparation preserves history for matching revisions and refreshes stale content', async () => {
  const record = captureClosedTab([tab], [], {}, getTabId(tab), 'v1')!;
  const same = await prepareClosedTabForReopen(record, {
    readNote: async () => ({ content: 'disk', revision: 'r1' }),
    createEditorState: (content) => EditorState.create({ doc: content }),
    exists: async () => true,
  });
  assert.strictEqual(same, record);
  assert.strictEqual(same.tab.kind === 'note' && same.tab.state, tab.state);

  const fresh = await prepareClosedTabForReopen(record, {
    readNote: async () => ({ content: 'current disk', revision: 'r2' }),
    createEditorState: (content) => EditorState.create({ doc: content }),
    exists: async () => true,
  });
  assert.notStrictEqual(fresh.tab, tab);
  assert.equal(fresh.tab.kind, 'note');
  if (fresh.tab.kind === 'note') {
    assert.equal(fresh.tab.note.content, 'current disk');
    assert.equal(fresh.tab.note.revision, 'r2');
    assert.equal(fresh.tab.state.doc.toString(), 'current disk');
    assert.equal(fresh.tab.scrollTop, 0);
  }
  assert.equal(tab.note.content, 'unsaved');
});

test('preparation rejects deleted notes and missing image assets without writes', async () => {
  let writes = 0;
  const deps = {
    readNote: async () => null,
    createEditorState: (content: string) =>
      EditorState.create({ doc: content }),
    exists: async (_vaultId: string, path: string) => path === 'a.png',
  };
  const noteRecord = captureClosedTab([tab], [], {}, getTabId(tab), 'v1')!;
  await assert.rejects(
    prepareClosedTabForReopen(noteRecord, deps),
    /no longer exists/,
  );
  const imageRecord = captureClosedTab([image], [], {}, getTabId(image), 'v1')!;
  assert.strictEqual(
    await prepareClosedTabForReopen(imageRecord, deps),
    imageRecord,
  );
  await assert.rejects(
    prepareClosedTabForReopen(
      { ...imageRecord, tab: { ...image, path: 'gone.png' } },
      deps,
    ),
    /no longer exists/,
  );
  assert.equal(writes, 0);
});

test('reopened tab layout serializes back with original order and group metadata', () => {
  const record = captureClosedTab(
    [image, tab],
    [group],
    { [getTabId(tab)]: 'g' },
    getTabId(tab),
    'v1',
  )!;
  const current = {
    tabs: [image],
    groups: [group],
    assignments: {},
    activeID: getTabId(image),
  };
  const reopened = restoreClosedTab(current, record, 'v1');
  const layout = serializeTabLayout(
    reopened.tabs,
    reopened.activeID,
    reopened.groups,
    reopened.assignments,
    new Map(),
  );
  assert.deepEqual(
    layout.tabs.map((item) =>
      item.kind === 'note'
        ? item.path
        : item.kind === 'image'
          ? item.path
          : item.id,
    ),
    ['a.png', 'n.md'],
  );
  assert.deepEqual(layout.groups, [group]);
  assert.deepEqual(layout.assignments, { [getTabId(tab)]: 'g' });
});

test('existing group metadata wins when recreating a missing group is unnecessary', () => {
  const record = captureClosedTab(
    [tab],
    [group],
    { [getTabId(tab)]: 'g' },
    getTabId(tab),
    'v1',
  )!;
  const currentGroup = { ...group, name: 'Renamed', collapsed: false };
  const restored = restoreClosedTab(
    { tabs: [], groups: [currentGroup], assignments: {}, activeID: null },
    record,
    'v1',
  );
  assert.strictEqual(restored.groups[0], currentGroup);
  assert.equal(restored.groups[0].name, 'Renamed');
});
