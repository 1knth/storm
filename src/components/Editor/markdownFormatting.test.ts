import { EditorSelection, EditorState } from '@codemirror/state';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatMarkdownSelection } from './markdownFormatting';

function run(doc: string, from: number, to: number, kind: 'bold' | 'italic') {
  const state = EditorState.create({
    doc,
    selection: { anchor: from, head: to },
  });
  return state.update(formatMarkdownSelection(state, kind)).state;
}

describe('formatMarkdownSelection', () => {
  it('wraps a selected range and preserves its selection', () => {
    const result = run('hello', 1, 4, 'bold');
    assert.equal(result.doc.toString(), 'h**ell**o');
    assert.equal(result.selection.main.from, 3);
    assert.equal(result.selection.main.to, 6);
  });

  it('inserts an empty pair with the cursor inside', () => {
    const result = run('hello', 2, 2, 'italic');
    assert.equal(result.doc.toString(), 'he**llo');
    assert.equal(result.selection.main.from, 3);
  });

  it('unwraps markers surrounding the selection', () => {
    const result = run('**hello**', 2, 7, 'bold');
    assert.equal(result.doc.toString(), 'hello');
    assert.equal(result.selection.main.from, 0);
    assert.equal(result.selection.main.to, 5);
  });

  it('unwraps selected complete syntax', () => {
    const result = run('*hello*', 0, 7, 'italic');
    assert.equal(result.doc.toString(), 'hello');
  });

  it('formats multiple selections in one state update', () => {
    const state = EditorState.create({
      doc: 'one two',
      extensions: EditorState.allowMultipleSelections.of(true),
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 7),
      ]),
    });
    const result = state.update(formatMarkdownSelection(state, 'italic')).state;
    assert.equal(result.doc.toString(), '*one* *two*');
    assert.deepEqual(
      result.selection.ranges.map((range) => [range.from, range.to]),
      [
        [1, 4],
        [7, 10],
      ],
    );
  });
});
