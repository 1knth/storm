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
import { syntaxTree } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { createMarkdownSyntaxHighlighting } from './Editor/markdownHighlighting';

class MarkdownWidget extends WidgetType {
  private root?: Root;
  constructor(
    private text: string,
    private render: (text: string) => ReactNode,
  ) {
    super();
  }
  eq(other: MarkdownWidget) {
    return this.text === other.text;
  }
  toDOM() {
    const element = document.createElement('div');
    element.className = 'quiz-answer-rendered';
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
  renderMarkdown: (text: string) => ReactNode;
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
      const ranges = [];
      const selection = state.selection.main;
      const cursorBlock = syntaxTree(state).topNode;
      for (let node = cursorBlock.firstChild; node; node = node.nextSibling) {
        if (
          state.field(focused) &&
          selection.from <= node.to &&
          selection.to >= node.from
        )
          continue;
        ranges.push(
          Decoration.replace({
            widget: new MarkdownWidget(
              state.sliceDoc(node.from, node.to),
              (text) => latest.current.renderMarkdown(text),
            ),
            block: true,
          }).range(node.from, node.to),
        );
      }
      return Decoration.set(ranges);
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
            '&': { backgroundColor: 'transparent' },
            '&.cm-focused': { outline: 'none' },
            '.cm-content': {
              minHeight: props.long ? '9rem' : '3rem',
              fontFamily: 'inherit',
              padding: '8px',
            },
            '.cm-scroller': {
              fontFamily: 'inherit',
              maxHeight: '16rem',
              overflow: 'auto',
            },
            '.cm-line': { padding: '0' },
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
