import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { completionStatus } from '@codemirror/autocomplete';
import { indentOnInput, indentUnit } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import { markdownCompletionExtension } from './markdownCompletions';
import { EditorView, keymap } from '@codemirror/view';
import { markdownTableEnter } from './markdownTables';

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
  keymap.of([
    {
      key: 'Enter',
      run: (view) =>
        completionStatus(view.state) !== 'active' && markdownTableEnter(view),
    },
    { key: 'Enter', run: insertNewlineContinueMarkup },
    ...historyKeymap,
    ...defaultKeymap,
    indentWithTab,
  ]),
];
