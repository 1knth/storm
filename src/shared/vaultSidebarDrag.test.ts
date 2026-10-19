import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  handleVaultSidebarDrop,
  reorderBefore,
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
