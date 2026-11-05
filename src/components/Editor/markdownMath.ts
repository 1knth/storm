import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export const markdownMathRemarkPlugin = [
  remarkMath,
  { singleDollarTextMath: true },
] as [typeof remarkMath, { singleDollarTextMath: boolean }];

export const markdownMathRehypePlugin = [
  rehypeKatex,
  {
    trust: false,
    strict: 'warn' as const,
    throwOnError: false,
    maxExpand: 1000,
    maxSize: 10,
  },
] as [
  typeof rehypeKatex,
  {
    trust: boolean;
    strict: 'warn';
    throwOnError: boolean;
    maxExpand: number;
    maxSize: number;
  },
];

// remark-math closes a display block only on a line holding nothing but
// `$$`. When a closer lands mid-line (`… = q.$$ **Next point**`), the block
// never closes and swallows every following line, turning the rest of the
// message into one KaTeX error. Close such blocks at that `$$`, or at the
// first blank line if no closer exists, and parse the remainder as ordinary
// Markdown. Positions stay in original source offsets, so offset-based
// plugins (tasks, reveal units, currency) keep working.
const CLOSING_FENCE = /^[ \t>]*\${2,}[ \t]*$/;

function findSplit(source: string, from: number, to: number) {
  for (let i = from; i < to; i++) {
    const ch = source[i];
    if (ch === '$' && source[i + 1] === '$') {
      let slashes = 0;
      for (let j = i - 1; j >= 0 && source[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return { mathEnd: i, restStart: i + 2 };
      i++;
    } else if (ch === '\n') {
      const next = source.indexOf('\n', i + 1);
      const lineEnd = next === -1 || next > to ? to : next;
      if (/^[ \t>]*$/.test(source.slice(i + 1, lineEnd)) && lineEnd < to)
        return { mathEnd: i, restStart: i };
    }
  }
  return null;
}

export function remarkDisplayMathRecovery(this: any) {
  const parse = (markdown: string) => this.parse(markdown);
  return (tree: any, file: any) => {
    const source = String(file);
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++)
      if (source[i] === '\n') lineStarts.push(i + 1);
    const point = (offset: number) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return { line: lo + 1, column: offset - lineStarts[lo] + 1, offset };
    };

    // Container continuation lines (list indentation, `>` quote markers)
    // carry up to `width` prefix characters that are not content.
    const stripPrefixes = (start: number, end: number, width: number) => {
      const pieces: { text: string; origin: number; at: number }[] = [];
      let text = '';
      let lineStart = start;
      let first = true;
      while (lineStart <= end) {
        const nl = source.indexOf('\n', lineStart);
        const lineEnd = nl === -1 || nl >= end ? end : nl;
        let skip = 0;
        if (!first)
          while (skip < width && /[ \t>]/.test(source[lineStart + skip] ?? ''))
            skip++;
        pieces.push({ text, origin: lineStart + skip, at: text.length });
        text += source.slice(lineStart + skip, lineEnd);
        if (lineEnd >= end) break;
        text += '\n';
        lineStart = lineEnd + 1;
        first = false;
      }
      const toOrigin = (offset: number) => {
        let k = pieces.length - 1;
        while (k > 0 && pieces[k].at > offset) k--;
        return pieces[k].origin + (offset - pieces[k].at);
      };
      return { text, toOrigin };
    };

    const shift = (node: any, toOrigin: (offset: number) => number) => {
      if (node.position) {
        node.position = {
          start: point(toOrigin(node.position.start.offset)),
          end: point(toOrigin(node.position.end.offset)),
        };
      }
      for (const child of node.children ?? []) shift(child, toOrigin);
    };

    const repair = (parent: any) => {
      const children = parent.children;
      if (!children) return;
      for (let index = 0; index < children.length; index++) {
        const node = children[index];
        if (node.type !== 'math') {
          repair(node);
          continue;
        }
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (start == null || end == null) continue;
        const openerEnd = source.indexOf('\n', start);
        if (openerEnd === -1 || openerEnd >= end) continue;
        const lastLine = source.slice(
          source.lastIndexOf('\n', end - 1) + 1,
          end,
        );
        if (CLOSING_FENCE.test(lastLine)) continue;

        const split = findSplit(source, openerEnd, end);
        if (!split) continue;
        const width = start - (source.lastIndexOf('\n', start - 1) + 1);
        const body = stripPrefixes(start, split.mathEnd, width)
          .text.replace(/^\$+/, '')
          .trim();
        node.value = body;
        node.meta = null;
        node.data.hChildren[0].children = [{ type: 'text', value: body }];
        node.position = { start: point(start), end: point(split.restStart) };

        const rest = stripPrefixes(split.restStart, end, width);
        if (!rest.text.trim()) continue;
        const restTree = parse(rest.text);
        shift(restTree, rest.toOrigin);
        // The remainder can hold its own broken block.
        repair(restTree);
        children.splice(index + 1, 0, ...restTree.children);
      }
    };
    repair(tree);
  };
}
