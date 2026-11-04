import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ensureSyntaxTree } from '@codemirror/language';
import { answerPreviewRanges } from './quizAnswerDecorations';
import { formatTable, insertTable, tableAt } from './quizAnswerTables';

test('insert places a truth-table template on its own block', () => {
  const { text, cursor } = insertTable('Answer:', 7);
  assert.ok(text.startsWith('Answer:\n\n| p '));
  assert.equal(cursor, 'Answer:\n\n'.length);
  assert.deepEqual(tableAt(text, cursor)?.rows[0], ['p', 'q', 'result']);
});

test('reads cells and ignores pipes inside math', () => {
  const text = '| $|x|$ | b |\n| --- | --- |\n| 1 | 2 |';
  assert.deepEqual(tableAt(text, 0)?.rows, [
    ['$|x|$', 'b'],
    ['1', '2'],
  ]);
  assert.equal(tableAt('plain text', 3), null);
});

test('formatting round-trips cells and escapes bare pipes', () => {
  const rows = [
    ['p', 'q', '$a|b$'],
    ['T', 'x|y', ''],
  ];
  const text = formatTable(rows);
  assert.match(text.split('\n')[1], /^\|(?: -+ \|){3}$/);
  assert.deepEqual(tableAt(text, 0)?.rows, [
    ['p', 'q', '$a|b$'],
    ['T', 'x\\|y', ''],
  ]);
});

test('tables stay rendered even with the caret inside them', () => {
  const doc = 'Intro\n\n| p | q |\n| --- | --- |\n| T | F |';
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.length - 2 },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length);
  const tables = answerPreviewRanges(state, true).filter((r) => r.table);
  assert.deepEqual(tables, [
    { from: 7, to: doc.length, block: true, table: true },
  ]);
});
