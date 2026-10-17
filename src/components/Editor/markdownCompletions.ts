import {
  autocompletion,
  snippetCompletion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

const templates = [
  snippetCompletion('# ${Heading}', { label: 'h1', detail: 'Heading level 1' }),
  snippetCompletion('## ${Heading}', {
    label: 'h2',
    detail: 'Heading level 2',
  }),
  snippetCompletion('### ${Heading}', {
    label: 'h3',
    detail: 'Heading level 3',
  }),
  snippetCompletion('#### ${Heading}', {
    label: 'h4',
    detail: 'Heading level 4',
  }),
  snippetCompletion('##### ${Heading}', {
    label: 'h5',
    detail: 'Heading level 5',
  }),
  snippetCompletion('###### ${Heading}', {
    label: 'h6',
    detail: 'Heading level 6',
  }),
  snippetCompletion('[${text}](${url})', {
    label: 'link',
    detail: 'Markdown link',
  }),
  snippetCompletion('> ${quote}', { label: 'quote', detail: 'Blockquote' }),
  snippetCompletion('```$0\n${code}\n```', {
    label: 'fence',
    detail: 'Fenced code block',
  }),
  snippetCompletion(
    '| ${Column 1} | ${Column 2} |\n| --- | --- |\n| ${Value} | ${Value} |',
    { label: 'table', detail: 'Markdown table (2 columns)' },
  ),
  snippetCompletion('- [ ] ${task}', {
    label: 'task',
    detail: 'Markdown task',
  }),
  snippetCompletion('- [x] ${task}', {
    label: 'task done',
    detail: 'Completed task',
  }),
  snippetCompletion('![${alt}](${path})', {
    label: 'image',
    detail: 'Markdown image',
  }),
  snippetCompletion('![[${filename}]]', {
    label: 'wiki image',
    detail: 'Vault image embed',
  }),
  snippetCompletion(
    '```mermaid\nflowchart TD\n    A[Start] --> B[Next step]\n```',
    { label: 'mermaid', detail: 'Flowchart fence' },
  ),
  snippetCompletion(
    '```mermaid\nsequenceDiagram\n    Alice->>Bob: Hello\n    Bob-->>Alice: Hi\n```',
    { label: 'mermaid sequence', detail: 'Sequence diagram fence' },
  ),
  snippetCompletion(
    '```chart\ntype: bar\nlabels: ["A", "B"]\nseries:\n  - title: Values\n    data: [1, 2]\n```',
    { label: 'chart', detail: 'Bar chart YAML' },
  ),
  snippetCompletion(
    '```chart\ntype: line\nlabels: ["A", "B"]\nseries:\n  - title: Values\n    data: [1, 2]\n```',
    { label: 'chart line', detail: 'Line chart YAML' },
  ),
];

function codeFenceAt(context: CompletionContext) {
  let fence: { marker: string; kind: string } | null = null;
  for (const line of context.state.doc
    .sliceString(0, context.pos)
    .split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!marker) continue;
    if (!fence)
      fence = {
        marker: marker[1],
        kind: marker[2].trim().split(/\s+/)[0] ?? '',
      };
    else if (
      marker[1][0] === fence.marker[0] &&
      marker[1].length >= fence.marker.length
    )
      fence = null;
  }
  return fence;
}

export function markdownCompletions(context: CompletionContext) {
  const line = context.state.doc.lineAt(context.pos);
  const fence = codeFenceAt(context);
  if (fence && !['mermaid', 'chart'].includes(fence.kind)) return null;
  const prefix = line.text.slice(0, context.pos - line.from);
  const taskPrefix = /^( {0,3}(?:[-+*]|\d+[.)])\s+)\[$/.exec(prefix);
  if (taskPrefix && !fence) {
    return {
      from: line.from,
      options: [
        snippetCompletion(`${taskPrefix[1]}[ ] \${task}`, {
          label: 'task',
          detail: 'Markdown task',
        }),
        snippetCompletion(`${taskPrefix[1]}[x] \${task}`, {
          label: 'task done',
          detail: 'Completed task',
        }),
      ],
    };
  }
  const word = context.matchBefore(/[\w-]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  if (fence?.kind === 'mermaid') {
    return {
      from: word.from,
      options: ['flowchart TD', 'sequenceDiagram', 'graph TD'].map((label) => ({
        label,
        type: 'keyword',
      })),
    };
  }
  if (fence?.kind === 'chart') {
    return {
      from: word.from,
      options: ['type:', 'labels:', 'series:', 'title:', 'data:'].map(
        (label) => ({ label, type: 'property' }),
      ),
    };
  }
  if (
    syntaxTree(context.state).resolveInner(context.pos, -1).name ===
    'InlineCode'
  )
    return null;
  if (
    !/^(?:h[1-6]|heading[1-6]?|link|quote|blockquote|fence|code|table|task|image|mermaid|chart)$/i.test(
      word.text,
    )
  )
    return null;
  return { from: word.from, options: templates };
}

export const markdownCompletionExtension: Extension = autocompletion({
  override: [markdownCompletions],
  activateOnTyping: true,
  defaultKeymap: true,
});
