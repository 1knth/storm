import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  previewNoteScrollKey,
  previewScrollTarget,
  rememberPreviewScroll,
} from './previewNoteScroll';

describe('per-note markdown preview scroll', () => {
  it('restores each note position after switching away and back', () => {
    const positions = new Map<string, number>();
    const a = previewNoteScrollKey({ vaultId: 'vault', notePath: 'a.md' });
    const b = previewNoteScrollKey({ vaultId: 'vault', notePath: 'b.md' });
    rememberPreviewScroll(positions, a, 800);
    rememberPreviewScroll(positions, b, 200);
    assert.equal(previewScrollTarget(positions, b, 2000, 500), 200);
    assert.equal(previewScrollTarget(positions, a, 2000, 500), 800);
  });

  it('keeps same-basename notes in different vaults independent', () => {
    const positions = new Map<string, number>();
    const first = previewNoteScrollKey({
      vaultId: 'one',
      notePath: 'folder/note.md',
    });
    const second = previewNoteScrollKey({
      vaultId: 'two',
      notePath: 'folder/note.md',
    });
    rememberPreviewScroll(positions, first, 500);
    assert.equal(previewScrollTarget(positions, second, 1000, 400), 0);
    assert.equal(previewScrollTarget(positions, first, 1000, 400), 500);
  });

  it('starts a never-visited note at the top', () => {
    assert.equal(previewScrollTarget(new Map(), 'new-note', 1000, 400), 0);
  });

  it('defers instead of replacing a saved offset when content is initially too short', () => {
    const positions = new Map([['note', 800]]);
    assert.equal(previewScrollTarget(positions, 'note', 300, 200), null);
    assert.equal(positions.get('note'), 800);
    assert.equal(previewScrollTarget(positions, 'note', 1200, 200), 800);
  });

  it('ignores invalid offsets', () => {
    const positions = new Map<string, number>();
    rememberPreviewScroll(positions, 'note', Number.NaN);
    rememberPreviewScroll(positions, 'note', -1);
    assert.equal(positions.has('note'), false);
  });
});
