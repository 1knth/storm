import {
  defaultKeymap,
  indentLess,
  indentMore,
  history,
  historyKeymap,
} from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { completionStatus } from '@codemirror/autocomplete';
import { indentOnInput, indentUnit, syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { getCM } from '@replit/codemirror-vim';
import { markdownCompletionExtension } from './markdownCompletions';
import { EditorView, keymap } from '@codemirror/view';
import { markdownTableEnter } from './markdownTables';
import { markdownTaskEnter, markdownTaskX } from './markdownTaskEnter';
import { formatMarkdownSelection } from './markdownFormatting';

function isListContext(view: EditorView) {
  const vimState = getCM(view)?.state.vim;
  if (vimState && (!vimState.insertMode || vimState.visualMode)) return false;

  return view.state.selection.ranges.every((range) => {
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(
      range.head,
      -1,
    );
    let inListItem = false;
    for (; node; node = node.parent) {
      if (node.name === 'FencedCode' || node.name === 'InlineCode')
        return false;
      if (node.name === 'ListItem') inListItem = true;
    }
    return inListItem;
  });
}

const pairedAsteriskPosition = StateField.define<number | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(markAsteriskPair)) return effect.value;
    }
    return transaction.docChanged ||
      transaction.selection !== transaction.startState.selection
      ? null
      : value;
  },
});
const markAsteriskPair = StateEffect.define<number>();

// Keep editor behavior reusable and independent of DOM/React lifecycle concerns.
export const markdownEditorExtensions = [
  pairedAsteriskPosition,
  indentUnit.of('  '),
  indentOnInput(),
  EditorView.inputHandler.of((view, from, to, text) => {
    if (from !== to || text.length !== 1 || (text !== '*' && text !== '$'))
      return false;

    const next = view.state.sliceDoc(from, from + 1);
    const completingAsteriskPair =
      text === '*' &&
      view.state.field(pairedAsteriskPosition) === from &&
      view.state.sliceDoc(from, from + 1) === '*';
    if (completingAsteriskPair) {
      view.dispatch({
        changes: { from, insert: '**' },
        selection: { anchor: from + 1 },
        userEvent: 'input.type',
      });
      return true;
    }

    if (next === text) {
      view.dispatch({
        selection: { anchor: from + 1 },
        userEvent: 'input.type',
      });
      return true;
    }

    const completingDollarPair =
      text === '$' && view.state.sliceDoc(from - 1, from) === '$';
    if (text === '$' && !completingDollarPair) return false;

    view.dispatch({
      changes: completingDollarPair
        ? { from: from - 1, to: from, insert: '$$' }
        : { from, insert: '**' },
      selection: { anchor: completingDollarPair ? from : from + 1 },
      effects:
        text === '*' && !completingAsteriskPair
          ? markAsteriskPair.of(from + 1)
          : [],
      userEvent: 'input.type',
    });
    return true;
  }),
  markdownCompletionExtension,
  history(),
  Prec.highest(
    keymap.of([
      {
        key: 'x',
        run: (view) => markdownTaskX(view),
      },
      {
        key: 'Enter',
        run: (view) =>
          completionStatus(view.state) !== 'active' && markdownTaskEnter(view),
      },
    ]),
  ),
  Prec.highest(
    keymap.of(
      (['Mod-b', 'Mod-i'] as const).map((key) => ({
        key,
        run: (view: EditorView) => {
          const kind = key === 'Mod-b' ? 'bold' : 'italic';
          const vimState = getCM(view)?.state.vim;
          const selection = view.state.selection.main;
          const normalMode =
            vimState && !vimState.insertMode && !vimState.visualMode;
          const range =
            normalMode && selection.empty
              ? view.state.wordAt(selection.head)
              : null;

          const blankLine =
            view.state.doc.lineAt(selection.head).text.trim().length === 0;
          if (normalMode && !range && selection.empty && !blankLine)
            return true;
          const formatState = range
            ? view.state.update({
                selection: { anchor: range.from, head: range.to },
              }).state
            : view.state;
          const formatted = formatMarkdownSelection(formatState, kind);
          const emptyPair = selection.empty && !range;
          const cursor = range
            ? Math.max(range.from, range.to - 1) + (kind === 'bold' ? 2 : 1)
            : undefined;
          view.dispatch({
            ...formatted,
            ...(cursor === undefined && emptyPair
              ? {
                  selection: {
                    anchor: selection.head + (kind === 'bold' ? 2 : 1),
                  },
                }
              : cursor !== undefined
                ? { selection: { anchor: cursor } }
                : {}),
            userEvent: 'input.format',
          });
          if (emptyPair && vimState) vimState.insertMode = true;
          return true;
        },
      })),
    ),
  ),
  keymap.of([
    {
      key: 'Tab',
      run: (view) => {
        if (completionStatus(view.state) === 'active') return false;
        const vimState = getCM(view)?.state.vim;
        if (vimState && (!vimState.insertMode || vimState.visualMode))
          return false;
        if (isListContext(view)) return indentMore(view);
        view.dispatch({
          changes: { from: view.state.selection.main.from, insert: '  ' },
          selection: { anchor: view.state.selection.main.from + 2 },
          userEvent: 'input',
        });
        return true;
      },
    },
    {
      key: 'Shift-Tab',
      run: (view) =>
        completionStatus(view.state) !== 'active' &&
        isListContext(view) &&
        indentLess(view),
    },
    ...(
      [
        ['Mod-Shift-x', 'strikethrough'],
        ['Mod-`', 'code'],
        ['Mod-k', 'link'],
      ] as const
    ).map(([key, kind]) => ({
      key,
      run: (view: EditorView) => {
        const vimState = getCM(view)?.state.vim;
        if (vimState && (!vimState.insertMode || vimState.visualMode))
          return false;
        view.dispatch({
          ...formatMarkdownSelection(view.state, kind),
          userEvent: 'input.format',
        });
        return true;
      },
    })),
    {
      key: 'Enter',
      run: (view) =>
        completionStatus(view.state) !== 'active' && markdownTableEnter(view),
    },
    { key: 'Shift-Enter', run: insertNewlineContinueMarkup },
    { key: 'Enter', run: insertNewlineContinueMarkup },
    ...historyKeymap,
    ...defaultKeymap.filter(({ key }) => key !== 'Tab'),
  ]),
];
