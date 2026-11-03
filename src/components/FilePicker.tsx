import type { ReactNode, RefObject } from 'react';
import type { Appearance } from '../appearance';
import type { VaultEntry } from '../shared/types';
import AssetPreviewPane from './AssetPreviewDialog';
import MarkdownPreview from './Editor/MarkdownPreview';

type FilePickerProps = {
  entries: VaultEntry[];
  highlightedIndex: number;
  query: string;
  hasVault: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  activeVaultId: string | null;
  preview: { path: string; markdown: string } | null;
  previewState: 'loading' | 'error' | null;
  highlightedEntry: VaultEntry | undefined;
  appearance: Appearance;
  onQueryChange: (query: string) => void;
  onHighlight: (index: number) => void;
  onOpen: (entry: VaultEntry) => void | Promise<void>;
  onOpenWikiNote: (target: string, fromPath: string) => void;
  onClose: () => void;
};

export default function FilePicker({
  entries,
  highlightedIndex,
  query,
  hasVault,
  inputRef,
  activeVaultId,
  preview,
  previewState,
  highlightedEntry,
  appearance,
  onQueryChange,
  onHighlight,
  onOpen,
  onOpenWikiNote,
  onClose,
}: FilePickerProps) {
  let fileList: ReactNode;
  if (!hasVault) {
    fileList = (
      <li className="p-4 text-sm text-white/60">
        Choose a vault from the file explorer first.
      </li>
    );
  } else if (entries.length === 0) {
    fileList = (
      <li className="p-4 text-sm text-white/60">No matching files.</li>
    );
  } else {
    fileList = entries.map((entry, index) => (
      <li key={entry.path}>
        <button
          type="button"
          onMouseEnter={() => onHighlight(index)}
          onClick={() => {
            void Promise.resolve(onOpen(entry)).then(onClose);
          }}
          className={`app-popup-row command-palette-row w-full px-3 py-1.5 text-left ${index === highlightedIndex ? 'is-highlighted' : ''}`}
        >
          <span className="block truncate text-[13px] leading-5">
            {entry.name}
          </span>
          <span className="command-palette-row-detail block truncate text-[11px] leading-4">
            {entry.path}
          </span>
        </button>
      </li>
    ));
  }

  let previewContent: ReactNode;
  if (previewState === 'loading') {
    previewContent = (
      <p className="p-4 text-sm text-white/50">Loading preview…</p>
    );
  } else if (previewState === 'error') {
    previewContent = (
      <p className="p-4 text-sm text-white/50">Could not load this file.</p>
    );
  } else if (highlightedEntry?.kind === 'image' && activeVaultId) {
    previewContent = (
      <AssetPreviewPane
        key={`${activeVaultId}:${highlightedEntry.path}`}
        vaultId={activeVaultId}
        relativePath={highlightedEntry.path}
        filename={highlightedEntry.name}
      />
    );
  } else if (preview) {
    previewContent = (
      <MarkdownPreview
        compact
        markdown={preview.markdown}
        vaultId={activeVaultId ?? ''}
        notePath={preview.path}
        onOpenNote={(target) => onOpenWikiNote(target, preview.path)}
        appearance={appearance}
      />
    );
  } else {
    previewContent = (
      <p className="p-4 text-sm text-white/50">Select a file to preview.</p>
    );
  }

  return (
    <div
      className="command-palette-backdrop fixed inset-0 z-50 flex items-start justify-center p-8 pt-[15vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-file-title"
        className="app-popup-surface command-palette-surface flex max-h-[80vh] w-full max-w-5xl flex-col overflow-hidden"
      >
        <h2 id="open-file-title" className="sr-only">
          Open file
        </h2>
        <input
          ref={inputRef}
          aria-label="Search files"
          placeholder={
            hasVault
              ? 'Search files by name or path…'
              : 'Choose a vault to open files'
          }
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          disabled={!hasVault}
          className="app-input w-full rounded-none border-0 border-b border-white/[0.08] bg-transparent px-5 py-3.5 text-[17px] outline-none placeholder:text-white/35 focus-visible:border-white/[0.08]"
        />
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul className="min-h-0 max-h-[30vh] w-full overflow-y-auto p-1.5 md:max-h-none md:w-1/2 md:border-r md:border-white/[0.08]">
            {fileList}
          </ul>
          <section
            aria-label="File preview"
            className="flex min-h-[28vh] w-full min-w-0 flex-col overflow-hidden md:min-h-[50vh] md:w-1/2"
          >
            <h3 className="shrink-0 border-b border-white/[0.08] px-4 py-2 text-[11px] font-medium text-white/45">
              Preview
            </h3>
            {previewContent}
          </section>
        </div>
        <p className="shrink-0 border-t border-white/[0.08] px-5 py-2 text-[11px] text-white/35">
          ↑↓ to navigate · Enter to open · Esc to close
        </p>
      </section>
    </div>
  );
}
