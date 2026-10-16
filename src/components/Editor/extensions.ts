import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { completionStatus } from '@codemirror/autocomplete';
import { indentOnInput, indentUnit } from '@codemirror/language';
import { markdownCompletionExtension } from './markdownCompletions';
import { keymap } from '@codemirror/view';
import { markdownTableEnter } from './markdownTables';

// Keep editor behavior reusable and independent of DOM/React lifecycle concerns.
export const markdownEditorExtensions = [
  indentUnit.of('  '),
  indentOnInput(),
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
