import {
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state';

export type MarkdownFormatKind =
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'link';

export function formatMarkdownSelection(
  state: EditorState,
  kind: MarkdownFormatKind,
): TransactionSpec {
  const marker =
    kind === 'bold'
      ? '**'
      : kind === 'italic'
        ? '*'
        : kind === 'strikethrough'
          ? '~~'
          : kind === 'code'
            ? '`'
            : '';
  return state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    if (kind === 'link') {
      const before = state.sliceDoc(range.from - 1, range.from);
      const after = state.sliceDoc(range.to, range.to + 1);
      if (
        selected &&
        before === '[' &&
        after === ']' &&
        state.sliceDoc(range.to + 1, range.to + 2) === '('
      ) {
        const end = state.doc.lineAt(range.to).to;
        const close = state.sliceDoc(range.to + 2, end).indexOf(')');
        if (close >= 0) {
          const urlEnd = range.to + 2 + close;
          return {
            changes: { from: range.from - 1, to: urlEnd + 1, insert: selected },
            range: EditorSelection.range(range.from - 1, range.to - 1),
          };
        }
      }
      const insert = selected ? `[${selected}]()` : '[text](https://)';
      const from = range.from;
      const labelFrom = from + 1;
      const anchor = selected ? from + selected.length + 3 : labelFrom;
      const head = selected ? anchor : labelFrom + 4;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.range(anchor, head),
      };
    }

    const before = state.sliceDoc(range.from - marker.length, range.from);
    const after = state.sliceDoc(range.to, range.to + marker.length);
    let from = range.from;
    let to = range.to;
    let insert = `${marker}${selected}${marker}`;
    let anchor = range.anchor + marker.length;
    let head = range.head + marker.length;

    if (selected && before === marker && after === marker) {
      from = range.from - marker.length;
      to = range.to + marker.length;
      insert = selected;
      anchor = range.anchor - marker.length;
      head = range.head - marker.length;
    } else if (
      selected.startsWith(marker) &&
      selected.endsWith(marker) &&
      selected.length >= marker.length * 2
    ) {
      insert = selected.slice(marker.length, -marker.length);
      anchor =
        range.anchor + (range.anchor <= range.head ? 0 : -marker.length * 2);
      head = range.head + (range.anchor <= range.head ? -marker.length * 2 : 0);
    } else if (!selected) {
      insert = marker + marker;
      anchor = head = range.from + marker.length;
    }

    return {
      changes: { from, to, insert },
      range: EditorSelection.range(anchor, head),
    };
  });
}
