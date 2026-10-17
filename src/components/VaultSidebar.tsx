import { useRef, useState } from 'react';
import { useToast } from './Toast';
import ContextMenu from './ContextMenu';
import type { ContextMenuItem, ContextMenuPosition } from './ContextMenu';
import { contextMenuPointForElement, isContextMenuKey } from './ContextMenu';
import type { FormEvent } from 'react';
import type { RegisteredVault, VaultGroup } from '../shared/types';
import { GROUP_COLORS, groupColorForId } from '../shared/groupColors';
import { FaPlus } from 'react-icons/fa';
import { FaFolderTree } from 'react-icons/fa6';
import { IoIosSettings } from 'react-icons/io';
import { RiMenuUnfold4Fill } from 'react-icons/ri';

type Props = {
  vaults: RegisteredVault[];
  groups: VaultGroup[];
  visibleVaults: RegisteredVault[];
  onGroupsChange: (groups: VaultGroup[]) => void;
  onVaultsChange: (vaults: RegisteredVault[]) => void;
  activeVaultId: string | null;
  onActivate: (id: string, focusExplorer?: boolean) => void;
  onAdd: () => void;
  collapsed: boolean;
  onToggleExplorer: () => void;
  toggleExplorerShortcut: boolean;
  onRemove: (id: string) => void;
  error: string | null;
  commandHeld: boolean;
  vimMode: boolean;
  onOpenSettings: () => void;
};

export default function VaultSidebar({
  vaults,
  groups,
  visibleVaults,
  onGroupsChange,
  onVaultsChange,
  activeVaultId,
  onActivate,
  onAdd,
  collapsed,
  onToggleExplorer,
  toggleExplorerShortcut,
  onRemove,
  error,
  commandHeld,
  vimMode,
  onOpenSettings,
}: Props) {
  const [groupForm, setGroupForm] = useState<{
    id?: string;
    name: string;
    mode?: 'choose' | 'name';
    selectionId?: string;
    folderName?: string;
  } | null>(null);
  const [menu, setMenu] = useState<{
    target: { kind: 'vault'; id: string } | { kind: 'group'; id: string };
    position: ContextMenuPosition;
    returnFocusTo: HTMLElement;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const { notifyError } = useToast();
  const formInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    const [nextGroups, result] = await Promise.all([
      window.vault.groupsList(),
      window.vault.registryList(),
    ]);
    onGroupsChange(nextGroups);
    onVaultsChange(result.vaults);
  };
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      notifyError(
        cause instanceof Error
          ? cause.message
          : 'Unable to update vault groups',
      );
    } finally {
      setBusy(false);
    }
  };
  const saveGroup = (event: FormEvent) => {
    event.preventDefault();
    if (!groupForm || !groupForm.name.trim() || busy) return;
    const { id, name } = groupForm;
    void run(async () => {
      if (id) await window.vault.groupRename(id, name.trim());
      else if (groupForm.selectionId)
        await window.vault.groupCreateFromFolder(
          groupForm.selectionId,
          name.trim(),
        );
      else await window.vault.groupCreate(name.trim());
      setGroupForm(null);
    });
  };
  const openMenu = (
    target: { kind: 'vault'; id: string } | { kind: 'group'; id: string },
    position: ContextMenuPosition,
    returnFocusTo: HTMLElement,
  ) => setMenu({ target, position, returnFocusTo });
  const menuItems: ContextMenuItem[] =
    menu?.target.kind === 'vault'
      ? (() => {
          const vault = vaults.find((item) => item.id === menu.target.id);
          if (!vault) return [];
          return [
            {
              id: 'move-label',
              label: 'Move to group',
              onSelect: () => {},
              disabled: true,
            },
            {
              id: 'ungrouped',
              label: 'Ungrouped',
              disabled: !vault.groupId || busy,
              onSelect: () =>
                void run(() => window.vault.groupSetVault(vault.id, null)),
            },
            ...groups.map((group) => ({
              id: `group-${group.id}`,
              label: group.name,
              disabled: vault.groupId === group.id || busy,
              onSelect: () =>
                void run(() => window.vault.groupSetVault(vault.id, group.id)),
            })),
          ];
        })()
      : menu?.target.kind === 'group'
        ? (() => {
            const group = groups.find((item) => item.id === menu.target.id);
            if (!group) return [];
            return [
              {
                id: 'change-color',
                label: 'Change color',
                submenu: {
                  type: 'swatches',
                  items: Object.entries(GROUP_COLORS).map(([color, value]) => ({
                    id: `color-${color}`,
                    label: `${color[0].toUpperCase()}${color.slice(1)}`,
                    color: value,
                    selected:
                      (group.color ?? groupColorForId(group.id)) === color,
                    onSelect: () =>
                      void run(() =>
                        window.vault.groupSetColor(
                          group.id,
                          color as keyof typeof GROUP_COLORS,
                        ),
                      ),
                  })),
                },
              },
              {
                id: 'rename',
                label: 'Rename',
                onSelect: () => {
                  setGroupForm({ id: group.id, name: group.name });
                  requestAnimationFrame(() => formInput.current?.focus());
                },
              },
              {
                id: 'delete',
                label: 'Delete group',
                disabled: busy,
                danger: true,
                onSelect: () =>
                  void run(() => window.vault.groupRemove(group.id)),
              },
            ];
          })()
        : [];
  const ungrouped = visibleVaults.filter(
    (vault) =>
      !vault.groupId || !groups.some((group) => group.id === vault.groupId),
  );
  const renderVault = (vault: RegisteredVault, index: number) => (
    <li
      key={vault.id}
      className="group relative flex min-h-8 min-w-0 items-center rounded-md"
    >
      <button
        type="button"
        data-vault-row
        data-vault-id={vault.id}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMenu(
            { kind: 'vault', id: vault.id },
            { x: event.clientX, y: event.clientY },
            event.currentTarget,
          );
        }}
        onKeyDown={(event) => {
          if (isContextMenuKey(event)) {
            event.preventDefault();
            openMenu(
              { kind: 'vault', id: vault.id },
              contextMenuPointForElement(event.currentTarget),
              event.currentTarget,
            );
          }
        }}
        onClick={() => onActivate(vault.id)}
        aria-current={vault.id === activeVaultId ? 'true' : undefined}
        title={`${vault.name}\n${vault.path}`}
        className={`relative min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left text-xs ${commandHeld && index < 9 ? 'pr-20' : 'pr-8'} ${vault.id === activeVaultId ? 'bg-white/10 text-white' : 'sidebar-hover-tint text-white/65 hover:bg-white/5 hover:text-white focus-visible:bg-white/5 focus-visible:text-white'}`}
      >
        <span className="block min-w-0 truncate">{vault.name}</span>
        {commandHeld && index < 9 && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute right-8 top-1/2 z-20 -translate-y-1/2 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white"
          >
            {navigator.platform.toLowerCase().includes('mac')
              ? '⌃⇧'
              : 'Ctrl+Shift+'}
            {index + 1}
          </span>
        )}
      </button>
      <button
        type="button"
        aria-label={`Move ${vault.name} to group`}
        title={`Move ${vault.name} to group`}
        onClick={(event) =>
          openMenu(
            { kind: 'vault', id: vault.id },
            contextMenuPointForElement(event.currentTarget),
            event.currentTarget,
          )
        }
        className="absolute right-7 z-10 rounded px-1.5 py-1 text-xs text-white/50 opacity-0 hover:bg-white/10 hover:text-white focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        ⋯
      </button>
      <button
        type="button"
        onClick={() => onRemove(vault.id)}
        aria-label={`Remove ${vault.name} from vault list`}
        title={
          vault.id === activeVaultId
            ? 'Switch to another vault before removing'
            : 'Remove from list (files are kept)'
        }
        className="absolute right-1 rounded px-1.5 py-1 text-xs text-white/45 opacity-0 hover:bg-white/10 hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        ×
      </button>
    </li>
  );

  return (
    <aside
      data-pane="vaults"
      tabIndex={-1}
      className="flex min-h-0 w-[176px] shrink-0 flex-col bg-black/70 px-3 pb-3 pt-7 text-white select-none"
      onKeyDown={(event) => {
        if (!vimMode || event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, [contenteditable="true"]')) return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            '[data-vault-row]',
          ),
        );
        const button = target.closest<HTMLButtonElement>('[data-vault-row]');
        const index = button ? buttons.indexOf(button) : -1;
        if (event.key === 'j' || event.key === 'k') {
          event.preventDefault();
          buttons[
            Math.max(
              0,
              Math.min(
                buttons.length - 1,
                index + (event.key === 'j' ? 1 : -1),
              ),
            )
          ]?.focus();
        } else if ((event.key === 'Enter' || event.key === 'l') && button) {
          event.preventDefault();
          onActivate(button.dataset.vaultId ?? '', event.key === 'Enter');
        }
      }}
    >
      <div className="mx-1 mb-2 flex h-9 shrink-0 items-center justify-between border-b border-white/10 px-1">
        <h2 className="text-sm font-semibold text-white/80">Vaults</h2>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              setGroupForm({ name: '', mode: 'choose' });
            }}
            aria-label="Create group"
            title="Create group"
            className="app-icon-button"
          >
            <FaFolderTree aria-hidden="true" size={14} />
          </button>
          <button
            type="button"
            onClick={onAdd}
            aria-label="Add vault"
            title="Add vault"
            className="app-icon-button"
          >
            <FaPlus aria-hidden="true" size={14} />
          </button>
          {collapsed && (
            <button
              type="button"
              onClick={onToggleExplorer}
              aria-label="Show file explorer"
              aria-expanded="false"
              title={`Show file explorer${toggleExplorerShortcut ? ` (${navigator.platform.toLowerCase().includes('mac') ? '⌘S' : 'Ctrl+S'})` : ''}`}
              className="app-icon-button relative"
            >
              <RiMenuUnfold4Fill aria-hidden="true" className="h-3.5 w-3.5" />
              {commandHeld && toggleExplorerShortcut && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white"
                >
                  {navigator.platform.toLowerCase().includes('mac')
                    ? '⌘S'
                    : 'Ctrl+S'}
                </span>
              )}
            </button>
          )}
        </div>
      </div>
      {groupForm && (
        <form
          onSubmit={saveGroup}
          className="app-popup-surface mb-2 p-2"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setGroupForm(null);
            }
          }}
        >
          {!groupForm.id && groupForm.mode === 'choose' ? (
            <>
              <p className="mb-2 text-xs text-white/70">Create a vault group</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setGroupForm({ name: '' });
                  requestAnimationFrame(() => formInput.current?.focus());
                }}
                className="app-popup-row block w-full px-2 py-1 text-left text-xs"
              >
                Empty group
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const selection = await window.vault.groupFolderChoose();
                    if (!selection) return;
                    setGroupForm({
                      mode: 'name',
                      selectionId: selection.selectionId,
                      folderName: selection.name,
                      name: selection.name,
                    });
                    requestAnimationFrame(() => formInput.current?.focus());
                  } catch (cause) {
                    notifyError(
                      cause instanceof Error
                        ? cause.message
                        : 'Unable to select folder',
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                className="app-popup-row block w-full px-2 py-1 text-left text-xs"
              >
                Create from folder…
              </button>
              <button
                type="button"
                onClick={() => setGroupForm(null)}
                className="app-button mt-1 w-full py-1 text-right text-xs text-white/60"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <label className="mb-1 block text-xs text-white/70">
                {groupForm.id
                  ? 'Rename group'
                  : groupForm.folderName
                    ? `Group name (vaults inside “${groupForm.folderName}”)`
                    : 'New group'}
              </label>
              {groupForm.folderName && (
                <p className="mb-2 text-xs text-white/60">
                  Immediate subfolders become vaults; if there are none, the
                  selected folder itself becomes a vault. Already-added vaults
                  will be reassigned to this group.
                </p>
              )}
              <input
                ref={formInput}
                value={groupForm.name}
                onChange={(event) =>
                  setGroupForm({ ...groupForm, name: event.target.value })
                }
                aria-label="Group name"
                maxLength={80}
                className="app-input w-full px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              />
              <div className="mt-1 flex justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setGroupForm(null)}
                  className="app-button px-2 py-1 text-xs text-white/60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy || !groupForm.name.trim()}
                  className="app-button px-2 py-1 text-xs text-white disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </>
          )}
        </form>
      )}
      <ul className="mx-1 min-h-0 flex-1 space-y-0 overflow-y-auto">
        {ungrouped.map((vault) =>
          renderVault(vault, visibleVaults.indexOf(vault)),
        )}
        {groups.map((group) => {
          const members = vaults.filter((vault) => vault.groupId === group.id);
          return (
            <li key={group.id} className="min-w-0">
              <div className="group/header flex min-w-0 items-center rounded-md">
                <button
                  type="button"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openMenu(
                      { kind: 'group', id: group.id },
                      { x: event.clientX, y: event.clientY },
                      event.currentTarget,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event)) {
                      event.preventDefault();
                      openMenu(
                        { kind: 'group', id: group.id },
                        contextMenuPointForElement(event.currentTarget),
                        event.currentTarget,
                      );
                    }
                  }}
                  aria-expanded={!group.collapsed}
                  onClick={() =>
                    void run(() =>
                      window.vault.groupSetCollapsed(
                        group.id,
                        !group.collapsed,
                      ),
                    )
                  }
                  className="flex min-w-0 flex-1 items-center gap-1 truncate rounded px-2 py-1.5 text-left text-xs font-semibold leading-4 text-white/70 hover:text-white"
                >
                  <span className="flex h-4 w-3 shrink-0 items-center justify-center text-base leading-none">
                    {group.collapsed ? '▸' : '▾'}
                  </span>
                  <span
                    aria-hidden="true"
                    className="flex h-4 w-2 shrink-0 items-center justify-center"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor:
                          GROUP_COLORS[
                            group.color ?? groupColorForId(group.id)
                          ],
                      }}
                    />
                  </span>
                  <span className="flex h-4 min-w-0 items-center truncate">
                    {group.name}
                  </span>
                  {members.length > 0 && (
                    <span className="flex h-4 shrink-0 items-center text-xs text-white/35">
                      {members.length}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Group actions for ${group.name}`}
                  title={`Group actions for ${group.name}`}
                  onClick={(event) =>
                    openMenu(
                      { kind: 'group', id: group.id },
                      contextMenuPointForElement(event.currentTarget),
                      event.currentTarget,
                    )
                  }
                  className="rounded px-1 text-white/50 hover:bg-white/10 hover:text-white"
                >
                  ⋯
                </button>
              </div>
              {!group.collapsed && (
                <ul className="ml-2 space-y-0 border-l border-white/10 pl-1">
                  {members.map((vault) =>
                    renderVault(vault, visibleVaults.indexOf(vault)),
                  )}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {menu && (
        <ContextMenu
          position={menu.position}
          items={menuItems}
          returnFocusTo={menu.returnFocusTo}
          onClose={() => setMenu(null)}
          label={
            menu.target.kind === 'group' ? 'Group actions' : 'Move to group'
          }
        />
      )}
      {!error && vaults.length === 0 ? (
        <p className="mt-2 shrink-0 text-xs text-white/40">
          Add a vault to get started.
        </p>
      ) : null}
      <div className="mt-2 shrink-0 border-t border-white/10 pt-2">
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label="Settings"
          aria-haspopup="dialog"
          title="Settings (⌘+,)"
          className="app-icon-button relative focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <IoIosSettings aria-hidden="true" className="h-3.5 w-3.5" />
          {commandHeld && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute bottom-full left-0 z-20 mb-1 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white"
            >
              {navigator.platform.toLowerCase().includes('mac')
                ? '⌘,'
                : 'Ctrl+,'}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
