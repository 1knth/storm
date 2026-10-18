type Position = {
  start: { offset?: number; line: number; column: number };
  end: { offset?: number; line: number; column: number };
};
type Node = {
  type: string;
  value?: string;
  children?: Node[];
  position?: Position;
  [key: string]: any;
};

const listMarker = /^(?:[-+*]|\d+[.)])[ \t]+/;

// Promote only root-level lazy lines. Indented continuations and non-paragraph
// blocks remain under their list item; this intentionally is not a rewriter.
export function remarkListContinuations(source: string) {
  return (tree: Node) => {
    if (!Array.isArray(tree.children)) return;
    const roots: Node[] = [];
    for (const block of tree.children) {
      if (block.type !== 'list' || !Array.isArray(block.children)) {
        roots.push(block);
        continue;
      }
      let currentItems: Node[] = [];
      let itemsBeforeSegment = 0;
      const flush = () => {
        if (currentItems.length) {
          roots.push({
            ...block,
            ...(block.ordered
              ? { start: (block.start ?? 1) + itemsBeforeSegment }
              : {}),
            children: currentItems,
          });
          itemsBeforeSegment += currentItems.length;
        }
        currentItems = [];
      };
      for (const item of block.children) {
        const paragraph = item.children?.[0];
        const boundary = findBoundary(paragraph, source);
        if (boundary == null || item.children?.length !== 1) {
          currentItems.push(item);
          continue;
        }
        const split = splitParagraph(paragraph!, boundary);
        if (!split) {
          currentItems.push(item);
          continue;
        }
        currentItems.push({ ...item, children: [split.before] });
        flush();
        roots.push(split.after);
      }
      flush();
    }
    tree.children = roots;
  };
}

function findBoundary(
  paragraph: Node | undefined,
  source: string,
): number | undefined {
  const position = paragraph?.position;
  if (
    paragraph?.type !== 'paragraph' ||
    !position?.start.offset ||
    !position.end.line
  )
    return;
  for (let line = position.start.line + 1; line <= position.end.line; line++) {
    const offset = lineOffset(source, line);
    if (offset == null) continue;
    const end = source.indexOf('\n', offset);
    const text = source
      .slice(offset, end < 0 ? source.length : end)
      .replace(/\r$/, '');
    if (
      !text ||
      /^\s/.test(text) ||
      listMarker.test(text) ||
      /^(?:#{1,6})(?:\s|$)/.test(text) ||
      /^(```|~~~)/.test(text)
    )
      continue;
    return offset;
  }
}

function lineOffset(source: string, line: number): number | undefined {
  let offset = 0;
  for (let current = 1; current < line; current++) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) return;
    offset = newline + 1;
  }
  return offset;
}

function splitParagraph(
  paragraph: Node,
  offset: number,
): { before: Node; after: Node } | undefined {
  const before: Node[] = [];
  const after: Node[] = [];
  let splitSeen = false;
  for (const child of paragraph.children ?? []) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (
      child.type === 'text' &&
      typeof start === 'number' &&
      typeof end === 'number' &&
      start < offset &&
      end > offset
    ) {
      const index = offset - start;
      if (child.value?.[index - 1] !== '\n' || !child.value.slice(index).length)
        return;
      const leftValue = child.value.slice(0, index - 1);
      const rightValue = child.value.slice(index);
      const splitPosition = {
        line: child.position!.end.line,
        column: 1,
        offset,
      };
      if (leftValue)
        before.push({
          ...child,
          value: leftValue,
          position: { ...child.position!, end: splitPosition },
        });
      if (rightValue)
        after.push({
          ...child,
          value: rightValue,
          position: { ...child.position!, start: splitPosition },
        });
      splitSeen = true;
      continue;
    }
    if (!splitSeen && typeof end === 'number' && end <= offset)
      before.push(child);
    else if (typeof start === 'number' && start >= offset) {
      splitSeen = true;
      after.push(child);
    } else return; // A formatted inline node straddles the boundary.
  }
  if (!splitSeen || !before.length || !after.length) return;
  return {
    before: {
      ...paragraph,
      children: before,
      position: {
        ...paragraph.position!,
        end: {
          line: paragraph.position!.end.line,
          column: paragraph.position!.end.column,
          offset,
        },
      },
    },
    after: {
      ...paragraph,
      children: after,
      position: {
        ...paragraph.position!,
        start: { line: paragraph.position!.start.line, column: 1, offset },
      },
    },
  };
}
