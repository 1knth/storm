// Render ordinary Markdown line endings as visible line breaks without changing
// fenced/inline code or Markdown block structure.
export function remarkSoftBreaks() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!Array.isArray(node.children)) return;
      const children: any[] = [];
      for (const child of node.children) {
        if (child.type === 'text' && child.value.includes('\n')) {
          const lines = child.value.split('\n');
          let offset = child.position?.start?.offset;
          let line = child.position?.start?.line;
          let column = child.position?.start?.column;
          for (let index = 0; index < lines.length; index++) {
            if (lines[index]) {
              const value = lines[index];
              const start = { offset, line, column };
              children.push({
                ...child,
                value,
                ...(child.position
                  ? {
                      position: {
                        ...child.position,
                        start,
                        end: {
                          offset:
                            offset == null ? undefined : offset + value.length,
                          line,
                          column:
                            column == null ? undefined : column + value.length,
                        },
                      },
                    }
                  : {}),
              });
              offset = offset == null ? undefined : offset + value.length;
              column = column == null ? undefined : column + value.length;
            }
            if (index < lines.length - 1) {
              children.push({
                type: 'break',
                ...(child.position
                  ? {
                      position: {
                        start: {
                          offset,
                          line,
                          column,
                        },
                        end: {
                          offset: offset == null ? undefined : offset + 1,
                          line: line == null ? undefined : line + 1,
                          column: 1,
                        },
                      },
                    }
                  : {}),
              });
              offset = offset == null ? undefined : offset + 1;
              line = line == null ? undefined : line + 1;
              column = 1;
            }
          }
        } else {
          visit(child);
          children.push(child);
        }
      }
      node.children = children;
    };
    visit(tree);
  };
}
