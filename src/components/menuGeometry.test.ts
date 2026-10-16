import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampMenuPosition, positionSubmenu } from './menuGeometry';
import { nextEnabledMenuIndex } from './ContextMenu';
import type { ContextMenuItem } from './ContextMenu';

describe('clampMenuPosition', () => {
  it('keeps a menu inside each viewport corner with an 8px gutter', () => {
    const corners = [
      [0, 0, 8, 8],
      [990, 0, 792, 8],
      [0, 790, 8, 672],
      [990, 790, 792, 672],
    ];
    for (const [x, y, left, top] of corners) {
      assert.deepEqual(clampMenuPosition(x, y, 200, 120, 1000, 800), {
        left,
        top,
      });
    }
  });

  it('bounds menus larger than the viewport', () => {
    assert.deepEqual(clampMenuPosition(900, 700, 1200, 900, 1000, 800), {
      left: 8,
      top: 8,
    });
  });

  it('recomputes against changed viewport dimensions', () => {
    assert.deepEqual(clampMenuPosition(900, 700, 200, 120, 1000, 800), {
      left: 792,
      top: 672,
    });
    assert.deepEqual(clampMenuPosition(900, 700, 200, 120, 700, 600), {
      left: 492,
      top: 472,
    });
  });
});

describe('positionSubmenu', () => {
  it('places the submenu 4px to the right when it fits', () => {
    assert.deepEqual(
      positionSubmenu(
        { left: 20, right: 120, top: 40, bottom: 72 },
        { width: 100, height: 80 },
        { width: 500, height: 400 },
      ),
      { left: 124, top: 40 },
    );
  });

  it('flips left when the submenu would overflow the right edge', () => {
    assert.deepEqual(
      positionSubmenu(
        { left: 800, right: 900, top: 40, bottom: 72 },
        { width: 100, height: 80 },
        { width: 1000, height: 400 },
      ),
      { left: 696, top: 40 },
    );
  });

  it('clamps both top and bottom overflow to the viewport gutter', () => {
    assert.deepEqual(
      positionSubmenu(
        { left: 40, right: 100, top: 790, bottom: 820 },
        { width: 100, height: 120 },
        { width: 400, height: 800 },
      ),
      { left: 104, top: 672 },
    );
    assert.deepEqual(
      positionSubmenu(
        { left: 40, right: 100, top: -20, bottom: 10 },
        { width: 100, height: 120 },
        { width: 400, height: 800 },
      ),
      { left: 104, top: 8 },
    );
  });

  it('bounds the palette to a tiny viewport', () => {
    assert.deepEqual(
      positionSubmenu(
        { left: 20, right: 40, top: 30, bottom: 40 },
        { width: 200, height: 300 },
        { width: 40, height: 30 },
      ),
      { left: 8, top: 8 },
    );
  });
});

describe('nextEnabledMenuIndex', () => {
  const items: ContextMenuItem[] = [
    { id: 'first', label: 'First', onSelect: () => {} },
    { type: 'separator', id: 'separator' },
    { id: 'disabled', label: 'Disabled', disabled: true, onSelect: () => {} },
    { id: 'last', label: 'Last', onSelect: () => {} },
  ];

  it('skips separators and disabled items and wraps in either direction', () => {
    assert.equal(nextEnabledMenuIndex(items, 0, 1), 3);
    assert.equal(nextEnabledMenuIndex(items, 3, 1), 0);
    assert.equal(nextEnabledMenuIndex(items, 3, -1), 0);
    assert.equal(nextEnabledMenuIndex(items, 0, -1), 3);
  });

  it('returns no index when there are no enabled actions', () => {
    assert.equal(nextEnabledMenuIndex([], 0, 1), -1);
    assert.equal(
      nextEnabledMenuIndex([{ type: 'separator', id: 'only' }], 0, -1),
      -1,
    );
  });
});
