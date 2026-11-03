// Normalize LaTeX delimiters before Markdown consumes their backslashes as
// punctuation escapes. Use parsed code ranges to keep examples literal.
export function remarkQuizLatexDelimiters(this: any) {
  return (tree: any, file: any) => {
    const source = String(file);
    const codeRanges: [number, number][] = [];
    const visit = (node: any) => {
      if (node.type === 'code' || node.type === 'inlineCode') {
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (start != null && end != null) codeRanges.push([start, end]);
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
    const normalized = source.replace(
      /\\\[([\s\S]*?)\\\]|\\\(([^\n]*?)\\\)/g,
      (match, display, inline, offset) => {
        let precedingSlashes = 0;
        for (let i = offset - 1; i >= 0 && source[i] === '\\'; i--)
          precedingSlashes++;
        if (
          precedingSlashes % 2 ||
          codeRanges.some(
            ([start, end]) => offset < end && offset + match.length > start,
          )
        )
          return match;
        if (display == null) return `$${inline}$`;
        // Keep the block inside its list item or blockquote: continuation
        // lines need the same indentation or quote prefix as the opener.
        const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
        const prefix = source.slice(lineStart, offset);
        const lines = display
          .trim()
          .split('\n')
          .map((line: string) => line.trim());
        // Display delimiters used mid-sentence cannot open a block without
        // splitting the paragraph; render that equation inline instead.
        if (!/^[ \t>]*$/.test(prefix)) return `$$${lines.join(' ')}$$`;
        const body = lines.map((line: string) => `${prefix}${line}`).join('\n');
        return `$$\n${body}\n${prefix}$$`;
      },
    );
    if (normalized === source) return tree;
    // Later source-based transforms (including currency handling) must use
    // the same offsets as the reparsed tree.
    file.value = normalized;
    return this.parse(normalized);
  };
}
