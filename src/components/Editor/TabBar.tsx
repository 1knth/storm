import { useEffect, useRef, useState } from 'react';
import { FaPlus } from 'react-icons/fa';
import type { TabSnapshot } from './Editor';
import {
  assignTab,
  getTabId,
  validateTabGroupName,
  visibleTabOrder,
  TAB_GROUP_COLORS,
  tabGroupColor,
} from './tabGroups';
import type { TabAssignments, TabGroup } from './tabGroups';
import ContextMenu from '../ContextMenu';
import type { ContextMenuItem, ContextMenuPosition } from '../ContextMenu';
import { contextMenuPointForElement, isContextMenuKey } from '../ContextMenu';

type Props = {
  tabs: TabSnapshot[];
  activeId: string | null;
  commandHeld: boolean;
  onSelect: (tab: TabSnapshot) => void;
  onClose: (tab: TabSnapshot) => void;
  onNew: () => void;
  groups: TabGroup[];
  assignments: TabAssignments;
  onGroupsChange: (groups: TabGroup[]) => void;
  onAssignmentsChange: (assignments: TabAssignments) => void;
  vaultId: string | null;
  onMoveTab: (
    vaultId: string,
    tabId: string,
    groupId: string | null,
    beforeTabId: string | null,
  ) => void;
  onMoveGroup: (
    vaultId: string,
    groupId: string,
    beforeGroupId: string | null,
  ) => void;
};
export default function TabBar({
  tabs,
  activeId,
  commandHeld,
  onSelect,
  onClose,
  onNew,
  groups,
  assignments,
  onGroupsChange,
  onAssignmentsChange,
  vaultId,
  onMoveTab,
  onMoveGroup,
}: Props) {
  const [dialog, setDialog] = useState<{ id?: string; value: string } | null>(
    null,
  );
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState<{
    type: 'tab' | 'group';
    id: string;
    vaultId: string;
  } | null>(null);
  const [groupDropTarget, setGroupDropTarget] = useState<string | null>(null);
  const dragMoved = useRef(false);
  const draggingRef = useRef<{
    type: 'tab' | 'group';
    id: string;
    vaultId: string;
  } | null>(null);
  const clearDrag = () => {
    draggingRef.current = null;
    setDragging(null);
    setGroupDropTarget(null);
  };
  useEffect(() => {
    clearDrag();
    dragMoved.current = false;
  }, [vaultId]);
  useEffect(
    () => () => {
      draggingRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!dragging) return;
    const clear = () => clearDrag();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    window.addEventListener('blur', clear);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('blur', clear);
      window.removeEventListener('keydown', escape);
    };
  }, [dragging]);
  const internalType = 'application/x-storm-tab-drag';
  const startDrag = (
    event: React.DragEvent,
    type: 'tab' | 'group',
    id: string,
  ) => {
    if (!vaultId) {
      event.preventDefault();
      return;
    }
    const payload = { type, id, vaultId };
    event.dataTransfer.setData(internalType, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'move';
    draggingRef.current = payload;
    setDragging(payload);
    dragMoved.current = true;
  };
  const validDrag = (event: React.DragEvent) => {
    const payload = draggingRef.current;
    return payload &&
      payload.vaultId === vaultId &&
      event.dataTransfer.types.includes(internalType) &&
      (payload.type === 'tab'
        ? tabs.some((tab) => getTabId(tab) === payload.id)
        : groups.some((group) => group.id === payload.id))
      ? payload
      : null;
  };
  const allowDrop = (event: React.DragEvent) => {
    if (validDrag(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }
  };
  const dropTab = (
    event: React.DragEvent,
    groupId: string | null,
    beforeId: string | null,
  ) => {
    const payload = validDrag(event);
    if (
      !payload ||
      payload.type !== 'tab' ||
      !event.dataTransfer.types.includes(internalType)
    )
      return false;
    event.preventDefault();
    event.stopPropagation();
    onMoveTab(payload.vaultId, payload.id, groupId, beforeId);
    clearDrag();
    return true;
  };
  const dropGroup = (event: React.DragEvent, targetId: string) => {
    const payload = validDrag(event);
    if (!payload || payload.type !== 'group') return;
    event.preventDefault();
    event.stopPropagation();
    const target = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const after = event.clientX >= target.left + target.width / 2;
    const targetIndex = groups.findIndex((group) => group.id === targetId);
    const beforeId = after ? (groups[targetIndex + 1]?.id ?? null) : targetId;
    if (payload.id !== targetId)
      onMoveGroup(payload.vaultId, payload.id, beforeId);
    clearDrag();
  };
  const tabDropTarget = (event: React.DragEvent) =>
    (event.target as HTMLElement).closest<HTMLElement>('[data-tab-id]');
  const dropOnTab = (event: React.DragEvent) => {
    const target = tabDropTarget(event);
    if (!target) return false;
    const targetId = target.dataset.tabId;
    const targetTab = tabs.find((tab) => getTabId(tab) === targetId);
    if (!targetId || !targetTab) return false;
    const groupId = assignments[targetId] ?? null;
    const rect = target.getBoundingClientRect();
    const after = event.clientX >= rect.left + rect.width / 2;
    const members = order.filter(
      (tab) => (assignments[getTabId(tab)] ?? null) === groupId,
    );
    const position = members.findIndex((tab) => getTabId(tab) === targetId);
    const beforeId = after
      ? position >= 0 && members[position + 1]
        ? getTabId(members[position + 1])
        : null
      : targetId;
    return dropTab(event, groupId, beforeId);
  };
  const dropOnGroup = (event: React.DragEvent, groupId: string) => {
    if (dropOnTab(event)) return;
    dropTab(event, groupId, null);
  };
  const [menu, setMenu] = useState<{
    position: ContextMenuPosition;
    returnFocusTo: HTMLElement | null;
    items: ContextMenuItem[];
  } | null>(null);
  const platformKey = navigator.platform.toLowerCase().includes('mac')
    ? '⌘'
    : 'Ctrl+';
  const order = visibleTabOrder(tabs, groups, assignments);
  const showTabMenu = (
    tabId: string,
    position: ContextMenuPosition,
    returnFocusTo: HTMLElement | null,
  ) => {
    const items: ContextMenuItem[] = [
      {
        id: 'create-group',
        label: 'Create group…',
        onSelect: () => setDialog({ value: '' }),
      },
      ...groups.map((group) => ({
        id: `move-${group.id}`,
        label: `${assignments[tabId] === group.id ? '✓ ' : ''}Move to ${group.name}`,
        onSelect: () => {
          onAssignmentsChange(assignTab(assignments, tabId, group.id));
          onGroupsChange(
            groups.map((item) =>
              item.id === group.id ? { ...item, collapsed: false } : item,
            ),
          );
        },
      })),
      ...(assignments[tabId]
        ? [
            {
              id: 'ungroup',
              label: 'Ungroup tab',
              onSelect: () =>
                onAssignmentsChange(assignTab(assignments, tabId, null)),
            },
          ]
        : []),
    ];
    setMenu({ position, returnFocusTo, items });
  };
  const showGroupMenu = (
    group: TabGroup,
    position: ContextMenuPosition,
    returnFocusTo: HTMLElement | null,
  ) =>
    setMenu({
      position,
      returnFocusTo,
      items: [
        {
          id: 'change-color',
          label: 'Change color',
          submenu: {
            type: 'swatches',
            items: Object.entries(TAB_GROUP_COLORS).map(([color, value]) => ({
              id: `color-${color}`,
              label: `${color[0].toUpperCase()}${color.slice(1)}`,
              color: value,
              selected: tabGroupColor(group, groups.indexOf(group)) === color,
              onSelect: () =>
                onGroupsChange(
                  groups.map((item) =>
                    item.id === group.id
                      ? {
                          ...item,
                          color: color as keyof typeof TAB_GROUP_COLORS,
                        }
                      : item,
                  ),
                ),
            })),
          },
        },
        {
          id: 'rename',
          label: 'Rename group…',
          onSelect: () => setDialog({ id: group.id, value: group.name }),
        },
        {
          id: 'remove',
          label: 'Remove group (keep tabs)',
          danger: true,
          onSelect: () => {
            onAssignmentsChange(
              Object.fromEntries(
                Object.entries(assignments).filter(([, id]) => id !== group.id),
              ),
            );
            onGroupsChange(groups.filter((item) => item.id !== group.id));
          },
        },
      ],
    });
  const submitGroup = () => {
    if (!dialog) return;
    const issue = validateTabGroupName(dialog.value, groups, dialog.id);
    if (issue) {
      setError(issue);
      return;
    }
    if (dialog.id)
      onGroupsChange(
        groups.map((group) =>
          group.id === dialog.id
            ? { ...group, name: dialog.value.trim() }
            : group,
        ),
      );
    else {
      const group = {
        id: crypto.randomUUID(),
        name: dialog.value.trim(),
        collapsed: false,
        color: 'blue' as const,
      };
      onGroupsChange([...groups, group]);
      const active = tabs.find((tab) => getTabId(tab) === activeId);
      if (active)
        onAssignmentsChange(assignTab(assignments, getTabId(active), group.id));
    }
    setDialog(null);
    setError('');
  };
  const renderTab = (tab: TabSnapshot) => {
    const id = getTabId(tab);
    const index = order.findIndex((item) => getTabId(item) === id);
    const label =
      tab.kind === 'note' ? tab.note.path.split('/').at(-1) : 'New tab';
    return (
      <div
        key={id}
        data-tab-id={id}
        onDragEnd={clearDrag}
        onDragOver={allowDrop}
        onDrop={dropOnTab}
        className={`relative flex max-w-56 shrink-0 items-center border-r border-white/10 ${activeId === id ? 'bg-black/50 text-white' : 'text-white/60 hover:bg-white/10'}`}
        onClickCapture={(event) => {
          if (dragMoved.current) {
            event.stopPropagation();
            dragMoved.current = false;
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          showTabMenu(
            id,
            { x: event.clientX, y: event.clientY },
            event.currentTarget,
          );
        }}
        onKeyDown={(event) => {
          if (isContextMenuKey(event)) {
            event.preventDefault();
            showTabMenu(
              id,
              contextMenuPointForElement(event.currentTarget),
              event.currentTarget,
            );
          }
        }}
      >
        <button
          type="button"
          draggable
          onDragStart={(event) => startDrag(event, 'tab', id)}
          onClick={() => onSelect(tab)}
          aria-current={activeId === id ? 'page' : undefined}
          className="truncate px-2 text-[11px]"
          title={tab.kind === 'note' ? tab.note.path : 'New tab'}
        >
          {label}
        </button>
        {commandHeld && index >= 0 && index < 9 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-7 top-1/2 z-20 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-1 py-0.5 text-[9px] leading-none text-white shadow"
          >
            {platformKey}
            {index + 1}
          </span>
        )}
        <button
          type="button"
          onClick={() => onClose(tab)}
          aria-label={`Close ${label}`}
          className="min-w-6 px-1.5 text-[11px] text-white/50 hover:text-white"
        >
          ×
        </button>
      </div>
    );
  };
  return (
    <>
      <nav
        aria-label="Open tabs"
        onDragOver={allowDrop}
        onDrop={(event) => {
          if (!dropOnTab(event)) dropTab(event, null, null);
        }}
        className="relative flex h-7 min-h-7 min-w-0 shrink-0 items-stretch gap-0 overflow-x-auto overflow-y-hidden overscroll-y-none rounded-xl bg-black/50"
      >
        {groups.map((group) => {
          const members = tabs.filter(
            (tab) => assignments[getTabId(tab)] === group.id,
          );
          return (
            <div
              key={group.id}
              data-tab-group-id={group.id}
              onDrop={(event) => {
                const payload = validDrag(event);
                if (payload?.type === 'group') dropGroup(event, group.id);
                else dropOnGroup(event, group.id);
              }}
              className={`relative flex shrink-0 items-stretch border-r border-white/15 border-b-2 ${groupDropTarget === group.id ? 'ring-1 ring-inset ring-indigo-400/70' : ''}`}
              style={{
                borderBottomColor:
                  TAB_GROUP_COLORS[tabGroupColor(group, groups.indexOf(group))],
              }}
              onDragOver={(event) => {
                allowDrop(event);
                if (validDrag(event)?.type === 'group')
                  setGroupDropTarget(group.id);
              }}
              onDragEnd={clearDrag}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                showGroupMenu(
                  group,
                  { x: event.clientX, y: event.clientY },
                  event.currentTarget,
                );
              }}
              onKeyDown={(event) => {
                if (isContextMenuKey(event)) {
                  event.preventDefault();
                  showGroupMenu(
                    group,
                    contextMenuPointForElement(event.currentTarget),
                    event.currentTarget,
                  );
                }
              }}
            >
              <button
                type="button"
                draggable
                onDragStart={(event) => {
                  event.stopPropagation();
                  startDrag(event, 'group', group.id);
                }}
                onDragEnd={clearDrag}
                className="px-2 text-[11px] text-white/65 hover:bg-white/10"
                aria-expanded={!group.collapsed}
                onClick={() => {
                  if (dragMoved.current) {
                    dragMoved.current = false;
                    return;
                  }
                  onGroupsChange(
                    groups.map((item) =>
                      item.id === group.id
                        ? { ...item, collapsed: !item.collapsed }
                        : item,
                    ),
                  );
                }}
              >
                {group.collapsed ? '▸' : '▾'} {group.name}{' '}
                <span className="text-white/35">{members.length}</span>
              </button>
              {!group.collapsed && members.map(renderTab)}
            </div>
          );
        })}
        {tabs
          .filter(
            (tab) =>
              !assignments[getTabId(tab)] ||
              !groups.some((group) => group.id === assignments[getTabId(tab)]),
          )
          .map(renderTab)}
        <button
          type="button"
          onClick={onNew}
          aria-label="New tab (⌘T)"
          aria-keyshortcuts="Meta+T Control+T"
          title={`New tab (${platformKey}T)`}
          className="relative flex h-7 w-8 shrink-0 items-center justify-center text-white/65 hover:bg-white/10 hover:text-white"
        >
          <FaPlus aria-hidden="true" size={12} />
          <span
            className={`pointer-events-none absolute left-1/2 top-full z-20 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[10px] leading-none text-white transition-opacity ${commandHeld ? 'opacity-100' : 'opacity-0'}`}
            aria-hidden="true"
          >
            {platformKey}T
          </span>
        </button>
      </nav>
      {menu && (
        <ContextMenu
          position={menu.position}
          items={menu.items}
          returnFocusTo={menu.returnFocusTo}
          onClose={() => setMenu(null)}
        />
      )}
      {dialog && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDialog(null);
          }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="tab-group-title"
            className="w-full max-w-xs rounded-lg border border-white/15 bg-[#202124] p-4 text-white shadow-xl"
            onSubmit={(event) => {
              event.preventDefault();
              submitGroup();
            }}
          >
            <h2 id="tab-group-title" className="mb-3 text-sm font-semibold">
              {dialog.id ? 'Rename tab group' : 'New tab group'}
            </h2>
            <label className="block text-xs">
              Name
              <input
                autoFocus
                maxLength={80}
                value={dialog.value}
                onChange={(event) => {
                  setDialog({ ...dialog, value: event.target.value });
                  setError('');
                }}
                className="mt-1 w-full rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm"
              />
            </label>
            {error && (
              <p role="alert" className="mt-2 text-xs text-red-300">
                {error}
              </p>
            )}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="px-2 py-1 text-xs"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button className="rounded bg-blue-600 px-2 py-1 text-xs">
                Save
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
