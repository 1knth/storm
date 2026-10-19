import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  beginVaultSidebarDrag,
  groupDropAnchor,
  groupHeaderVaultDrop,
  handleVaultSidebarDrop,
  reorderBefore,
  rootItemDropAnchor,
  vaultDropAnchor,
  vaultPlacementForDrop,
} from './vaultSidebarDrag';
import type { RegisteredVault } from './types';

const rows: RegisteredVault[] = ['a', 'b', 'c'].map((id) => ({
  id,
  name: id,
  path: `/${id}`,
}));

test('row midpoint chooses before/after anchors, accounting for dragged row removal', () => {
  assert.equal(vaultDropAnchor(rows, 'b', 49, 0, 100, 'a'), 'b');
  assert.equal(vaultDropAnchor(rows, 'b', 51, 0, 100, 'a'), 'c');
  assert.equal(vaultDropAnchor(rows, 'c', 99, 0, 100, 'a'), null);
  assert.equal(vaultDropAnchor(rows, 'b', 20, 0, 100, 'b'), 'b');
  assert.equal(vaultDropAnchor(rows, 'missing', 20, 0, 100, 'a'), undefined);
});

test('vault dragstart bubbles no group payload over the vault payload', () => {
  const values = new Map<string, string>();
  let stopped = false;
  const event = {
    dataTransfer: {
      effectAllowed: '',
      setData: (type: string, value: string) => values.set(type, value),
    },
    stopPropagation: () => {
      stopped = true;
    },
  };
  beginVaultSidebarDrag(event, { kind: 'vault', id: 'inside-group' });
  if (!stopped) beginVaultSidebarDrag(event, { kind: 'group', id: 'parent' });
  assert.deepEqual(JSON.parse(values.get('application/x-vault-sidebar')!), {
    kind: 'vault',
    id: 'inside-group',
  });
  assert.equal(event.dataTransfer.effectAllowed, 'move');
  assert.equal(stopped, true);
});

test('root drop placement clears group and unpins exactly once at its boundary', () => {
  let stopped = false;
  const placements: ReturnType<typeof vaultPlacementForDrop>[] = [];
  handleVaultSidebarDrop(
    {
      dataTransfer: {
        getData: () => JSON.stringify({ kind: 'vault', id: 'a' }),
      },
      preventDefault: () => {},
      stopPropagation: () => {
        stopped = true;
      },
    },
    (payload) => {
      const source = {
        id: 'a',
        name: 'A',
        path: '/a',
        groupId: 'g',
        pinned: true,
      };
      if (payload?.kind === 'vault')
        placements.push(
          vaultPlacementForDrop(source, {
            groupId: null,
            pinned: false,
            beforeVaultId: null,
          }),
        );
    },
  );
  if (!stopped) placements.push({} as ReturnType<typeof vaultPlacementForDrop>);
  assert.deepEqual(placements, [
    { vaultId: 'a', groupId: null, pinned: false, beforeVaultId: null },
  ]);
});

test('group header upper edge routes to root beginning and center assigns to the group', () => {
  assert.deepEqual(groupHeaderVaultDrop(102, 100, 40, 'g', 'root-first'), {
    groupId: null,
    beforeVaultId: 'root-first',
  });
  assert.deepEqual(groupHeaderVaultDrop(102, 100, 40, 'g', null), {
    groupId: null,
    beforeVaultId: null,
  });
  assert.deepEqual(groupHeaderVaultDrop(120, 100, 40, 'g', 'root-first'), {
    groupId: 'g',
    beforeVaultId: null,
  });
});

test('mixed root insertion anchors handle mixed item kinds and reject self drops', () => {
  const items = [
    { kind: 'vault' as const, id: 'v' },
    { kind: 'group' as const, id: 'g' },
    { kind: 'vault' as const, id: 'w' },
  ];
  assert.deepEqual(
    rootItemDropAnchor(items, items[0], items[1], true),
    items[2],
  );
  assert.equal(rootItemDropAnchor(items, items[0], items[0], true), undefined);
  assert.equal(rootItemDropAnchor(items, items[2], items[1], true), null);
  assert.deepEqual(
    rootItemDropAnchor(items, items[0], items[1], false),
    items[1],
  );
});

test('group drop anchors sort before and after, including append at the last group', () => {
  const groups = ['one', 'two', 'three'].map((id) => ({ id }));
  assert.equal(groupDropAnchor(groups, 'three', 'one', false), 'one');
  assert.equal(groupDropAnchor(groups, 'one', 'three', true), null);
  const ordered = reorderBefore(
    groups.map((item) => item.id),
    'one',
    groupDropAnchor(groups, 'one', 'three', true),
  );
  assert.deepEqual(ordered, ['two', 'three', 'one']);
});

test('pin-lane placement preserves remembered group and pin state', () => {
  assert.deepEqual(
    vaultPlacementForDrop(
      { id: 'a', name: 'A', path: '/a', groupId: 'g' },
      {
        groupId: null,
        pinned: true,
        beforeVaultId: null,
      },
    ),
    { vaultId: 'a', groupId: 'g', pinned: true, beforeVaultId: null },
  );
});

test('reorder rejects self-drop and retains append behavior', () => {
  assert.equal(reorderBefore(['a', 'b', 'c'], 'b', 'b'), null);
  assert.deepEqual(reorderBefore(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
  assert.deepEqual(reorderBefore(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
});

test('nested drop boundary stops parent dispatch and invokes exactly one placement', () => {
  let prevented = false;
  let stopped = false;
  let operations = 0;
  const event = {
    dataTransfer: { getData: () => JSON.stringify({ kind: 'vault', id: 'a' }) },
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  };
  const dispatchParent = () => {
    if (!stopped) operations++;
  };
  handleVaultSidebarDrop(event, (payload) => {
    if (payload?.kind === 'vault') operations++;
  });
  dispatchParent();
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(operations, 1);
});

test('invalid/external payload is consumed without invoking placement or parent fallback', () => {
  let stopped = false;
  let operations = 0;
  handleVaultSidebarDrop(
    {
      dataTransfer: { getData: () => 'not internal' },
      preventDefault: () => {},
      stopPropagation: () => {
        stopped = true;
      },
    },
    (payload) => {
      if (payload) operations++;
    },
  );
  if (!stopped) operations++;
  assert.equal(operations, 0);
});
