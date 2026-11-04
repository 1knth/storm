// Click-to-copy for rendered KaTeX. KaTeX keeps the original TeX in a MathML
// annotation, so one delegated listener serves every Markdown preview.

const MATH_ROOTS = '.markdown-preview-content, .quiz-agent-markdown';
// Math inside interactive controls (answer choices, links, the inline answer
// editor) keeps its own click behaviour.
const INTERACTIVE = 'label, button, a, [contenteditable="true"], .cm-editor';
const COPIED_MS = 1200;

export function getLatexCopyText(katex: Element): string | null {
  const tex = katex
    .querySelector('annotation[encoding="application/x-tex"]')
    ?.textContent?.trim();
  if (!tex) return null;
  return katex.closest('.katex-display') ? `$$\n${tex}\n$$` : `$${tex}$`;
}

export function findCopyableLatex(target: EventTarget | null): Element | null {
  const closest = (target as Element | null)?.closest;
  if (typeof closest !== 'function') return null;
  const katex = (target as Element).closest('.katex');
  if (!katex || !katex.closest(MATH_ROOTS) || katex.closest(INTERACTIVE))
    return null;
  return katex;
}

let installed = false;

export function installLatexCopy(doc: Document = document) {
  if (installed) return;
  installed = true;
  doc.addEventListener('mouseover', (event) => {
    const katex = findCopyableLatex(event.target);
    if (katex && !katex.hasAttribute('data-latex-copy')) {
      katex.setAttribute('data-latex-copy', '');
      katex.setAttribute('title', 'Click to copy LaTeX');
    }
  });
  doc.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const selection = doc.getSelection();
    // Leave drag-selecting text alone.
    if (selection && !selection.isCollapsed) return;
    const katex = findCopyableLatex(event.target);
    const text = katex && getLatexCopyText(katex);
    if (!katex || !text) return;
    event.preventDefault();
    void navigator.clipboard?.writeText(text).then(() => {
      katex.setAttribute('data-latex-copied', '');
      window.setTimeout(
        () => katex.removeAttribute('data-latex-copied'),
        COPIED_MS,
      );
    });
  });
}
