// remark-math accepts whitespace before a closing dollar, so ordinary prices
// like "$100 qualifies; $50 is reduced" become one equation. Reparse those
// numeric, whitespace-ended spans with the currency dollars escaped. Working
// from math nodes keeps code, links, escaped dollars, and display math intact.
export function remarkQuizCurrency(this: any) {
  return (tree: any, file: any) => {
    let source = String(file);
    while (true) {
      const offsets = new Set<number>();
      const visit = (node: any) => {
        if (
          node.type === 'inlineMath' &&
          // A price followed by prose or another price; numeric equations
          // such as "$2 + 2 $" must keep their math delimiters.
          /^\d[\d,.]*(?:\s+(?:$|[a-z]{2,}\b|[`*])|[–—-]$)/i.test(node.value) &&
          /(?:\s|[–—-])$/.test(node.value)
        ) {
          const start = node.position?.start?.offset;
          const end = node.position?.end?.offset;
          if (
            start != null &&
            end != null &&
            source[start + 1] !== '$' &&
            source[end - 2] !== '$'
          ) {
            offsets.add(start);
            // The supposed closing delimiter can be the next price's opener.
            // Leave it available when it actually opens a following equation.
            if (/\d/.test(source[end] ?? '')) offsets.add(end - 1);
          }
        }
        for (const child of node.children ?? []) visit(child);
      };
      visit(tree);
      if (!offsets.size) return tree;
      for (const offset of [...offsets].sort((a, b) => b - a)) {
        source = `${source.slice(0, offset)}\\${source.slice(offset)}`;
      }
      tree = this.parse(source);
    }
  };
}
