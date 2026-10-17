import React, { createContext, memo, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  markdownMathRemarkPlugin,
  markdownMathRehypePlugin,
} from './markdownMath';
import 'katex/dist/katex.min.css';
import MermaidBlock from './MermaidBlock';
import NumericChart from './NumericChart';
import { VaultImage } from './VaultImage';
import { remarkTaskOffsets } from './markdownTasks';
import type { TaskTogglePayload } from './markdownTasks';
import type { Appearance } from '../../appearance';

function sourcePositions() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (node.type === 'element' && node.position?.start?.line) {
        node.properties ??= {};
        node.properties['data-source-start'] = node.position.start.line;
        node.properties['data-source-end'] =
          node.position.end?.line ?? node.position.start.line;
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

type Props = {
  markdown: string;
  vaultId: string;
  notePath: string;
  onToggleTask?: (payload: TaskTogglePayload) => void;
  onOpenNote?: (target: string) => void;
  compact?: boolean;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  onUserScroll?: () => void;
  appearance: Appearance;
};

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
            if (match.index > start)
              children.push({
                type: 'text',
                value: text.value.slice(start, match.index),
              });
            const [target, size] = match[1].split('|', 2);
            const width = size?.match(/^(\d+)$/)?.[1];
            children.push({
              type: 'image',
              url: target.trim(),
              alt: size && !width ? size.trim() : '',
              data: {
                hProperties: {
                  'data-vault-kind': 'wiki',
                  ...(width ? { width: Number(width) } : {}),
                },
              },
            });
            start = pattern.lastIndex;
          }
          if (start) {
            if (start < text.value.length)
              children.push({ type: 'text', value: text.value.slice(start) });
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

function remarkWikiLinks() {
  return (tree: any) => {
    const visit = (node: any) => {
      if (!Array.isArray(node.children)) return;
      const children: any[] = [];
      for (const child of node.children) {
        if (child.type === 'text') {
          const pattern = /(?<!!)\[\[([^\]]+)\]\]/g;
          let start = 0;
          let match: RegExpExecArray | null;
          while ((match = pattern.exec(child.value))) {
            if (match.index > start)
              children.push({
                type: 'text',
                value: child.value.slice(start, match.index),
              });
            const [rawTarget, rawLabel] = match[1].split('|', 2);
            const target = rawTarget.trim();
            if (target)
              children.push({
                type: 'link',
                url: `vault-note:${encodeURIComponent(target)}`,
                children: [
                  { type: 'text', value: (rawLabel ?? target).trim() },
                ],
              });
            start = pattern.lastIndex;
          }
          if (start < child.value.length)
            children.push({ type: 'text', value: child.value.slice(start) });
        } else {
          if (child.type !== 'code' && child.type !== 'image') visit(child);
          children.push(child);
        }
      }
      node.children = children;
    };
    visit(tree);
  };
}

const AppearanceContext = createContext<Appearance | null>(null);

function MarkdownPre({
  children,
  ...sourceProps
}: {
  children?: React.ReactNode;
  'data-source-start'?: number;
  'data-source-end'?: number;
}) {
  const appearance = useContext(AppearanceContext);
  if (!appearance) throw new Error('MarkdownPre requires AppearanceContext');
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === 'object' && 'props' in child) {
    const props = child.props as {
      className?: string;
      children?: unknown;
    };
    const source = String(props.children ?? '').replace(/\n$/, '');
    if (props.className?.split(/\s+/).includes('language-mermaid'))
      return (
        <div {...sourceProps}>
          <MermaidBlock source={source} appearance={appearance} />
        </div>
      );
    if (props.className?.split(/\s+/).includes('language-chart'))
      return (
        <div {...sourceProps}>
          <NumericChart source={source} />
        </div>
      );
  }
  return <pre {...sourceProps}>{children}</pre>;
}

function MarkdownPreview({
  markdown,
  vaultId,
  notePath,
  onToggleTask,
  onOpenNote,
  compact = false,
  scrollRef,
  onScroll,
  onUserScroll,
  appearance,
}: Props) {
  return (
    <section
      aria-label={compact ? 'Reading preview' : undefined}
      className={`flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${compact ? '' : 'border-l border-white/10'}`}
    >
      {!compact && (
        <h2 className="preview-heading shrink-0 px-4 py-3 text-xs font-medium text-white/50">
          Preview
        </h2>
      )}
      <AppearanceContext.Provider value={appearance}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheelCapture={onUserScroll}
          onPointerDownCapture={onUserScroll}
          onTouchStartCapture={onUserScroll}
          className="markdown-preview-content min-h-0 flex-1 overflow-auto px-5 pb-6 text-sm leading-7 text-white/85 [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex]:text-inherit [&_a]:text-sky-300 [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-white/15 [&_li]:my-1 [&_li:has(>label)]:list-none [&_li:has(>label)]:pl-0 [&_ul:has(>li>label)]:!list-none [&_ul:has(>li>label)]:!pl-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-white/20 [&_th]:px-3 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-white/20 [&_td]:px-3 [&_td]:py-1 [&_ul]:list-disc [&_ul]:pl-6 [&_img]:max-w-full"
        >
          <ReactMarkdown
            remarkPlugins={[
              markdownMathRemarkPlugin,
              remarkGfm,
              () => remarkTaskOffsets(markdown),
              remarkWikiImages,
              remarkWikiLinks,
            ]}
            rehypePlugins={[sourcePositions, markdownMathRehypePlugin]}
            components={{
              h1: ({ children, ...props }) => (
                <h1 {...props} style={{ color: appearance.headings[0] }}>
                  {children}
                </h1>
              ),
              h2: ({ children, ...props }) => (
                <h2 {...props} style={{ color: appearance.headings[1] }}>
                  {children}
                </h2>
              ),
              h3: ({ children, ...props }) => (
                <h3 {...props} style={{ color: appearance.headings[2] }}>
                  {children}
                </h3>
              ),
              h4: ({ children, ...props }) => (
                <h4 {...props} style={{ color: appearance.headings[3] }}>
                  {children}
                </h4>
              ),
              h5: ({ children, ...props }) => (
                <h5 {...props} style={{ color: appearance.headings[4] }}>
                  {children}
                </h5>
              ),
              h6: ({ children, ...props }) => (
                <h6 {...props} style={{ color: appearance.headings[5] }}>
                  {children}
                </h6>
              ),
              table: ({ children, ...props }) => (
                <div className="my-4 max-w-full overflow-x-auto">
                  <table {...props}>{children}</table>
                </div>
              ),
              li: ({ children, node, ...props }: any) => {
                const offset = node?.properties['data-task-offset'];
                const childElements = React.Children.toArray(children);
                const taskInput = childElements.find(
                  (child) =>
                    React.isValidElement(child) &&
                    (child.props as { type?: string }).type === 'checkbox',
                );
                if (
                  !React.isValidElement(taskInput) ||
                  typeof offset !== 'number'
                )
                  return <li {...props}>{children}</li>;

                const checked = Boolean(
                  (taskInput.props as { checked?: boolean }).checked,
                );
                const expected = markdown[offset];
                const taskContent = childElements.filter(
                  (child) => child !== taskInput && child !== ' ',
                );

                return (
                  <li
                    {...props}
                    className={`${props.className ?? ''} !list-none !pl-0`}
                  >
                    <label className="inline-flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!onToggleTask}
                        aria-label={
                          checked
                            ? 'Mark task incomplete'
                            : 'Mark task complete'
                        }
                        className="mt-2 accent-sky-400"
                        onChange={() =>
                          onToggleTask?.({
                            vaultId,
                            notePath,
                            source: markdown,
                            offset,
                            expected,
                          })
                        }
                      />
                      <span>{taskContent}</span>
                    </label>
                  </li>
                );
              },
              a: ({ children, href }) => {
                const target =
                  typeof href === 'string' && href.startsWith('vault-note:')
                    ? decodeURIComponent(href.slice('vault-note:'.length))
                    : null;
                return (
                  <a
                    href={target ? '#' : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      if (target) onOpenNote?.(target);
                    }}
                    aria-disabled={!target || !onOpenNote}
                  >
                    {children}
                  </a>
                );
              },
              img: ({ src, alt, width, node }) => (
                <VaultImage
                  vaultId={vaultId}
                  notePath={notePath}
                  src={String(src ?? '')}
                  alt={alt}
                  width={typeof width === 'number' ? width : undefined}
                  kind={
                    node?.properties['data-vault-kind'] === 'wiki'
                      ? 'wiki'
                      : 'markdown'
                  }
                />
              ),
              pre: MarkdownPre,
            }}
          >
            {markdown}
          </ReactMarkdown>
        </div>
      </AppearanceContext.Provider>
    </section>
  );
}

export default memo(MarkdownPreview);
