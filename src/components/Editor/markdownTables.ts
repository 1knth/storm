import { syntaxTree } from '@codemirror/language';
import { getCM } from '@replit/codemirror-vim';
import type { Command } from '@codemirror/view';

function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const values: string[] = [];
  let cell = '';
  let ticks = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '`') {
      let end = i;
      while (trimmed[end + 1] === '`') end++;
      const run = end - i + 1;
      ticks = ticks === run ? 0 : ticks || run;
      cell += trimmed.slice(i, end + 1);
      i = end;
    } else if (char === '|' && !ticks && (i === 0 || trimmed[i - 1] !== '\\')) {
      values.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  values.push(cell.trim());
  if (trimmed.startsWith('|')) values.shift();
  if (trimmed.endsWith('|') && trimmed.at(-2) !== '\\') values.pop();
  return values.length >= 2 ? values : null;
}

function separator(line: string): string[] | null {
  const parts = cells(line);
  return parts?.every((part) => /^:?-{3,}:?$/.test(part)) ? parts : null;
}

function insideCodeFence(
  doc: Parameters<Command>[0]['state']['doc'],
  lineNumber: number,
): boolean {
  let fence: { marker: string; length: number } | null = null;
  for (let number = 1; number <= lineNumber; number++) {
    const text = doc.line(number).text;
    const match = /^ {0,3}(?:> ?)*(`{3,}|~{3,})(.*)$/.exec(text);
    if (!match) continue;
    const marker = match[1][0];
    const length = match[1].length;
    if (!fence) {
      if (marker !== '`' || !match[2].includes('`')) fence = { marker, length };
    } else if (
      fence.marker === marker &&
      length >= fence.length &&
      /^\s*$/.test(match[2])
    ) {
      fence = null;
    }
  }
  return fence !== null;
}

export function markdownTableEnter(view: Parameters<Command>[0]): boolean {
  if (
    view.state.selection.ranges.length !== 1 ||
    !view.state.selection.main.empty
  )
    return false;
  const { head } = view.state.selection.main;
  const line = view.state.doc.lineAt(head);
  if (
    head !== line.to ||
    syntaxTree(view.state).resolveInner(head, -1).name === 'InlineCode'
  )
    return false;
  // getCM returns null when Vim is not installed; do not construct or enable it here.
  const cm = getCM(view);
  const vimState = cm?.state.vim;
  if (vimState && (!vimState.insertMode || vimState.visualMode)) return false;
  if (insideCodeFence(view.state.doc, line.number)) return false;
  const current = cells(line.text);
  if (!current) return false;
  const previous =
    line.number > 1 ? view.state.doc.line(line.number - 1) : null;
  const previousPrevious =
    line.number > 2 ? view.state.doc.line(line.number - 2) : null;
  const inTable = Boolean(
    previous &&
    (separator(previous.text) ||
      (previousPrevious &&
        separator(previousPrevious.text) &&
        cells(previous.text))),
  );
  const indent = line.text.match(/^\s*/)?.[0] ?? '';
  const makeRow = (count: number) =>
    `${indent}| ${Array(count).fill('').join(' | ')} |`;
  const insert = (text: string, cursorOffset: number) => {
    const from = line.to;
    view.dispatch({
      changes: { from, insert: `\n${text}` },
      selection: { anchor: from + 1 + cursorOffset },
      userEvent: 'input',
    });
    return true;
  };
  if (inTable && current.every((cell) => cell === '')) {
    const next =
      line.number < view.state.doc.lines
        ? view.state.doc.line(line.number + 1)
        : null;
    if (!next || !cells(next.text)) {
      view.dispatch({
        changes: { from: line.from - 1, to: line.to },
        selection: { anchor: line.from - 1 },
        userEvent: 'input',
      });
      return true;
    }
    return false;
  }
  if (inTable && previous && !separator(line.text))
    return insert(makeRow(current.length), indent.length + 2);
  if (separator(line.text))
    return insert(makeRow(current.length), indent.length + 2);
  const next =
    line.number < view.state.doc.lines
      ? view.state.doc.line(line.number + 1)
      : null;
  if (separator(next?.text ?? '')) {
    const body =
      next!.number < view.state.doc.lines
        ? view.state.doc.line(next!.number + 1)
        : null;
    if (body && cells(body.text)) {
      view.dispatch({
        selection: {
          anchor: body.from + (body.text.match(/^\s*/)?.[0].length ?? 0) + 2,
        },
      });
      return true;
    }
    const from = next!.to;
    view.dispatch({
      changes: { from, insert: `\n${makeRow(current.length)}` },
      selection: { anchor: from + 1 + indent.length + 2 },
      userEvent: 'input',
    });
    return true;
  }
  // Recognize a header only when immediately followed by a table body row, or create its separator/body.
  if (next && cells(next.text)) {
    const after =
      next.number < view.state.doc.lines
        ? view.state.doc.line(next.number + 1)
        : null;
    if (separator(next.text) || (after && separator(after.text)))
      return insert(makeRow(current.length), indent.length + 2);
  }
  const sep = `${indent}| ${Array(current.length).fill('---').join(' | ')} |`;
  const row = makeRow(current.length);
  const from = line.to;
  view.dispatch({
    changes: { from, insert: `\n${sep}\n${row}` },
    selection: { anchor: from + 1 + sep.length + 1 + indent.length + 2 },
    userEvent: 'input',
  });
  return true;
}
