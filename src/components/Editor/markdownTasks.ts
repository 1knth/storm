export function remarkTaskOffsets(source: string) {
  return (tree: any) => {
    const visit = (node: any) => {
      if (node.type === 'listItem' && node.position) {
        const start = node.position.start.offset;
        const lineEnd = source.indexOf('\n', start);
        const line = source
          .slice(start, lineEnd < 0 ? source.length : lineEnd)
          .replace(/\r$/, '');
        const marker =
          /^(?: {0,3}(?:[-+*]|\d+[.)])[ \t]+)\[([ xX])\](.*)$/.exec(line);
        const paragraph = node.children?.[0];
        const emptyTaskLabel =
          marker &&
          /^[ \t]*$/.test(marker[2]) &&
          node.checked === null &&
          node.children.length === 1 &&
          paragraph?.type === 'paragraph' &&
          paragraph.children?.length === 1 &&
          paragraph.children[0].type === 'text' &&
          paragraph.children[0].value ===
            marker[0].slice(marker[0].indexOf('['), marker[0].indexOf(']') + 1);

        if (emptyTaskLabel) {
          node.checked = marker[1].toLowerCase() === 'x';
          paragraph.children = [];
        }

        if (typeof node.checked === 'boolean' && marker) {
          node.data ??= {};
          node.data.hProperties = {
            ...node.data.hProperties,
            'data-task-offset': start + marker[0].indexOf('[') + 1,
          };
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

export type TaskTogglePayload = {
  vaultId: string;
  notePath: string;
  source: string;
  offset: number;
  expected: string;
};

export function taskToggleMatchesBinding(
  payload: TaskTogglePayload,
  binding: { vaultId: string; notePath: string } | null,
): boolean {
  return (
    !!binding &&
    payload.vaultId === binding.vaultId &&
    payload.notePath === binding.notePath
  );
}

export function taskMarkerChange(
  offset: number,
  expected: string,
  source: string,
): { from: number; to: number; insert: string } | null {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    (expected !== ' ' && expected !== 'x' && expected !== 'X') ||
    source[offset] !== expected
  )
    return null;
  return { from: offset, to: offset + 1, insert: expected === ' ' ? 'x' : ' ' };
}
