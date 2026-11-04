import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Note from './Note';
import type { VaultEntry } from '../shared/types';
import { DEFAULT_APPEARANCE } from '../appearance';

function render(entry: VaultEntry, appearance = DEFAULT_APPEARANCE) {
  return renderToStaticMarkup(
    <ul>
      <Note
        entry={entry}
        entries={[entry]}
        depth={0}
        selectedId={entry.path}
        onNoteClick={() => assert.fail('SSR must not select a note')}
        onImageClick={() => assert.fail('SSR must not open the viewer')}
        onPdfClick={() => assert.fail('SSR must not open the PDF')}
        vaultId="vault-1"
        appearance={appearance}
      />
    </ul>,
  );
}

test('image entries use the existing compact file-row layout without a note peek', () => {
  const markup = render({
    path: 'images/photo.png',
    name: 'photo.png',
    kind: 'image',
    isDirectory: false,
    peek: 'must not render as a note peek',
    mimeType: 'image/png',
  });

  assert.match(markup, /data-entry-kind="image"/);
  assert.match(markup, /aria-label="Preview image photo\.png"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /photo\.png/);
  assert.doesNotMatch(markup, /must not render as a note peek/);
});

test('PDF entries render as openable file rows without a note peek', () => {
  const markup = render({
    path: 'docs/manual.PDF',
    name: 'manual.PDF',
    kind: 'pdf',
    isDirectory: false,
    peek: '',
  });
  assert.match(markup, /data-entry-kind="pdf"/);
  assert.match(markup, /aria-label="Open PDF manual\.PDF"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.doesNotMatch(markup, /file-tree-peek/);
});

test('Markdown entries retain their note selection and peek rendering', () => {
  const markup = render({
    path: 'readme.md',
    name: 'readme.md',
    kind: 'note',
    isDirectory: false,
    peek: 'A normal note',
  });

  assert.match(markup, /data-entry-kind="note"/);
  assert.match(markup, /A normal note/);
  assert.match(markup, /data-entry-directory="false"/);
});
