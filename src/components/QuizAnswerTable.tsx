import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WidgetType, type EditorView } from '@codemirror/view';
import { redo, undo } from '@codemirror/commands';
import { formatTable, tableAt } from './quizAnswerTables';

export type TableAction =
  | 'column-left'
  | 'column-right'
  | 'row-above'
  | 'row-below'
  | 'delete-column'
  | 'delete-row'
  | 'delete-table';
/** Runs a toolbar action on the focused cell; null when no cell is focused. */
export type TableTools = ((action: TableAction) => void) | null;

const unescape = (cell: string) => cell.replace(/\\\|/g, '|');

type GridProps = {
  rows: string[][];
  onChange: (rows: string[][]) => void;
  onDelete: () => void;
  onExit: (where: 'before' | 'after') => void;
  onHistory: (direction: 'undo' | 'redo') => void;
  onTools: (tools: TableTools) => void;
  renderMarkdown: (text: string) => ReactNode;
};

/** Obsidian-style table: type into cells; the Markdown source stays hidden. */
function Grid({
  rows,
  onChange,
  onDelete,
  onExit,
  onHistory,
  onTools,
  renderMarkdown,
}: GridProps) {
  const [cell, setEditing] = useState<[number, number] | null>(null);
  // Bumped after undo/redo so the open input remounts with the restored text.
  const [epoch, setEpoch] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const width = rows[0].length;
  // Undo can remove the row or column being edited.
  const editing =
    cell && cell[0] < rows.length && cell[1] < width ? cell : null;

  const focus = (row: number, column: number) => {
    setEditing([row, column]);
    // The input mounts on the next render; focus it once it exists.
    requestAnimationFrame(() =>
      gridRef.current
        ?.querySelector<HTMLInputElement>(`input[data-cell="${row}:${column}"]`)
        ?.focus(),
    );
  };
  const set = (row: number, column: number, value: string) =>
    onChange(
      rows.map((r, i) =>
        i === row ? r.map((cell, c) => (c === column ? value : cell)) : r,
      ),
    );

  const run = (action: TableAction) => {
    if (!editing) return;
    const [r, c] = editing;
    const insertColumn = (at: number) => {
      onChange(rows.map((row) => [...row.slice(0, at), '', ...row.slice(at)]));
      focus(r, at);
    };
    const insertRow = (at: number) => {
      onChange([
        ...rows.slice(0, at),
        rows[0].map(() => ''),
        ...rows.slice(at),
      ]);
      focus(at, c);
    };
    if (action === 'column-left') insertColumn(c);
    else if (action === 'column-right') insertColumn(c + 1);
    // The header stays first: GFM tables need it.
    else if (action === 'row-above') insertRow(Math.max(1, r));
    else if (action === 'row-below') insertRow(r + 1);
    else if (action === 'delete-column') {
      if (width === 1) return onDelete();
      onChange(rows.map((row) => row.filter((_, i) => i !== c)));
      focus(r, Math.min(c, width - 2));
    } else if (action === 'delete-row') {
      if (r === 0 || rows.length <= 2) return;
      onChange(rows.filter((_, i) => i !== r));
      focus(Math.min(r, rows.length - 2), c);
    } else onDelete();
  };
  const runRef = useRef(run);
  runRef.current = run;
  const active = editing !== null;
  useEffect(() => {
    onTools(active ? (action) => runRef.current(action) : null);
  }, [active, onTools]);
  useEffect(() => () => onTools(null), [onTools]);

  const move = (r: number, c: number, key: string, shift: boolean) => {
    if (key === 'Tab') {
      const index = r * width + c + (shift ? -1 : 1);
      if (index < 0) return onExit('before');
      if (index >= rows.length * width) {
        onChange([...rows, rows[0].map(() => '')]);
        return focus(rows.length, 0);
      }
      return focus(Math.floor(index / width), index % width);
    }
    if (key === 'ArrowUp') return r === 0 ? onExit('before') : focus(r - 1, c);
    if (key === 'ArrowDown' || key === 'Enter')
      return r + 1 >= rows.length ? onExit('after') : focus(r + 1, c);
  };

  return (
    <div className="quiz-answer-table" ref={gridRef}>
      <table>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className={r === 0 ? 'quiz-answer-table-head' : ''}>
              {row.map((cell, c) => {
                const selected = editing?.[0] === r && editing[1] === c;
                return (
                  <td
                    key={c}
                    className={selected ? 'is-editing' : ''}
                    onMouseDown={(event) => {
                      if (selected) return;
                      event.preventDefault();
                      focus(r, c);
                    }}
                  >
                    {/* The rendered text keeps the column's width while its input overlays it. */}
                    <div
                      className="quiz-answer-table-cell"
                      aria-hidden={selected}
                    >
                      {cell ? renderMarkdown(cell) : ' '}
                    </div>
                    {selected && (
                      <input
                        key={epoch}
                        autoFocus
                        data-cell={`${r}:${c}`}
                        aria-label={`Row ${r + 1}, column ${c + 1}`}
                        defaultValue={unescape(cell)}
                        onInput={(event) =>
                          set(r, c, event.currentTarget.value)
                        }
                        onBlur={() => setEditing(null)}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Escape') return onExit('after');
                          if (
                            (event.metaKey || event.ctrlKey) &&
                            event.key.toLowerCase() === 'z'
                          ) {
                            // Use the composer's history so row and column edits undo too.
                            event.preventDefault();
                            onHistory(event.shiftKey ? 'redo' : 'undo');
                            setEpoch((value) => value + 1);
                            return;
                          }
                          if (
                            ['Tab', 'ArrowUp', 'ArrowDown', 'Enter'].includes(
                              event.key,
                            )
                          ) {
                            event.preventDefault();
                            move(r, c, event.key, event.shiftKey);
                          }
                        }}
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

export class TableWidget extends WidgetType {
  constructor(
    private text: string,
    private renderMarkdown: (text: string) => ReactNode,
    private onTools: (tools: TableTools) => void,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return this.text === other.text;
  }
  private render(dom: HTMLElement, view: EditorView) {
    const table = tableAt(this.text, 0);
    if (!table) return;
    // Look the range up at edit time; earlier edits may have moved it.
    const current = () =>
      tableAt(view.state.doc.toString(), view.posAtDOM(dom));
    roots.get(dom)?.render(
      <Grid
        rows={table.rows}
        renderMarkdown={this.renderMarkdown}
        onTools={this.onTools}
        onHistory={(direction) => (direction === 'undo' ? undo : redo)(view)}
        onExit={(where) => {
          const range = current();
          if (!range) return;
          const doc = view.state.doc;
          let anchor = where === 'before' ? range.from - 1 : range.to + 1;
          if (where === 'after' && range.to >= doc.length) {
            // Give the caret a line to land on below a trailing table.
            view.dispatch({ changes: { from: doc.length, insert: '\n' } });
            anchor = view.state.doc.length;
          }
          view.dispatch({
            selection: {
              anchor: Math.max(0, Math.min(anchor, view.state.doc.length)),
            },
          });
          view.focus();
        }}
        onDelete={() => {
          const range = current();
          if (!range) return;
          // Take one line break with it so no blank line is left behind.
          const to = Math.min(view.state.doc.length, range.to + 1);
          view.dispatch({
            changes: { from: range.from, to },
            selection: { anchor: range.from },
            userEvent: 'delete',
          });
          view.focus();
        }}
        onChange={(rows) => {
          const range = current();
          if (!range) return;
          view.dispatch({
            changes: {
              from: range.from,
              to: range.to,
              insert: formatTable(rows),
            },
            userEvent: 'input',
          });
        }}
      />,
    );
  }
  toDOM(view: EditorView) {
    const dom = document.createElement('div');
    roots.set(dom, createRoot(dom));
    this.render(dom, view);
    return dom;
  }
  // Re-render in place so a focused cell keeps focus while its text changes.
  updateDOM(dom: HTMLElement, view: EditorView) {
    if (!roots.has(dom)) return false;
    this.render(dom, view);
    return true;
  }
  destroy(dom: HTMLElement) {
    const root = roots.get(dom);
    roots.delete(dom);
    queueMicrotask(() => root?.unmount());
  }
  // The grid handles its own clicks and keys; CodeMirror must not move the caret.
  ignoreEvent() {
    return true;
  }
}
