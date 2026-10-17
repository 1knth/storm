import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// Keep syntax colors independent from CodeMirror's structural editor theme.
export const DEFAULT_HEADING_COLORS = [
  '#d8b4fe',
  '#c4a1f5',
  '#b9a0e8',
  '#b9a0e8',
  '#b9a0e8',
  '#b9a0e8',
];
export function createMarkdownSyntaxHighlighting(
  headingColors: string[] = DEFAULT_HEADING_COLORS,
) {
  return syntaxHighlighting(
    HighlightStyle.define([
      ...headingColors.map((color, index) => ({
        tag: [
          tags.heading1,
          tags.heading2,
          tags.heading3,
          tags.heading4,
          tags.heading5,
          tags.heading6,
        ][index],
        color,
        fontWeight: index === 0 ? '700' : index === 1 ? '650' : '600',
      })),

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
}
export const markdownSyntaxHighlighting = createMarkdownSyntaxHighlighting();
