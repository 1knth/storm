import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EditorState, StateEffect, StateField } from '@codemirror/state';
import {
  EditorView,
  Decoration,
  WidgetType,
  keymap,
  placeholder,
} from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { answerPreviewRanges } from './quizAnswerDecorations';
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
};

/** Render completed Markdown blocks in place; reveal source around the caret. */
export default function QuizAnswerEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
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
            widget: new MarkdownWidget(
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
        doc: latest.current.value,
        extensions: [
          markdown(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          createMarkdownSyntaxHighlighting(),
          focused,
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
  return (
    <div
      ref={host}
      className="quiz-answer-editor mt-1 w-full rounded-lg border border-white/15 bg-black/20"
    />
  );
}
