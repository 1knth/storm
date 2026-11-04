/** Pure text edits for GFM pipe tables in the quiz answer composer. */
export type TableEdit = { text: string; cursor: number };
export type AnswerTable = {
  from: number;
  to: number;
  rows: string[][];
  row: number;
  column: number;
};

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells: string[] = [];
  let cell = '';
  let math = false;
  for (let i = 1; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (char === '\\' && i + 1 < trimmed.length) {
      cell += char + trimmed[++i];
      continue;
    }
    if (char === '$') math = !math;
    // A pipe inside $…$ belongs to the formula, not the table.
    if (char === '|' && !math) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  if (cell.trim()) cells.push(cell.trim());
  return cells.length ? cells : null;
}

const isSeparator = (cells: string[]) =>
  cells.every((cell) => /^:?-{1,}:?$/.test(cell));

/** The table around `pos`, with the caret's row (0 = header) and column. */
export function tableAt(text: string, pos: number): AnswerTable | null {
  const lines = text.split('\n');
  let offset = 0;
  let index = 0;
  for (; index < lines.length; index++) {
    if (pos <= offset + lines[index].length) break;
    offset += lines[index].length + 1;
  }
  if (index >= lines.length || !splitRow(lines[index])) return null;
  let first = index;
  while (first > 0 && splitRow(lines[first - 1])) first--;
  let last = index;
  while (last + 1 < lines.length && splitRow(lines[last + 1])) last++;
  const raw = lines.slice(first, last + 1).map((line) => splitRow(line)!);
  if (raw.length < 2 || !isSeparator(raw[1])) return null;
  const from = lines.slice(0, first).reduce((n, l) => n + l.length + 1, 0);
  const to = from + lines.slice(first, last + 1).join('\n').length;
  const lineStart = offset;
  const before = lines[index].slice(0, pos - lineStart);
  const column = Math.max(0, (splitRow(before + ' |') ?? ['']).length - 1);
  const rows = raw.filter((_, i) => i !== 1);
  const width = Math.max(...rows.map((r) => r.length));
  const sourceRow = index - first;
  return {
    from,
    to,
    rows: rows.map((r) => [...r, ...Array(width - r.length).fill('')]),
    row: sourceRow === 0 ? 0 : Math.max(1, sourceRow - 1),
    column: Math.min(column, width - 1),
  };
}

/** Pad cells so the source reads as a grid. */
function format(rows: string[][]): { text: string } {
  const sizes = rows[0].map((_, c) =>
    Math.max(3, ...rows.map((r) => [...r[c]].length)),
  );
  const line = (cells: string[]) =>
    `|${cells.map((cell, c) => ` ${cell}${' '.repeat(sizes[c] - [...cell].length)} |`).join('')}`;
  const separator = line(sizes.map((size) => '-'.repeat(size)));
  return {
    text: [line(rows[0]), separator, ...rows.slice(1).map(line)].join('\n'),
  };
}

export function insertTable(text: string, pos: number): TableEdit {
  const rows = [
    ['p', 'q', 'result'],
    ['', '', ''],
    ['', '', ''],
  ];
  const before = text.slice(0, pos);
  const lead =
    !before || before.endsWith('\n\n')
      ? ''
      : before.endsWith('\n')
        ? '\n'
        : '\n\n';
  const after = text.slice(pos);
  const trail =
    !after || after.startsWith('\n\n')
      ? ''
      : after.startsWith('\n')
        ? '\n'
        : '\n\n';
  return {
    text: before + lead + format(rows).text + trail + after,
    // The table's start; the editor focuses its first body cell.
    cursor: before.length + lead.length,
  };
}

/** Markdown source for a grid of cell values; pipes in cells are escaped. */
export function formatTable(rows: string[][]): string {
  return format(
    rows.map((row) =>
      row.map((cell) =>
        cell
          .replace(/\n/g, ' ')
          // A bare pipe would split the cell; pipes inside $…$ are left alone.
          .split('$')
          .map((part, i) => (i % 2 ? part : part.replace(/(?<!\\)\|/g, '\\|')))
          .join('$'),
      ),
    ),
  ).text;
}
