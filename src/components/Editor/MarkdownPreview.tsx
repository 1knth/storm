import React, {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
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
import { remarkSoftBreaks } from './markdownSoftBreaks';
import { remarkListContinuations } from './markdownListContinuations';
import { remarkBlankLines } from './markdownBlankLines';
import type { TaskTogglePayload } from './markdownTasks';
import type { Appearance } from '../../appearance';
import {
  createRevealScheduleRegistry,
  PREVIEW_REVEAL_CADENCE_MS,
  planRevealUnits,
  getRevealTiming,
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

function rehypeRevealUnits({
  registry,
  startOffset,
  markdown,
}: {
  registry: ReturnType<typeof createRevealScheduleRegistry>;
  startOffset: number;
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
        [
          'code',
          'math',
          'inlineMath',
          'image',
          'img',
          'table',
          'svg',
          'input',
        ].includes(node.tagName);
      if (node.tagName === 'pre' && node.position) {
        const offset =
          node.position.start?.offset ??
          lineOffsets[(node.position.start?.line ?? 1) - 1] ??
          fallbackOffset;
        const key = `block:${offset}:${path.join('.')}`;
        units.push({ key, sourceOffset: offset, kind: 'block' });
        node.properties ??= {};
        node.properties['data-reveal-key'] = key;
        node.properties['data-reveal-kind'] = 'block';
      }
      if (node.tagName === 'p' && !excluded) {
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
          const childBlocked =
            blocked ||
            (child.properties?.className ?? []).some((name: string) =>
              ['katex', 'katex-display'].includes(name),
            ) ||
            [
              'code',
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
            if (position === undefined) {
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
    const apply = (node: any) => {
      const key = node.properties?.['data-reveal-key'];
      const plan = key ? schedules.get(key) : undefined;
      if (plan) node.properties['data-reveal-at'] = plan.scheduledAt;
      (node.children ?? []).forEach(apply);
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
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  onUserScroll?: () => void;
  onScrollIntent?: () => void;
  onReadingKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  appearance: Appearance;
  revealStartLine?: number;
  revealId?: string;
  onRevealProgress?: (progress: {
    generationId: string;
    previewKey: number;
    pending: boolean;
    snapshot: string;
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

function MarkdownHeading({ level, children, ...props }: any) {
  const appearance = useContext(AppearanceContext);
  if (!appearance)
    throw new Error('MarkdownHeading requires AppearanceContext');
  const Tag = `h${level}` as React.ElementType;
  return (
    <Tag {...props} style={{ color: appearance.headings[level - 1] }}>
      {children}
    </Tag>
  );
}

function MarkdownTable({ children, ...props }: any) {
  return (
    <div className="my-4 max-w-full overflow-x-auto">
      <table {...props}>{children}</table>
    </div>
  );
}

function MarkdownTaskListItem({ children, node, ...props }: any) {
  const context = useContext(PreviewContext);
  if (!context) throw new Error('MarkdownTaskListItem requires PreviewContext');
  const { markdown, vaultId, notePath, onToggleTask } = context;
  const offset = node?.properties['data-task-offset'];
  const expected = typeof offset === 'number' ? markdown[offset] : undefined;
  if (
    typeof offset !== 'number' ||
    (expected !== ' ' && expected !== 'x' && expected !== 'X')
  )
    return <li {...props}>{children}</li>;
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
      style={{ listStyleType: 'none' }}
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
        <RevealBlock sourceProps={sourceProps}>
          <MermaidBlock source={source} appearance={appearance} />
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

function RevealBlock({ sourceProps, children }: any) {
  const context = useContext(RevealContext);
  const registry = useContext(RevealRegistryContext);
  const start = sourceProps?.['data-source-start'];
  const schedule = registry?.words.get(
    String(sourceProps?.['data-reveal-key']),
  );
  const delay = useRef(
    schedule && registry
      ? getRevealTiming(
          registry,
          String(sourceProps?.['data-reveal-key']),
          Date.now(),
        )
      : 0,
  );
  if (
    !context ||
    !registry ||
    typeof start !== 'number' ||
    start < context.startLine ||
    !schedule
  )
    return children;
  return (
    <div
      {...sourceProps}
      data-preview-reveal-block=""
      className="markdown-block-reveal"
      style={{ animationDelay: `${delay.current}ms` }}
    >
      {children}
    </div>
  );
}

export function AnimatedRevealWord({ children, ...props }: any) {
  const registry = useContext(RevealRegistryContext);
  const key = props['data-reveal-key'];
  const delay = useRef(
    registry && typeof key === 'string'
      ? getRevealTiming(registry, key, Date.now())
      : 0,
  );
  return (
    <span {...props} style={{ animationDelay: `${delay.current}ms` }}>
      {children}
    </span>
  );
}

export function RevealWordAdapter({ children, ...props }: any) {
  const key = props['data-reveal-key'];
  return (
    <AnimatedRevealWord key={key} {...props}>
      {children}
    </AnimatedRevealWord>
  );
}

const markdownComponents = {
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
  scrollRef,
  onScroll,
  onUserScroll,
  onScrollIntent,
  onReadingKeyDown,
  appearance,
  revealStartLine,
  revealId,
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
    following: true,
    programmatic: false,
    frame: 0,
    initialized: false,
  });
  const scrollElement = scrollRef;
  useEffect(() => {
    const container = scrollElement?.current;
    if (!container) return;
    const state = followRef.current;
    if (!state.initialized) {
      state.following =
        container.scrollHeight - container.clientHeight - container.scrollTop <=
        24;
      state.initialized = true;
    }
    const onAnimationStart = (event: AnimationEvent) => {
      if (
        !event.target ||
        !(event.target instanceof Element) ||
        !event.target.matches(
          '[data-preview-reveal-word], [data-preview-reveal-block]',
        )
      )
        return;
      const word = event.target as HTMLElement;
      cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(() => {
        state.frame = 0;
        if (!state.following) return;
        const containerRect = container.getBoundingClientRect();
        const wordRect = word.getBoundingClientRect();
        const bottom = containerRect.bottom - 28;
        if (wordRect.bottom > bottom) {
          const delta = wordRect.bottom - bottom;
          state.programmatic = true;
          container.scrollTop = Math.max(
            container.scrollTop,
            container.scrollTop + delta,
          );
          requestAnimationFrame(() => {
            state.programmatic = false;
          });
        }
      });
    };
    const onScroll = () => {
      if (state.programmatic) return;
      const atBottom =
        container.scrollHeight - container.clientHeight - container.scrollTop <=
        24;
      state.following = atBottom;
    };
    container.addEventListener('animationstart', onAnimationStart, true);
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('animationstart', onAnimationStart, true);
      container.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    };
  }, [scrollElement]);
  const registryRef = useRef<{
    id?: string;
    registry: ReturnType<typeof createRevealScheduleRegistry>;
  } | null>(null);
  if (registryRef.current === null || registryRef.current.id !== revealId) {
    registryRef.current = {
      id: revealId,
      registry: createRevealScheduleRegistry(),
    };
  }
  const diagnosticsRoot = useRef<HTMLElement>(null);
  const revealProgressCallback = useRef(onRevealProgress);
  const previewVersion = useRef(0);
  useEffect(() => {
    revealProgressCallback.current = onRevealProgress;
  }, [onRevealProgress]);
  useEffect(() => {
    const root = diagnosticsRoot.current;
    if (!root || !onRevealProgress) return;
    const previewKey = ++previewVersion.current;
    const generationId = revealId ?? `preview-${previewKey}`;
    const units = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-preview-reveal-word], [data-preview-reveal-block]',
      ),
    ];
    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    const pending = new Set<string>();
    if (!reducedMotion) {
      for (const unit of units) {
        const key = unit.dataset.revealKey;
        if (!key) continue;
        const animation = unit
          .getAnimations()
          .find((item) => item.playState === 'running');
        if (animation) pending.add(key);
      }
    }
    const notify = (isPending: boolean) =>
      revealProgressCallback.current?.({
        generationId,
        previewKey,
        pending: isPending,
        snapshot: markdown,
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
      if (event.animationName !== 'markdown-word-reveal') return;
      const key = event.target.dataset.revealKey;
      if (!key || !pending.delete(key)) return;
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
      {!compact && (
        <h2 className="preview-heading shrink-0 px-4 py-3 text-xs font-medium text-white/50">
          Preview
        </h2>
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
                  tabIndex={compact ? 0 : undefined}
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
                      followRef.current.following = false;
                      onScrollIntent?.();
                    }
                    onReadingKeyDown?.(event);
                  }}
                  onWheelCapture={() => {
                    followRef.current.following = false;
                    onScrollIntent?.();
                    onUserScroll?.();
                  }}
                  onTouchMoveCapture={() => onScrollIntent?.()}
                  className="markdown-preview-content min-h-0 flex-1 overflow-auto px-5 pb-6 text-sm leading-[1.3] text-white/85 [&_.markdown-blank-line]:h-[1.3em] [&_.markdown-blank-line]:select-none [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex]:text-inherit [&_a]:text-sky-300 [&_blockquote]:border-l-2 [&_blockquote]:border-white/20 [&_blockquote]:pl-4 [&_code]:rounded [&_code]:bg-white/10 [&_code]:px-1 [&_code]:py-0.5 [&_h1]:mb-4 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-5 [&_hr]:border-white/15 [&_li]:my-1 [&_li:has(>label)]:list-none [&_li:has(>label)]:pl-0 [&_ul:has(>li>label)]:!list-none [&_ul:has(>li>label)]:!pl-0 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-0.5 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-black/40 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-white/20 [&_th]:px-3 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-white/20 [&_td]:px-3 [&_td]:py-1 [&_ul]:list-disc [&_ul]:pl-6 [&_img]:max-w-full"
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
                          markdown,
                        },
                      ],
                    ]}
                    components={markdownComponents}
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
