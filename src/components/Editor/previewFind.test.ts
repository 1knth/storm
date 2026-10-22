import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findPreviewTextMatches,
  findPreviewTextMatchesInBlocks,
  isPreviewFindShortcut,
  nextPreviewFindIndex,
} from './previewFind';

describe('rendered preview find', () => {
  it('recognizes Command/Control+F with either key casing only', () => {
    assert.equal(
      isPreviewFindShortcut({ metaKey: true, ctrlKey: false, key: 'f' }),
      true,
    );
    assert.equal(
      isPreviewFindShortcut({ metaKey: false, ctrlKey: true, key: 'F' }),
      true,
    );
    assert.equal(
      isPreviewFindShortcut({ metaKey: false, ctrlKey: false, key: 'f' }),
      false,
    );
    assert.equal(
      isPreviewFindShortcut({ metaKey: true, ctrlKey: false, key: 'p' }),
      false,
    );
  });

  it('matches case-insensitively across adjacent rendered text nodes', () => {
    const renderedText = ['Storm ', 'NOTE', ' storm'];
    const combined = renderedText.join('');
    const matches = findPreviewTextMatches(combined, 'storm note');
    assert.deepEqual(matches, [{ start: 0, end: 10 }]);
    assert.equal(renderedText[0]!.length, 6);
  });

  it('does not match across block boundaries but preserves inline continuity', () => {
    assert.deepEqual(
      findPreviewTextMatchesInBlocks(['Storm ', 'NOTE'], 'storm note'),
      [],
    );
    assert.deepEqual(
      findPreviewTextMatchesInBlocks(['Storm ', 'NOTE'], 'note'),
      [{ start: 7, end: 11 }],
    );
    assert.deepEqual(
      findPreviewTextMatchesInBlocks(['Storm ', 'NOTE'], 'storm note'),
      [],
    );
    assert.deepEqual(
      findPreviewTextMatches(['Storm ', 'NOTE'].join(''), 'storm note'),
      [{ start: 0, end: 10 }],
    );
  });

  it('returns no matches for an empty query or absent text', () => {
    assert.deepEqual(findPreviewTextMatches('Some note', ''), []);
    assert.deepEqual(findPreviewTextMatches('Some note', 'missing'), []);
  });

  it('wraps navigation and safely handles no matches', () => {
    assert.equal(nextPreviewFindIndex(0, 1, 3), 1);
    assert.equal(nextPreviewFindIndex(0, -1, 3), 2);
    assert.equal(nextPreviewFindIndex(0, 1, 0), 0);
  });
});
