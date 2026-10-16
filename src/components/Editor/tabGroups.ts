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
export function visibleTabOrder(
  tabs: TabSnapshot[],
  groups: TabGroup[],
  assignments: TabAssignments,
) {
  const grouped = groups
    .filter((group) => !group.collapsed)
    .flatMap((group) =>
      tabs.filter((tab) => assignments[getTabId(tab)] === group.id),
    );
  return [
    ...grouped,
    ...tabs.filter(
      (tab) =>
        !assignments[getTabId(tab)] ||
        !groups.some((group) => group.id === assignments[getTabId(tab)]),
    ),
  ];
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
