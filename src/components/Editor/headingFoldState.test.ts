import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getHeadingFoldState, setHeadingFoldState } from './headingFoldState';

const key = (vault: string, note: string, section: string) =>
  JSON.stringify([vault, note, section]);

describe('heading fold state', () => {
  it('retains collapsed and expanded values across preview remounts', () => {
    const first = key('vault-a', 'notes/a.md', 'heading-1');
    setHeadingFoldState(first, true);
    // B represents another mounted preview/tab; returning to A reads its state.
    assert.equal(
      getHeadingFoldState(key('vault-a', 'notes/b.md', 'heading-1')),
      undefined,
    );
    assert.equal(getHeadingFoldState(first), true);
    setHeadingFoldState(first, false);
    assert.equal(getHeadingFoldState(first), false);
  });

  it('isolates matching note paths in different vaults and nested sections', () => {
    setHeadingFoldState(key('vault-a', 'same/path.md', 'outer'), true);
    setHeadingFoldState(key('vault-a', 'same/path.md', 'inner'), false);
    setHeadingFoldState(key('vault-b', 'same/path.md', 'outer'), false);
    assert.equal(
      getHeadingFoldState(key('vault-a', 'same/path.md', 'outer')),
      true,
    );
    assert.equal(
      getHeadingFoldState(key('vault-a', 'same/path.md', 'inner')),
      false,
    );
    assert.equal(
      getHeadingFoldState(key('vault-b', 'same/path.md', 'outer')),
      false,
    );
  });

  it('evicts oldest entries to keep module-lifetime storage bounded', () => {
    const prefix = `eviction-${Date.now()}`;
    setHeadingFoldState(`${prefix}-oldest`, true);
    for (let index = 0; index < 2_000; index++) {
      setHeadingFoldState(`${prefix}-${index}`, true);
    }
    assert.equal(getHeadingFoldState(`${prefix}-oldest`), undefined);
    assert.equal(getHeadingFoldState(`${prefix}-1999`), true);
  });
});
