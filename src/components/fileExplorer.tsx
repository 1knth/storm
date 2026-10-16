import { useEffect, useRef, useState } from 'react';
import { RiMenuUnfold4Fill } from 'react-icons/ri';
import Note from './Note';

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
      className={`pointer-events-none absolute left-1/2 top-full z-20 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[10px] leading-none text-white transition-opacity duration-150 ${visible ? 'opacity-100' : 'opacity-0'}`}
    >
      {children}
    </span>
  );
}

type FileExplorerProps = {
  onNoteSelect: (path: string) => void;
  onVaultChange: () => void;
  onVaultPath: (path: string) => void;
  beforeVaultChange: () => Promise<boolean>;
  vimMode: boolean;
  onVimModeChange: (enabled: boolean) => void;
  openFileShortcut: boolean;
  onOpenFileShortcutChange: (enabled: boolean) => void;
  toggleExplorerShortcut: boolean;
  commandHeld: boolean;
  onToggleExplorerShortcutChange: (enabled: boolean) => void;
  selectedPath: string | null;
  onNotesChange: (
    notes: Awaited<ReturnType<typeof window.vault.listNotes>>,
  ) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
};

export default function FileExplorer({
  onNoteSelect,
  onVaultChange,
  onVaultPath,
  beforeVaultChange,
  vimMode,
  onVimModeChange,
  openFileShortcut,
  onOpenFileShortcutChange,
  toggleExplorerShortcut,
  commandHeld,
  onToggleExplorerShortcutChange,
  selectedPath,
  onNotesChange,
  collapsed,
  onToggleCollapsed,
}: FileExplorerProps) {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [notes, setNotes] = useState<
    Awaited<ReturnType<typeof window.vault.listNotes>>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const changeVaultRef = useRef<HTMLButtonElement>(null);
  const vaultName = vaultPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;

  useEffect(() => {
    const unsubscribe = window.vault.onSettingsOpen(() =>
      setSettingsOpen(true),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (event.key === 'Escape') setSettingsOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    if (settingsOpen) changeVaultRef.current?.focus();
    else settingsButtonRef.current?.focus();
  }, [settingsOpen]);

  const chooseVault = async () => {
    setError(null);
    try {
      if (!(await beforeVaultChange())) return;
      const selectedPath = await window.vault.choose();
      if (!selectedPath) return;
      onVaultChange();
      onVaultPath(selectedPath);
      setVaultPath(selectedPath);
      setLoading(true);
      const listedNotes = await window.vault.listNotes();
      setNotes(listedNotes);
      onNotesChange(listedNotes);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to load vault');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <aside
        className={`${collapsed ? 'hidden' : 'flex'} h-full w-80 shrink-0 flex-col rounded-2xl bg-black/50 p-4 text-white select-none`}
      >
        {/* title + fold */}
        <div className="flex flex-row items-center justify-between pb-4">
          <div className="flex min-w-0 items-baseline gap-2">
            <h1 className="text-xl font-bold">Directory</h1>
            {vaultName && (
              <span
                className="truncate text-sm text-white/50"
                title={vaultPath ?? undefined}
              >
                {vaultName}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Hide file explorer"
              title="Hide file explorer (⌘/Ctrl+B)"
              onClick={onToggleCollapsed}
              className="relative rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              <RiMenuUnfold4Fill aria-hidden="true" />
              <ShortcutHint visible={commandHeld && toggleExplorerShortcut}>
                {navigator.platform.toLowerCase().includes('mac')
                  ? '⌘B'
                  : 'Ctrl+B'}
              </ShortcutHint>
            </button>
            <button
              ref={settingsButtonRef}
              type="button"
              aria-label="Open settings"
              title="Open settings (⌘+,)"
              onClick={() => setSettingsOpen(true)}
              className="relative rounded-md p-1 text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
            >
              <ShortcutHint visible={commandHeld}>
                {navigator.platform.toLowerCase().includes('mac')
                  ? '⌘,'
                  : 'Ctrl+,'}
              </ShortcutHint>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5Z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m19.4 15 .08.08a1.75 1.75 0 1 1-2.47 2.47l-.08-.08a1.75 1.75 0 0 0-2.98 1.24v.23a1.75 1.75 0 1 1-3.5 0v-.12a1.75 1.75 0 0 0-2.98-1.24l-.08.08a1.75 1.75 0 1 1-2.47-2.47l.08-.08a1.75 1.75 0 0 0-1.24-2.98h-.23a1.75 1.75 0 1 1 0-3.5h.12a1.75 1.75 0 0 0 1.24-2.98l-.08-.08a1.75 1.75 0 1 1 2.47-2.47l.08.08a1.75 1.75 0 0 0 2.98-1.24v-.23a1.75 1.75 0 1 1 3.5 0v.12a1.75 1.75 0 0 0 2.98 1.24l.08-.08a1.75 1.75 0 1 1 2.47 2.47l-.08.08a1.75 1.75 0 0 0 1.24 2.98h.23a1.75 1.75 0 1 1 0 3.5h-.12A1.75 1.75 0 0 0 19.4 15Z"
                />
              </svg>
            </button>
          </div>
        </div>

        {!vaultPath ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <button
              type="button"
              onClick={chooseVault}
              disabled={loading}
              className="rounded-lg bg-white/10 px-3 py-2 hover:bg-white/20 disabled:opacity-50"
            >
              Open vault
            </button>
            <p className="text-sm text-white/70">No vault selected.</p>
          </div>
        ) : (
          <></>
        )}

        {loading && (
          <p className="mt-4 text-sm text-white/70">Loading notes…</p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-red-300">
            {error}
          </p>
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
      {settingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false);
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
                onClick={() => setSettingsOpen(false)}
                className="rounded-md px-2 py-1 text-white/60 hover:bg-white/10 hover:text-white"
              >
                ×
              </button>
            </div>
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
                onClick={async () => {
                  await chooseVault();
                  setSettingsOpen(false);
                }}
                disabled={loading}
                className="shrink-0 rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white disabled:opacity-50"
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
                onChange={(event) => onVimModeChange(event.target.checked)}
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
                    ⌘/Ctrl + B
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
              <p className="text-xs text-white/50">Open settings: ⌘ + ,</p>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
