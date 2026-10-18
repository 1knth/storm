import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Note from './Note';
import type { VaultEntry } from '../shared/types';

function render(entry: VaultEntry) {
  return renderToStaticMarkup(
    <ul>
      <Note
        entry={entry}
        entries={[entry]}
        depth={0}
        selectedId={entry.path}
        onNoteClick={() => assert.fail('SSR must not select a note')}
        onImageClick={() => assert.fail('SSR must not open the viewer')}
        vaultId="vault-1"
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
  assert.match(markup, /min-h-10 w-full flex-col justify-center p-1\.5/);
  assert.match(markup, /file-tree-icon flex h-3\.5 w-3\.5/);
  assert.match(markup, /file-tree-label truncate/);
  assert.match(markup, /photo\.png/);
  assert.doesNotMatch(markup, />IMG</);
  assert.doesNotMatch(markup, /must not render as a note peek/);
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
