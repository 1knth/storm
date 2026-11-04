import { useEffect, useMemo, useRef, useState } from 'react';
import { FaFolder } from 'react-icons/fa6';
import type { QuizScope } from '../shared/quizProtocol';

/** Short learner-facing label for a session's study context. */
export function quizScopeLabel(scope: QuizScope | undefined): string {
  if (!scope) return 'No context';
  if (scope.notePath) return scope.notePath.split('/').pop() || scope.notePath;
  if (scope.folderPath === '.') return 'Entire vault';
  if (scope.folderPath)
    return scope.folderPath.split('/').pop() || scope.folderPath;
  if (scope.selectedNotePaths.length)
    return `${scope.selectedNotePaths.length} notes`;
  return 'No sources';
}

function parentFolder(path: string): string | null {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : null;
}

/**
 * Attach, replace, or clear the folder/note an existing quiz draws study context
 * from. Scope is contextual only; it never authorizes note edits.
 */
export default function QuizScopePicker({
  scope,
  vaultId,
  notePath,
  onChange,
}: {
  scope: QuizScope | undefined;
  vaultId: string | null;
  notePath: string | null;
  onChange: (scope: QuizScope | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void window.vault
      ?.listNotes()
      .then((entries) => {
        if (cancelled) return;
        const paths = new Set<string>();
        for (const entry of entries) {
          const path = entry.path.replace(/\\/g, '/');
          if (entry.isDirectory) paths.add(path);
          // Folders are also derived from note parents in case listings omit them.
          for (let p = parentFolder(path); p; p = parentFolder(p)) paths.add(p);
        }
        setFolders([...paths].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => setFolders([]));
    const close = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => {
      cancelled = true;
      document.removeEventListener('mousedown', close);
    };
  }, [open]);

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return folders
      .filter((f) => !query || f.toLocaleLowerCase().includes(query))
      .slice(0, 200);
  }, [folders, filter]);

  const choose = (next: QuizScope | null) => {
    setBusy(true);
    void onChange(next).finally(() => {
      setBusy(false);
      setOpen(false);
    });
  };
  const scoped = (patch: Partial<QuizScope>): QuizScope => ({
    vaultId: vaultId!,
    notePath: null,
    folderPath: null,
    selectedNotePaths: [],
    ...patch,
  });
  const otherVault = !!scope && !!vaultId && scope.vaultId !== vaultId;
  const noteFolder = notePath ? parentFolder(notePath) : null;
  const item =
    'app-popup-row block w-full truncate text-left disabled:opacity-40';

  return (
    <div ref={root} className="relative min-w-0">
      <button
        type="button"
        aria-label={`Study context: ${quizScopeLabel(scope)}`}
        aria-expanded={open}
        title={
          scope
            ? `Tutor can read: ${scope.folderPath || scope.notePath || 'entire vault'}`
            : 'Attach a folder so the tutor can read your course material'
        }
        className={`inline-flex min-w-0 max-w-[12rem] cursor-pointer items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-sm hover:text-white/80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/70 ${scope ? 'text-sky-300' : 'text-white/50'}`}
        onClick={() => setOpen((value) => !value)}
      >
        <FaFolder aria-hidden="true" size={11} />
        <span className="truncate">{quizScopeLabel(scope)}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose study context"
          className="app-popup-surface macos-context-menu quiz-scope-menu absolute left-0 top-full z-20 mt-1 w-72 select-none"
        >
          <p className="px-2.5 pt-0.5 pb-1 text-xs text-white/50">
            The tutor can read Markdown in this context. It cannot edit notes.
          </p>
          {!vaultId ? (
            <p className="px-2.5 py-0.5 text-white/60">Open a vault first.</p>
          ) : (
            <>
              {otherVault && (
                <p className="px-2.5 pb-1 text-xs text-amber-300">
                  Current context belongs to another vault.
                </p>
              )}
              {noteFolder && (
                <button
                  type="button"
                  disabled={busy}
                  className={item}
                  onClick={() => choose(scoped({ folderPath: noteFolder }))}
                >
                  Current note’s folder ({noteFolder})
                </button>
              )}
              {notePath && (
                <button
                  type="button"
                  disabled={busy}
                  className={item}
                  onClick={() => choose(scoped({ notePath }))}
                >
                  Current note only
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                className={item}
                onClick={() => choose(scoped({ folderPath: '.' }))}
              >
                Entire vault
              </button>
              <div role="separator" className="macos-context-menu-separator" />
              <input
                aria-label="Filter folders"
                placeholder="Filter folders"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="quiz-scope-filter mx-1 mb-1 w-[calc(100%-0.5rem)] rounded-[5px] border px-2 py-0.5 text-white placeholder:text-white/40 focus:outline-none"
              />
              <div className="max-h-56 overflow-y-auto">
                {visible.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    disabled={busy}
                    className={`${item} relative pl-6`}
                    aria-current={
                      scope?.folderPath === folder && !otherVault
                        ? 'true'
                        : undefined
                    }
                    onClick={() => choose(scoped({ folderPath: folder }))}
                  >
                    {scope?.folderPath === folder && !otherVault && (
                      <span
                        aria-hidden="true"
                        className="absolute left-2 top-1/2 -translate-y-1/2"
                      >
                        ✓
                      </span>
                    )}
                    {folder}
                  </button>
                ))}
                {!visible.length && (
                  <p className="px-2.5 py-0.5 text-white/40">
                    No folders found.
                  </p>
                )}
              </div>
            </>
          )}
          {scope && (
            <>
              <div role="separator" className="macos-context-menu-separator" />
              <button
                type="button"
                disabled={busy}
                className={`${item} text-red-300`}
                onClick={() => choose(null)}
              >
                Remove context
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
