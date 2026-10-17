import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import MarkdownPreview from './MarkdownPreview';
import { DEFAULT_APPEARANCE } from '../../appearance';
import remarkGfm from 'remark-gfm';
import {
  remarkTaskOffsets,
  taskMarkerChange,
  taskToggleMatchesBinding,
} from './markdownTasks';

function render(markdown: string) {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, () => remarkTaskOffsets(markdown)],
        components: {
          li: ({ children, checked, node, ...props }: any) => {
            const offset = node?.properties['data-task-offset'];
            if (typeof checked !== 'boolean' || typeof offset !== 'number')
              return React.createElement('li', props, children);
            return React.createElement(
              'li',
              props,
              React.createElement('input', {
                type: 'checkbox',
                checked,
                readOnly: true,
                'data-offset': offset,
              }),
              children,
            );
          },
        },
      },
      markdown,
    ),
  );
}

describe('Markdown task preview', () => {
  it('renders actual preview checkboxes enabled for editing and disabled in read-only mode', () => {
    const source = '- [ ] one\n- [x] two';
    const renderPreview = (onToggleTask?: () => void) =>
      renderToStaticMarkup(
        React.createElement(MarkdownPreview, {
          markdown: source,
          vaultId: 'vault-a',
          notePath: 'tasks.md',
          appearance: DEFAULT_APPEARANCE,
          onToggleTask,
        }),
      );
    const activeHtml = renderPreview(() => {});
    const readOnlyHtml = renderPreview();

    assert.match(activeHtml, /<input type="checkbox"[^>]*\/>/);
    assert.doesNotMatch(activeHtml, /<input type="checkbox" disabled=""/);
    assert.equal((activeHtml.match(/type="checkbox"/g) ?? []).length, 2);
    assert.equal(
      (readOnlyHtml.match(/type="checkbox" disabled=""/g) ?? []).length,
      2,
    );
    assert.match(activeHtml, /data-task-offset="3"/);
    assert.match(activeHtml, /data-task-offset="13"/);
    assert.equal((activeHtml.match(/checked=""/g) ?? []).length, 1);
  });
  it('renders GFM task checkbox states and associates source marker offsets for duplicate tasks', () => {
    const source = '- [ ] same\n- [x] same';
    const html = render(source);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /data-task-offset="3"/);
    assert.match(html, /data-task-offset="14"/);
    assert.match(html, /checked=""/);
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  });

  it('finds offsets in nested and ordered task lists', () => {
    const source = '- parent\n  - [ ] nested\n\n2. [X] ordered';
    const html = render(source);
    assert.match(
      html,
      new RegExp(`data-task-offset="${source.indexOf('[ ]') + 1}"`),
    );
    assert.match(
      html,
      new RegExp(`data-task-offset="${source.indexOf('[X]') + 1}"`),
    );
    assert.match(html, /checked=""/);
  });

  it('handles quoted tasks and CRLF source positions', () => {
    const quoted = '> - [ ] quoted';
    assert.match(
      render(quoted),
      new RegExp(`data-task-offset="${quoted.indexOf('[ ]') + 1}"`),
    );
    const crlf = '- [ ] first\r\n- [ ] second';
    const html = render(crlf);
    assert.match(
      html,
      new RegExp(`data-task-offset="${crlf.indexOf('[ ]') + 1}"`),
    );
    assert.match(
      html,
      new RegExp(`data-task-offset="${crlf.lastIndexOf('[ ]') + 1}"`),
    );
  });

  it('ignores task-like text in inline and fenced code', () => {
    const html = render('`- [ ] inline`\n\n```md\n- [ ] fenced\n```');
    assert.doesNotMatch(html, /type="checkbox"/);
  });

  it('rejects task callbacks from another note or vault even when the source matches', () => {
    const payload = {
      vaultId: 'vault-a',
      notePath: 'same.md',
      source: '- [ ] same',
      offset: 3,
      expected: ' ',
    };
    assert.equal(
      taskToggleMatchesBinding(payload, {
        vaultId: 'vault-a',
        notePath: 'same.md',
      }),
      true,
    );
    assert.equal(
      taskToggleMatchesBinding(payload, {
        vaultId: 'vault-a',
        notePath: 'other.md',
      }),
      false,
    );
    assert.equal(
      taskToggleMatchesBinding(payload, {
        vaultId: 'vault-b',
        notePath: 'same.md',
      }),
      false,
    );
    assert.equal(taskToggleMatchesBinding(payload, null), false);
  });

  it('accepts only the current checkbox marker and toggles spaces or either x case', () => {
    assert.deepEqual(taskMarkerChange(3, ' ', '- [ ] task'), {
      from: 3,
      to: 4,
      insert: 'x',
    });
    assert.deepEqual(taskMarkerChange(3, 'X', '- [X] task'), {
      from: 3,
      to: 4,
      insert: ' ',
    });
    assert.equal(taskMarkerChange(3, 'x', '- [ ] task'), null);
    assert.equal(taskMarkerChange(99, ' ', '- [ ] task'), null);
    assert.equal(taskMarkerChange(-1, ' ', '- [ ] task'), null);
  });
});
