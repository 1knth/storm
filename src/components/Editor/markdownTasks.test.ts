import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MarkdownPreview from './MarkdownPreview';
import { DEFAULT_APPEARANCE } from '../../appearance';
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
  it('reveals every prose word across real Markdown plugins', () => {
    const source = [
      'One **bold word** and *italic text* with [linked words](https://example.com) here.',
      'Second paragraph has several ordinary words for preview reveals.',
      'Third paragraph includes more words beyond the first few spans.',
    ].join('\n\n');
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: source,
        vaultId: 'vault-a',
        notePath: 'all-words.md',
        appearance: DEFAULT_APPEARANCE,
        revealStartLine: 1,
        revealId: 'all-words-regression',
      }),
    );
    const spans = [
      ...html.matchAll(
        /<span[^>]*data-preview-reveal-word[^>]*data-reveal-key="([^"]+)"[^>]*>(.*?)<\/span>/g,
      ),
    ];
    const expectedWords =
      [
        'One bold word and italic text with linked words here.',
        'Second paragraph has several ordinary words for preview reveals.',
        'Third paragraph includes more words beyond the first few spans.',
      ]
        .join(' ')
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    assert.equal(spans.length, expectedWords.length, html);
    assert.equal(new Set(spans.map((match) => match[1])).size, spans.length);
    assert.ok(spans.every((match) => match[1].length > 0));
    assert.equal(
      (html.match(/class="markdown-prose-reveal"/g) ?? []).length,
      3,
    );
  });
  it('renders appended words with per-unit scheduled delays, not ordinal multiplication', () => {
    const originalNow = Date.now;
    Date.now = () => 1_000;
    try {
      const html = renderToStaticMarkup(
        React.createElement(MarkdownPreview, {
          markdown: 'A quick brown fox',
          vaultId: 'vault',
          notePath: 'note.md',
          appearance: DEFAULT_APPEARANCE,
          revealStartLine: 1,
          revealId: 'generation-test',
        }),
      );
      assert.match(html, /data-preview-reveal-word/);
      const delays = [...html.matchAll(/animation-delay:([0-9.]+)ms/g)].map(
        (match) => Number(match[1]),
      );
      assert.equal(delays.length, 4);
      assert.deepEqual(
        delays.slice(1).map((delay, index) => delay - delays[index]),
        [150, 150, 150],
      );
    } finally {
      Date.now = originalNow;
    }
  });
  it('renders one accessible-hidden spacer per top-level physical blank line', () => {
    const spacerCount = (source: string) => {
      const html = renderToStaticMarkup(
        React.createElement(MarkdownPreview, {
          markdown: source,
          vaultId: 'vault-a',
          notePath: 'blank-lines.md',
          appearance: DEFAULT_APPEARANCE,
        }),
      );
      return (html.match(/class="markdown-blank-line"/g) ?? []).length;
    };

    assert.equal(spacerCount('first\n\nsecond'), 1);
    assert.equal(spacerCount('first\n\n\n\nsecond'), 3);
    assert.equal(spacerCount('\nfirst'), 1);
    assert.equal(spacerCount('first\n'), 1);
    assert.equal(spacerCount('first\n\n'), 2);
    assert.equal(spacerCount('first\n \t\nsecond'), 1);
    assert.equal(spacerCount('```text\nfirst\n\nsecond\n```'), 0);
  });
  it('promotes root-level unindented lines after a task to a paragraph', () => {
    const source = '- [x] label\na\nkjk\ndaw';
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: source,
        vaultId: 'vault-a',
        notePath: 'lazy-task.md',
        appearance: DEFAULT_APPEARANCE,
        onToggleTask: () => {},
      }),
    );
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 1);
    assert.match(html, /data-task-offset="3"/);
    assert.match(html, /<p[^>]*>a<br[^>]*>\s*kjk<br[^>]*>\s*daw<\/p>/);
    assert.ok(html.indexOf('</ul>') < html.indexOf('<p'));
  });

  it('keeps indented continuations in a list item and splits later root content', () => {
    const source = '2. task\n  continuation\n3. second\noutside\n4. third';
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: source,
        vaultId: 'vault-a',
        notePath: 'ordered-lazy.md',
        appearance: DEFAULT_APPEARANCE,
      }),
    );
    assert.match(html, /<ol start="2"[^>]*>[\s\S]*?continuation[\s\S]*?<\/ol>/);
    assert.match(html, /<ol start="2"/);
    assert.match(html, /<p[^>]*>outside<\/p>/);
  });
  it('renders ordinary Markdown text only once in preview', () => {
    const source =
      '### Learning Switches:\n\n- MAC (PHY) Address\n- Forwarding frames';
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: source,
        vaultId: 'vault-a',
        notePath: 'notes.md',
        appearance: DEFAULT_APPEARANCE,
      }),
    );

    for (const text of [
      'Learning Switches:',
      'MAC (PHY) Address',
      'Forwarding frames',
    ]) {
      assert.equal(
        html.split(text).length - 1,
        1,
        `${text} should render once`,
      );
    }
  });

  it('preserves ordinary source newlines as preview line breaks without changing paragraphs or code', () => {
    const source =
      'first line\nsecond line\n\nnew paragraph\n\n```text\ncode\nline\n```';
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: source,
        vaultId: 'vault-a',
        notePath: 'lines.md',
        appearance: DEFAULT_APPEARANCE,
      }),
    );
    assert.match(html, /first line<br[^>]*>\s*second line/);
    assert.match(html, /<p[^>]*>new paragraph<\/p>/);
    assert.match(html, /<code class="language-text"[^>]*>code\nline/);
  });

  it('preserves task body line breaks and the task marker source offset', () => {
    const source = '- [ ] first line\n  second line';
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: source,
        vaultId: 'vault-a',
        notePath: 'task-lines.md',
        appearance: DEFAULT_APPEARANCE,
        onToggleTask: () => {},
      }),
    );
    assert.match(html, /data-task-offset="3"/);
    assert.match(html, /first line<br[^>]*>\s*second line/);
  });

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
    assert.match(activeHtml, /<li[^>]*style="list-style-type:none"/);
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

  it('renders wiki note links with labels without rewriting code or image embeds', () => {
    const source =
      '[[note]] [[folder/note|A & B]] ![[image|240]] `[[inline]]`' +
      '\n\n```md\n[[fenced]]\n```';
    const html = renderToStaticMarkup(
      React.createElement(MarkdownPreview, {
        markdown: source,
        vaultId: 'vault-a',
        notePath: 'folder/current.md',
        appearance: DEFAULT_APPEARANCE,
        onOpenNote: () => {},
      }),
    );
    assert.match(html, /<a[^>]*>note<\/a>/);
    assert.match(html, /<a[^>]*>A &amp; B<\/a>/);
    assert.match(html, /Loading image…/);
    assert.match(html, /<code[^>]*>\[\[inline\]\]<\/code>/);
    assert.match(html, /<code class="language-md"[^>]*>\[\[fenced\]\]/);
    assert.doesNotMatch(html, /<a[^>]*>inline<\/a>|<a[^>]*>fenced<\/a>/);
  });

  it('renders empty task markers with preserved state and source offsets', () => {
    const sources = [
      '- [ ]',
      '- [x] ',
      '- [ ]   ',
      '  - [X]',
      '  1. [x]',
      '2. [ ]',
      '- [ ]\n',
    ];
    for (const source of sources) {
      const activeHtml = renderToStaticMarkup(
        React.createElement(MarkdownPreview, {
          markdown: source,
          vaultId: 'vault-a',
          notePath: 'empty-task.md',
          appearance: DEFAULT_APPEARANCE,
          onToggleTask: () => {},
        }),
      );
      const readOnlyHtml = renderToStaticMarkup(
        React.createElement(MarkdownPreview, {
          markdown: source,
          vaultId: 'vault-a',
          notePath: 'empty-task.md',
          appearance: DEFAULT_APPEARANCE,
        }),
      );
      const markerOffset = source.indexOf('[') + 1;
      assert.equal(
        (activeHtml.match(/type="checkbox"/g) ?? []).length,
        1,
        source,
      );
      assert.match(
        activeHtml,
        new RegExp(`data-task-offset="${markerOffset}"`),
      );
      assert.match(
        activeHtml,
        /aria-label="Mark task (?:complete|incomplete)"/,
      );
      assert.doesNotMatch(activeHtml, /type="checkbox" disabled=""/);
      assert.match(readOnlyHtml, /type="checkbox" disabled=""/);
      assert.equal(
        (activeHtml.match(/checked=""/g) ?? []).length,
        /\[x\]|\[X\]/.test(source) ? 1 : 0,
      );
    }
  });

  it('renders tight, loose, and nested task items through the actual preview', () => {
    const source =
      '```mermaid\nflowchart TD\nA --> B\n```\n\n' +
      '- [x] loose checked\n\n' +
      '- [ ] loose unchecked\n' +
      '- ordinary list item\n' +
      '  - [X] nested checked\n' +
      '- [ ]   '; // empty label with trailing spaces
    const preview = (onToggleTask?: () => void) =>
      renderToStaticMarkup(
        React.createElement(MarkdownPreview, {
          markdown: source,
          vaultId: 'vault-a',
          notePath: 'mixed-tasks.md',
          appearance: DEFAULT_APPEARANCE,
          onToggleTask,
        }),
      );
    const html = preview(() => {});
    const readOnlyHtml = preview();

    const taskOffsets = [
      source.indexOf('[x]') + 1,
      source.indexOf('[ ]') + 1,
      source.indexOf('[X]') + 1,
      source.lastIndexOf('[ ]') + 1,
    ];
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 4);
    assert.equal((html.match(/style="list-style-type:none"/g) ?? []).length, 4);
    assert.equal((html.match(/checked=""/g) ?? []).length, 2);
    for (const offset of taskOffsets)
      assert.match(html, new RegExp(`data-task-offset="${offset}"`));
    assert.match(html, /<p[^>]*>ordinary list item<\/p>/);
    assert.match(html, /aria-label="Rendering diagram"/);
    assert.doesNotMatch(html, /type="checkbox" disabled=""/);
    assert.equal(
      (readOnlyHtml.match(/type="checkbox" disabled=""/g) ?? []).length,
      4,
    );
    for (const offset of taskOffsets) {
      const expected = source[offset];
      assert.ok(expected === ' ' || expected === 'x' || expected === 'X');
      assert.deepEqual(taskMarkerChange(offset, expected, source), {
        from: offset,
        to: offset + 1,
        insert: expected === ' ' ? 'x' : ' ',
      });
    }
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

  it('ignores task-like text in prose, inline and fenced code', () => {
    const html = render(
      'ordinary [ ] prose\n\n`- [ ] inline`\n\n```md\n- [ ] fenced\n```',
    );
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
