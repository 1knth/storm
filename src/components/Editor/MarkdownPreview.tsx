import ReactMarkdown from 'react-markdown';
import MermaidBlock from './MermaidBlock';
import NumericChart from './NumericChart';
import { VaultImage } from './VaultImage';

type Props = { markdown: string; vaultId: string; notePath: string };

// Runs on Markdown text nodes only, leaving inline and fenced code literal.
function remarkWikiImages() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!('children' in node)) return;
      const children = [];
      for (const child of node.children) {
        if (child.type === 'text') {
          const text = child;
          const pattern = /!\[\[([^\]]+)\]\]/g;
          let start = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(text.value))) {
            if (match.index > start) children.push({ type: 'text', value: text.value.slice(start, match.index) });
            const [target, size] = match[1].split('|', 2);
            const width = size?.match(/^(\d+)$/)?.[1];
            children.push({ type: 'image', url: target.trim(), alt: size && !width ? size.trim() : '', data: { hProperties: { 'data-vault-kind': 'wiki', ...(width ? { width: Number(width) } : {}) } } });
            start = pattern.lastIndex;
          }
          if (start) {
            if (start < text.value.length) children.push({ type: 'text', value: text.value.slice(start) });
          } else children.push(child);
        } else {
          if (child.type !== 'code') visit(child);
          children.push(child);
        }
      }
      node.children = children as typeof node.children;
    };
    visit(tree);
  };
}

export default function MarkdownPreview({ markdown, vaultId, notePath }: Props) {
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-l border-white/10">
      <h2 className="shrink-0 px-4 py-3 text-xs font-medium text-white/50">Preview</h2>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-6 text-sm leading-7 text-white/85 [&_a]:text-sky-300 [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-white/15 [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_ul]:list-disc [&_ul]:pl-6 [&_img]:max-w-full">
        <ReactMarkdown remarkPlugins={[remarkWikiImages]} components={{
          a: ({ children }) => <a href="#" onClick={(event) => event.preventDefault()} aria-disabled="true">{children}</a>,
          img: ({ src, alt, width, node }) => <VaultImage vaultId={vaultId} notePath={notePath} src={String(src ?? '')} alt={alt} width={typeof width === 'number' ? width : undefined} kind={node?.properties['data-vault-kind'] === 'wiki' ? 'wiki' : 'markdown'} />,
          pre: ({ children }) => {
            const child = Array.isArray(children) ? children[0] : children;
            if (child && typeof child === 'object' && 'props' in child) {
              const props = child.props as { className?: string; children?: unknown };
              const source = String(props.children ?? '').replace(/\n$/, '');
              if (props.className?.split(/\s+/).includes('language-mermaid')) return <MermaidBlock source={source} />;
              if (props.className?.split(/\s+/).includes('language-chart')) return <NumericChart source={source} />;
            }
            return <pre>{children}</pre>;
          },
        }}>{markdown}</ReactMarkdown>
      </div>
    </section>
  );
}
