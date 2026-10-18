// Preserve physical blank source lines between top-level Markdown blocks. Keeping
// these as positioned HAST-compatible nodes makes them visible without changing
// the source or turning whitespace-only lines into Markdown content.
export function remarkBlankLines(source: string) {
  return (tree: any) => {
    if (tree.type !== 'root' || !Array.isArray(tree.children)) return;
    const lines = source.split('\n');
    const children: any[] = [];
    let nextLine = 1;
    const appendBlankLinesUntil = (line: number) => {
      for (let blankLine = nextLine; blankLine < line; blankLine++) {
        if (/^[\t ]*$/.test(lines[blankLine - 1] ?? '')) {
          children.push({
            type: 'blankLine',
            data: {
              hName: 'div',
              hProperties: {
                'aria-hidden': 'true',
                className: ['markdown-blank-line'],
              },
            },
            position: {
              start: { line: blankLine, column: 1, offset: 0 },
              end: { line: blankLine, column: 1, offset: 0 },
            },
          });
        }
      }
    };
    for (const child of tree.children) {
      const startLine = child.position?.start?.line;
      if (typeof startLine === 'number') appendBlankLinesUntil(startLine);
      children.push(child);
      const endLine = child.position?.end?.line;
      if (typeof endLine === 'number')
        nextLine = Math.max(nextLine, endLine + 1);
    }
    // Include real empty lines at the end, but not split()'s phantom after a
    // final newline: line count is the editor's physical-line count.
    const physicalLineCount = source.split('\n').length;
    appendBlankLinesUntil(physicalLineCount + 1);
    tree.children = children;
  };
}
