import {
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from '@codemirror/state';

export type MarkdownFormatKind = 'bold' | 'italic';

export function formatMarkdownSelection(
  state: EditorState,
  kind: MarkdownFormatKind,
): TransactionSpec {
  const marker = kind === 'bold' ? '**' : '*';
  return state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
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
      from = range.from;
      to = range.to;
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
