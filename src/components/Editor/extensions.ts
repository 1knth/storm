import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { indentOnInput, indentUnit } from '@codemirror/language';
import { keymap } from '@codemirror/view';

// Keep editor behavior reusable and independent of DOM/React lifecycle concerns.
export const markdownEditorExtensions = [
  indentUnit.of('  '),
  indentOnInput(),
  history(),
  keymap.of([
    { key: 'Enter', run: insertNewlineContinueMarkup },
    ...historyKeymap,
    ...defaultKeymap,
    indentWithTab,
  ]),
];
