import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { getCM } from '@replit/codemirror-vim';
import type { Command } from '@codemirror/view';

export const markdownTaskEnter: Command = (view) => {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const vimState = getCM(view)?.state.vim;
  if (vimState && (!vimState.insertMode || vimState.visualMode)) return false;

  const line = view.state.doc.lineAt(selection.main.head);
  const marker = /^( {0,3}(?:[-+*]|\d+[.)])\s+)\[([ xX])\]/.exec(line.text);
  if (!marker) return false;

  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(
    line.from + marker[1].length + 1,
    -1,
  );
  let inListItem = false;
  for (; node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'InlineCode') return false;
    if (node.name === 'ListItem') inListItem = true;
  }
  if (!inListItem) return false;

  const offset = line.from + marker[1].length + 1;
  const current = marker[2];
  view.dispatch({
    changes: {
      from: offset,
      to: offset + 1,
      insert: current === ' ' ? 'x' : ' ',
    },
    selection: { anchor: selection.main.head },
    userEvent: 'input',
  });
  return true;
};
