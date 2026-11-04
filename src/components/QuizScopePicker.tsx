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
    'block w-full truncate rounded px-2 py-1 text-left text-sm text-white/80 hover:bg-white/10 disabled:opacity-40';

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={`Study context: ${quizScopeLabel(scope)}`}
        aria-expanded={open}
        title={
          scope
            ? `Tutor can read: ${scope.folderPath || scope.notePath || 'entire vault'}`
            : 'Attach a folder so the tutor can read your course material'
        }
        className={`inline-flex max-w-[12rem] shrink-0 cursor-pointer items-center gap-1 rounded-md bg-white/10 px-1.5 py-0.5 text-sm hover:text-white/80 focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/70 ${scope ? 'text-sky-300' : 'text-white/50'}`}
        onClick={() => setOpen((value) => !value)}
      >
        <FaFolder aria-hidden="true" size={11} />
        <span className="truncate">{quizScopeLabel(scope)}</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose study context"
          className="absolute left-0 top-full z-20 mt-1 w-72 rounded-md border border-white/15 bg-neutral-900 p-2 shadow-lg"
        >
          <p className="mb-2 text-xs text-white/50">
            The tutor can read Markdown in this context. It cannot edit notes.
          </p>
          {!vaultId ? (
            <p className="text-sm text-white/60">Open a vault first.</p>
          ) : (
            <>
              {otherVault && (
                <p className="mb-2 text-xs text-amber-300">
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
              <input
                aria-label="Filter folders"
                placeholder="Filter folders"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                className="my-2 w-full rounded border border-white/15 bg-transparent px-2 py-1 text-sm text-white placeholder:text-white/40"
              />
              <div className="max-h-56 overflow-y-auto">
                {visible.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    disabled={busy}
                    className={`${item} ${scope?.folderPath === folder && !otherVault ? 'text-sky-300' : ''}`}
                    onClick={() => choose(scoped({ folderPath: folder }))}
                  >
                    {folder}
                  </button>
                ))}
                {!visible.length && (
                  <p className="px-2 py-1 text-sm text-white/40">
                    No folders found.
                  </p>
                )}
              </div>
            </>
          )}
          {scope && (
            <button
              type="button"
              disabled={busy}
              className={`${item} mt-2 border-t border-white/10 pt-2 text-red-300`}
              onClick={() => choose(null)}
            >
              Remove context
            </button>
          )}
        </div>
      )}
    </div>
  );
}
