import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FaPlus } from 'react-icons/fa';
import { FaRegFile } from 'react-icons/fa6';
import type { TabSnapshot } from './Editor';
import { removedTabSnapshots } from './tabPresence';
import {
  assignTab,
  getTabId,
  validateTabGroupName,
  visibleTabOrder,
  mixedTabOrder,
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
  canCloseTab?: (tab: TabSnapshot) => boolean;
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
    before:
      | { type: 'tab'; tabId: string }
      | { type: 'group'; groupId: string }
      | null,
  ) => void;
};
export default function TabBar({
  tabs,
  activeId,
  commandHeld,
  onSelect,
  onClose,
  canCloseTab = () => true,
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
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const tabListRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = tabListRef.current;
    if (!element) return;
    const updateOverflow = () =>
      setTabsOverflow(element.scrollWidth > element.clientWidth);
    updateOverflow();
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [tabs.length, groups.length]);
  const [exitingTabs, setExitingTabs] = useState<
    Array<{ tab: TabSnapshot; rect: DOMRect }>
  >([]);
  const tabElements = useRef(new Map<string, HTMLElement>());
  const tabRects = useRef(new Map<string, DOMRect>());
  const tabsRef = useRef(new Map(tabs.map((tab) => [getTabId(tab), tab])));
  const previousIds = useRef(new Set(tabs.map(getTabId)));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const currentIds = new Set(tabs.map(getTabId));
  const enteringIds = new Set(
    tabs.filter((tab) => !previousIds.current.has(getTabId(tab))).map(getTabId),
  );
  useLayoutEffect(() => {
    // Reconcile against the prior committed snapshot before replacing it. The
    // passive effect runs too late: this map must still contain removed tabs.
    const removed = [...previousIds.current].filter(
      (id) => !currentIds.has(id),
    );
    if (removed.length) {
      const snapshots = removedTabSnapshots(
        previousIds.current,
        tabsRef.current,
        tabRects.current,
        currentIds,
      );
      setExitingTabs((current) => [
        ...current.filter(({ tab }) => !removed.includes(getTabId(tab))),
        ...snapshots,
      ]);
      removed.forEach((id) => {
        const oldTimer = timers.current.get(id);
        if (oldTimer) clearTimeout(oldTimer);
        timers.current.set(
          id,
          setTimeout(() => {
            setExitingTabs((current) =>
              current.filter(({ tab }) => getTabId(tab) !== id),
            );
            timers.current.delete(id);
          }, 300),
        );
      });
    }
    tabs.forEach((tab) => {
      const id = getTabId(tab);
      const timer = timers.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(id);
        setExitingTabs((current) =>
          current.filter(({ tab: item }) => getTabId(item) !== id),
        );
      }
    });
    previousIds.current = currentIds;
    tabsRef.current = new Map(tabs.map((tab) => [getTabId(tab), tab]));
    for (const [id, element] of tabElements.current) {
      if (element.isConnected)
        tabRects.current.set(id, element.getBoundingClientRect());
    }
  });
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
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
    const units = mixedTabOrder(tabs, groups, assignments);
    const targetIndex = units.findIndex(
      (unit) => unit.type === 'group' && unit.group.id === targetId,
    );
    const beforeUnit = after ? units[targetIndex + 1] : units[targetIndex];
    const before = beforeUnit
      ? beforeUnit.type === 'group'
        ? { type: 'group' as const, groupId: beforeUnit.group.id }
        : { type: 'tab' as const, tabId: getTabId(beforeUnit.tab) }
      : null;
    if (payload.id !== targetId)
      onMoveGroup(payload.vaultId, payload.id, before);
    clearDrag();
  };
  const tabDropTarget = (event: React.DragEvent) =>
    (event.target as HTMLElement).closest<HTMLElement>('[data-tab-id]');
  const dropOnTab = (event: React.DragEvent) => {
    const payload = validDrag(event);
    const target = tabDropTarget(event);
    if (payload?.type === 'group' && target) {
      const targetId = target.dataset.tabId;
      if (!targetId) return false;
      event.preventDefault();
      event.stopPropagation();
      const rect = target.getBoundingClientRect();
      const after = event.clientX >= rect.left + rect.width / 2;
      const units = mixedTabOrder(tabs, groups, assignments);
      const targetIndex = units.findIndex((unit) =>
        unit.type === 'tab'
          ? getTabId(unit.tab) === targetId
          : unit.tabs.some((tab) => getTabId(tab) === targetId),
      );
      const unit = after ? units[targetIndex + 1] : units[targetIndex];
      const before = unit
        ? unit.type === 'group'
          ? { type: 'group' as const, groupId: unit.group.id }
          : { type: 'tab' as const, tabId: getTabId(unit.tab) }
        : null;
      onMoveGroup(payload.vaultId, payload.id, before);
      clearDrag();
      return true;
    }
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
  const renderTab = (tab: TabSnapshot, exiting = false) => {
    const id = getTabId(tab);
    const index = order.findIndex((item) => getTabId(item) === id);
    const label =
      tab.kind === 'note'
        ? tab.note.path.split('/').at(-1)
        : tab.kind === 'image'
          ? tab.filename
          : tab.kind === 'pdf'
            ? tab.fileName
            : 'New tab';
    return (
      <div
        ref={(element) => {
          if (exiting) return;
          if (element) tabElements.current.set(id, element);
          else tabElements.current.delete(id);
        }}
        key={id}
        data-tab-id={exiting ? undefined : id}
        aria-hidden={exiting || undefined}
        inert={exiting || undefined}
        onDragEnd={clearDrag}
        onDragOver={allowDrop}
        onDrop={dropOnTab}
        style={
          exiting
            ? {
                position: 'fixed',
                left: exitingTabs.find((item) => getTabId(item.tab) === id)
                  ?.rect.left,
                top: exitingTabs.find((item) => getTabId(item.tab) === id)?.rect
                  .top,
                width: exitingTabs.find((item) => getTabId(item.tab) === id)
                  ?.rect.width,
                height: exitingTabs.find((item) => getTabId(item.tab) === id)
                  ?.rect.height,
                zIndex: 50,
              }
            : undefined
        }
        className={`tab-surface group/tab relative flex h-8 w-[10.5rem] shrink-0 items-center rounded-full border px-3 transition-[background-color,border-color,color] duration-150 focus-within:z-10 ${exiting ? 'tab-presence-exit' : enteringIds.has(id) ? 'tab-presence-enter' : ''} ${activeId === id ? 'tab-surface--active border-white/10 bg-[rgb(32_32_32/72%)] text-white' : 'tab-surface--inactive border-transparent bg-[rgb(32_32_32/24%)] text-white/60 hover:bg-[rgb(32_32_32/48%)]'}`}
        onAnimationEnd={(event) => {
          if (exiting && event.animationName === 'tab-presence-exit') {
            const timer = timers.current.get(id);
            if (timer) clearTimeout(timer);
            timers.current.delete(id);
            setExitingTabs((current) =>
              current.filter(({ tab }) => getTabId(tab) !== id),
            );
          }
        }}
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
          className="flex min-w-0 flex-1 items-center gap-2 truncate py-1 text-[13px] leading-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/35"
          title={tab.kind === 'note' ? tab.note.path : label}
        >
          <FaRegFile
            aria-hidden="true"
            className="tab-file-icon h-3 w-3 shrink-0 opacity-75"
          />
          <span className="tab-name truncate">{label}</span>
        </button>
        {commandHeld && index >= 0 && index < 9 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-7 top-1/2 z-20 -translate-y-1/2 whitespace-nowrap rounded-md bg-black/90 px-1 py-0.5 text-[9px] font-medium leading-none text-white shadow"
          >
            {platformKey}
            {index + 1}
          </span>
        )}
        <button
          type="button"
          onClick={() => onClose(tab)}
          disabled={!canCloseTab(tab)}
          aria-label={
            canCloseTab(tab)
              ? `Close ${label}`
              : `${label} cannot close while its agent is connected or writing`
          }
          title={
            canCloseTab(tab)
              ? `Close ${label}`
              : 'Agent connected — stop or finish writing before closing this tab'
          }
          className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] text-white/55 opacity-0 transition-[background-color,color,opacity] duration-150 hover:bg-white/10 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/35 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
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
          if (dropOnTab(event)) return;
          const payload = validDrag(event);
          if (payload?.type === 'group') {
            event.preventDefault();
            onMoveGroup(payload.vaultId, payload.id, null);
            clearDrag();
          } else dropTab(event, null, null);
        }}
        ref={tabListRef}
        className={`tab-list relative flex h-11 min-h-11 w-full min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-y-none bg-transparent select-none ${tabsOverflow ? 'tab-list--overflowing' : ''}`}
      >
        {mixedTabOrder(tabs, groups, assignments).map((unit) => {
          if (unit.type === 'tab') return renderTab(unit.tab);
          const { group } = unit;
          const members = unit.tabs;
          return (
            <div
              key={group.id}
              data-tab-group-id={group.id}
              onDrop={(event) => {
                const payload = validDrag(event);
                if (payload?.type === 'group') dropGroup(event, group.id);
                else dropOnGroup(event, group.id);
              }}
              className={`tab-group-surface relative flex h-9 min-h-9 max-h-9 shrink-0 items-center gap-1 overflow-hidden rounded-none border-0 border-b-2 bg-transparent px-1 transition-colors ${groupDropTarget === group.id ? 'ring-1 ring-inset ring-white/25' : ''}`}
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
                title={group.name}
                className="flex max-w-[10.5rem] shrink-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] font-medium leading-none text-white transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/65"
                style={{
                  backgroundColor: `${TAB_GROUP_COLORS[tabGroupColor(group, groups.indexOf(group))]}40`,
                }}
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
                <span aria-hidden="true" className="shrink-0 text-white/55">
                  {group.collapsed ? '▸' : '▾'}
                </span>
                <span className="min-w-0 truncate">{group.name}</span>
                <span className="shrink-0 text-white/40">{members.length}</span>
              </button>
              {!group.collapsed && members.map((tab) => renderTab(tab))}
            </div>
          );
        })}
        <button
          type="button"
          onClick={onNew}
          aria-label="New tab (⌘T)"
          aria-keyshortcuts="Meta+T Control+T"
          title={`New tab (${platformKey}T)`}
          className="editor-new-tab-button app-icon-button relative h-7 w-7 rounded-lg text-white/65"
        >
          <FaPlus aria-hidden="true" size={12} />
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-150 ${commandHeld ? 'opacity-100' : 'opacity-0'}`}
          >
            <span className="whitespace-nowrap rounded-lg bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white">
              {platformKey}T
            </span>
          </span>
        </button>
      </nav>
      {exitingTabs.length > 0 &&
        createPortal(
          exitingTabs.map(({ tab }) => renderTab(tab, true)),
          document.body,
        )}
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
            className="w-full max-w-xs rounded-lg border border-white/15 bg-[#202124] p-4 text-white shadow-xl select-none"
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
                className="mt-1 w-full rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm select-text"
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
