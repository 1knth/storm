import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
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
