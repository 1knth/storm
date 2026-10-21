import type { TabSnapshot } from './Editor';
import { getTabId, type TabAssignments, type TabGroup } from './tabGroups';

export type ClosedTabRecord = {
  tab: TabSnapshot;
  vaultId: string;
  index: number;
  group?: TabGroup;
  groupIndex?: number;
};

export type ClosedTabState = {
  tabs: TabSnapshot[];
  groups: TabGroup[];
  assignments: TabAssignments;
  activeID: string | null;
};

/** Capture the tab and its placement without cloning EditorState. */
export function captureClosedTab(
  tabs: TabSnapshot[],
  groups: TabGroup[],
  assignments: TabAssignments,
  tabID: string,
  vaultID: string,
): ClosedTabRecord | null {
  const index = tabs.findIndex((tab) => getTabId(tab) === tabID);
  if (index < 0) return null;
  const tab = tabs[index];
  if ((tab.kind !== 'note' && tab.kind !== 'image') || tab.vaultId !== vaultID)
    return null;
  const groupId = assignments[tabID];
  const groupIndex = groups.findIndex((group) => group.id === groupId);
  return {
    tab,
    vaultId: vaultID,
    index,
    ...(groupIndex >= 0 ? { group: groups[groupIndex], groupIndex } : {}),
  };
}

/** Restore only into the originating vault; existing open instances are untouched. */
export type ClosedTabReopenDependencies = {
  readNote: (
    vaultId: string,
    path: string,
  ) => Promise<{
    content: string;
    revision: string;
  } | null>;
  createEditorState: (
    content: string,
  ) => import('@codemirror/state').EditorState;
  exists: (vaultId: string, path: string) => Promise<boolean>;
};

/** Prepare a closed snapshot against current disk state without mutating tab history/layout. */
export async function prepareClosedTabForReopen(
  record: ClosedTabRecord,
  deps: ClosedTabReopenDependencies,
): Promise<ClosedTabRecord> {
  if (record.tab.kind === 'note') {
    const current = await deps.readNote(record.vaultId, record.tab.note.path);
    if (!current)
      throw new Error(`Closed note no longer exists: ${record.tab.note.path}`);
    if (current.revision === record.tab.note.revision) return record;
    return {
      ...record,
      tab: {
        ...record.tab,
        note: {
          ...record.tab.note,
          content: current.content,
          revision: current.revision,
        },
        state: deps.createEditorState(current.content),
        scrollTop: 0,
      },
    };
  }
  if (record.tab.kind === 'image') {
    if (!(await deps.exists(record.vaultId, record.tab.path)))
      throw new Error(`Closed image no longer exists: ${record.tab.path}`);
    return record;
  }
  throw new Error('Only note and image tabs can be reopened');
}

export function restoreClosedTab(
  current: ClosedTabState,
  record: ClosedTabRecord,
  vaultID: string,
): ClosedTabState {
  if (
    vaultID !== record.vaultId ||
    (record.tab.kind !== 'note' && record.tab.kind !== 'image') ||
    record.tab.vaultId !== record.vaultId
  )
    return current;
  const id = getTabId(record.tab);
  const alreadyOpen = current.tabs.some((tab) => getTabId(tab) === id);
  if (alreadyOpen) return { ...current, activeID: id };

  const tabs = current.tabs.slice();
  tabs.splice(Math.max(0, Math.min(record.index, tabs.length)), 0, record.tab);
  let groups = current.groups;
  let assignments = current.assignments;
  if (record.group) {
    const existingIndex = groups.findIndex(
      (group) => group.id === record.group!.id,
    );
    if (existingIndex < 0) {
      groups = groups.slice();
      groups.splice(
        Math.max(
          0,
          Math.min(record.groupIndex ?? groups.length, groups.length),
        ),
        0,
        record.group,
      );
    }
    assignments = { ...assignments, [id]: record.group.id };
  }
  return { tabs, groups, assignments, activeID: id };
}
