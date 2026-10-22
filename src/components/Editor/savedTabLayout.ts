import type { SavedTabLayout } from '../../shared/types';
import type { TabSnapshot } from './Editor';
import { getTabId } from './tabGroups';
import { cleanTabAssignments, normalizeTabGroupState } from './tabGroups';
import type { TabAssignments, TabGroup } from './tabGroups';

/** Reconcile saved memberships only after saved groups and live tabs are available. */
export function restoreTabGroupState(
  tabs: TabSnapshot[],
  groups: TabGroup[],
  assignments: TabAssignments,
) {
  const validAssignments = cleanTabAssignments(assignments, tabs, groups);
  return normalizeTabGroupState(tabs, groups, validAssignments);
}

export function serializeTabLayout(
  tabs: TabSnapshot[],
  activeId: string | null,
  groups: TabGroup[],
  assignments: TabAssignments,
  snapshots: Map<string, TabSnapshot>,
): SavedTabLayout {
  return {
    version: 1,
    tabs: tabs.map((tab) => {
      const latest = snapshots.get(getTabId(tab)) ?? tab;
      if (latest.kind === 'empty') return { kind: 'empty', id: latest.id };
      if (latest.kind === 'image') return { kind: 'image', path: latest.path };
      if (latest.kind === 'pdf')
        return { kind: 'pdf', relativePath: latest.relativePath };
      const selection = latest.state.selection.main;
      return {
        kind: 'note',
        path: latest.note.path,
        anchor: selection.anchor,
        head: selection.head,
        scrollTop: latest.scrollTop,
      };
    }),
    activeTab: activeId,
    groups: groups.map(({ id, name, collapsed, color }) => ({
      id,
      name,
      collapsed,
      ...(color ? { color } : {}),
    })),
    assignments: { ...assignments },
  };
}
