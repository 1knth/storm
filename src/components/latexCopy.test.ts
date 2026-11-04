import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findCopyableLatex, getLatexCopyText } from './latexCopy';

// Minimal Element stand-in: `ancestors` lists the selectors closest() matches.
function fakeKatex(tex: string | null, ancestors: string[]) {
  const el: any = {
    closest: (selector: string) =>
      selector === '.katex' ||
      selector.split(',').some((part) => ancestors.includes(part.trim()))
        ? el
        : null,
    querySelector: () => (tex === null ? null : { textContent: ` ${tex} ` }),
  };
  return el as Element;
}

describe('latex copy', () => {
  it('copies inline TeX with single dollars', () => {
    const el = fakeKatex('x^2', ['.quiz-agent-markdown']);
    assert.equal(findCopyableLatex(el), el);
    assert.equal(getLatexCopyText(el), '$x^2$');
  });

  it('copies display TeX with block delimiters', () => {
    const el = fakeKatex('\\frac{a}{b}', [
      '.markdown-preview-content',
      '.katex-display',
    ]);
    assert.equal(getLatexCopyText(el), '$$\n\\frac{a}{b}\n$$');
  });

  it('ignores math in choices, outside previews, or without source', () => {
    assert.equal(
      findCopyableLatex(fakeKatex('y', ['.quiz-agent-markdown', 'label'])),
      null,
    );
    assert.equal(findCopyableLatex(fakeKatex('z', [])), null);
    assert.equal(findCopyableLatex(null), null);
    assert.equal(getLatexCopyText(fakeKatex(null, [])), null);
  });
});
