import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { markdown } from '@codemirror/lang-markdown';
import {
  codeFolding,
  ensureSyntaxTree,
  foldable,
  foldEffect,
  foldedRanges,
  unfoldEffect,
} from '@codemirror/language';
import { EditorState } from '@codemirror/state';

describe('Markdown heading folding', () => {
  function stateFor(doc: string) {
    const state = EditorState.create({
      doc,
      extensions: [markdown(), codeFolding()],
    });
    ensureSyntaxTree(state, state.doc.length, 1000);
    return state;
  }

  function headingFold(state: EditorState, lineNumber: number) {
    const line = state.doc.line(lineNumber);
    return foldable(state, line.from, line.to);
  }

  it('folds nested sections through, but not including, the next same-or-higher heading', () => {
    const state = stateFor('# One\nbody\n## Nested\ninside\n# Two\nend');
    const outer = headingFold(state, 1);
    const nested = headingFold(state, 3);
    assert.deepEqual(outer, { from: 5, to: 27 });
    assert.deepEqual(nested, { from: 20, to: 27 });
  });

  it('does not fold headings without a body and supports document boundaries', () => {
    assert.equal(headingFold(stateFor('# Only'), 1), null);
    const finalSection = stateFor('# First\ntext\n## Last\nbody');
    assert.deepEqual(headingFold(finalSection, 3), { from: 20, to: 25 });
    assert.equal(headingFold(stateFor('before\n# End'), 2), null);
  });

  it('ignores heading-like lines inside fenced code and recognizes Setext headings', () => {
    const state = stateFor('# Real\n```md\n# Not a heading\n```\nbody');
    assert.deepEqual(headingFold(state, 1), { from: 6, to: 37 });
    assert.equal(headingFold(state, 3), null);
    const setext = stateFor('Title\n---\nbody');
    assert.deepEqual(headingFold(setext, 1), { from: 5, to: 14 });
  });

  it('uses CodeMirror fold effects and maps folded ranges through edits', () => {
    let state = stateFor('# Heading\nbody\n# Next');
    const range = headingFold(state, 1);
    assert.ok(range);
    state = state.update({ effects: foldEffect.of(range) }).state;
    assert.equal(foldedRanges(state).size, 1);
    assert.equal(foldedRanges(state).iter().from, range.from);
    assert.equal(foldedRanges(state).iter().to, range.to);
    state = state.update({ changes: { from: 12, insert: 'more\n' } }).state;
    assert.equal(foldedRanges(state).iter().from, range.from);
    assert.equal(foldedRanges(state).iter().to, range.to + 5);
    state = state.update({
      effects: unfoldEffect.of({
        from: foldedRanges(state).iter().from,
        to: foldedRanges(state).iter().to,
      }),
    }).state;
    assert.equal(foldedRanges(state).size, 0);
  });
});
