import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import type { Text } from '@codemirror/state';
import {
  EditorView,
  Decoration,
  WidgetType,
  keymap,
  placeholder,
} from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { answerPreviewRanges } from './quizAnswerDecorations';
import { insertTable } from './quizAnswerTables';
import {
  TableWidget,
  type TableAction,
  type TableTools,
} from './QuizAnswerTable';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { createMarkdownSyntaxHighlighting } from './Editor/markdownHighlighting';

class MarkdownWidget extends WidgetType {
  private root?: Root;
  constructor(
    private text: string,
    private render: (text: string) => ReactNode,
    private block = true,
  ) {
    super();
  }
  eq(other: MarkdownWidget) {
    return this.text === other.text && this.block === other.block;
  }
  toDOM() {
    const element = document.createElement(this.block ? 'div' : 'span');
    element.className = this.block
      ? 'quiz-answer-rendered'
      : 'quiz-answer-rendered quiz-answer-inline';
    this.root = createRoot(element);
    this.root.render(this.render(this.text));
    return element;
  }
  destroy() {
    const root = this.root;
    // CodeMirror can remove widgets during a React commit.
    queueMicrotask(() => root?.unmount());
  }
  ignoreEvent() {
    return false;
  }
}

type Props = {
  value: string;
  long: boolean;
  onChange: (text: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  renderMarkdown: (text: string, inline?: boolean) => ReactNode;
  /** Receives the editor's insert-table command for buttons outside the box. */
  insertTableRef?: RefObject<(() => void) | null>;
};

const endsWithTable = (doc: Text) =>
  doc.line(doc.lines).text.trimStart().startsWith('|');
const withLineAfterTable = (text: string) =>
  text.split('\n').at(-1)!.trimStart().startsWith('|') ? `${text}\n` : text;

const TABLE_ACTIONS: [TableAction, string, string][] = [
  ['column-left', '+ Column left', 'Insert a column left of this cell'],
  ['column-right', '+ Column right', 'Insert a column right of this cell'],
  ['row-above', '+ Row above', 'Insert a row above this cell'],
  ['row-below', '+ Row below', 'Insert a row below this cell'],
  ['delete-column', '− Column', 'Delete this column'],
  ['delete-row', '− Row', 'Delete this row'],
  ['delete-table', 'Delete table', 'Delete the whole table'],
];

/** Render completed Markdown blocks in place; reveal source around the caret. */
export default function QuizAnswerEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [tableTools, setTableTools] = useState<TableTools>(null);
  // Stable across renders so table widgets can report their focused cell.
  const reportTools = useRef((tools: TableTools) =>
    setTableTools(() => tools),
  ).current;
  useLayoutEffect(() => {
    const focusChanged = StateEffect.define<boolean>();
    const focused = StateField.define({
      create: () => false,
      update(value, transaction) {
        for (const effect of transaction.effects) {
          if (effect.is(focusChanged)) return effect.value;
        }
        return value;
      },
    });
    const previews = StateField.define({
      create(state) {
        return decorate(state);
      },
      update(_value, transaction) {
        return decorate(transaction.state);
      },
      provide: (field) => EditorView.decorations.from(field),
    });
    function decorate(state: EditorState) {
      return Decoration.set(
        answerPreviewRanges(state, state.field(focused)).map((range) =>
          Decoration.replace({
            widget: range.table
              ? new TableWidget(
                  state.sliceDoc(range.from, range.to),
                  (text) => latest.current.renderMarkdown(text, true),
                  reportTools,
                )
              : new MarkdownWidget(
                  state.sliceDoc(range.from, range.to),
                  (text) => latest.current.renderMarkdown(text, !range.block),
                  range.block,
                ),
            block: range.block,
          }).range(range.from, range.to),
        ),
      );
    }

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: withLineAfterTable(latest.current.value),
        extensions: [
          // GFM so pipe tables parse as tables rather than paragraphs.
          markdown({ base: markdownLanguage }),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          createMarkdownSyntaxHighlighting(),
          focused,
          // Keep a line below a trailing table so the caret can reach it.
          EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || !endsWithTable(tr.newDoc)) return tr;
            return [
              tr,
              {
                changes: { from: tr.newDoc.length, insert: '\n' },
                sequential: true,
              },
            ];
          }),
          previews,
          EditorView.lineWrapping,
          placeholder('Type your answer, or paste a photo of your work'),
          EditorView.contentAttributes.of({
            'aria-label': 'Your answer',
            'aria-multiline': 'true',
          }),
          EditorView.domEventHandlers({
            focus(_event, view) {
              view.dispatch({ effects: focusChanged.of(true) });
            },
            blur(_event, view) {
              view.dispatch({ effects: focusChanged.of(false) });
            },
            keydown(event) {
              latest.current.onKeyDown(event);
              return event.defaultPrevented;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              latest.current.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            '&': { backgroundColor: 'transparent', cursor: 'text' },
            '&.cm-focused': { outline: 'none' },
            '.cm-content': {
              minHeight: props.long ? '9rem' : '3rem',
              fontFamily: 'inherit',
              caretColor: 'white',
              cursor: 'text',
              padding: '8px',
            },
            '.cm-scroller': {
              fontFamily: 'inherit',
              maxHeight: '16rem',
              overflow: 'auto',
            },
            '.cm-line': { padding: '0', cursor: 'text' },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [props.long]);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view && props.value !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.value },
      });
    }
  }, [props.value]);
  if (props.insertTableRef) props.insertTableRef.current = addTable;
  function addTable() {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    const { text: next, cursor } = insertTable(
      text,
      view.hasFocus ? view.state.selection.main.head : text.length,
    );
    view.dispatch({
      changes: { from: 0, to: text.length, insert: next },
      userEvent: 'input',
    });
    // Start typing in the first body cell of the new grid.
    requestAnimationFrame(() => {
      for (const grid of view.dom.querySelectorAll<HTMLElement>(
        '.quiz-answer-table',
      )) {
        if (view.posAtDOM(grid) !== cursor) continue;
        grid
          .querySelectorAll('tr')[1]
          ?.firstElementChild?.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
          );
      }
    });
  }
  return (
    <div className="quiz-answer-editor mt-1 w-full rounded-lg border border-white/15 bg-black/20">
      {tableTools && (
        <div className="flex flex-wrap items-center gap-1 border-b border-white/10 px-1.5 py-1 text-[11px] text-white/55">
          {TABLE_ACTIONS.map(([action, label, title]) => (
            <button
              key={action}
              type="button"
              title={title}
              className={`cursor-pointer rounded px-1.5 py-0.5 hover:bg-white/10 ${action.startsWith('delete') ? 'hover:text-red-300' : 'hover:text-white/85'}`}
              // Keep focus in the cell so the action knows where it applies.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => tableTools(action)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div ref={host} />
    </div>
  );
}
