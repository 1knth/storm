import { useEffect, useState } from 'react';
import { IoIosArrowForward } from 'react-icons/io';
import { FaFolder } from 'react-icons/fa';
import { FaRegFile } from 'react-icons/fa6';
import type { VaultEntry } from '../shared/types';
import NotePeek from './NotePeek';

type NoteProps = {
  entry: VaultEntry;
  entries: VaultEntry[];
  depth: number;
  selectedId: string | null;
  onNoteClick: (id: string) => void;
};

export default function Note({
  entry,
  entries,
  depth,
  selectedId,
  onNoteClick,
}: NoteProps) {
  const [expanded, setExpanded] = useState(false);
  const children = entries.filter((candidate) => {
    const parent = candidate.path
      .split('\\')
      .join('/')
      .split('/')
      .slice(0, -1)
      .join('/');
    return parent === entry.path.split('\\').join('/').replace(/\/$/, '');
  });
  const normalizedPath = entry.path.split('\\').join('/');
  const selectedPath = selectedId?.split('\\').join('/');
  const containsSelection =
    entry.isDirectory && selectedPath?.startsWith(`${normalizedPath}/`);
  useEffect(() => {
    if (containsSelection) setExpanded(true);
  }, [containsSelection]);
  const isSelected = !entry.isDirectory && selectedId === entry.path;
  return (
    <li data-entry-path={entry.path} data-entry-directory={entry.isDirectory}>
      {entry.isDirectory ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            className="sidebar-hover-tint flex w-full min-h-8 items-center justify-between rounded-md px-2 py-1 text-left text-xs text-white/90 transition-colors hover:bg-white/5 focus-visible:bg-white/5"
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              <FaFolder aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {entry.name}
            </span>
            <IoIosArrowForward
              aria-hidden="true"
              className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
          {expanded && children.length > 0 && (
            <ul>
              {children.map((child) => (
                <Note
                  key={child.path}
                  entry={child}
                  entries={entries}
                  depth={depth + 1}
                  selectedId={selectedId}
                  onNoteClick={onNoteClick}
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        <button
          type="button"
          id={`note-${encodeURIComponent(entry.path)}`}
          aria-pressed={isSelected}
          onClick={() => onNoteClick(entry.path)}
          style={{ paddingLeft: `${16 + depth * 16}px` }}
          className={`flex min-h-10 w-full flex-col justify-center p-1.5 text-left ${isSelected ? 'rounded-md bg-[#027DFF]/60' : 'rounded-none focus-visible:rounded-md focus-visible:bg-white/5'}`}
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium leading-4 text-white/90">
            <FaRegFile aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {entry.name.slice(0, entry.name.indexOf('.'))}
            </span>
          </span>
          <span className="block min-h-4 truncate border-b border-solid border-white/20 text-[11px] font-light leading-4 text-white/65">
            <NotePeek markdown={entry.peek} />
          </span>
        </button>
      )}
    </li>
  );
}
