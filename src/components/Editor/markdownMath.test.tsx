import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RevealWordAdapter } from './MarkdownPreview';
import { remarkTaskOffsets } from './markdownTasks';
import {
  markdownMathRemarkPlugin,
  markdownMathRehypePlugin,
} from './markdownMath';

function render(markdown: string, withPreviewSpans = false) {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          markdownMathRemarkPlugin,
          remarkGfm,
          () => remarkTaskOffsets(markdown),
        ],
        rehypePlugins: [markdownMathRehypePlugin],
        components: withPreviewSpans ? { span: RevealWordAdapter } : undefined,
      },
      markdown,
    ),
  );
}

describe('Markdown math preview', () => {
  it('renders inline and display math with KaTeX and MathML', () => {
    const html = render('Inline $x^2$\n\n$$\ny = mx + b\n$$');
    assert.match(html, /class="katex"/);
    assert.match(html, /class="katex-display"/);
    assert.match(html, /<math xmlns=/);
  });

  for (const [context, markdown] of [
    [
      'inline',
      String.raw`Frequency $B=f_{\max}-f_{\min}$ and $L=\frac{n(n-1)}{2}$.`,
    ],
    [
      'display',
      String.raw`$$
T=\frac{1}{5\times10^9}=2\times10^{-10}\ \text{s}=0.2\ \text{ns}=200\ \text{ps}.
$$`,
    ],
    [
      'table',
      String.raw`| Question | Relationship |
| --- | --- |
| Full-mesh links | $L=\frac{n(n-1)}{2}$ |
| Frequency bandwidth | $B=f_{\max}-f_{\min}$ |
| Ideal FDM count | $N=\lfloor B_{\text{available}}/B_{\text{channel}}\rfloor$ |`,
    ],
  ]) {
    it(`preserves native KaTeX layout through preview spans in ${context} math`, () => {
      const native = render(markdown);
      assert.match(native, /class="katex"/);
      assert.match(native, /style="[^"]*(?:vertical-align|top|height):/);
      assert.equal(render(markdown, true), native);
    });
  }

  it('leaves inline and fenced code containing dollar signs literal', () => {
    const html = render('`$x^2$`\n\n```txt\n$y^2$\n```');
    assert.match(html, /<code>\$x\^2\$<\/code>/);
    assert.match(html, /<code class="language-txt">\$y\^2\$\n<\/code>/);
    assert.doesNotMatch(html, /class="katex/);
  });

  it('keeps malformed math local without throwing during SSR', () => {
    const html = render('Before $\\frac{$ after');
    assert.match(html, /Before/);
    assert.match(html, /after/);
    assert.match(html, /katex-error/);
  });

  it('does not enable unsafe links, HTML, event attributes, or external images', () => {
    const html = render(
      '$\\href{javascript:alert(1)}{click}$ $\\htmlClass{pwned}{x}$ $\\includegraphics{https://evil.example/a.png}$\n\n<img src="https://evil.example/b.png" onerror="alert(1)">',
    );
    assert.doesNotMatch(html, /href="javascript:/i);
    assert.doesNotMatch(html, /<img[^>]+src="https:\/\//i);
    assert.doesNotMatch(html, /<[^>]+\sonerror=/i);
    assert.doesNotMatch(html, /class="pwned"/);
  });

  it('keeps task source offsets after math parsing in the production plugin order', () => {
    const source = '$x$\n\n- [ ] task';
    const html = render(source);
    assert.match(
      html,
      new RegExp(`data-task-offset="${source.indexOf('[ ]') + 1}"`),
    );
  });
});
