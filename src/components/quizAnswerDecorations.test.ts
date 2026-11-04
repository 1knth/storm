import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, EditorSelection } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { answerPreviewRanges } from './quizAnswerDecorations';

function previews(doc: string, cursor = doc.length) {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown()],
  });
  return answerPreviewRanges(state, true).map((r) => doc.slice(r.from, r.to));
}
test('renders completed inline constructs in the active paragraph', () => {
  assert.deepEqual(previews('**bold** and $x^2$ then type'), [
    '**bold**',
    '$x^2$',
  ]);
});
test('reveals source at both math boundaries and inside it', () => {
  const doc = 'a $x^2$ end';
  for (const cursor of [2, 4, 7]) assert.deepEqual(previews(doc, cursor), []);
});
test('keeps code, escaped dollars, currency and incomplete math literal', () => {
  assert.deepEqual(
    previews(
      '`$x$` and \\$y and $100 qualifies; $50 is reduced and $unfinished',
    ),
    ['`$x$`'],
  );
});
test('supports LaTeX delimiters and nested Markdown without overlapping widgets', () => {
  assert.deepEqual(previews('\\(x^2\\) **bold *inner*** done'), [
    '\\(x^2\\)',
    '**bold *inner***',
  ]);
});
test('selection crossing expressions reveals source without changing document', () => {
  const doc = '$x$ and **bold** end';
  const state = EditorState.create({
    doc,
    selection: EditorSelection.range(1, 12),
    extensions: [markdown()],
  });
  assert.deepEqual(answerPreviewRanges(state, true), []);
  assert.deepEqual(state.doc.toString(), doc);
  assert.deepEqual(answerPreviewRanges(state, false), [
    { from: 0, to: doc.length, block: true },
  ]);
});
