import { useEffect, useRef, useState } from 'react';
import { IoIosArrowForward } from 'react-icons/io';
import { FaFolder } from 'react-icons/fa';
import { FaRegFile } from 'react-icons/fa6';
import type { VaultEntry } from '../shared/types';
import type { Appearance } from '../appearance';
import NotePeek from './NotePeek';

type NoteProps = {
  entry: VaultEntry;
  entries: VaultEntry[];
  depth: number;
  selectedId: string | null;
  onNoteClick: (id: string) => void;
  onImageClick: (path: string) => void;
  onPdfClick: (path: string) => void;
  vaultId: string | null;
  appearance: Appearance;
};

export default function Note({
  entry,
  entries,
  depth,
  selectedId,
  onNoteClick,
  onImageClick,
  onPdfClick,
  vaultId,
  appearance,
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
  const isSelected =
    (entry.kind === 'note' || entry.kind === 'image' || entry.kind === 'pdf') &&
    selectedPath === normalizedPath;
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const thumbnailRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (entry.kind !== 'image' || !vaultId) return;
    const node = thumbnailRef.current;
    if (!node) return;
    let cancelled = false;
    let url: string | null = null;
    const observer = new IntersectionObserver(
      ([item]) => {
        if (!item.isIntersecting) return;
        observer.disconnect();
        window.vault
          .readAsset({ vaultId, relativePath: entry.path })
          .then((result) => {
            if (cancelled || !result.ok) return;
            const binary = atob(result.base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index++)
              bytes[index] = binary.charCodeAt(index);
            url = URL.createObjectURL(
              new Blob([bytes], { type: result.mimeType }),
            );
            setThumbnailUrl(url);
          })
          .catch(() => {});
      },
      { rootMargin: '100px' },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [entry.kind, entry.path, vaultId]);
  return (
    <li
      data-entry-path={entry.path}
      data-entry-directory={entry.isDirectory}
      data-entry-kind={entry.kind}
    >
      {entry.kind === 'directory' ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            style={{ paddingLeft: `${8 + depth * 16}px` }}
            className="sidebar-hover-tint flex w-full min-h-8 items-center justify-between rounded-md px-2 py-1 text-left text-xs text-white/90 transition-colors hover:bg-white/5 focus-visible:bg-white/5"
          >
            <span className="flex min-w-0 items-center gap-2 truncate">
              <FaFolder
                aria-hidden="true"
                className="file-tree-icon h-3.5 w-3.5 shrink-0"
                style={{ color: appearance.folderIcon }}
              />
              <span className="file-tree-label truncate">{entry.name}</span>
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
                  onImageClick={onImageClick}
                  onPdfClick={onPdfClick}
                  vaultId={vaultId}
                  appearance={appearance}
                />
              ))}
            </ul>
          )}
        </>
      ) : entry.kind === 'image' ? (
        <button
          type="button"
          id={`note-${encodeURIComponent(entry.path)}`}
          aria-label={`Preview image ${entry.name}`}
          aria-pressed={isSelected}
          onClick={() => onImageClick(entry.path)}
          style={{ paddingLeft: `${16 + depth * 16}px` }}
          className={`flex min-h-10 w-full flex-col justify-center p-1.5 text-left ${isSelected ? 'rounded-md bg-[#027DFF]/60' : 'rounded-none focus-visible:rounded-md focus-visible:bg-white/5'}`}
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium leading-4 text-white/90">
            <span
              ref={thumbnailRef}
              className="file-tree-icon flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden"
            >
              {thumbnailUrl ? (
                <img
                  src={thumbnailUrl}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                <FaRegFile aria-hidden="true" className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="file-tree-label truncate">{entry.name}</span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          id={`note-${encodeURIComponent(entry.path)}`}
          aria-label={
            entry.kind === 'pdf' ? `Open PDF ${entry.name}` : undefined
          }
          aria-pressed={isSelected}
          onClick={() =>
            entry.kind === 'pdf'
              ? onPdfClick(entry.path)
              : onNoteClick(entry.path)
          }
          style={{ paddingLeft: `${16 + depth * 16}px` }}
          className={`flex min-h-10 w-full flex-col justify-center p-1.5 text-left ${isSelected ? 'rounded-md bg-[#027DFF]/60' : 'rounded-none focus-visible:rounded-md focus-visible:bg-white/5'}`}
        >
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium leading-4 text-white/90">
            <FaRegFile
              aria-hidden="true"
              className="file-tree-icon h-3.5 w-3.5 shrink-0"
            />
            <span className="file-tree-label truncate">
              {entry.name.slice(0, entry.name.indexOf('.'))}
            </span>
          </span>
          {entry.kind === 'note' && (
            <span className="file-tree-peek block min-h-4 truncate border-b border-solid border-white/20 text-[11px] font-light leading-4 text-white/65">
              <NotePeek markdown={entry.peek} />
            </span>
          )}
        </button>
      )}
    </li>
  );
}
