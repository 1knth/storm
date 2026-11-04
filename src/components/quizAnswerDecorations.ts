import type { EditorState } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/** Source ranges are kept intact: moving into a preview reveals the original text. */
export function answerPreviewRanges(state: EditorState, focused: boolean) {
  const ranges: { from: number; to: number; block: boolean }[] = [];
  const active = (from: number, to: number) =>
    focused &&
    state.selection.ranges.some((selection) =>
      selection.empty
        ? selection.from >= from && selection.from <= to
        : selection.from < to && selection.to > from,
    );
  const tree = syntaxTree(state);
  for (let block = tree.topNode.firstChild; block; block = block.nextSibling) {
    if (!active(block.from, block.to)) {
      ranges.push({ from: block.from, to: block.to, block: true });
      continue;
    }
    // Keep block structure editable; replace only complete inline constructs.
    const inline: { from: number; to: number }[] = [];
    const protectedRanges: { from: number; to: number }[] = [];
    tree.iterate({
      from: block.from,
      to: block.to,
      enter(node) {
        if (
          ['FencedCode', 'CodeBlock', 'InlineCode', 'Link', 'Image'].includes(
            node.name,
          )
        )
          protectedRanges.push({ from: node.from, to: node.to });
        if (
          ['StrongEmphasis', 'Emphasis', 'InlineCode', 'Link'].includes(
            node.name,
          )
        )
          inline.push({ from: node.from, to: node.to });
      },
    });
    if (block.name === 'Paragraph') {
      const text = state.sliceDoc(block.from, block.to);
      const escaped = (offset: number) => {
        let count = 0;
        while (offset > 0 && text[--offset] === '\\') count++;
        return count % 2 === 1;
      };
      const math =
        /\$\$[^\n]+?\$\$|\$[^$\n]+?\$|\\\([^\n]*?\\\)|\\\[[^\n]*?\\\]/g;
      for (const match of text.matchAll(math)) {
        const from = block.from + match.index;
        const to = from + match[0].length;
        if (
          escaped(match.index) ||
          (match[0][0] === '$' && escaped(match.index + match[0].length - 1))
        )
          continue;
        if (protectedRanges.some((range) => from < range.to && to > range.from))
          continue;
        // Match the renderer's ordinary-price exception.
        if (
          match[0][0] === '$' &&
          match[0][1] !== '$' &&
          /^\d[\d,.]*(?:\s+(?:$|[a-z]{2,}\b|[`*])|[–—-]$)/i.test(
            match[0].slice(1, -1),
          ) &&
          /(?:\s|[–—-])$/.test(match[0].slice(1, -1))
        )
          continue;
        inline.push({ from, to });
      }
    }
    // Prefer outer constructs, avoiding overlapping CodeMirror replacements.
    inline.sort((a, b) => a.from - b.from || b.to - a.to);
    let end = -1;
    for (const range of inline) {
      if (range.from < end) continue;
      if (!active(range.from, range.to)) {
        ranges.push({ ...range, block: false });
        end = range.to;
      }
    }
  }
  return ranges;
}
