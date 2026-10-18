import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { getCM } from '@replit/codemirror-vim';
import type { Command } from '@codemirror/view';

export const markdownTaskEnter: Command = (view) => {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const vim = getCM(view)?.state.vim;
  // Toggle only in an initialized Vim Normal mode. No Vim (or an uninitialized
  // Vim extension) must fall through to the editor's ordinary Enter behavior.
  if (!vim || vim.insertMode || vim.visualMode) return false;

  const line = view.state.doc.lineAt(selection.main.head);
  const listMarker = /^(\s*)([-+*]|\d+[.)])([ \t]+)(?:\[([ xX])\])?/.exec(
    line.text,
  );
  const indent = listMarker?.[1] ?? /^(\s*)/.exec(line.text)![1];
  const markerStart = line.from + indent.length;
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(
    Math.min(
      line.to,
      markerStart +
        (listMarker ? listMarker[2].length + listMarker[3].length + 1 : 0),
    ),
    -1,
  );
  let inListItem = false;
  for (; node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'Table') return false;
    if (node.name === 'ListItem') inListItem = true;
  }
  let cursorNode: SyntaxNode | null = tree.resolveInner(
    selection.main.head,
    -1,
  );
  for (; cursorNode; cursorNode = cursorNode.parent) {
    if (cursorNode.name === 'FencedCode' || cursorNode.name === 'InlineCode')
      return false;
  }
  if (
    listMarker &&
    !inListItem &&
    /^\s{0,3}[-+*]|^\s*\d+[.)]/.test(line.text) === false
  )
    return false;

  let from = markerStart;
  let to = markerStart;
  let insert = '- ';
  if (listMarker) {
    const checkbox = listMarker[4];
    if (!checkbox) {
      to = markerStart + listMarker[2].length + listMarker[3].length;
      insert = `${listMarker[2]} [ ] `;
    } else if (checkbox === ' ') {
      from = markerStart;
      to =
        markerStart +
        listMarker[2].length +
        listMarker[3].length +
        4 +
        (line.text[
          markerStart + listMarker[2].length + listMarker[3].length + 4
        ] === ' '
          ? 1
          : 0);
      insert = `${listMarker[2]} `;
    } else {
      from = markerStart;
      to =
        markerStart +
        listMarker[2].length +
        listMarker[3].length +
        4 +
        (line.text[
          markerStart + listMarker[2].length + listMarker[3].length + 4
        ] === ' '
          ? 1
          : 0);
      insert = `${listMarker[2]} `;
    }
  } else {
    // Avoid turning structural Markdown (headings, tables, and fences) into list items.
    if (/^\s*(?:#{1,6}\s|>|\||```|~~~)/.test(line.text)) return false;
  }

  const cursor = selection.main.head;
  const nextCursor =
    cursor < from || (cursor === from && from !== to)
      ? cursor
      : cursor >= to
        ? cursor + insert.length - (to - from)
        : from + insert.length;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: nextCursor },
    userEvent: 'input',
  });
  return true;
};

export const markdownTaskX: Command = (view) => {
  const selection = view.state.selection;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const vim = getCM(view)?.state.vim;
  if (!vim || vim.insertMode || vim.visualMode) return false;

  const line = view.state.doc.lineAt(selection.main.head);
  const marker = /^(\s*)([-+*]|\d+[.)])([ \t]+)\[([ xX])\]/.exec(line.text);
  if (!marker) return false;
  const markerStart = line.from + marker[1].length;
  const tree = syntaxTree(view.state);
  let node: SyntaxNode | null = tree.resolveInner(markerStart, -1);
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'Table') return false;
    node = node.parent;
  }
  node = tree.resolveInner(selection.main.head, -1);
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'InlineCode') return false;
    node = node.parent;
  }

  const checkbox = markerStart + marker[2].length + marker[3].length + 1;
  const value = marker[4] === ' ' ? 'x' : ' ';
  view.dispatch({
    changes: { from: checkbox, to: checkbox + 1, insert: value },
    userEvent: 'input',
  });
  return true;
};
