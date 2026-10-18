import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_APPEARANCE } from '../appearance';
import type { VaultEntry } from '../shared/types';
import FilePicker from './FilePicker';

function renderPicker(
  highlightedEntry: VaultEntry,
  preview: { path: string; markdown: string } | null,
) {
  return renderToStaticMarkup(
    <FilePicker
      entries={[highlightedEntry]}
      highlightedIndex={0}
      query=""
      hasVault
      inputRef={{ current: null }}
      activeVaultId="vault-1"
      preview={preview}
      previewState={null}
      highlightedEntry={highlightedEntry}
      appearance={DEFAULT_APPEARANCE}
      onQueryChange={() => {}}
      onHighlight={() => {}}
      onOpen={() => {}}
      onOpenWikiNote={() => {}}
      onClose={() => {}}
    />,
  );
}

test('renders the image preview pane for a highlighted image entry', () => {
  const entry: VaultEntry = {
    path: 'images/photo.png',
    name: 'photo.png',
    kind: 'image',
    isDirectory: false,
    peek: '',
    mimeType: 'image/png',
  };
  const markup = renderPicker(entry, null);
  assert.match(markup, /data-image-viewer="true"/);
  assert.match(markup, /aria-label="photo\.png"/);
  assert.match(markup, /Loading image…/);
});

test('renders Markdown preview content for a highlighted note', () => {
  const entry: VaultEntry = {
    path: 'notes/example.md',
    name: 'example.md',
    kind: 'note',
    isDirectory: false,
    peek: '',
  };
  const markup = renderPicker(entry, {
    path: entry.path,
    markdown: '# Previewed note',
  });
  assert.match(markup, /Previewed note/);
  assert.match(markup, /aria-label="File preview"/);
});
