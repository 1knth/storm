import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ContextMenu from './ContextMenu';
import type { ContextMenuPosition } from './ContextMenu';
import { contextMenuPointForElement, isContextMenuKey } from './ContextMenu';
import { FaPlus } from 'react-icons/fa';
import { RiMenuUnfold4Fill } from 'react-icons/ri';
import Note from './Note';
import { DEFAULT_APPEARANCE } from '../appearance';
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
  onCreate: (kind: 'note' | 'folder', parentPath: string) => void;
  onCreateNote: () => void;
  onDeleteEntry?: (path: string, kind: 'note' | 'folder') => void;
  creationPending: boolean;
  onAddVault: () => void;
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
  onCreate,
  onDeleteEntry,
  creationPending,
  onAddVault,
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
      if (event.key === 'Escape') onSettingsOpenChange(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onSettingsOpenChange]);

  useEffect(() => {
    if (settingsOpen) changeVaultRef.current?.focus();
  }, [settingsOpen]);

  const chooseVault = () => onAddVault();
  const [contextMenu, setContextMenu] = useState<{
    position: ContextMenuPosition;
    parent: string;
    target: { path: string; kind: 'note' | 'folder' } | null;
    returnFocusTo: HTMLElement | null;
  } | null>(null);
  const openContextMenu = (
    target: HTMLElement,
    position: ContextMenuPosition,
  ) => {
    const row = target.closest<HTMLElement>('[data-entry-path]');
    const path = row?.dataset.entryPath ?? '';
    const isFolder = row?.dataset.entryDirectory === 'true';
    const returnFocusTo =
      row?.querySelector<HTMLElement>('button') ??
      target.closest<HTMLElement>('[data-pane="explorer"]');
    setContextMenu({
      position,
      returnFocusTo,
      parent: !path || isFolder ? path : path.split('/').slice(0, -1).join('/'),
      target: path ? { path, kind: isFolder ? 'folder' : 'note' } : null,
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
                (event.key === 'l' && !expanded)
              ) {
                event.preventDefault();
                if (event.key === 'Enter') button.click();
                else if (!expanded) button.click();
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
              if (event.key === 'Enter')
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
          <div className="flex items-center gap-1">
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
              className="app-icon-button relative disabled:cursor-not-allowed disabled:opacity-40"
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
              className="app-icon-button relative"
            >
              <RiMenuUnfold4Fill aria-hidden="true" className="h-3.5 w-3.5" />
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
              />
            ))}
        </ul>
      </aside>

      {contextMenu && (
        <ContextMenu
          position={contextMenu.position}
          returnFocusTo={contextMenu.returnFocusTo}
          onClose={() => setContextMenu(null)}
          label="Add to vault"
          items={[
            ...(['note', 'folder'] as const).map((kind) => ({
              id: `new-${kind}`,
              label: `New ${kind}`,
              onSelect: () => onCreate(kind, contextMenu.parent),
            })),
            ...(contextMenu.target && onDeleteEntry
              ? [
                  { type: 'separator' as const, id: 'entry-actions' },
                  {
                    id: 'delete-entry',
                    label: `Move ${contextMenu.target.kind} to Trash…`,
                    danger: true,
                    onSelect: () =>
                      onDeleteEntry(
                        contextMenu.target!.path,
                        contextMenu.target!.kind,
                      ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {settingsOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget)
                onSettingsOpenChange(false);
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
              className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#202124] p-6 text-white shadow-2xl"
            >
              <div className="mb-6 flex items-center justify-between">
                <h2 id="settings-title" className="text-lg font-semibold">
                  Settings
                </h2>
                <button
                  type="button"
                  aria-label="Close settings"
                  onClick={() => onSettingsOpenChange(false)}
                  className="rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white"
                >
                  ×
                </button>
              </div>
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
                <>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium">Vault</p>
                      <p className="mt-1 max-w-[15rem] break-all text-xs text-white/50">
                        {vaultPath ?? 'No vault selected'}
                      </p>
                    </div>
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
                  <label className="mt-6 flex cursor-pointer items-center justify-between gap-4">
                    <span>
                      <span className="block font-medium">Vim keybindings</span>
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
                  <div className="mt-6 space-y-4 border-t border-white/10 pt-4">
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
                  </div>
                </>
              )}
              {settingsTab === 'appearance' && (
                <div className="max-h-[65vh] space-y-2 overflow-y-auto">
                  <p className="mb-3 text-sm text-white/60">
                    Editor, preview, and diagram colors
                  </p>
                  <p className="text-sm font-semibold">Appearance</p>
                  <label className="flex items-center justify-between gap-3 text-xs text-white/80">
                    UI theme
                    <select
                      aria-label="UI theme"
                      className="app-input px-2 py-1"
                      value={appearance.theme}
                      onChange={(event) =>
                        onAppearanceChange({
                          ...appearance,
                          theme: event.target.value as 'dark' | 'light',
                        })
                      }
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </label>
                  {(
                    [
                      ['Selection highlight', 'selection'],
                      ['Cursor', 'cursor'],
                      ...appearance.headings.map((_, i) => [
                        `Heading ${i + 1}`,
                        `heading-${i + 1}`,
                      ]),
                      ['Mermaid background', 'mermaidBackground'],
                      ['Mermaid node fill', 'mermaidNodeFill'],
                      ['Mermaid node border', 'mermaidNodeBorder'],
                      ['Mermaid text', 'mermaidText'],
                      ['Mermaid connectors', 'mermaidConnectors'],
                    ] as [string, string][]
                  ).map(([label, key]) => {
                    const value = key.startsWith('heading-')
                      ? appearance.headings[Number(key.slice(8)) - 1]
                      : (appearance[key as keyof typeof appearance] as string);
                    return (
                      <label
                        key={key}
                        className="flex items-center justify-between gap-3 text-xs text-white/80"
                      >
                        {label}
                        <span className="flex items-center gap-2">
                          <input
                            aria-label={label}
                            type="color"
                            value={value}
                            onChange={(event) => {
                              const next = key.startsWith('heading-')
                                ? {
                                    ...appearance,
                                    headings: appearance.headings.map(
                                      (color, i) =>
                                        i === Number(key.slice(8)) - 1
                                          ? event.target.value
                                          : color,
                                    ),
                                  }
                                : { ...appearance, [key]: event.target.value };
                              onAppearanceChange(next);
                            }}
                          />
                          <input
                            aria-label={`${label} opacity`}
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            className="app-input w-16 px-1 py-1"
                            value={appearance.opacity[key]}
                            onChange={(event) =>
                              onAppearanceChange({
                                ...appearance,
                                opacity: {
                                  ...appearance.opacity,
                                  [key]: Math.max(
                                    0,
                                    Math.min(100, Number(event.target.value)),
                                  ),
                                },
                              })
                            }
                          />
                          <span>%</span>
                        </span>
                      </label>
                    );
                  })}
                  <button
                    type="button"
                    className="app-button text-xs"
                    onClick={() => onAppearanceChange(DEFAULT_APPEARANCE)}
                  >
                    Reset appearance
                  </button>
                </div>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
