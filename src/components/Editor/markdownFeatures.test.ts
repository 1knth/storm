import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdownEditorExtensions } from './extensions';
import { markdownCompletions } from './markdownCompletions';
import { markdownSyntaxHighlighting } from './markdownHighlighting';

function complete(text: string) {
  const state = EditorState.create({
    doc: text,
    extensions: [markdown(), markdownSyntaxHighlighting],
  });
  return markdownCompletions(new CompletionContext(state, text.length, false));
}

describe('Markdown editor features', () => {
  it('pairs a typed asterisk and pairs dollars only on the second dollar', () => {
    let state = EditorState.create({
      doc: '',
      extensions: markdownEditorExtensions,
    });
    const handler = state.facet(EditorView.inputHandler)[0];
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<typeof state.update>[0]) => {
        state = state.update(spec).state;
      },
    } as EditorView;
    const type = (text: string) => {
      const position = state.selection.main.head;
      return handler(view, position, position, text, () =>
        state.update({ changes: { from: position, insert: text } }),
      );
    };

    assert.equal(type('*'), true);
    assert.equal(state.doc.toString(), '**');
    assert.equal(state.selection.main.head, 1);
    assert.equal(type('*'), true);
    assert.equal(state.doc.toString(), '****');
    assert.equal(state.selection.main.head, 2);
    assert.equal(type('*'), true);
    assert.equal(state.doc.toString(), '****');
    assert.equal(state.selection.main.head, 3);

    state = EditorState.create({
      doc: '',
      extensions: markdownEditorExtensions,
    });
    assert.equal(type('$'), false);
    state = state.update({
      changes: { from: 0, insert: '$' },
      selection: { anchor: 1 },
    }).state;
    assert.equal(type('$'), true);
    assert.equal(state.doc.toString(), '$$');
    assert.equal(state.selection.main.head, 1);
  });

  it('skips an existing matching closer without changing the document', () => {
    let state = EditorState.create({
      doc: '**',
      selection: { anchor: 1 },
      extensions: markdownEditorExtensions,
    });
    const handler = state.facet(EditorView.inputHandler)[0];
    const view = {
      get state() {
        return state;
      },
      dispatch: (spec: Parameters<typeof state.update>[0]) => {
        state = state.update(spec).state;
      },
    } as EditorView;
    assert.equal(
      handler(view, 1, 1, '*', () => state.update({})),
      true,
    );
    assert.equal(state.doc.toString(), '**');
    assert.equal(state.selection.main.head, 2);
  });
  it('parses headings, emphasis, and inline code for syntax coloring', () => {
    const state = EditorState.create({
      doc: '# Heading\n**bold** *italic* `code`',
      extensions: [markdown(), markdownSyntaxHighlighting],
    });
    const names: string[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    for (const name of [
      'ATXHeading1',
      'StrongEmphasis',
      'Emphasis',
      'InlineCode',
    ]) {
      assert.ok(
        names.includes(name),
        `expected Markdown syntax tree node ${name}`,
      );
    }
  });

  it('offers Markdown table, task, image, wiki image, Mermaid, and chart templates from explicit prefixes', () => {
    assert.ok(
      complete('table')?.options.some((item) => item.label === 'table'),
    );
    assert.ok(complete('task')?.options.some((item) => item.label === 'task'));
    assert.ok(
      complete('image')?.options.some((item) => item.label === 'wiki image'),
    );
    assert.ok(
      complete('mermaid')?.options.some(
        (item) => item.label === 'mermaid sequence',
      ),
    );
    assert.ok(
      complete('chart')?.options.some((item) => item.label === 'chart line'),
    );
  });

  it('suggests syntax in supported fences but not arbitrary code fences or inline code', () => {
    assert.ok(
      complete('```mermaid\nflow')?.options.some(
        (item) => item.label === 'flowchart TD',
      ),
    );
    assert.ok(
      complete('```chart\ntype')?.options.some(
        (item) => item.label === 'type:',
      ),
    );
    assert.equal(complete('```js\ntask'), null);
    assert.equal(complete('`task`'), null);
    assert.equal(complete('ordinary'), null);
  });
});
