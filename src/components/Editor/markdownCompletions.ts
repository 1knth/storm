import {
  autocompletion,
  snippetCompletion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';

const templates = [
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
  const word = context.matchBefore(/[\w-]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const fence = codeFenceAt(context);
  if (fence && !['mermaid', 'chart'].includes(fence.kind)) return null;
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
  if (!/^(table|task|image|mermaid|chart)$/i.test(word.text)) return null;
  return { from: word.from, options: templates };
}

export const markdownCompletionExtension: Extension = autocompletion({
  override: [markdownCompletions],
  activateOnTyping: true,
  defaultKeymap: true,
});
