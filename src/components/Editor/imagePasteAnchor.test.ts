import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EditorState } from '@codemirror/state';
import { imagePasteChange, mapImagePasteAnchor } from './imagePasteAnchor';

describe('image paste anchors', () => {
  it('keeps selection-only changes anchored to the original paste position', () => {
    const state = EditorState.create({ doc: 'abcd', selection: { anchor: 1 } });
    const anchor = { from: 1, to: 1, replaceSelection: false };
    const transaction = state.update({ selection: { anchor: 3 } });
    assert.equal(transaction.docChanged, false);
    assert.deepEqual(imagePasteChange(anchor, '![](/image.png)'), {
      from: 1,
      to: 1,
      insert: '![](/image.png)',
    });
  });

  it('maps through edits before the anchor while preserving selected text', () => {
    const state = EditorState.create({ doc: 'abcdef' });
    const anchor = { from: 2, to: 5, replaceSelection: true };
    const transaction = state.update({ changes: { from: 0, insert: 'XX' } });
    mapImagePasteAnchor(anchor, transaction.changes);
    assert.deepEqual(anchor, { from: 4, to: 7, replaceSelection: true });
    assert.deepEqual(imagePasteChange(anchor, 'link'), {
      from: 4,
      to: 7,
      insert: 'link',
    });
  });

  it('does not erase text inserted into the originally selected range', () => {
    const state = EditorState.create({ doc: 'abcdef' });
    const anchor = { from: 2, to: 5, replaceSelection: true };
    const transaction = state.update({
      changes: { from: 3, to: 4, insert: 'NEW' },
    });
    mapImagePasteAnchor(anchor, transaction.changes);
    assert.equal(anchor.replaceSelection, false);
    assert.deepEqual(imagePasteChange(anchor, 'link'), {
      from: anchor.from,
      to: anchor.from,
      insert: 'link',
    });
  });

  it('associates concurrent pastes at one point in request order', () => {
    const state = EditorState.create({ doc: 'ab' });
    const first = { from: 1, to: 1, replaceSelection: false };
    const second = { ...first };
    const inserted = state.update({ changes: imagePasteChange(first, 'one') });
    mapImagePasteAnchor(second, inserted.changes);
    assert.deepEqual(imagePasteChange(second, 'two'), {
      from: 4,
      to: 4,
      insert: 'two',
    });
    const final = inserted.state.update({
      changes: imagePasteChange(second, 'two'),
    });
    assert.equal(final.state.doc.toString(), 'aonetwob');
  });
});
