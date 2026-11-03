// Callout blockquotes give tutoring responses labelled asides and hints the
// learner opens on purpose. Only this fixed set of labels is recognized, and
// the markup is generated here rather than accepted as raw HTML.
const CALLOUT_MARKER = /^\[!([a-z][a-z-]{0,15})\]([-+]?)[ \t]*/i;

const CALLOUT_LABELS: Record<string, string> = {
  note: 'Note',
  info: 'Note',
  tip: 'Tip',
  hint: 'Hint',
  example: 'Example',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
};
/** Hints stay closed so a learner chooses when to see them. */
const COLLAPSED_BY_DEFAULT = new Set(['hint']);

type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: Record<string, unknown>;
};

function container(name: string, className: string[], children: Node[]): Node {
  return {
    type: 'blockquote',
    data: { hName: name, hProperties: { className } },
    children,
  };
}

/** Split a callout's opening paragraph into its title line and the rest. */
function splitTitle(paragraph: Node): { title: Node[]; rest: Node[] } {
  const children = [...(paragraph.children ?? [])];
  const first = children[0];
  const newline = first?.value?.indexOf('\n') ?? -1;
  if (first?.type === 'text' && newline >= 0) {
    const title = first.value!.slice(0, newline);
    const remainder = first.value!.slice(newline + 1);
    return {
      title: title ? [{ type: 'text', value: title }] : [],
      rest: [
        ...(remainder ? [{ type: 'text', value: remainder }] : []),
        ...children.slice(1),
      ],
    };
  }
  const breakIndex = children.findIndex((child) => child.type === 'break');
  if (breakIndex < 0) return { title: children, rest: [] };
  return {
    title: children.slice(0, breakIndex),
    rest: children.slice(breakIndex + 1),
  };
}

export function remarkQuizCallouts() {
  return (tree: Node) => {
    const visit = (node: Node) => {
      for (const child of node.children ?? []) visit(child);
      if (node.type !== 'blockquote' || node.data) return;
      const [paragraph, ...siblings] = node.children ?? [];
      const marker = paragraph?.children?.[0];
      if (
        paragraph?.type !== 'paragraph' ||
        marker?.type !== 'text' ||
        !marker.value
      )
        return;
      const match = CALLOUT_MARKER.exec(marker.value);
      const kind = match?.[1].toLowerCase();
      if (!match || !kind || !(kind in CALLOUT_LABELS)) return;
      marker.value = marker.value.slice(match[0].length);
      const { title, rest } = splitTitle(paragraph);
      // An empty title line leaves a summary with nothing to click.
      const titled = title.filter(
        (node) => node.type !== 'text' || node.value?.trim(),
      );
      const body = [
        ...(rest.length ? [{ type: 'paragraph', children: rest }] : []),
        ...siblings,
      ];
      const collapsible =
        match[2] === '-' || match[2] === '+' || COLLAPSED_BY_DEFAULT.has(kind);
      const open =
        match[2] === '+' || (!match[2] && !COLLAPSED_BY_DEFAULT.has(kind));
      Object.assign(node, {
        data: {
          hName: collapsible ? 'details' : 'div',
          hProperties: {
            className: ['quiz-callout', `quiz-callout--${kind}`],
            ...(collapsible && open ? { open: true } : {}),
          },
        },
        children: [
          {
            type: 'paragraph',
            data: {
              hName: collapsible ? 'summary' : 'div',
              hProperties: { className: ['quiz-callout-title'] },
            },
            children: titled.length
              ? titled
              : [{ type: 'text', value: CALLOUT_LABELS[kind] }],
          },
          ...(body.length
            ? [container('div', ['quiz-callout-body'], body)]
            : []),
        ],
      });
    };
    visit(tree);
    return tree;
  };
}
