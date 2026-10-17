import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { removedTabSnapshots } from './tabPresence';
import type { TabSnapshot } from './Editor';

test('captures a removed tab from the previous committed snapshot before replacement', () => {
  const a: TabSnapshot = { kind: 'empty', id: 'a' };
  const b: TabSnapshot = { kind: 'empty', id: 'b' };
  const rectA = { left: 10 } as DOMRect;
  const rectB = { left: 20 } as DOMRect;
  const previousTabs = new Map([
    ['a', a],
    ['b', b],
  ]);
  const previousRects = new Map([
    ['a', rectA],
    ['b', rectB],
  ]);

  const removed = removedTabSnapshots(
    new Set(['a', 'b']),
    previousTabs,
    previousRects,
    new Set(['b']),
  );
  const currentTabs = new Map([['b', b]]);

  assert.deepEqual(removed, [{ tab: a, rect: rectA }]);
  assert.equal(currentTabs.has('a'), false);
});

test('does not create ghosts for unchanged or reordered tabs', () => {
  const a: TabSnapshot = { kind: 'empty', id: 'a' };
  const b: TabSnapshot = { kind: 'empty', id: 'b' };
  const tabs = new Map([
    ['a', a],
    ['b', b],
  ]);
  const rects = new Map([
    ['a', { left: 10 } as DOMRect],
    ['b', { left: 20 } as DOMRect],
  ]);

  assert.deepEqual(
    removedTabSnapshots(new Set(['a', 'b']), tabs, rects, new Set(['b', 'a'])),
    [],
  );
});
