import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import { rehypeRevealUnits } from './MarkdownPreview';
import { createRevealScheduleRegistry } from './managedPreviewBatch';

function revealTree(
  markdown: string,
  options: {
    startOffset?: number;
    revealRanges?: { from: number; to: number }[];
  } = {},
) {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .runSync(unified().use(remarkParse).use(remarkGfm).parse(markdown)) as any;
  rehypeRevealUnits({
    registry: createRevealScheduleRegistry(),
    startOffset: options.startOffset ?? 0,
    revealRanges: options.revealRanges,
    markdown,
  })(tree);
  return tree;
}

function find(node: any, tagName: string): any[] {
  return [
    ...(node.tagName === tagName ? [node] : []),
    ...(node.children ?? []).flatMap((child: any) => find(child, tagName)),
  ];
}

describe('Markdown preview styled reveal units', () => {
  it('reveals heading and mixed inline styles in source order without flattening structure', () => {
    const markdown = '# Title\n\nplain **bold** *italic* `code`';
    const tree = revealTree(markdown);
    const heading = find(tree, 'h1')[0];
    const paragraph = find(tree, 'p')[0];

    assert.ok(heading.properties.className.includes('markdown-prose-reveal'));
    assert.ok(paragraph.properties.className.includes('markdown-prose-reveal'));
    assert.ok(find(heading, 'span').length > 0);
    assert.equal(find(paragraph, 'strong').length, 1);
    assert.equal(find(paragraph, 'em').length, 1);
    assert.equal(find(paragraph, 'code').length, 1);
    assert.ok(
      find(paragraph, 'strong')[0].children.some(
        (node: any) => node.tagName === 'span',
      ),
    );
    assert.ok(
      find(paragraph, 'em')[0].children.some(
        (node: any) => node.tagName === 'span',
      ),
    );
    assert.ok(
      find(paragraph, 'code')[0].children.some(
        (node: any) => node.tagName === 'span',
      ),
    );

    const keys = find(tree, 'span')
      .map((node) => node.properties?.['data-reveal-key'])
      .filter(Boolean);
    const offsets = keys.map((key) => Number(key.split(':')[1]));
    assert.deepEqual(
      offsets,
      [...offsets].sort((a, b) => a - b),
    );
    assert.equal(keys.length, 5);
  });

  it('reveals blockquote prose while keeping fenced code as a separate block', () => {
    const markdown = '> quoted **bold**\n\n```js\nconst x = 1;\n```';
    const tree = revealTree(markdown);
    const quote = find(tree, 'blockquote')[0];
    const fenced = find(tree, 'pre')[0];

    assert.ok(quote);
    assert.equal(find(quote, 'strong').length, 1);
    assert.ok(find(quote, 'span').length > 0);
    assert.equal(quote.properties['data-reveal-decoration'], 'blockquote');
    assert.ok(Number.isFinite(quote.properties['data-reveal-decoration-at']));
    assert.equal(fenced.properties['data-reveal-kind'], 'block');
    assert.equal(find(fenced, 'span').length, 0);
  });

  it('treats each table as one scheduled atomic block between surrounding prose', () => {
    const markdown =
      'before table\n\n| Name | Value |\n| --- | --- |\n| alpha | beta |\n\nafter table';
    const tree = revealTree(markdown);
    const table = find(tree, 'table')[0];
    const blocks = find(tree, 'table').map((node) => ({
      key: node.properties['data-reveal-key'],
      kind: node.properties['data-reveal-kind'],
      offset: Number(node.properties['data-reveal-key'].split(':')[1]),
      scheduledAt: node.properties['data-reveal-at'],
    }));
    const words = find(tree, 'span').filter(
      (node) => node.properties['data-reveal-key'],
    );
    const tableSourceOffset = markdown.indexOf('| Name');

    assert.ok(table);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'block');
    assert.equal(blocks[0].offset, tableSourceOffset);
    assert.ok(Number.isFinite(blocks[0].scheduledAt));
    assert.equal(find(table, 'span').length, 0);
    const wordOffsets = words.map((word) =>
      Number(word.properties['data-reveal-key'].split(':')[1]),
    );
    assert.equal(wordOffsets.length, 4);
    assert.ok(
      wordOffsets.slice(0, 2).every((offset) => offset < tableSourceOffset),
    );
    assert.ok(
      wordOffsets.slice(2).every((offset) => offset > tableSourceOffset),
    );
    assert.ok(
      Math.max(
        ...words.slice(0, 2).map((word) => word.properties['data-reveal-at']),
      ) < blocks[0].scheduledAt,
    );
    assert.ok(
      blocks[0].scheduledAt <
        Math.min(
          ...words.slice(2).map((word) => word.properties['data-reveal-at']),
        ),
    );
  });

  it('keeps earlier pending table and code blocks gated across later append snapshots', () => {
    const registry = createRevealScheduleRegistry();
    const initial =
      'prose before\n\n| A | B |\n| - | - |\n| x | y |\n\n```txt\nresponse body\n```';
    const tableOffset = initial.indexOf('| A');
    const codeOffset = initial.indexOf('```txt');
    const render = (
      markdown: string,
      ranges: { from: number; to: number }[],
    ) => {
      const tree = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRehype)
        .runSync(
          unified().use(remarkParse).use(remarkGfm).parse(markdown),
        ) as any;
      rehypeRevealUnits({
        registry,
        startOffset: 0,
        revealRanges: ranges,
        markdown,
      })(tree);
      return tree;
    };
    const first = render(initial, [
      { from: tableOffset, to: tableOffset + 2 },
      { from: codeOffset, to: codeOffset + 2 },
    ]);
    const firstKeys = [
      find(first, 'table')[0].properties['data-reveal-key'],
      find(first, 'pre')[0].properties['data-reveal-key'],
    ];
    assert.ok(firstKeys.every((key) => key && registry.words.has(key)));

    const appended = `${initial}\n\nlatest appended prose`;
    const latestOffset = appended.indexOf('latest appended');
    const next = render(appended, [
      { from: latestOffset, to: appended.length },
    ]);
    assert.deepEqual(
      [
        find(next, 'table')[0].properties['data-reveal-key'],
        find(next, 'pre')[0].properties['data-reveal-key'],
      ],
      firstKeys,
    );
  });

  it('only schedules tables whose source intersects the requested reveal range', () => {
    const markdown = 'old prose\n\n| A | B |\n| - | - |\n| x | y |';
    const table = markdown.indexOf('| A');
    const unrelated = revealTree(markdown, {
      revealRanges: [{ from: 0, to: 9 }],
    });
    const matching = revealTree(markdown, {
      revealRanges: [{ from: table + 1, to: table + 3 }],
    });

    assert.equal(
      find(unrelated, 'table')[0].properties['data-reveal-key'],
      undefined,
    );
    assert.equal(
      find(matching, 'table')[0].properties['data-reveal-kind'],
      'block',
    );
  });

  it('keeps existing reveal slots stable when a live paragraph snapshot grows', () => {
    const registry = createRevealScheduleRegistry();
    const first = '# Heading\n\nType `inline code`';
    const next = `${first} then more words`;
    const render = (markdown: string) => {
      const tree = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRehype)
        .runSync(
          unified().use(remarkParse).use(remarkGfm).parse(markdown),
        ) as any;
      rehypeRevealUnits({ registry, startOffset: 0, markdown })(tree);
      return tree;
    };
    const firstTree = render(first);
    const before = new Map(
      find(firstTree, 'span').map((word) => [
        word.properties['data-reveal-key'],
        word.properties['data-reveal-at'],
      ]),
    );
    const nextTree = render(next);
    const nextWords = find(nextTree, 'span');
    const nextSlots = new Map(
      nextWords.map((word) => [
        word.properties['data-reveal-key'],
        word.properties['data-reveal-at'],
      ]),
    );

    for (const [key, scheduledAt] of before) {
      assert.equal(
        nextSlots.get(key),
        scheduledAt,
        `existing slot changed: ${key}`,
      );
    }
    const finalTree = render(`${first} then more words and another edit`);
    const finalWords = find(finalTree, 'span');
    for (const word of finalWords) {
      const key = word.properties['data-reveal-key'];
      if (nextSlots.has(key))
        assert.equal(
          word.properties['data-reveal-at'],
          nextSlots.get(key),
          `slot changed on third snapshot: ${key}`,
        );
    }
    assert.ok(
      finalWords.some(
        (word) => !nextSlots.has(word.properties['data-reveal-key']),
      ),
    );
    const code = find(nextTree, 'code')[0];
    assert.equal(code.properties['data-reveal-decoration'], 'code');
    assert.equal(
      code.properties['data-reveal-decoration-at'],
      find(code, 'span')[0].properties['data-reveal-at'],
    );
    assert.ok(
      nextWords.some((word) => !before.has(word.properties['data-reveal-key'])),
    );
  });

  it('schedules list markers and nested quote decoration with the first revealed word', () => {
    const tree = revealTree('- first **bold**\n\n- second item');
    const listItems = find(tree, 'li');
    const nestedTree = revealTree('- first\n  > nested quote');
    const quote = find(nestedTree, 'blockquote')[0];

    assert.equal(listItems.length, 2);
    for (const item of listItems) {
      const firstWord = find(item, 'span')[0];
      assert.ok(firstWord);
      assert.equal(
        item.properties['data-reveal-decoration-at'],
        firstWord.properties['data-reveal-at'],
      );
    }
    const taskTree = revealTree('- [ ] task item');
    const task = find(taskTree, 'li')[0];
    assert.equal(
      task.properties['data-reveal-decoration-at'],
      find(task, 'span')[0].properties['data-reveal-at'],
    );
    assert.equal(quote.properties['data-reveal-decoration'], 'blockquote');
    assert.equal(
      quote.properties['data-reveal-decoration-at'],
      find(quote, 'span')[0].properties['data-reveal-at'],
    );
  });
});
