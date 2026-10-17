import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assignTab,
  cleanTabAssignments,
  getTabId,
  hasOpenTabs,
  normalizeTabGroupState,
  moveTab,
  moveTabGroup,
  moveTabGroupBlock,
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
test('shows the tab bar only when at least one tab is open, regardless of groups', () => {
  assert.equal(hasOpenTabs([]), false);
  assert.equal(hasOpenTabs(tabs), true);
});
test('clears groups and assignments only when the actual tab list is empty', () => {
  const assigned = { a: 'g1' };
  assert.deepEqual(normalizeTabGroupState([], groups, assigned), {
    groups: [],
    assignments: {},
  });
  assert.deepEqual(normalizeTabGroupState([tabs[0]], groups, assigned), {
    groups,
    assignments: assigned,
  });
  // A collapsed group with real members still has open tabs.
  assert.deepEqual(
    normalizeTabGroupState([tabs[0]], groups, assigned).groups,
    groups,
  );
  // Empty tabs are real tabs too.
  assert.equal(
    normalizeTabGroupState([tabs[0]], groups, assigned).groups.length,
    2,
  );
});
test('uses stable fallback colors and the approved palette for groups', () => {
  const firstColor = tabGroupColor(groups[0], 0);
  const secondColor = tabGroupColor(groups[1], 1);
  assert.equal(tabGroupColor(groups[0], 1), firstColor);
  assert.equal(tabGroupColor(groups[1], 0), secondColor);
  assert.equal(tabGroupColor({ ...groups[0], color: 'green' }, 0), 'green');
  assert.equal(TAB_GROUP_COLORS.green, '#4ade80');
});
test('orders mixed strip units by first member and hides collapsed members', () => {
  assert.deepEqual(
    visibleTabOrder(tabs, groups, { a: 'g2', b: 'g1' }).map(
      (tab) => tab.kind === 'empty' && tab.id,
    ),
    ['a', 'c'],
  );
  assert.deepEqual(visibleTabOrder(tabs, groups, { b: 'g1' }).map(getTabId), [
    'a',
    'c',
  ]);
  assert.deepEqual(
    visibleTabOrder(tabs, groups, { a: 'invalid' }).map(getTabId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(visibleTabOrder(tabs, [], { a: 'invalid' }).map(getTabId), [
    'a',
    'b',
    'c',
  ]);
});
test('moves group members as a block around tab and group anchors', () => {
  const ordered = [tabs[0], tabs[1], tabs[2]];
  const assignments = { a: 'g2', c: 'g2' };
  assert.deepEqual(
    moveTabGroupBlock(ordered, groups, assignments, 'g2', {
      type: 'tab',
      tabId: 'b',
    })?.map(getTabId),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    moveTabGroupBlock(ordered, groups, assignments, 'g2', {
      type: 'group',
      groupId: 'g1',
    })?.map(getTabId),
    ['b', 'a', 'c'],
  );
  assert.deepEqual(
    moveTabGroupBlock(ordered, groups, assignments, 'g2', null)?.map(getTabId),
    ['b', 'a', 'c'],
  );
  assert.equal(
    moveTabGroupBlock(ordered, groups, assignments, 'missing', null),
    null,
  );
  assert.deepEqual(
    moveTabGroupBlock(ordered, groups, {}, 'g1', null)?.map(getTabId),
    ['a', 'b', 'c'],
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
