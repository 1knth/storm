import React, { useEffect, useRef, useState } from 'react';
import './index.css';
import { createRoot } from 'react-dom/client';
import FileExplorer from './components/fileExplorer';
import Editor from './components/Editor/Editor';
import type { EditorHandle, TabSnapshot } from './components/Editor/Editor';
import TabBar from './components/Editor/TabBar';
import { RiMenuUnfold4Fill } from 'react-icons/ri';

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

function App() {
  const editorRef = useRef<EditorHandle>(null);
  const navigationBusy = useRef(false);
  const [tabs, setTabs] = useState<TabSnapshot[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [commandHeld, setCommandHeld] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<
    Awaited<ReturnType<typeof window.vault.listNotes>>
  >([]);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const pickerInputRef = useRef<HTMLInputElement>(null);
  const pickerInvokerRef = useRef<HTMLElement | null>(null);
  const [vimMode, setVimMode] = useState(() => {
    try {
      return window.localStorage.getItem('storm.vimMode') === 'true';
    } catch {
      return false;
    }
  });
  const [openFileShortcut, setOpenFileShortcut] = useState(() => {
    try {
      return window.localStorage.getItem('storm.shortcut.openFile') !== 'false';
    } catch {
      return true;
    }
  });
  const [toggleExplorerShortcut, setToggleExplorerShortcut] = useState(() => {
    try {
      return (
        window.localStorage.getItem('storm.shortcut.toggleExplorer') !== 'false'
      );
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('storm.vimMode', String(vimMode));
    } catch {
      /* Optional preference. */
    }
  }, [vimMode]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'storm.shortcut.openFile',
        String(openFileShortcut),
      );
      window.localStorage.setItem(
        'storm.shortcut.toggleExplorer',
        String(toggleExplorerShortcut),
      );
    } catch {
      /* Optional preference. */
    }
    window.vault.setShortcutEnabled('openFile', openFileShortcut);
    window.vault.setShortcutEnabled('toggleExplorer', toggleExplorerShortcut);
  }, [openFileShortcut, toggleExplorerShortcut]);
  useEffect(() => {
    const updateModifier = (event: KeyboardEvent) =>
      setCommandHeld(
        navigator.platform.toLowerCase().includes('mac')
          ? event.metaKey
          : event.ctrlKey,
      );
    const clearModifier = () => setCommandHeld(false);
    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    window.addEventListener('blur', clearModifier);
    document.addEventListener('visibilitychange', clearModifier);
    return () => {
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
      window.removeEventListener('blur', clearModifier);
      document.removeEventListener('visibilitychange', clearModifier);
    };
  }, []);
  useEffect(() => {
    const unsubscribeOpen = window.vault.onOpenFile(() => {
      pickerInvokerRef.current = document.activeElement as HTMLElement;
      setPickerOpen(true);
    });
    const unsubscribeToggle = window.vault.onToggleExplorer(() =>
      setExplorerCollapsed((collapsed) => !collapsed),
    );
    return () => {
      unsubscribeOpen();
      unsubscribeToggle();
    };
  }, []);

  useEffect(() => {
    if (!pickerOpen) {
      pickerInvokerRef.current?.focus();
      return;
    }
    setQuery('');
    setHighlightedIndex(0);
    requestAnimationFrame(() => pickerInputRef.current?.focus());
  }, [pickerOpen]);

  const matchingNotes = notes
    .filter((note) => !note.isDirectory)
    .filter((note) =>
      note.path.toLowerCase().includes(query.trim().toLowerCase()),
    );

  useEffect(() => {
    if (!pickerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPickerOpen(false);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((index) =>
          Math.min(index + 1, matchingNotes.length - 1),
        );
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === 'Enter' && matchingNotes[highlightedIndex]) {
        event.preventDefault();
        void selectNote(matchingNotes[highlightedIndex].path).then(() =>
          setPickerOpen(false),
        );
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pickerOpen, matchingNotes, highlightedIndex]);

  useEffect(
    () =>
      window.vault.onShutdownFlush((id) => {
        void (async () => {
          let ok = false;
          try {
            ok = (await editorRef.current?.flush()) ?? true;
          } catch {
            ok = false;
          }
          await window.vault.acknowledgeShutdownFlush(id, ok).catch(() => {});
        })();
      }),
    [],
  );

  const selectNote = async (path: string) => {
    if (navigationBusy.current || path === activePath || !vaultPath) return;
    navigationBusy.current = true;
    try {
      if (!(await editorRef.current?.flush())) return;
      const outgoing = editorRef.current?.snapshot();
      if (outgoing)
        setTabs((old) =>
          old.map((tab) =>
            tab.note.path === outgoing.note.path ? outgoing : tab,
          ),
        );
      const existing = tabs.find((tab) => tab.note.path === path);
      if (existing) {
        editorRef.current?.activate(existing);
        setActivePath(path);
        return;
      }
      const note = await window.vault.readNote(path);
      editorRef.current?.openNote(note, vaultPath);
      const fresh = editorRef.current?.snapshot();
      if (fresh)
        setTabs((old) => [
          ...old.filter((tab) => tab.note.path !== path),
          fresh,
        ]);
      setActivePath(path);
    } catch (error) {
      console.error('Unable to open note', error);
    } finally {
      navigationBusy.current = false;
    }
  };

  const closeTab = async (path: string) => {
    if (navigationBusy.current) return;
    if (path !== activePath) {
      setTabs((old) => old.filter((tab) => tab.note.path !== path));
      return;
    }
    navigationBusy.current = true;
    try {
      if (!(await editorRef.current?.flush())) return;
      const remaining = tabs.filter((tab) => tab.note.path !== path);
      const next = remaining.at(-1);
      if (next) {
        editorRef.current?.activate(next);
        setActivePath(next.note.path);
      } else {
        setActivePath(null);
      }
      setTabs(remaining);
    } finally {
      navigationBusy.current = false;
    }
  };
  const changeVault = async () => {
    if (!(await editorRef.current?.flush())) return;
    setTabs([]);
    setActivePath(null);
  };

  return (
    <main className="flex h-screen min-h-0 w-screen flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 flex-row">
        <FileExplorer
          collapsed={explorerCollapsed}
          onToggleCollapsed={() =>
            setExplorerCollapsed((collapsed) => !collapsed)
          }
          onNotesChange={setNotes}
          onNoteSelect={selectNote}
          onVaultChange={() => {
            void changeVault();
          }}
          onVaultPath={setVaultPath}
          beforeVaultChange={() =>
            editorRef.current?.flush() ?? Promise.resolve(true)
          }
          vimMode={vimMode}
          onVimModeChange={setVimMode}
          openFileShortcut={openFileShortcut}
          onOpenFileShortcutChange={setOpenFileShortcut}
          toggleExplorerShortcut={toggleExplorerShortcut}
          commandHeld={commandHeld}
          onToggleExplorerShortcutChange={setToggleExplorerShortcut}
          selectedPath={activePath}
        />
        {explorerCollapsed && (
          <button
            type="button"
            aria-label="Show file explorer"
            aria-expanded={false}
            title="Show file explorer (⌘/Ctrl+B)"
            onClick={() => setExplorerCollapsed(false)}
            className="absolute left-3 top-3 z-10 rounded-md bg-black/50 p-2 text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
          >
            <RiMenuUnfold4Fill aria-hidden="true" className="h-4 w-4" />
            <ShortcutHint visible={commandHeld && toggleExplorerShortcut}>
              {navigator.platform.toLowerCase().includes('mac')
                ? '⌘B'
                : 'Ctrl+B'}
            </ShortcutHint>
          </button>
        )}
        <Editor
          ref={editorRef}
          vimMode={vimMode}
          tabs={
            <TabBar
              tabs={tabs}
              activePath={activePath}
              onSelect={selectNote}
              onClose={(path) => {
                void closeTab(path);
              }}
            />
          }
        />
      </div>
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-8 pt-[15vh]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPickerOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="open-file-title"
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/15 bg-[#202124] text-white shadow-2xl"
          >
            <h2 id="open-file-title" className="sr-only">
              Open file
            </h2>
            <input
              ref={pickerInputRef}
              aria-label="Search files"
              placeholder={
                vaultPath
                  ? 'Search files by name or path…'
                  : 'Choose a vault to open files'
              }
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlightedIndex(0);
              }}
              disabled={!vaultPath}
              className="w-full border-b border-white/10 bg-transparent px-5 py-4 outline-none placeholder:text-white/40"
            />
            <ul className="max-h-[50vh] overflow-y-auto p-2">
              {!vaultPath ? (
                <li className="p-4 text-sm text-white/60">
                  Choose a vault from the file explorer first.
                </li>
              ) : matchingNotes.length === 0 ? (
                <li className="p-4 text-sm text-white/60">
                  No matching files.
                </li>
              ) : (
                matchingNotes.map((note, index) => (
                  <li key={note.path}>
                    <button
                      type="button"
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() => {
                        void selectNote(note.path).then(() =>
                          setPickerOpen(false),
                        );
                      }}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm ${index === highlightedIndex ? 'bg-white/15' : 'hover:bg-white/10'}`}
                    >
                      <span className="block truncate">{note.name}</span>
                      <span className="block truncate text-xs text-white/45">
                        {note.path}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <p className="border-t border-white/10 px-5 py-3 text-xs text-white/40">
              ↑↓ to navigate · Enter to open · Esc to close
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
