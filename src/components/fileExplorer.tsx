import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ContextMenu from './ContextMenu';
import type { ContextMenuPosition } from './ContextMenu';
import { contextMenuPointForElement, isContextMenuKey } from './ContextMenu';
import { getExplorerContextMenuItems } from './fileExplorerContextMenu';
import { FaPlus } from 'react-icons/fa';
import { TbLayoutSidebarRightFilled } from 'react-icons/tb';
import Note from './Note';
import { commitOpacityDraft, DEFAULT_APPEARANCE } from '../appearance';
import type { Appearance } from '../appearance';

function OpacityInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = commitOpacityDraft(draft, value);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      aria-label={`${label} opacity`}
      type="text"
      inputMode="decimal"
      className="app-input w-16 px-1 py-1"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

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
  vaultId: string | null;
  onCreate: (kind: 'note' | 'folder', parentPath: string) => void;
  onCreateNote: () => void;
  onDeleteEntry?: (path: string, kind: 'note' | 'folder' | 'image') => void;
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
  vaultId,
  onCreate,
  onDeleteEntry,
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
  commandHeld,
  onToggleExplorerShortcutChange,
  selectedPath,
  collapsed,
  onToggleCollapsed,
  onCopyPathError,
  onPathCopied,
  appearance,
  onAppearanceChange,
}: FileExplorerProps) {
  const changeVaultRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const [settingsTab, setSettingsTab] = useState<'general' | 'appearance'>(
    'general',
  );
  const [confirmUnload, setConfirmUnload] = useState(false);
  const [unloading, setUnloading] = useState(false);
  const [cliAvailable, setCliAvailable] = useState(false);
  const [cliInstalled, setCliInstalled] = useState(false);
  const [cliBusy, setCliBusy] = useState(false);
  const [canOpenFilesAndFoldersSettings, setCanOpenFilesAndFoldersSettings] =
    useState(false);
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
      if (event.key === 'Escape' && !unloading) {
        if (confirmUnload) setConfirmUnload(false);
        else onSettingsOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [confirmUnload, onSettingsOpenChange, unloading]);

  useEffect(() => {
    void window.vault.cliAvailable().then(setCliAvailable);
    void window.vault.cliInstalled().then(setCliInstalled);
    void window.vault
      .canOpenFilesAndFoldersSettings()
      .then(setCanOpenFilesAndFoldersSettings);
  }, []);

  useEffect(() => {
    if (settingsOpen) changeVaultRef.current?.focus();
  }, [settingsOpen]);

  const chooseVault = () => onAddVault();
  const [contextMenu, setContextMenu] = useState<{
    position: ContextMenuPosition;
    parent: string;
    target: { path: string; kind: 'note' | 'folder' | 'image' } | null;
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
    if (
      row &&
      (!path ||
        (!isFolder && !isImage && !isNote) ||
        (isFolder && entryKind !== 'directory'))
    ) {
      setContextMenu(null);
      return;
    }
    if (row && !isFolder && !onDeleteEntry) {
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
        ? { path, kind: isFolder ? 'folder' : isImage ? 'image' : 'note' }
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
              if (row.dataset.entryKind === 'image') {
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
                aria-label="Copy vault path"
                title={`Copy path: ${vaultPath}`}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(vaultPath);
                    onPathCopied('copied path to clipboard');
                  } catch (error) {
                    onCopyPathError(
                      `Could not copy vault path: ${error instanceof Error ? error.message : String(error)}`,
                    );
                  }
                }}
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
            <button
              type="button"
              aria-label="Hide file explorer"
              title="Hide file explorer (⌘/Ctrl+S)"
              onClick={onToggleCollapsed}
              className="app-icon-button app-icon-button-no-hover-bg relative"
            >
              <TbLayoutSidebarRightFilled
                aria-hidden="true"
                className="!h-[14px] !w-[14px]"
              />
              <ShortcutHint visible={commandHeld && toggleExplorerShortcut}>
                {navigator.platform.toLowerCase().includes('mac')
                  ? '⌘S'
                  : 'Ctrl+S'}
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
                vaultId={vaultId}
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
          )}
        />
      )}
      {settingsOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !unloading)
                onSettingsOpenChange(false);
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              className="flex max-h-[calc(75dvh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#202124] p-5 text-white shadow-2xl"
            >
              <div className="mb-4 flex shrink-0 items-center justify-between">
                <h2 id="settings-title" className="text-lg font-semibold">
                  Settings
                </h2>
                <button
                  type="button"
                  aria-label="Close settings"
                  disabled={unloading}
                  onClick={() => onSettingsOpenChange(false)}
                  className="rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white"
                >
                  ×
                </button>
              </div>
              <div className="min-h-0 overflow-y-auto pr-1">
                {confirmUnload && (
                  <div
                    className="mb-5 rounded-xl border border-red-400/30 bg-red-500/5 p-4"
                    role="alertdialog"
                    aria-labelledby="unload-title"
                    aria-describedby="unload-description"
                  >
                    <h3 id="unload-title" className="font-semibold">
                      Unload all vaults?
                    </h3>
                    <p
                      id="unload-description"
                      className="mt-2 text-sm text-white/70"
                    >
                      This closes all vaults and tabs and clears saved vault
                      registrations, groups, and tab layouts. It does not delete
                      or modify any folders or notes.
                    </p>
                    <div className="mt-4 flex justify-end gap-2">
                      <button
                        type="button"
                        disabled={unloading}
                        onClick={() => setConfirmUnload(false)}
                        className="rounded-lg px-3 py-2 text-sm text-white/70 hover:bg-white/10"
                      >
                        Cancel
                      </button>
                      <button
                        autoFocus
                        type="button"
                        disabled={unloading}
                        onClick={async () => {
                          setUnloading(true);
                          try {
                            const unloaded = await onUnloadAllVaults();
                            if (unloaded) {
                              setConfirmUnload(false);
                              onSettingsOpenChange(false);
                            }
                          } finally {
                            setUnloading(false);
                          }
                        }}
                        className="rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-100 hover:bg-red-500/30 disabled:opacity-50"
                      >
                        {unloading ? 'Unloading…' : 'Unload all vaults'}
                      </button>
                    </div>
                  </div>
                )}
                <div
                  role="tablist"
                  aria-label="Settings"
                  className="mb-5 flex gap-2 border-b border-white/10"
                >
                  {(['general', 'appearance'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      role="tab"
                      aria-selected={settingsTab === tab}
                      onClick={() => setSettingsTab(tab)}
                      className={`px-3 py-2 text-sm capitalize ${settingsTab === tab ? 'border-b-2 border-blue-400 text-white' : 'text-white/60'}`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>
                {settingsTab === 'general' && (
                  <div className="space-y-5">
                    <fieldset className="space-y-3">
                      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/50">
                        Vaults
                      </legend>
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <p className="font-medium">Vault</p>
                          <p className="mt-1 max-w-[15rem] break-all text-xs text-white/50">
                            {vaultPath ?? 'No vault selected'}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <div className="flex flex-col items-end gap-2">
                            <button
                              ref={changeVaultRef}
                              type="button"
                              onClick={() => {
                                chooseVault();
                                onSettingsOpenChange(false);
                              }}
                              disabled={loading}
                              className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20 disabled:opacity-50"
                            >
                              Change vault
                            </button>
                          </div>
                          <button
                            type="button"
                            disabled={vaultCount === 0 || unloading}
                            onClick={() => setConfirmUnload(true)}
                            className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-100 hover:bg-red-500/25 disabled:opacity-50"
                          >
                            Unload all vaults…
                          </button>
                        </div>
                      </div>
                      <div className="-mt-1 flex items-center justify-between gap-4">
                        <p className="max-w-[20rem] text-xs text-white/50">
                          If access failed, choose that folder again. macOS
                          controls Files &amp; Folders prompts; Storm cannot
                          force one to appear.
                        </p>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <button
                            type="button"
                            onClick={chooseVault}
                            disabled={loading}
                            title="Choose the vault folder again to request access. macOS controls any Files & Folders prompts."
                            className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20 disabled:opacity-50"
                          >
                            Request folder access…
                          </button>
                          {canOpenFilesAndFoldersSettings && (
                            <button
                              type="button"
                              onClick={() =>
                                void window.vault
                                  .openFilesAndFoldersSettings()
                                  .catch((error: unknown) =>
                                    console.error(
                                      'Could not open Files & Folders settings',
                                      error,
                                    ),
                                  )
                              }
                              className="text-right text-xs text-white/60 underline underline-offset-2 hover:text-white"
                            >
                              Still blocked? Open Files &amp; Folders settings
                            </button>
                          )}
                        </div>
                      </div>
                    </fieldset>
                    {cliAvailable && (
                      <fieldset className="space-y-3 border-t border-white/10 pt-3">
                        <legend className="text-xs font-semibold uppercase tracking-wide text-white/50">
                          CLI
                        </legend>
                        <div className="flex items-center justify-between gap-4">
                          <div>
                            <p className="font-medium">Storm CLI</p>
                            <p className="mt-1 text-xs text-white/50">
                              Create a terminal command shortcut for the bundled
                              CLI.
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={cliBusy}
                            onClick={() => {
                              setCliBusy(true);
                              const operation = cliInstalled
                                ? window.vault.disableCli()
                                : window.vault.enableCli();
                              void operation
                                .then(setCliInstalled)
                                .catch((error: unknown) =>
                                  console.error(
                                    'Could not change Storm CLI state',
                                    error,
                                  ),
                                )
                                .finally(() => {
                                  void window.vault
                                    .cliInstalled()
                                    .then(setCliInstalled)
                                    .catch((error: unknown) =>
                                      console.error(
                                        'Could not refresh Storm CLI state',
                                        error,
                                      ),
                                    )
                                    .finally(() => setCliBusy(false));
                                });
                            }}
                            className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20 disabled:opacity-50"
                          >
                            {cliInstalled ? 'Disable' : 'Enable'}
                          </button>
                        </div>
                      </fieldset>
                    )}
                    <fieldset className="space-y-3 border-t border-white/10 pt-3">
                      <legend className="text-xs font-semibold uppercase tracking-wide text-white/50">
                        Editor
                      </legend>
                      <label className="flex cursor-pointer items-center justify-between gap-4">
                        <span>
                          <span className="block font-medium">
                            Vim keybindings
                          </span>
                          <span className="mt-1 block text-xs text-white/50">
                            Use Esc for normal mode and i to insert.
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={vimMode}
                          onChange={(event) =>
                            onVimModeChange(event.target.checked)
                          }
                          className="h-4 w-4 accent-blue-500"
                        />
                      </label>
                    </fieldset>
                    <fieldset className="space-y-4 border-t border-white/10 pt-3">
                      <legend className="text-xs font-semibold uppercase tracking-wide text-white/50">
                        Keyboard shortcuts
                      </legend>
                      <label className="flex cursor-pointer items-center justify-between gap-4">
                        <span>
                          <span className="block text-sm font-medium">
                            Open file shortcut
                          </span>
                          <span className="mt-1 block text-xs text-white/50">
                            ⌘/Ctrl + P
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={openFileShortcut}
                          onChange={(event) =>
                            onOpenFileShortcutChange(event.target.checked)
                          }
                          className="h-4 w-4 accent-blue-500"
                        />
                      </label>
                      <label className="flex cursor-pointer items-center justify-between gap-4">
                        <span>
                          <span className="block text-sm font-medium">
                            Toggle file explorer shortcut
                          </span>
                          <span className="mt-1 block text-xs text-white/50">
                            ⌘/Ctrl + S
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={toggleExplorerShortcut}
                          onChange={(event) =>
                            onToggleExplorerShortcutChange(event.target.checked)
                          }
                          className="h-4 w-4 accent-blue-500"
                        />
                      </label>
                      <p className="text-xs text-white/50">
                        Open settings: ⌘ + ,
                      </p>
                    </fieldset>
                  </div>
                )}
                {settingsTab === 'appearance' && (
                  <div className="space-y-4">
                    <p className="mb-3 text-sm text-white/60">
                      Fine-tune editor highlights, Mermaid diagrams, and charts.
                    </p>
                    {(
                      [
                        [
                          'Editor',
                          [
                            ['Selection highlight', 'selection'],
                            ['Active line', 'activeLine'],
                            ['Cursor', 'cursor'],
                            ...appearance.headings.map((_, i) => [
                              `Heading ${i + 1}`,
                              `heading-${i + 1}`,
                            ]),
                          ],
                        ],
                        [
                          'Mermaid · canvas & nodes',
                          [
                            ['Background', 'mermaidBackground'],
                            ['Node fill', 'mermaidNodeFill'],
                            ['Node border', 'mermaidNodeBorder'],
                            ['Group fill', 'mermaidGroupFill'],
                            ['Group border', 'mermaidGroupBorder'],
                            ['Group text', 'mermaidGroupText'],
                            ['Diagram text', 'mermaidText'],
                          ],
                        ],
                        [
                          'Mermaid · connectors & sequence',
                          [
                            ['Diagram connectors', 'mermaidConnectors'],
                            ['Sequence arrows & lines', 'mermaidSignalColor'],
                          ],
                        ],
                        [
                          'Charts',
                          [
                            ['Text & labels', 'chartText'],
                            ['Grid lines', 'chartGrid'],
                            ...appearance.chartSeries.map((_, i) => [
                              `Series ${i + 1}`,
                              `chartSeries-${i + 1}`,
                            ]),
                          ],
                        ],
                      ] as [string, [string, string][]][]
                    ).map(([group, colors]) => (
                      <fieldset
                        key={group}
                        className="space-y-2 border-t border-white/10 pt-3 first:border-0 first:pt-0"
                      >
                        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/55">
                          {group}
                        </legend>
                        {colors.map(([label, key]) => {
                          const headingIndex = key.startsWith('heading-')
                            ? Number(key.slice(8)) - 1
                            : -1;
                          const seriesIndex = key.startsWith('chartSeries-')
                            ? Number(key.slice(12)) - 1
                            : -1;
                          const value =
                            headingIndex >= 0
                              ? appearance.headings[headingIndex]
                              : seriesIndex >= 0
                                ? appearance.chartSeries[seriesIndex]
                                : (appearance[
                                    key as keyof typeof appearance
                                  ] as string);
                          return (
                            <div
                              key={key}
                              className="grid grid-cols-[1fr_auto] items-center gap-3 text-xs text-white/80"
                            >
                              <label htmlFor={`appearance-${key}`}>
                                {label}
                              </label>
                              <span className="flex items-center gap-2">
                                <input
                                  id={`appearance-${key}`}
                                  aria-label={label}
                                  type="color"
                                  style={{ colorScheme: 'dark' }}
                                  value={value}
                                  onChange={(event) => {
                                    const next =
                                      headingIndex >= 0
                                        ? {
                                            ...appearance,
                                            headings: appearance.headings.map(
                                              (color, i) =>
                                                i === headingIndex
                                                  ? event.target.value
                                                  : color,
                                            ),
                                          }
                                        : seriesIndex >= 0
                                          ? {
                                              ...appearance,
                                              chartSeries:
                                                appearance.chartSeries.map(
                                                  (color, i) =>
                                                    i === seriesIndex
                                                      ? event.target.value
                                                      : color,
                                                ),
                                            }
                                          : {
                                              ...appearance,
                                              [key]: event.target.value,
                                            };
                                    onAppearanceChange(next);
                                  }}
                                />
                                <OpacityInput
                                  label={label}
                                  value={appearance.opacity[key]}
                                  onCommit={(value) =>
                                    onAppearanceChange({
                                      ...appearance,
                                      opacity: {
                                        ...appearance.opacity,
                                        [key]: value,
                                      },
                                    })
                                  }
                                />
                                <span>%</span>
                              </span>
                            </div>
                          );
                        })}
                      </fieldset>
                    ))}
                    <button
                      type="button"
                      className="app-button text-xs"
                      onClick={() => onAppearanceChange(DEFAULT_APPEARANCE)}
                    >
                      Reset appearance
                    </button>
                  </div>
                )}
              </div>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
