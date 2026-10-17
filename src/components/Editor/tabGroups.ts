import type { TabSnapshot } from './Editor';
import { GROUP_COLORS, groupColorForId } from '../../shared/groupColors';

export const TAB_GROUP_COLORS = GROUP_COLORS;
export type TabGroupColor = keyof typeof TAB_GROUP_COLORS;
export type TabGroup = {
  id: string;
  name: string;
  collapsed: boolean;
  color?: TabGroupColor;
};
export function tabGroupColor(group: TabGroup, _index: number): TabGroupColor {
  return group.color ?? groupColorForId(group.id);
}
export type TabAssignments = Record<string, string>;
export const getTabId = (tab: TabSnapshot) =>
  tab.kind === 'note' ? tab.note.path : tab.id;

export const hasOpenTabs = (tabs: TabSnapshot[]) => tabs.length > 0;
export type TabStripUnit =
  | { type: 'tab'; tab: TabSnapshot }
  | { type: 'group'; group: TabGroup; tabs: TabSnapshot[] };

/** Top-level strip order: a group's unit occupies its first member's global tab position. */
export function mixedTabOrder(
  tabs: TabSnapshot[],
  groups: TabGroup[],
  assignments: TabAssignments,
): TabStripUnit[] {
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const members = new Map<string, TabSnapshot[]>();
  for (const tab of tabs) {
    const groupId = assignments[getTabId(tab)];
    if (groupsById.has(groupId))
      members.set(groupId, [...(members.get(groupId) ?? []), tab]);
  }
  const emitted = new Set<string>();
  const units: TabStripUnit[] = [];
  for (const tab of tabs) {
    const groupId = assignments[getTabId(tab)];
    const group = groupsById.get(groupId);
    if (!group) units.push({ type: 'tab', tab });
    else if (!emitted.has(groupId)) {
      emitted.add(groupId);
      units.push({ type: 'group', group, tabs: members.get(groupId) ?? [] });
    }
  }
  for (const group of groups) {
    if (!emitted.has(group.id)) units.push({ type: 'group', group, tabs: [] });
  }
  return units;
}

export function visibleTabOrder(
  tabs: TabSnapshot[],
  groups: TabGroup[],
  assignments: TabAssignments,
) {
  return mixedTabOrder(tabs, groups, assignments).flatMap((unit) =>
    unit.type === 'tab' ? [unit.tab] : unit.group.collapsed ? [] : unit.tabs,
  );
}

/** Move a group's tab block before a top-level tab or group anchor, or to the end. */
export function moveTabGroupBlock(
  tabs: TabSnapshot[],
  groups: TabGroup[],
  assignments: TabAssignments,
  groupId: string,
  before:
    | { type: 'tab'; tabId: string }
    | { type: 'group'; groupId: string }
    | null,
): TabSnapshot[] | null {
  const group = groups.find((item) => item.id === groupId);
  if (!group) return null;
  const units = mixedTabOrder(tabs, groups, assignments);
  const source = units.findIndex(
    (unit) => unit.type === 'group' && unit.group.id === groupId,
  );
  if (
    before?.type === 'group' &&
    !groups.some((item) => item.id === before.groupId)
  )
    return null;
  if (
    before?.type === 'tab' &&
    !tabs.some((tab) => getTabId(tab) === before.tabId)
  )
    return null;
  const target =
    before === null
      ? units.length
      : units.findIndex((unit) =>
          before.type === 'group'
            ? unit.type === 'group' && unit.group.id === before.groupId
            : unit.type === 'tab' && getTabId(unit.tab) === before.tabId,
        );
  if (target < 0) return null;
  if (target === source || target === source + 1) return tabs;
  const [unit] = units.splice(source, 1);
  const insertion =
    before === null
      ? units.length
      : units.findIndex((item) =>
          before.type === 'group'
            ? item.type === 'group' && item.group.id === before.groupId
            : item.type === 'tab' && getTabId(item.tab) === before.tabId,
        );
  units.splice(insertion, 0, unit);
  return units.flatMap((item) =>
    item.type === 'tab' ? [item.tab] : item.tabs,
  );
}
export function cleanTabAssignments(
  assignments: TabAssignments,
  tabs: TabSnapshot[],
  groups: TabGroup[],
) {
  const tabIds = new Set(tabs.map(getTabId));
  const groupIds = new Set(groups.map((group) => group.id));
  return Object.fromEntries(
    Object.entries(assignments).filter(
      ([tabId, groupId]) => tabIds.has(tabId) && groupIds.has(groupId),
    ),
  );
}
export type TabMoveResult = {
  tabs: TabSnapshot[];
  assignments: TabAssignments;
};

/** Move a tab before a destination member, or to the end of its destination group. */
export function moveTab(
  tabs: TabSnapshot[],
  groups: TabGroup[],
  assignments: TabAssignments,
  tabId: string,
  targetGroupId: string | null,
  beforeTabId: string | null = null,
): TabMoveResult | null {
  const sourceIndex = tabs.findIndex((tab) => getTabId(tab) === tabId);
  if (
    sourceIndex < 0 ||
    (targetGroupId !== null &&
      !groups.some((group) => group.id === targetGroupId))
  )
    return null;
  const sourceGroupId = assignments[tabId] ?? null;
  if (beforeTabId === tabId)
    return sourceGroupId === targetGroupId ? { tabs, assignments } : null;
  if (beforeTabId !== null) {
    const destination = tabs.find((tab) => getTabId(tab) === beforeTabId);
    if (!destination || (assignments[beforeTabId] ?? null) !== targetGroupId)
      return null;
  }
  const nextTabs = tabs.filter((_, index) => index !== sourceIndex);
  let insertionIndex: number;
  if (beforeTabId !== null) {
    insertionIndex = nextTabs.findIndex((tab) => getTabId(tab) === beforeTabId);
  } else if (targetGroupId === null) {
    insertionIndex = nextTabs.length;
  } else {
    const lastMember = nextTabs.findLastIndex(
      (tab) => assignments[getTabId(tab)] === targetGroupId,
    );
    insertionIndex = lastMember < 0 ? nextTabs.length : lastMember + 1;
  }
  nextTabs.splice(insertionIndex, 0, tabs[sourceIndex]);
  const nextAssignments = { ...assignments };
  if (targetGroupId === null) delete nextAssignments[tabId];
  else nextAssignments[tabId] = targetGroupId;
  if (
    sourceGroupId === targetGroupId &&
    nextTabs.every((tab, index) => tab === tabs[index])
  )
    return { tabs, assignments };
  return { tabs: nextTabs, assignments: nextAssignments };
}

export function moveTabGroup(
  groups: TabGroup[],
  groupId: string,
  beforeGroupId: string | null,
): TabGroup[] | null {
  const sourceIndex = groups.findIndex((group) => group.id === groupId);
  if (
    sourceIndex < 0 ||
    (beforeGroupId !== null &&
      !groups.some((group) => group.id === beforeGroupId))
  )
    return null;
  if (
    beforeGroupId === groupId ||
    (beforeGroupId === null && sourceIndex === groups.length - 1)
  )
    return groups;
  const next = groups.slice();
  const [group] = next.splice(sourceIndex, 1);
  const targetIndex =
    beforeGroupId === null
      ? next.length
      : next.findIndex((item) => item.id === beforeGroupId);
  next.splice(targetIndex, 0, group);
  return next;
}

export function assignTab(
  assignments: TabAssignments,
  tabId: string,
  groupId: string | null,
): TabAssignments {
  const next = { ...assignments };
  if (groupId) next[tabId] = groupId;
  else delete next[tabId];
  return next;
}
export function validateTabGroupName(
  value: string,
  groups: TabGroup[],
  exceptId?: string,
): string | null {
  const name = value.trim();
  if (!name) return 'Enter a group name.';
  if (name.length > 80) return 'Group names must be 80 characters or fewer.';
  if (
    groups.some(
      (group) =>
        group.id !== exceptId &&
        group.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
    )
  )
    return 'A group with that name already exists.';
  return null;
}
export function removeTabGroup(
  groupId: string,
  groups: TabGroup[],
  assignments: TabAssignments,
) {
  return {
    groups: groups.filter((group) => group.id !== groupId),
    assignments: Object.fromEntries(
      Object.entries(assignments).filter(([, id]) => id !== groupId),
    ),
  };
}
