import { useCallback, useEffect, useRef, useState } from 'react';
import ContextMenu from './ContextMenu';
import type { ContextMenuPosition } from './ContextMenu';
import { contextMenuPointForElement, isContextMenuKey } from './ContextMenu';
import {
  absoluteExplorerPath,
  getExplorerContextMenuItems,
} from './fileExplorerContextMenu';
import { runDirectoryPathAction } from './directoryPathAction';
import { copyPathAction } from './copyPathAction';
import {
  actualPathForOptimisticRename,
  reconcileOptimisticRename,
  remapOptimisticPath,
} from './optimisticRename';
import { FaPlus } from 'react-icons/fa';
import Note from './Note';
import SettingsDialog from './Settings/SettingsDialog';
import type { Appearance } from '../appearance';

function ShortcutHint({
  children,
  visible,
}: {
  children: React.ReactNode;
  visible: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white transition-opacity duration-150 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      {children}
    </span>
  );
}

type FileExplorerProps = {
  onNoteSelect: (path: string, focusEditor?: boolean) => void;
  onImageSelect: (path: string) => void;
  onPdfSelect: (path: string) => void;
  vaultId: string | null;
  onCreate: (kind: 'note' | 'folder', parentPath: string) => void;
  onCreateNote: () => void;
  onDeleteEntry?: (
    path: string,
    kind: 'note' | 'folder' | 'image' | 'pdf',
  ) => void;
  onRenameEntry: (path: string, newName: string) => Promise<void>;
  creationPending: boolean;
  onAddVault: () => void;
  onUnloadAllVaults: () => Promise<boolean>;
  vaultCount: number;
  vaultPath: string | null;
  notes: Awaited<ReturnType<typeof window.vault.listNotes>>;
  loading: boolean;
  error: string | null;
  vimMode: boolean;
  onVimModeChange: (enabled: boolean) => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  openFileShortcut: boolean;
  onOpenFileShortcutChange: (enabled: boolean) => void;
  toggleExplorerShortcut: boolean;
  toggleVaultsShortcut: boolean;
  onToggleVaultsShortcutChange: (enabled: boolean) => void;
  commandHeld: boolean;
  onToggleExplorerShortcutChange: (enabled: boolean) => void;
  selectedPath: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCopyPathError: (message: string) => void;
  onPathCopied: (message: string) => void;
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
};

export default function FileExplorer({
  onNoteSelect,
  onImageSelect,
  onPdfSelect,
  vaultId,
  onCreate,
  onDeleteEntry,
  onRenameEntry,
  creationPending,
  onAddVault,
  onUnloadAllVaults,
  vaultCount,
  vaultPath,
  notes,
  loading,
  error,
  vimMode,
  onVimModeChange,
  settingsOpen,
  onSettingsOpenChange,
  openFileShortcut,
  onOpenFileShortcutChange,
  toggleExplorerShortcut,
  toggleVaultsShortcut,
  onToggleVaultsShortcutChange,
  commandHeld,
  onToggleExplorerShortcutChange,
  selectedPath,
  collapsed,
  onCopyPathError,
  onPathCopied,
  appearance,
  onAppearanceChange,
}: FileExplorerProps) {
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [optimisticRename, setOptimisticRename] = useState<{
    oldPath: string;
    newPath: string;
    committed: boolean;
  } | null>(null);

  useEffect(() => {
    if (!optimisticRename?.committed) return;
    setOptimisticRename(
      reconcileOptimisticRename(
        optimisticRename,
        notes.map((note) => note.path),
      ),
    );
  }, [notes, optimisticRename]);
  const [renameDialog, setRenameDialog] = useState<{
    path: string;
    kind: 'note' | 'folder' | 'image' | 'pdf';
    name: string;
  } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const vaultName = vaultPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;

  useEffect(() => {
    const unsubscribe = window.vault.onSettingsOpen(() =>
      onSettingsOpenChange(true),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        onSettingsOpenChange(true);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onSettingsOpenChange]);

  const closeSettings = useCallback(
    () => onSettingsOpenChange(false),
    [onSettingsOpenChange],
  );
  const [contextMenu, setContextMenu] = useState<{
    position: ContextMenuPosition;
    parent: string;
    target: { path: string; kind: 'note' | 'folder' | 'image' | 'pdf' } | null;
    returnFocusTo: HTMLElement | null;
  } | null>(null);
  const openContextMenu = (
    target: HTMLElement,
    position: ContextMenuPosition,
  ) => {
    const row = target.closest<HTMLElement>('[data-entry-path]');
    const path = row?.dataset.entryPath ?? '';
    const isFolder = row?.dataset.entryDirectory === 'true';
    const entryKind = row?.dataset.entryKind;
    const isImage = entryKind === 'image';
    const isNote = entryKind === 'note';
    const isPdf = entryKind === 'pdf';
    if (
      row &&
      (!path ||
        (!isFolder && !isImage && !isNote && !isPdf) ||
        (isFolder && entryKind !== 'directory'))
    ) {
      setContextMenu(null);
      return;
    }
    const returnFocusTo =
      row?.querySelector<HTMLElement>('button') ??
      target.closest<HTMLElement>('[data-pane="explorer"]');
    setContextMenu({
      position,
      returnFocusTo,
      parent: !path || isFolder ? path : path.split('/').slice(0, -1).join('/'),
      target: path
        ? {
            path,
            kind: isFolder
              ? 'folder'
              : isImage
                ? 'image'
                : isPdf
                  ? 'pdf'
                  : 'note',
          }
        : null,
    });
  };

  return (
    <>
      <aside
        data-pane="explorer"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (isContextMenuKey(event)) {
            const row = (event.target as HTMLElement).closest<HTMLElement>(
              '[data-entry-path]',
            );
            if (row && event.currentTarget.contains(row)) {
              event.preventDefault();
              openContextMenu(row, contextMenuPointForElement(row));
              return;
            }
          }
          if (!vimMode || event.metaKey || event.ctrlKey || event.altKey)
            return;
          const target = event.target as HTMLElement;
          const row = target.closest<HTMLElement>('[data-entry-path]');
          if (!row || !event.currentTarget.contains(row)) return;
          const rows = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              '[data-entry-path]',
            ),
          ).filter((item) => item.querySelector('button'));
          const index = rows.indexOf(row);
          const focusRow = (next: HTMLElement | undefined) =>
            next?.querySelector<HTMLButtonElement>('button')?.focus();
          if (event.key === 'j' || event.key === 'k') {
            event.preventDefault();
            focusRow(rows[index + (event.key === 'j' ? 1 : -1)]);
          } else if (
            event.key === 'h' ||
            event.key === 'l' ||
            event.key === 'Enter'
          ) {
            const button = row.querySelector<HTMLButtonElement>('button');
            if (!button) return;
            if (row.dataset.entryDirectory === 'true') {
              const expanded = button.getAttribute('aria-expanded') === 'true';
              if (
                event.key === 'Enter' ||
                (event.key === 'h' && expanded) ||
                event.key === 'l'
              ) {
                event.preventDefault();
                if (event.key === 'Enter' || event.key === 'l') button.click();
              } else if (event.key === 'h') {
                event.preventDefault();
                focusRow(
                  row.parentElement?.closest<HTMLElement>(
                    '[data-entry-path]',
                  ) ?? undefined,
                );
              }
            } else if (event.key !== 'h') {
              event.preventDefault();
              if (
                row.dataset.entryKind === 'image' ||
                row.dataset.entryKind === 'pdf'
              ) {
                if (event.key === 'Enter')
                  row.querySelector<HTMLButtonElement>('button')?.click();
              } else if (event.key === 'Enter')
                onNoteSelect(row.dataset.entryPath ?? '', true);
              else onNoteSelect(row.dataset.entryPath ?? '', false);
            } else {
              event.preventDefault();
              focusRow(
                row.parentElement?.closest<HTMLElement>('[data-entry-path]') ??
                  undefined,
              );
            }
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openContextMenu(event.target as HTMLElement, {
            x: event.clientX,
            y: event.clientY,
          });
        }}
        className={`${collapsed ? 'hidden' : 'flex'} min-h-0 min-w-[240px] max-w-80 flex-[0_1_24vw] flex-col bg-black/50 p-3 text-white select-none`}
        style={{ width: 'clamp(260px, 24vw, 320px)' }}
      >
        {/* title + fold */}
        <div className="mb-2 flex h-9 shrink-0 flex-row items-center justify-between border-b border-white/10 px-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-sm font-semibold text-white/80">Directory</h1>
            {vaultName && vaultPath && (
              <button
                type="button"
                aria-label="Copy vault path; Command-click to open directory"
                title={`Copy path: ${vaultPath}\nCommand-click to open directory in Finder`}
                onClick={(event) =>
                  void runDirectoryPathAction(event.metaKey, vaultPath, {
                    openDirectory: () => window.vault.openDirectory(),
                    copyPath: (path) => navigator.clipboard.writeText(path),
                    onCopied: () => onPathCopied('copied path to clipboard'),
                    onError: onCopyPathError,
                  })
                }
                className="truncate rounded-sm text-left text-sm text-white/50 hover:text-white/80 hover:underline underline-offset-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/70"
              >
                {vaultName}
              </button>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              ref={addButtonRef}
              aria-label="Add note or folder"
              title="Add note or folder"
              disabled={!vaultPath || creationPending}
              onClick={() => {
                if (!vaultPath || creationPending) return;
                const rect = addButtonRef.current?.getBoundingClientRect();
                if (!rect) return;
                setContextMenu({
                  position: { x: rect.left, y: rect.bottom },
                  returnFocusTo: addButtonRef.current,
                  parent: '',
                  target: null,
                });
              }}
              className="app-icon-button app-icon-button-no-hover-bg relative disabled:cursor-not-allowed disabled:opacity-40"
            >
              <FaPlus aria-hidden="true" size={14} />
              <ShortcutHint visible={commandHeld}>
                {navigator.platform.toLowerCase().includes('mac')
                  ? '⌘N'
                  : 'Ctrl+N'}
              </ShortcutHint>
            </button>
          </div>
        </div>

        {!vaultPath && (
          <p className="text-sm text-white/70">No vault selected.</p>
        )}

        {loading && (
          <p className="mt-4 text-sm text-white/70">Loading notes…</p>
        )}
        {!loading && !error && vaultPath && notes.length === 0 && (
          <p className="mt-4 text-sm text-white/70">No Markdown notes found.</p>
        )}
        <ul className="flex min-h-0 flex-col overflow-y-auto">
          {notes
            .map((entry) => {
              if (!optimisticRename) return entry;
              return {
                ...entry,
                path: remapOptimisticPath(entry.path, optimisticRename),
              };
            })
            .filter((note) => !note.path.split('\\').join('/').includes('/'))
            .map((note) => (
              <Note
                key={note.path}
                entry={note}
                entries={notes}
                depth={0}
                selectedId={selectedPath}
                onNoteClick={onNoteSelect}
                onImageClick={onImageSelect}
                onPdfClick={onPdfSelect}
                vaultId={vaultId}
                appearance={appearance}
              />
            ))}
        </ul>
      </aside>

      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          returnFocusTo={contextMenu.returnFocusTo}
          onClose={() => setContextMenu(null)}
          label={
            contextMenu.target?.kind === 'folder'
              ? 'Add to vault'
              : 'File actions'
          }
          items={getExplorerContextMenuItems(
            contextMenu.target,
            contextMenu.parent,
            onCreate,
            onDeleteEntry,
            (path, kind) =>
              void window.vault
                .openLocation(path, kind)
                .catch((error) =>
                  onCopyPathError(
                    error instanceof Error ? error.message : String(error),
                  ),
                ),
            (entryPath, kind) => {
              const filename = entryPath.split('/').at(-1) ?? entryPath;
              const dot = filename.lastIndexOf('.');
              const initial =
                kind !== 'folder' && dot > 0
                  ? filename.slice(0, dot)
                  : filename;
              setRenameDialog({ path: entryPath, kind, name: initial });
            },
            async (entryPath) => {
              if (!vaultPath) return;
              const actualPath = actualPathForOptimisticRename(
                entryPath,
                optimisticRename,
              );
              const path = absoluteExplorerPath(vaultPath, actualPath);
              await copyPathAction(path, {
                writeText: (value) => navigator.clipboard.writeText(value),
                onCopied: () => onPathCopied('copied path to clipboard'),
                onError: onCopyPathError,
              });
            },
            (entryPath) => onPdfSelect(entryPath),
          )}
        />
      )}
      {renameDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            className="w-full max-w-xs rounded-lg border border-white/15 bg-[#202124] p-4 text-white shadow-xl select-none"
            onSubmit={(event) => {
              event.preventDefault();
              const { path, kind } = renameDialog;
              const filename = path.split('/').at(-1) ?? path;
              const dot = filename.lastIndexOf('.');
              const entered = renameDialog.name.trim();
              const name =
                kind !== 'folder' && dot > 0
                  ? `${entered}${filename.slice(dot)}`
                  : entered;
              setRenameDialog(null);
              if (!name || name === filename || optimisticRename) return;
              const oldPath = path.split('\\\\').join('/');
              const newPath = `${oldPath.split('/').slice(0, -1).join('/')}${oldPath.includes('/') ? '/' : ''}${name}`;
              setOptimisticRename({ oldPath, newPath, committed: false });
              void onRenameEntry(path, name)
                .then(() =>
                  setOptimisticRename((current) =>
                    current ? { ...current, committed: true } : null,
                  ),
                )
                .catch((error) => {
                  setOptimisticRename(null);
                  onCopyPathError(
                    error instanceof Error ? error.message : String(error),
                  );
                });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setRenameDialog(null);
              }
            }}
          >
            <h2 id="rename-title" className="mb-3 text-sm font-semibold">
              Rename
            </h2>
            <label className="block text-xs">
              Name
              <input
                ref={renameInputRef}
                autoFocus
                value={renameDialog.name}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) =>
                  setRenameDialog({ ...renameDialog, name: event.target.value })
                }
                className="mt-1 w-full rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm select-text"
              />
            </label>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="px-2 py-1 text-xs"
                onClick={() => setRenameDialog(null)}
              >
                Cancel
              </button>
              <button className="rounded bg-blue-600 px-2 py-1 text-xs">
                Rename
              </button>
            </div>
          </form>
        </div>
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={closeSettings}
          vaultPath={vaultPath}
          vaultCount={vaultCount}
          loading={loading}
          onAddVault={onAddVault}
          onUnloadAllVaults={onUnloadAllVaults}
          vimMode={vimMode}
          onVimModeChange={onVimModeChange}
          openFileShortcut={openFileShortcut}
          onOpenFileShortcutChange={onOpenFileShortcutChange}
          toggleExplorerShortcut={toggleExplorerShortcut}
          onToggleExplorerShortcutChange={onToggleExplorerShortcutChange}
          toggleVaultsShortcut={toggleVaultsShortcut}
          onToggleVaultsShortcutChange={onToggleVaultsShortcutChange}
          appearance={appearance}
          onAppearanceChange={onAppearanceChange}
        />
      )}
    </>
  );
}
