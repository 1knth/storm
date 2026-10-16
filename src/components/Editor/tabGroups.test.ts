import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assignTab,
  cleanTabAssignments,
  getTabId,
  moveTab,
  moveTabGroup,
  removeTabGroup,
  validateTabGroupName,
  visibleTabOrder,
  tabGroupColor,
  TAB_GROUP_COLORS,
} from './tabGroups';
import type { TabSnapshot } from './Editor';
const tabs: TabSnapshot[] = [
  { kind: 'empty', id: 'a' },
  { kind: 'empty', id: 'b' },
  { kind: 'empty', id: 'c' },
];
const groups = [
  { id: 'g1', name: 'One', collapsed: true },
  { id: 'g2', name: 'Two', collapsed: false },
];
test('uses stable fallback colors and the approved palette for groups', () => {
  const firstColor = tabGroupColor(groups[0], 0);
  const secondColor = tabGroupColor(groups[1], 1);
  assert.equal(tabGroupColor(groups[0], 1), firstColor);
  assert.equal(tabGroupColor(groups[1], 0), secondColor);
  assert.equal(tabGroupColor({ ...groups[0], color: 'green' }, 0), 'green');
  assert.equal(TAB_GROUP_COLORS.green, '#4ade80');
});
test('orders visible tabs by group order and omits members hidden by collapsed groups', () => {
  assert.deepEqual(
    visibleTabOrder(tabs, groups, { a: 'g2', b: 'g1' }).map(
      (tab) => tab.kind === 'empty' && tab.id,
    ),
    ['a', 'c'],
  );
});
test('assign, ungroup, and remove group without closing tabs', () => {
  assert.deepEqual(assignTab({ a: 'g1' }, 'a', null), {});
  assert.deepEqual(removeTabGroup('g1', groups, { a: 'g1', b: 'g2' }), {
    groups: [groups[1]],
    assignments: { b: 'g2' },
  });
  assert.deepEqual(
    cleanTabAssignments(
      { a: 'g1', stale: 'g1', b: 'missing' },
      tabs.slice(0, 1),
      groups,
    ),
    { a: 'g1' },
  );
});
test('moves tabs immutably within groups, across groups, and to/from ungrouped tabs', () => {
  const source = tabs;
  const moved = moveTab(tabs, groups, { a: 'g2', b: 'g2' }, 'b', 'g2', 'a');
  assert.ok(moved);
  assert.deepEqual(moved.tabs.map(getTabId), ['b', 'a', 'c']);
  assert.notEqual(moved.tabs, tabs);
  assert.deepEqual(tabs, source);
  const cross = moveTab(tabs, groups, { a: 'g2' }, 'a', 'g1');
  assert.ok(cross);
  assert.equal(cross.assignments.a, 'g1');
  const ungroup = moveTab(tabs, groups, { a: 'g2' }, 'a', null);
  assert.ok(ungroup);
  assert.equal('a' in ungroup.assignments, false);
  const regroup = moveTab(tabs, groups, {}, 'a', 'g1');
  assert.ok(regroup);
  assert.equal(regroup.assignments.a, 'g1');
});
test('rejects invalid tab moves and preserves identities for no-ops', () => {
  const assignments = { a: 'g2', b: 'g1' };
  assert.equal(moveTab(tabs, groups, assignments, 'missing', 'g1'), null);
  assert.equal(moveTab(tabs, groups, assignments, 'a', 'missing'), null);
  assert.equal(moveTab(tabs, groups, assignments, 'a', 'g1', 'a'), null);
  assert.equal(moveTab(tabs, groups, assignments, 'a', 'g1', 'c'), null);
  const noop = moveTab(tabs, groups, assignments, 'a', 'g2', 'a');
  assert.ok(noop);
  assert.equal(noop.tabs, tabs);
  assert.equal(noop.assignments, assignments);
});
test('reorders groups and rejects missing group references', () => {
  assert.deepEqual(
    moveTabGroup(groups, 'g2', 'g1')?.map((group) => group.id),
    ['g2', 'g1'],
  );
  assert.deepEqual(
    moveTabGroup(groups, 'g1', null)?.map((group) => group.id),
    ['g2', 'g1'],
  );
  assert.equal(moveTabGroup(groups, 'missing', null), null);
  assert.equal(moveTabGroup(groups, 'g1', 'missing'), null);
  assert.equal(moveTabGroup(groups, 'g1', 'g1'), groups);
});
test('validates trimmed group names, length and case-insensitive uniqueness', () => {
  assert.equal(validateTabGroupName('  New  ', groups), null);
  assert.equal(
    validateTabGroupName(' one ', groups),
    'A group with that name already exists.',
  );
  assert.equal(validateTabGroupName('  ', groups), 'Enter a group name.');
  assert.match(validateTabGroupName('x'.repeat(81), groups) ?? '', /80/);
});
