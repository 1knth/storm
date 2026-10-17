import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Keep syntax colors independent from CodeMirror's structural editor theme.
export const markdownSyntaxHighlighting = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.heading1, color: '#d8b4fe', fontWeight: '700' },
    { tag: tags.heading2, color: '#c4a1f5', fontWeight: '650' },
    { tag: tags.heading3, color: '#b9a0e8', fontWeight: '600' },
    {
      tag: [tags.heading4, tags.heading5, tags.heading6],
      color: '#b9a0e8',
      fontWeight: '600',
    },
    { tag: tags.strong, color: '#f2d29b', fontWeight: '700' },
    { tag: tags.emphasis, color: '#d8b4fe', fontStyle: 'italic' },
    { tag: tags.link, color: '#83c8f0' },
    { tag: tags.url, color: '#83c8f0' },
    {
      tag: tags.monospace,
      color: '#8ed6c0',
      fontFamily: 'inherit',
      fontSize: '1em',
      lineHeight: 1,
    },
    { tag: tags.processingInstruction, color: '#8f82a3' },
    { tag: tags.labelName, color: '#a9a1b5' },
  ]),
);
