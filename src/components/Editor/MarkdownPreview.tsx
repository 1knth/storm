import React, {
  createContext,
  useCallback,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getHeadingFoldState, setHeadingFoldState } from './headingFoldState';
import {
  markdownMathRemarkPlugin,
  markdownMathRehypePlugin,
} from './markdownMath';
import 'katex/dist/katex.min.css';
import MermaidBlock from './MermaidBlock';
import NumericChart from './NumericChart';
import { VaultImage } from './VaultImage';
import { remarkTaskOffsets } from './markdownTasks';
import { remarkSoftBreaks } from './markdownSoftBreaks';
import { remarkListContinuations } from './markdownListContinuations';
import { remarkBlankLines } from './markdownBlankLines';
import type { TaskTogglePayload } from './markdownTasks';
import {
  findPreviewTextMatchesInBlocks,
  nextPreviewFindIndex,
} from './previewFind';
import type { Appearance } from '../../appearance';
import {
  isActiveAgentPreviewReveal,
  isNextPreviewVisualLine,
  previewFollowTailSpace,
  previewFollowTarget,
} from './previewAutoFollow';
import {
  createRevealScheduleRegistry,
  collectPendingRevealKeys,
  PREVIEW_REVEAL_CADENCE_MS,
  planRevealUnits,
  getRevealTiming,
  getReadyRevealDelay,
  isRevealComplete,
  completeRevealUnit,
  commitRevealTimeline,
  markRevealStarted,
  wordSegments,
} from './managedPreviewBatch';

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

export function rehypeRevealUnits({
  registry,
  startOffset,
  revealRanges,
  markdown,
}: {
  registry: ReturnType<typeof createRevealScheduleRegistry>;
  startOffset: number;
  revealRanges?: readonly { from: number; to: number }[];
  markdown: string;
}) {
  return (tree: any) => {
    const units: {
      key: string;
      sourceOffset: number;
      kind: 'word' | 'block';
      paragraphKey?: string;
    }[] = [];
    const lineOffsets = [0];
    for (let index = 0; index < markdown.length; index++)
      if (markdown[index] === '\\n') lineOffsets.push(index + 1);
    let fallbackOffset = 0;
    const visit = (node: any, path: number[], ineligible = false) => {
      const excluded =
        ineligible ||
        (node.properties?.className ?? []).some((name: string) =>
          ['katex', 'katex-display'].includes(name),
        ) ||
        ['math', 'inlineMath', 'image', 'img', 'svg', 'input'].includes(
          node.tagName,
        );
      if (['pre', 'table'].includes(node.tagName)) {
        const offset =
          node.position?.start?.offset ??
          lineOffsets[(node.position?.start?.line ?? 1) - 1] ??
          fallbackOffset;
        const end = node.position?.end?.offset ?? offset;
        const key = `block:${offset}:${path.join('.')}`;
        const eligible =
          registry.words.has(key) ||
          (revealRanges
            ? revealRanges.some(({ from, to }) => offset < to && end > from)
            : offset >= startOffset);
        if (eligible) {
          units.push({ key, sourceOffset: offset, kind: 'block' });
          node.properties ??= {};
          node.properties['data-reveal-key'] = key;
          node.properties['data-reveal-kind'] = 'block';
        }
      }
      if (['li', 'blockquote'].includes(node.tagName)) {
        node.properties ??= {};
        node.properties['data-reveal-decoration'] = node.tagName;
      }
      if (
        ['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(
          node.tagName,
        ) &&
        !excluded
      ) {
        node.properties ??= {};
        const paragraphStart =
          node.position?.start?.offset ??
          lineOffsets[(node.position?.start?.line ?? 1) - 1] ??
          fallbackOffset;
        const paragraphKey = `paragraph:${paragraphStart}`;
        let paragraphTextOffset = 0;
        node.properties.className = [
          ...(node.properties.className ?? []),
          'markdown-prose-reveal',
        ];
        const wrap = (child: any, childPath: number[], blocked = false) => {
          if (child.tagName === 'code' && !blocked) {
            child.properties ??= {};
            child.properties['data-reveal-decoration'] = 'code';
          }
          if (['li', 'blockquote'].includes(child.tagName)) {
            child.properties ??= {};
            child.properties['data-reveal-decoration'] = child.tagName;
          }
          const childBlocked =
            blocked ||
            (child.properties?.className ?? []).some((name: string) =>
              ['katex', 'katex-display'].includes(name),
            ) ||
            [
              'math',
              'inlineMath',
              'image',
              'img',
              'svg',
              'table',
              'input',
            ].includes(child.tagName);
          if (child.type === 'text' && !childBlocked) {
            const position = child.position?.start?.offset;
            const base = position ?? paragraphStart + paragraphTextOffset;
            const text = child.value ?? '';
            paragraphTextOffset += text.length;
            fallbackOffset = Math.max(fallbackOffset, base + text.length);
            // Remark transforms may replace text nodes without preserving their
            // positions. Anchor those nodes to the positioned paragraph instead
            // of treating their local offsets as document-global source offsets.
            const eligibilityOffset =
              position === undefined ? paragraphStart : base;
            const segments = wordSegments(text, base, startOffset);
            if (revealRanges) {
              for (const segment of segments) {
                const segmentEnd = segment.offset + segment.text.length;
                segment.animate =
                  !/^\s+$/.test(segment.text) &&
                  revealRanges.some(
                    ({ from, to }) => segment.offset < to && segmentEnd > from,
                  );
              }
            } else if (position === undefined) {
              for (const segment of segments)
                segment.animate =
                  !/^\s+$/.test(segment.text) &&
                  eligibilityOffset >= startOffset;
            }
            return segments.map((segment, index) => {
              if (!segment.animate)
                return { type: 'text', value: segment.text };
              const key = `word:${base}:${childPath.join('.')}:${index}`;
              units.push({
                key,
                sourceOffset: segment.offset,
                kind: 'word',
                paragraphKey,
              });
              return {
                type: 'element',
                tagName: 'span',
                properties: {
                  className: ['markdown-word-reveal'],
                  'data-preview-reveal-word': '',
                  'data-reveal-key': key,
                },
                children: [{ type: 'text', value: segment.text }],
              };
            });
          }
          if (child.children)
            child.children = child.children.flatMap(
              (nested: any, index: number) =>
                wrap(nested, [...childPath, index], childBlocked),
            );
          return [child];
        };
        node.children = (node.children ?? []).flatMap(
          (child: any, index: number) => wrap(child, [...path, index]),
        );
      } else {
        (node.children ?? []).forEach((child: any, index: number) =>
          visit(child, [...path, index], excluded),
        );
      }
    };
    visit(tree, []);
    const plans = planRevealUnits(
      registry,
      units,
      Date.now(),
      PREVIEW_REVEAL_CADENCE_MS,
    );
    const schedules = new Map(plans.map((plan) => [plan.key, plan]));
    const apply = (node: any): number | undefined => {
      const key = node.properties?.['data-reveal-key'];
      const plan = key ? schedules.get(key) : undefined;
      if (plan) node.properties['data-reveal-at'] = plan.scheduledAt;
      const childScheduleTimes = (node.children ?? [])
        .map(apply)
        .filter(
          (time: number | undefined): time is number => time !== undefined,
        );
      const firstReveal =
        plan?.scheduledAt ??
        (childScheduleTimes.length
          ? Math.min(...childScheduleTimes)
          : undefined);
      if (
        firstReveal !== undefined &&
        node.properties?.['data-reveal-decoration']
      )
        node.properties['data-reveal-decoration-at'] = firstReveal;
      return firstReveal;
    };
    apply(tree);
  };
}

type Props = {
  markdown: string;
  vaultId: string;
  notePath: string;
  onToggleTask?: (payload: TaskTogglePayload) => void;
  onOpenNote?: (target: string) => void;
  compact?: boolean;
  findOpen?: boolean;
  onCloseFind?: () => void;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  onUserScroll?: () => void;
  onScrollIntent?: () => void;
  onReadingKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  appearance: Appearance;
  revealStartLine?: number;
  revealRanges?: readonly { from: number; to: number }[];
  revealId?: string;
  previewRevision?: number;
  revealRegistry?: ReturnType<typeof createRevealScheduleRegistry>;
  onRevealProgress?: (progress: {
    generationId: string;
    previewKey: number;
    pending: boolean;
    snapshot: string;
    revision: number;
  }) => void;
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

export function markdownPreviewUrlTransform(url: string): string {
  // Wiki links are generated by remarkWikiLinks; keep their internal routing
  // scheme while delegating every other URL to react-markdown's sanitizer.
  if (/^vault-note:[^\s]*$/i.test(url)) return url;
  return defaultUrlTransform(url);
}

export function remarkWikiLinks() {
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

export function rehypeHeadingSections() {
  return (tree: any) => {
    const children = tree.children ?? [];
    const output: any[] = [];
    const stack: { level: number; section: any }[] = [];
    for (const child of children) {
      // Only document-level headings start sections. Headings nested in lists or
      // blockquotes belong to that container and must not restructure siblings.
      const match =
        child.type === 'element'
          ? /^h([1-6])$/.exec(child.tagName ?? '')
          : null;
      if (match) {
        const level = Number(match[1]);
        while (stack.length && stack[stack.length - 1].level >= level)
          stack.pop();
        const section = {
          type: 'element',
          tagName: 'preview-section',
          properties: {
            'data-section-start': child.properties?.['data-source-start'],
            'data-section-level': level,
          },
          data: child.data,
          children: [child],
        };
        (stack.length ? stack[stack.length - 1].section.children : output).push(
          section,
        );
        stack.push({ level, section });
      } else {
        (stack.length ? stack[stack.length - 1].section.children : output).push(
          child,
        );
      }
    }
    tree.children = output;
  };
}

const AppearanceContext = createContext<Appearance | null>(null);
const ImageContext = createContext<{
  vaultId: string;
  notePath: string;
} | null>(null);
const PreviewContext = createContext<{
  markdown: string;
  vaultId: string;
  notePath: string;
  onToggleTask?: (payload: TaskTogglePayload) => void;
  onOpenNote?: (target: string) => void;
} | null>(null);
const HeadingFoldContext = createContext<{
  collapsed: boolean;
  toggle: () => void;
} | null>(null);

function MarkdownImage({ src, alt, width, node }: any) {
  const context = useContext(ImageContext);
  if (!context) throw new Error('MarkdownImage requires ImageContext');
  return (
    <VaultImage
      vaultId={context.vaultId}
      notePath={context.notePath}
      src={String(src ?? '')}
      alt={alt}
      width={typeof width === 'number' ? width : undefined}
      kind={
        node?.properties['data-vault-kind'] === 'wiki' ? 'wiki' : 'markdown'
      }
    />
  );
}

function MarkdownSection({ children, node }: any) {
  const identity = node?.properties?.['data-section-start'] ?? 'unknown';
  const context = useContext(PreviewContext);
  const collapseKey = JSON.stringify([
    context?.vaultId ?? '',
    context?.notePath ?? '',
    identity,
  ]);
  const [collapsed, setCollapsed] = useState(
    () => getHeadingFoldState(collapseKey) ?? false,
  );
  useEffect(() => {
    setCollapsed(getHeadingFoldState(collapseKey) ?? false);
  }, [collapseKey]);
  return (
    <section
      key={`${identity}`}
      data-preview-section={identity}
      data-collapsed={collapsed || undefined}
    >
      <HeadingFoldContext.Provider
        value={{
          collapsed,
          toggle: () => {
            const next = !collapsed;
            setHeadingFoldState(collapseKey, next);
            setCollapsed(next);
          },
        }}
      >
        <div>
          {React.Children.map(children, (child, index) => (
            <div
              aria-hidden={collapsed && index > 0 ? true : undefined}
              inert={collapsed && index > 0 ? true : undefined}
              style={
                collapsed && index > 0
                  ? {
                      height: 0,
                      overflow: 'hidden',
                      visibility: 'hidden',
                      pointerEvents: 'none',
                    }
                  : undefined
              }
            >
              {child}
            </div>
          ))}
        </div>
      </HeadingFoldContext.Provider>
    </section>
  );
}

function MarkdownHeading({ level, children, ...props }: any) {
  const appearance = useContext(AppearanceContext);
  const fold = useContext(HeadingFoldContext);
  if (!appearance)
    throw new Error('MarkdownHeading requires AppearanceContext');
  const Tag = `h${level}` as React.ElementType;
  return (
    <Tag
      {...props}
      className={`${props.className ?? ''} preview-fold-heading`}
      style={{ color: appearance.headings[level - 1] }}
    >
      <span className="preview-fold-heading-text">
        {children}
        <button
          type="button"
          aria-label={`${fold?.collapsed ? 'Expand' : 'Collapse'} heading`}
          aria-expanded={!fold?.collapsed}
          onClick={fold?.toggle}
          className="preview-heading-fold-control"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className={
              fold?.collapsed
                ? 'preview-fold-icon is-collapsed'
                : 'preview-fold-icon'
            }
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </span>
    </Tag>
  );
}

function MarkdownTable({ children, ...props }: any) {
  return (
    <RevealBlock sourceProps={props}>
      <div className="my-4 max-w-full overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
    </RevealBlock>
  );
}

function MarkdownTaskListItem({ children, node, ...props }: any) {
  const context = useContext(PreviewContext);
  if (!context) throw new Error('MarkdownTaskListItem requires PreviewContext');
  const { markdown, vaultId, notePath, onToggleTask } = context;
  const offset = node?.properties['data-task-offset'];
  const expected = typeof offset === 'number' ? markdown[offset] : undefined;
  const scheduledAt = Number(props['data-reveal-decoration-at']);
  const [decorationDelay] = useState(() =>
    Number.isFinite(scheduledAt)
      ? `${Math.max(0, scheduledAt - Date.now())}ms`
      : '0ms',
  );
  if (
    typeof offset !== 'number' ||
    (expected !== ' ' && expected !== 'x' && expected !== 'X')
  )
    return (
      <li
        {...props}
        style={{
          ...props.style,
          '--markdown-decoration-delay': decorationDelay,
        }}
      >
        {children}
      </li>
    );
  let removedTaskInput = false;
  let firstParagraph = true;
  const removeTaskInput = (element: React.ReactNode): React.ReactNode => {
    if (!React.isValidElement(element) || removedTaskInput) return element;
    const type = element.type;
    if (type === 'ul' || type === 'ol') return element;
    const elementProps = element.props as {
      children?: React.ReactNode;
      type?: string;
    };
    if (type === 'input' && elementProps.type === 'checkbox') {
      removedTaskInput = true;
      return null;
    }
    if (!('children' in elementProps)) return element;
    const isFirstParagraph = type === 'p' && firstParagraph;
    if (isFirstParagraph) firstParagraph = false;
    return React.cloneElement(element, {
      ...elementProps,
      ...(isFirstParagraph
        ? { className: `${(elementProps as any).className ?? ''} !my-0` }
        : {}),
      children: React.Children.map(elementProps.children, removeTaskInput),
    } as any);
  };
  const taskContent = React.Children.toArray(children).map(removeTaskInput);
  const checked = expected.toLowerCase() === 'x';
  return (
    <li
      {...props}
      className={`${props.className ?? ''} !list-none !pl-0`}
      style={{
        ...props.style,
        '--markdown-decoration-delay': decorationDelay,
        listStyleType: 'none',
      }}
    >
      <label className="inline-flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={!onToggleTask}
          aria-label={checked ? 'Mark task incomplete' : 'Mark task complete'}
          className="mt-[2px] accent-sky-400"
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
}

function MarkdownLink({ children, href }: any) {
  const context = useContext(PreviewContext);
  if (!context) throw new Error('MarkdownLink requires PreviewContext');
  const target =
    typeof href === 'string' && href.startsWith('vault-note:')
      ? decodeURIComponent(href.slice('vault-note:'.length))
      : null;
  const safeExternal = (() => {
    if (typeof href !== 'string') return null;
    try {
      const url = new URL(href);
      return url.protocol === 'https:' || url.protocol === 'http:'
        ? url.href
        : null;
    } catch {
      return null;
    }
  })();
  return (
    <a
      href={target ? '#' : (safeExternal ?? undefined)}
      target={safeExternal ? '_blank' : undefined}
      rel={safeExternal ? 'noopener noreferrer' : undefined}
      onClick={(event) => {
        if (target) {
          event.preventDefault();
          context.onOpenNote?.(target);
        } else if (!safeExternal) event.preventDefault();
      }}
      aria-disabled={!target && !safeExternal ? true : undefined}
    >
      {children}
    </a>
  );
}

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
        <RevealBlock
          sourceProps={sourceProps}
          waitForReady
          readinessKey={source}
        >
          {(onReady: () => void) => (
            <MermaidBlock
              source={source}
              appearance={appearance}
              onReady={onReady}
            />
          )}
        </RevealBlock>
      );
    if (props.className?.split(/\s+/).includes('language-chart'))
      return (
        <RevealBlock sourceProps={sourceProps}>
          <NumericChart source={source} appearance={appearance} />
        </RevealBlock>
      );
  }
  return (
    <RevealBlock sourceProps={sourceProps}>
      <pre {...sourceProps}>{children}</pre>
    </RevealBlock>
  );
}

function RevealBlock({
  sourceProps,
  children,
  waitForReady = false,
  readinessKey,
}: any) {
  const context = useContext(RevealContext);
  const registry = useContext(RevealRegistryContext);
  const start = sourceProps?.['data-source-start'];
  const schedule = registry?.words.get(
    String(sourceProps?.['data-reveal-key']),
  );
  const key = String(sourceProps?.['data-reveal-key']);
  const timing =
    registry && schedule
      ? {
          delay: getRevealTiming(registry, key, Date.now()),
          complete: isRevealComplete(registry, key, Date.now()),
        }
      : null;
  const [activation, setActivation] = useState<{
    key: string | undefined;
    delay: number;
  } | null>(null);
  const ready = !waitForReady || activation?.key === readinessKey;
  const onReady = useCallback(() => {
    setActivation((current) => {
      if (current?.key === readinessKey) return current;
      return {
        key: readinessKey,
        delay: getReadyRevealDelay(
          schedule?.scheduledAt ?? Date.now(),
          Date.now(),
        ),
      };
    });
  }, [readinessKey, schedule]);
  if (!context || !registry || typeof start !== 'number' || !schedule)
    return typeof children === 'function' ? children(onReady) : children;
  return (
    <div
      {...sourceProps}
      data-preview-reveal-block=""
      data-reveal-gated={waitForReady && !ready ? 'pending' : undefined}
      className="markdown-block-reveal"
      style={
        !ready
          ? { animation: 'none', opacity: 0 }
          : waitForReady
            ? { animationDelay: `${activation?.delay ?? 0}ms` }
            : timing?.complete
              ? { animation: 'none', opacity: 1 }
              : { animationDelay: `${Math.max(0, timing?.delay ?? 0)}ms` }
      }
    >
      {typeof children === 'function' ? children(onReady) : children}
    </div>
  );
}

export function AnimatedRevealWord({ children, ...props }: any) {
  const registry = useContext(RevealRegistryContext);
  const key = props['data-reveal-key'];
  const timing =
    registry && typeof key === 'string'
      ? {
          delay: getRevealTiming(registry, key, Date.now()),
          complete: isRevealComplete(registry, key, Date.now()),
        }
      : null;
  const [delay] = useState(() => timing?.delay ?? 0);
  const style = timing?.complete
    ? { animation: 'none', opacity: 1 }
    : { animationDelay: `${delay}ms` };
  return (
    <span {...props} style={style}>
      {children}
    </span>
  );
}

export function RevealWordAdapter({ children, node: _node, ...props }: any) {
  const key = props['data-reveal-key'];
  // KaTeX uses inline styles for fractions, scripts, and baselines. Only spans
  // explicitly marked by our reveal plugin should receive animation styles.
  if (typeof key !== 'string') return <span {...props}>{children}</span>;
  return (
    <AnimatedRevealWord key={key} {...props}>
      {children}
    </AnimatedRevealWord>
  );
}

function RevealDecoration({ tag: Tag, children, ...props }: any) {
  const scheduledAt = Number(props['data-reveal-decoration-at']);
  const [revealDelay] = useState(() =>
    Number.isFinite(scheduledAt) ? Math.max(0, scheduledAt - Date.now()) : 0,
  );
  return (
    <Tag
      {...props}
      style={{
        ...props.style,
        '--markdown-decoration-delay': `${revealDelay}ms`,
      }}
    >
      {children}
    </Tag>
  );
}

const markdownComponents = {
  'preview-section': MarkdownSection,
  blockquote: (props: any) => <RevealDecoration tag="blockquote" {...props} />,
  code: (props: any) => <RevealDecoration tag="code" {...props} />,
  h1: (props: any) => <MarkdownHeading {...props} level={1} />,
  h2: (props: any) => <MarkdownHeading {...props} level={2} />,
  h3: (props: any) => <MarkdownHeading {...props} level={3} />,
  h4: (props: any) => <MarkdownHeading {...props} level={4} />,
  h5: (props: any) => <MarkdownHeading {...props} level={5} />,
  h6: (props: any) => <MarkdownHeading {...props} level={6} />,
  span: RevealWordAdapter,
  table: MarkdownTable,
  li: MarkdownTaskListItem,
  a: MarkdownLink,
  img: MarkdownImage,
  pre: MarkdownPre,
};

const RevealContext = createContext<{ startLine: number; id?: string } | null>(
  null,
);
const RevealRegistryContext = createContext<ReturnType<
  typeof createRevealScheduleRegistry
> | null>(null);

function MarkdownPreview({
  markdown,
  vaultId,
  notePath,
  onToggleTask,
  onOpenNote,
  compact = false,
  findOpen: controlledFindOpen,
  onCloseFind,
  scrollRef,
  onScroll,
  onUserScroll,
  onScrollIntent,
  onReadingKeyDown,
  appearance,
  revealStartLine,
  revealRanges,
  revealId,
  previewRevision,
  revealRegistry,
  onRevealProgress,
}: Props) {
  const viteEnv = (
    import.meta as ImportMeta & { env?: Record<string, string | boolean> }
  ).env;
  const diagnosticsEnabled =
    viteEnv?.DEV === true && viteEnv.VITE_STORM_REVEAL_DEBUG === '1';
  const [diagnostics, setDiagnostics] = useState(
    'Reveal diagnostics enabled; waiting for preview commit.',
  );
  const followRef = useRef({
    frame: 0,
    lastLineTop: Number.NEGATIVE_INFINITY,
    lastUnit: null as HTMLElement | null,
  });
  const followTailRef = useRef<{
    container: HTMLElement;
    original: string;
    basePadding: number;
  } | null>(null);
  const scrollElement = scrollRef;

  useEffect(() => {
    return () => {
      const tail = followTailRef.current;
      if (!tail) return;
      tail.container.style.paddingBottom = tail.original;
      followTailRef.current = null;
    };
  }, [notePath]);
  useEffect(() => {
    const container = scrollElement?.current;
    if (!container || !isActiveAgentPreviewReveal(revealId, revealRanges))
      return;
    const state = followRef.current;
    state.lastLineTop = Number.NEGATIVE_INFINITY;
    if (
      !followTailRef.current ||
      followTailRef.current.container !== container
    ) {
      followTailRef.current = {
        container,
        original: container.style.paddingBottom,
        basePadding:
          Number.parseFloat(window.getComputedStyle(container).paddingBottom) ||
          0,
      };
    }
    const updateTailSpace = () => {
      const basePadding = followTailRef.current?.basePadding ?? 0;
      container.style.paddingBottom = `${basePadding + previewFollowTailSpace(container.clientHeight)}px`;
    };
    updateTailSpace();
    const followLine = (unit: HTMLElement) => {
      if (!unit.isConnected) return;
      const containerRect = container.getBoundingClientRect();
      const visualLineTop =
        unit.getBoundingClientRect().top -
        containerRect.top +
        container.scrollTop;
      const target = previewFollowTarget({
        visualLineTop,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
      });
      const reducedMotion = window.matchMedia(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      container.scrollTo({
        top: target,
        behavior: reducedMotion ? 'instant' : 'smooth',
      });
    };
    const onAnimationStart = (event: AnimationEvent) => {
      if (
        !event.target ||
        !(event.target instanceof HTMLElement) ||
        !event.target.matches(
          '[data-preview-reveal-word], [data-preview-reveal-block]',
        )
      )
        return;
      const unit = event.target;
      state.lastUnit = unit;
      const key = unit.dataset.revealKey;
      if (key) markRevealStarted(registryRef.current!.registry, key);
      cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(() => {
        state.frame = 0;
        const containerRect = container.getBoundingClientRect();
        const visualLineTop =
          unit.getBoundingClientRect().top -
          containerRect.top +
          container.scrollTop;
        if (!isNextPreviewVisualLine(visualLineTop, state.lastLineTop)) return;
        state.lastLineTop = visualLineTop;
        followLine(unit);
      });
    };
    const onResize = () => {
      updateTailSpace();
      if (!state.lastUnit) return;
      cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(() => {
        state.frame = 0;
        if (state.lastUnit) followLine(state.lastUnit);
      });
    };
    container.addEventListener('animationstart', onAnimationStart, true);
    window.addEventListener('resize', onResize);
    return () => {
      container.removeEventListener('animationstart', onAnimationStart, true);
      window.removeEventListener('resize', onResize);
      state.lastUnit = null;
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, [scrollElement, notePath, revealId, revealRanges]);
  const registryRef = useRef<{
    id?: string;
    registry: ReturnType<typeof createRevealScheduleRegistry>;
  } | null>(null);
  if (revealRegistry) {
    registryRef.current = { id: revealId, registry: revealRegistry };
  } else if (
    registryRef.current === null ||
    registryRef.current.id !== revealId
  ) {
    registryRef.current = {
      id: revealId,
      registry: createRevealScheduleRegistry(),
    };
  }
  const diagnosticsRoot = useRef<HTMLElement>(null);
  const findOpen = controlledFindOpen ?? false;
  const closeFind = onCloseFind ?? (() => {});
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const findMatches = useRef<Range[]>([]);
  useEffect(() => {
    if (findOpen) {
      findInput.current?.focus();
    }
  }, [findOpen]);
  useEffect(() => {
    const root = diagnosticsRoot.current;
    const highlights = window.CSS as typeof CSS & {
      highlights?: Map<string, unknown>;
    };
    if (!root || !highlights?.highlights) return;
    const name = 'storm-note-find';
    let style = document.getElementById('storm-note-find-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'storm-note-find-style';
      style.textContent =
        '::highlight(storm-note-find) { background: #b7791f; color: white; }';
      document.head.append(style);
    }
    highlights.highlights.delete(name);
    findMatches.current = [];
    if (findQuery) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: { node: Node; start: number; end: number }[] = [];
      const blocks: { key: Element | null; text: string }[] = [];
      let text = '';
      let currentBlock: Element | null = null;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (
          node.parentElement?.closest(
            'button, input, script, style, [role="search"]',
          )
        )
          continue;
        const block =
          node.parentElement?.closest(
            'p, li, blockquote, pre, table, h1, h2, h3, h4, h5, h6, section, div',
          ) ?? null;
        if (blocks.length && block !== currentBlock) text += '\u0000';
        currentBlock = block;
        const value = node.textContent ?? '';
        nodes.push({
          node,
          start: text.length,
          end: text.length + value.length,
        });
        text += value;
        const previous = blocks[blocks.length - 1];
        if (previous?.key === block) previous.text += value;
        else blocks.push({ key: block, text: value });
      }
      for (const match of findPreviewTextMatchesInBlocks(
        blocks.map(({ text: blockText }) => blockText),
        findQuery,
      )) {
        const startNode = nodes.find(
          (item) => match.start >= item.start && match.start < item.end,
        );
        const endNode = nodes.find(
          (item) => match.end > item.start && match.end <= item.end,
        );
        if (!startNode || !endNode) continue;
        const range = document.createRange();
        range.setStart(startNode.node, match.start - startNode.start);
        range.setEnd(endNode.node, match.end - endNode.start);
        findMatches.current.push(range);
      }
      if (findMatches.current.length) {
        const HighlightConstructor = (
          window as Window & { Highlight?: new (...ranges: Range[]) => unknown }
        ).Highlight;
        if (HighlightConstructor)
          highlights.highlights.set(
            name,
            new HighlightConstructor(...findMatches.current),
          );
      }
    }
    setFindCount(findMatches.current.length);
    setFindIndex((index) =>
      Math.min(index, Math.max(0, findMatches.current.length - 1)),
    );
  }, [findQuery, markdown]);
  const navigateFind = (direction: number) => {
    const matches = findMatches.current;
    if (!matches.length) return;
    const next = nextPreviewFindIndex(findIndex, direction, matches.length);
    setFindIndex(next);
    const range = matches[next];
    const element = range.startContainer.parentElement;
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const [, setRevealTimelineRevision] = useState(0);
  useLayoutEffect(() => {
    if (commitRevealTimeline(registryRef.current!.registry, Date.now()))
      setRevealTimelineRevision((revision) => revision + 1);
  });
  const revealProgressCallback = useRef(onRevealProgress);
  const previewVersion = useRef(0);
  useEffect(() => {
    revealProgressCallback.current = onRevealProgress;
  }, [onRevealProgress]);
  useEffect(() => {
    const root = diagnosticsRoot.current;
    if (!root || !onRevealProgress) return;
    const previewKey = previewRevision ?? ++previewVersion.current;
    const generationId = revealId ?? `preview-${previewKey}`;
    const units = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-preview-reveal-word], [data-preview-reveal-block]',
      ),
    ];
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const pending = collectPendingRevealKeys(root, units, reducedMotion);
    const notify = (isPending: boolean) =>
      revealProgressCallback.current?.({
        generationId,
        previewKey,
        pending: isPending,
        snapshot: markdown,
        revision: previewKey,
      });
    notify(pending.size > 0);
    const onAnimationFinished = (event: AnimationEvent) => {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.matches(
          '[data-preview-reveal-word], [data-preview-reveal-block]',
        )
      )
        return;
      if (
        event.animationName !== 'markdown-word-reveal' &&
        event.animationName !== 'markdown-block-reveal'
      )
        return;
      const key = event.target.dataset.revealKey;
      if (!key || !pending.delete(key)) return;
      completeRevealUnit(registryRef.current!.registry, key);
      notify(pending.size > 0);
    };
    root.addEventListener('animationend', onAnimationFinished, true);
    root.addEventListener('animationcancel', onAnimationFinished, true);
    return () => {
      root.removeEventListener('animationend', onAnimationFinished, true);
      root.removeEventListener('animationcancel', onAnimationFinished, true);
    };
  }, [markdown, revealId, revealStartLine]);
  useEffect(() => {
    const root = diagnosticsRoot.current;
    if (!diagnosticsEnabled || !root) return;
    const seen = new WeakMap<Element, string>();
    const keysToNodes = new Map<string, Element>();
    const starts: number[] = [];
    const samples: string[] = [];
    let generation = revealId ?? 'preview';
    let publication = 0;
    const summarize = () => {
      const words = [
        ...root.querySelectorAll<HTMLElement>('[data-preview-reveal-word]'),
      ];
      const delays = words
        .map((word) => parseFloat(getComputedStyle(word).animationDelay) * 1000)
        .filter((delay) => delay > 0);
      const sample = words.slice(0, 8).map((word) => {
        const style = getComputedStyle(word);
        return `${word.dataset.revealKey ?? 'no-key'}{delay=${style.animationDelay},duration=${style.animationDuration},name=${style.animationName},opacity=${style.opacity},planned=${word.dataset.revealAt ?? 'n/a'}}`;
      });
      samples.push(
        `commit#${publication} words=${words.length} positiveDelays=${delays.length} range=${delays.length ? `${Math.min(...delays)}..${Math.max(...delays)}ms` : 'none'} sample=${sample.join(' | ')}`,
      );
      while (samples.length > 200) samples.shift();
      setDiagnostics(samples.slice(-6).join('\\n'));
    };
    const observer = new MutationObserver(() => {
      publication++;
      for (const word of root.querySelectorAll<HTMLElement>(
        '[data-preview-reveal-word]',
      )) {
        const key = word.dataset.revealKey;
        if (!key) continue;
        const previous = keysToNodes.get(key);
        if (previous && previous !== word)
          samples.push(
            `REMOUNT ${key} generation=${generation} publication=${publication}`,
          );
        keysToNodes.set(key, word);
        seen.set(word, key);
      }
      summarize();
    });
    const onStart = (event: AnimationEvent) => {
      const target = event.target;
      if (
        !(target instanceof HTMLElement) ||
        !target.matches('[data-preview-reveal-word]')
      )
        return;
      starts.push(performance.now());
      if (starts.length <= 200)
        samples.push(
          `start t=${starts.at(-1)?.toFixed(1)}ms key=${target.dataset.revealKey ?? 'no-key'} generation=${generation} publication=${publication}`,
        );
      if (starts.length % 10 === 0) {
        const buckets = new Map<number, number>();
        for (const time of starts)
          buckets.set(
            Math.floor(time / 100) * 100,
            (buckets.get(Math.floor(time / 100) * 100) ?? 0) + 1,
          );
        console.info('[Storm reveal diagnostics]', {
          generation,
          publication,
          starts: starts.length,
          startsPer100ms: [...buckets.entries()],
          recent: samples.slice(-12),
        });
      }
    };
    root.addEventListener('animationstart', onStart, true);
    observer.observe(root, { childList: true, subtree: true });
    publication++;
    summarize();
    return () => {
      observer.disconnect();
      root.removeEventListener('animationstart', onStart, true);
      keysToNodes.clear();
      starts.length = 0;
      samples.length = 0;
      generation = '';
    };
  }, [diagnosticsEnabled, revealId]);
  return (
    <section
      ref={diagnosticsRoot}
      aria-label={compact ? 'Reading preview' : undefined}
      className={`flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${compact ? '' : 'border-l border-white/10'}`}
    >
      {findOpen && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2"
          role="search"
          aria-label="Find in note preview"
        >
          <input
            ref={findInput}
            type="search"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                navigateFind(event.shiftKey ? -1 : 1);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
                setFindQuery('');
              }
            }}
            aria-label="Find in preview"
            placeholder="Find in preview"
            className="min-w-0 flex-1 rounded bg-white/10 px-2 py-1 text-sm text-white outline-none focus:ring-1 focus:ring-sky-400"
          />
          <span
            className="whitespace-nowrap text-xs text-white/60"
            aria-live="polite"
          >
            {findQuery
              ? `${findCount ? findIndex + 1 : 0} of ${findCount}`
              : '0 of 0'}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            onClick={() => navigateFind(-1)}
            className="text-white/70"
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Next match"
            onClick={() => navigateFind(1)}
            className="text-white/70"
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="Close find"
            onClick={() => {
              closeFind();
              setFindQuery('');
            }}
            className="text-white/70"
          >
            ×
          </button>
        </div>
      )}
      <AppearanceContext.Provider value={appearance}>
        <RevealRegistryContext.Provider value={registryRef.current.registry}>
          <RevealContext.Provider
            value={
              revealStartLine === undefined
                ? null
                : { startLine: revealStartLine, id: revealId }
            }
          >
            <PreviewContext.Provider
              value={{ markdown, vaultId, notePath, onToggleTask, onOpenNote }}
            >
              <ImageContext.Provider value={{ vaultId, notePath }}>
                <div
                  ref={scrollRef}
                  data-preview-focus=""
                  tabIndex={0}
                  onScroll={onScroll}
                  onKeyDownCapture={(event) => {
                    if (
                      [
                        'ArrowUp',
                        'ArrowDown',
                        'PageUp',
                        'PageDown',
                        'Home',
                        'End',
                        ' ',
                      ].includes(event.key)
                    ) {
                      onScrollIntent?.();
                    }
                    onReadingKeyDown?.(event);
                  }}
                  onWheelCapture={() => {
                    onScrollIntent?.();
                    onUserScroll?.();
                  }}
                  onTouchMoveCapture={() => onScrollIntent?.()}
                  className={`markdown-preview-content min-h-0 flex-1 overflow-auto px-5 pb-6 text-sm leading-[1.3] text-white/85 [&_.markdown-blank-line]:h-[1.3em] [&_.markdown-blank-line]:select-none [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex]:text-inherit [&_a]:text-sky-300 [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-white/15 [&_li]:my-1 [&_li:has(>label)]:list-none [&_li:has(>label)]:pl-0 [&_ul:has(>li>label)]:!list-none [&_ul:has(>li>label)]:!pl-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-0.5 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-white/20 [&_th]:px-3 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-white/20 [&_td]:px-3 [&_td]:py-1 [&_ul]:list-disc [&_ul]:pl-6 [&_img]:max-w-full`}
                >
                  <ReactMarkdown
                    remarkPlugins={[
                      markdownMathRemarkPlugin,
                      remarkGfm,
                      () => remarkListContinuations(markdown),
                      () => remarkBlankLines(markdown),
                      remarkSoftBreaks,
                      () => remarkTaskOffsets(markdown),
                      remarkWikiImages,
                      remarkWikiLinks,
                    ]}
                    rehypePlugins={[
                      sourcePositions,
                      markdownMathRehypePlugin,
                      [
                        rehypeRevealUnits,
                        {
                          registry: registryRef.current.registry,
                          startOffset:
                            revealStartLine === undefined
                              ? markdown.length + 1
                              : markdown
                                  .split('\n')
                                  .slice(0, revealStartLine - 1)
                                  .join('\n').length +
                                (revealStartLine > 1 ? 1 : 0),
                          revealRanges,
                          markdown,
                        },
                      ],
                      rehypeHeadingSections,
                    ]}
                    components={markdownComponents}
                    urlTransform={markdownPreviewUrlTransform}
                  >
                    {markdown}
                  </ReactMarkdown>
                </div>
              </ImageContext.Provider>
            </PreviewContext.Provider>
          </RevealContext.Provider>
        </RevealRegistryContext.Provider>
      </AppearanceContext.Provider>
      {diagnosticsEnabled && (
        <aside className="pointer-events-auto absolute bottom-2 right-2 z-50 max-h-40 max-w-[min(36rem,90vw)] overflow-auto rounded bg-black/90 p-2 text-[10px] text-white shadow-lg">
          <button
            type="button"
            className="mb-1 underline"
            onClick={() => void navigator.clipboard?.writeText(diagnostics)}
          >
            Copy reveal diagnostics
          </button>
          <pre className="whitespace-pre-wrap">{diagnostics}</pre>
        </aside>
      )}
    </section>
  );
}

export default memo(MarkdownPreview);
