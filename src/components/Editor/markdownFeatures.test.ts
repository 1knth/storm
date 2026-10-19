import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CompletionContext } from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { highlightingFor, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { markdownEditorExtensions } from './extensions';
import { markdownCompletions } from './markdownCompletions';
import { markdownSyntaxHighlighting } from './markdownHighlighting';
import { tags } from '@lezer/highlight';

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

  it('formats words under the cursor in Vim Normal mode without splitting them', () => {
    let state = EditorState.create({
      doc: 'some text here',
      selection: { anchor: 7 },
      extensions: markdownEditorExtensions,
    });
    const vim = { insertMode: false, visualMode: false };
    const view = {
      get state() {
        return state;
      },
      cm: { state: { vim } },
      dispatch: (transaction: Parameters<typeof state.update>[0]) => {
        state = state.update(transaction).state;
      },
    } as unknown as EditorView;
    const runKey = (key: string) => {
      const binding = state
        .facet(keymap)
        .flat()
        .find((candidate) => candidate.key === key);
      assert.ok(binding?.run);
      return binding.run(view);
    };

    assert.equal(runKey('Mod-i'), true);
    assert.equal(state.doc.toString(), 'some *text* here');
    assert.equal(state.selection.main.empty, true);
    assert.equal(state.selection.main.head, 9);
    assert.equal(vim.insertMode, false);
    assert.equal(vim.visualMode, false);

    state = EditorState.create({
      doc: 'some text here',
      selection: { anchor: 7 },
      extensions: markdownEditorExtensions,
    });
    assert.equal(runKey('Mod-b'), true);
    assert.equal(state.doc.toString(), 'some **text** here');
    assert.equal(state.selection.main.empty, true);
    assert.equal(vim.insertMode, false);

    for (const [key, expected, caret] of [
      ['Mod-i', '**', 1],
      ['Mod-b', '****', 2],
    ] as const) {
      state = EditorState.create({
        doc: '',
        extensions: markdownEditorExtensions,
      });
      vim.insertMode = false;
      vim.visualMode = false;
      assert.equal(runKey(key), true);
      assert.equal(state.doc.toString(), expected);
      assert.equal(state.selection.main.head, caret);
      assert.equal(vim.insertMode, true);
    }

    state = EditorState.create({
      doc: 'selected',
      selection: { anchor: 0, head: 8 },
      extensions: markdownEditorExtensions,
    });
    vim.insertMode = true;
    vim.visualMode = true;
    assert.equal(runKey('Mod-b'), true);
    assert.equal(state.doc.toString(), '**selected**');
    assert.equal(state.selection.main.from, 2);
    assert.equal(state.selection.main.to, 10);
    assert.equal(vim.insertMode, true);
    assert.equal(vim.visualMode, true);
  });

  it('cycles task markers through the configured Normal-mode Enter keymap', () => {
    let state = EditorState.create({
      doc: 'task',
      extensions: [markdown(), ...markdownEditorExtensions],
    });
    const view = {
      get state() {
        return state;
      },
      cm: { state: { vim: { insertMode: false, visualMode: false } } },
      dispatch: (transaction: Parameters<typeof state.update>[0]) => {
        state = state.update(transaction).state;
      },
    } as unknown as EditorView;
    const enterBindings = state
      .facet(keymap)
      .flat()
      .filter((binding) => binding.key === 'Enter');

    for (const expected of ['- task', '- [ ] task']) {
      state = state.update({ selection: { anchor: state.doc.length } }).state;
      let handled = false;
      for (const binding of enterBindings) {
        if (binding.run?.(view)) {
          handled = true;
          break;
        }
      }
      assert.equal(handled, true);
      assert.equal(state.doc.toString(), expected);
    }

    state = state.update({ selection: { anchor: state.doc.length } }).state;
    const xBindings = state
      .facet(keymap)
      .flat()
      .filter((binding) => binding.key === 'x');
    let handled = false;
    for (const binding of xBindings) {
      if (binding.run?.(view)) {
        handled = true;
        break;
      }
    }
    assert.equal(handled, true);
    assert.equal(state.doc.toString(), '- [x] task');
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
  it('runs Markdown tags through the configured highlighter without crashing', () => {
    const state = EditorState.create({
      doc: '# Heading\n**bold** *italic* [link](https://example.com) `code`',
      extensions: [markdown(), markdownSyntaxHighlighting],
    });

    for (const tag of [
      'heading1',
      'strong',
      'emphasis',
      'link',
      'url',
      'monospace',
    ] as const) {
      assert.ok(highlightingFor(state, [tags[tag]]), `expected ${tag} styling`);
    }
  });

  it('fully parses inline HTML in the configured editor state', () => {
    const state = EditorState.create({
      doc: [
        '| left | right |',
        '| --- | --- |',
        '| value | <br><br> |',
        '| | $$x^2$$ |',
      ].join('\n'),
      extensions: [markdown(), ...markdownEditorExtensions],
    });
    const names: string[] = [];
    syntaxTree(state).iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    assert.ok(names.includes('Document'), 'expected a Markdown document tree');
    assert.ok(names.includes('HTMLTag'), 'expected embedded HTML to parse');
  });

  it('parses headings, emphasis, and inline code for syntax coloring', () => {
    const state = EditorState.create({
      doc: '# Heading\n**bold** *italic* `code`',
      extensions: [
        markdown(),
        markdownSyntaxHighlighting,
        ...markdownEditorExtensions,
      ],
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

  it('offers task completion after literal unordered, nested, and ordered list markers', () => {
    for (const source of ['- [', '  * [', '3. [']) {
      const result = complete(source);
      assert.ok(result, source);
      const task = result.options.find((item) => item.label === 'task');
      assert.ok(task, source);
      assert.equal(result.from, 0, source);
      assert.equal(task.label, 'task');
    }
    assert.equal(complete('prose - ['), null);
    assert.equal(complete('```md\\n- ['), null);
  });

  it('offers contextual heading, link, quote, and fence snippets only by explicit prefix', () => {
    for (const [prefix, label] of [
      ['h1', 'h1'],
      ['h6', 'h6'],
      ['link', 'link'],
      ['quote', 'quote'],
      ['fence', 'fence'],
    ]) {
      assert.ok(
        complete(prefix)?.options.some((item) => item.label === label),
        prefix,
      );
    }
    assert.equal(complete('ordinary prose'), null);
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
