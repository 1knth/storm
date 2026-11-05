import { EditorSelection } from '@codemirror/state';
import type { SelectionRange } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { CodeMirror, getCM, Vim } from '@replit/codemirror-vim';

// The upstream gj/gk fallback at the document edge asks posAtCoords for a point
// below the content; a miss becomes offset 0, so j on an empty last line jumps
// to the top. This motion moves by visual line and simply stops at either edge.
const goalColumns = new WeakMap<
  EditorView,
  { head: number; column: number | undefined }
>();

const onSameVisualLine = (view: EditorView, from: number, to: number) => {
  const a = view.coordsAtPos(from);
  const b = view.coordsAtPos(to);
  if (!a || !b)
    return (
      view.state.doc.lineAt(from).number === view.state.doc.lineAt(to).number
    );
  return Math.abs(a.top - b.top) < 1;
};

export function moveByDisplayLine(
  view: EditorView,
  start: number,
  forward: boolean,
  repeat: number,
): SelectionRange {
  const goal = goalColumns.get(view);
  // Normal mode clips the cursor off a line's end, so accept a one-char drift.
  const column =
    goal && Math.abs(goal.head - start) <= 1 ? goal.column : undefined;
  let range = EditorSelection.cursor(start, 1, undefined, column);
  for (let i = 0; i < repeat; i++) {
    const next = view.moveVertically(range, forward);
    if (
      next.head === range.head ||
      onSameVisualLine(view, range.head, next.head)
    )
      break;
    range = next;
  }
  goalColumns.set(view, { head: range.head, column: range.goalColumn });
  return range;
}

Vim.defineMotion('moveByDisplayLineClamped', (cm, head, args) => {
  const view = cm.cm6 as EditorView;
  const doc = view.state.doc;
  const start = Math.min(doc.line(head.line + 1).from + head.ch, doc.length);
  const { head: offset } = moveByDisplayLine(
    view,
    start,
    Boolean(args.forward),
    args.repeat ?? 1,
  );
  const line = doc.lineAt(offset);
  return new CodeMirror.Pos(line.number - 1, offset - line.from);
});
Vim.mapCommand(
  'j',
  'motion',
  'moveByDisplayLineClamped',
  { forward: true },
  { context: 'normal' },
);
Vim.mapCommand(
  'k',
  'motion',
  'moveByDisplayLineClamped',
  { forward: false },
  { context: 'normal' },
);

// Like Vim, a user scroll drags the normal-mode cursor onto the nearest visible
// line. Otherwise the next edit (o, u, ...) reveals the off-screen cursor and the
// view jumps back to it.
export function keepVimCursorInView(view: EditorView) {
  const vimState = getCM(view)?.state.vim;
  if (!vimState || vimState.insertMode || vimState.visualMode) return;
  const scroller = view.scrollDOM.getBoundingClientRect();
  const x = view.contentDOM.getBoundingClientRect().left + 1;
  const head = view.state.selection.main.head;
  const cursor = view.coordsAtPos(head);
  if (cursor && cursor.top >= scroller.top && cursor.bottom <= scroller.bottom)
    return;
  const above = !cursor
    ? head < view.viewport.from || head < view.visibleRanges[0]?.from
    : cursor.top < scroller.top;
  // Probe one line in from the edge so a partly clipped line doesn't count.
  const y = above
    ? scroller.top + view.defaultLineHeight
    : scroller.bottom - view.defaultLineHeight;
  const target = view.posAtCoords({ x, y });
  if (target === null) return;
  const line = view.state.doc.lineAt(target);
  view.dispatch({ selection: { anchor: line.from } });
}
