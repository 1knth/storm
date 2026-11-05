import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  IoAdd,
  IoChevronDown,
  IoChevronForward,
  IoContract,
  IoExpand,
  IoRemove,
  IoScanOutline,
} from 'react-icons/io5';
import MermaidBlock from './Editor/MermaidBlock';
import { rgbaColor, type Appearance } from '../appearance';
import {
  LESSON_NODE_STATUSES,
  lessonMapMermaid,
  type LessonNodeStatus,
  type QuizLessonMap as LessonMap,
} from '../shared/lessonMap';
import {
  centerOn,
  initialView,
  zoomAt,
  type Box,
  type MapView,
  type Size,
} from './lessonMapView';

const COLLAPSED_KEY = 'storm.quiz.lessonMapCollapsed';
const EXPANDED_KEY = 'storm.quiz.lessonMapExpanded';
const ZOOM_STEP = 1.25;
const PAN_STEP = 40;

const STATUS_LABEL: Record<LessonNodeStatus, string> = {
  'not-started': 'Not started',
  introduced: 'Introduced',
  guided: 'Guided',
  independent: 'Independent',
  mastered: 'Mastered',
  retained: 'Retained',
  'needs-review': 'Needs review',
};

function svgSize(svg: SVGSVGElement | null): Size {
  const box = svg?.viewBox.baseVal;
  return box && box.width
    ? { width: box.width, height: box.height }
    : {
        width: 0,
        height: 0,
      };
}

/**
 * Pinned dependency map for the lesson. Mermaid renders only when the graph
 * changes; focus and status are applied to the existing SVG through classes so
 * the dimming animates. The map pans (drag, scroll, arrow keys) and zooms
 * (pinch, Ctrl/Cmd+scroll, +/-), and recentres on the topic being taught.
 */
export default function QuizLessonMap({
  map,
  appearance,
}: {
  map: LessonMap;
  appearance: Appearance;
}) {
  const [collapsed, setCollapsed] = useState(
    () => window.localStorage.getItem(COLLAPSED_KEY) === '1',
  );
  const [expanded, setExpanded] = useState(
    () => window.localStorage.getItem(EXPANDED_KEY) === '1',
  );
  const [renderCount, setRenderCount] = useState(0);
  const [view, setView] = useState<MapView>({ x: 0, y: 0, scale: 1 });
  const [dragging, setDragging] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  // Once the learner moves the map, resizes stop resetting their view.
  const userMoved = useRef(false);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  // Polling hands us a new object every second; key the source on the graph only.
  const graphKey = JSON.stringify([map.nodes, map.edges]);
  const source = useMemo(() => lessonMapMermaid(map), [graphKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const onReady = useMemo(() => () => setRenderCount((n) => n + 1), []);
  const focus = useMemo(() => new Set(map.focus), [map.focus.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const colors = {
    '--lm-focus': rgbaColor(
      appearance.lessonMapFocus,
      appearance.opacity.lessonMapFocus,
    ),
    '--lm-mastered': rgbaColor(
      appearance.lessonMapMastered,
      appearance.opacity.lessonMapMastered,
    ),
    '--lm-independent': rgbaColor(
      appearance.lessonMapIndependent,
      appearance.opacity.lessonMapIndependent,
    ),
    '--lm-guided': rgbaColor(
      appearance.lessonMapGuided,
      appearance.opacity.lessonMapGuided,
    ),
    '--lm-needs-review': rgbaColor(
      appearance.lessonMapNeedsReview,
      appearance.opacity.lessonMapNeedsReview,
    ),
  } as CSSProperties;

  const viewportSize = (): Size => ({
    width: viewport.current?.clientWidth ?? 0,
    height: viewport.current?.clientHeight ?? 0,
  });

  /**
   * Focused node's box in unscaled diagram coordinates. Uses SVG geometry, not
   * getBoundingClientRect, so a running pan/zoom transition cannot skew it. The
   * SVG sits at the content origin at natural size (see index.css).
   */
  const focusBox = useCallback((): Box | undefined => {
    const node =
      content.current?.querySelector<SVGGElement>('g.node.lm-active');
    const matrix = node?.getCTM();
    if (!node || !matrix) return undefined;
    const box = node.getBBox();
    return {
      x: matrix.a * box.x + matrix.e,
      y: matrix.d * box.y + matrix.f,
      width: box.width * matrix.a,
      height: box.height * matrix.d,
    };
  }, []);

  const resetView = useCallback(() => {
    const svg = content.current?.querySelector('svg') ?? null;
    userMoved.current = false;
    setView(initialView(svgSize(svg), viewportSize(), focusBox()));
  }, [focusBox]);

  // Show the SVG at its natural size; the viewport transform does the scaling.
  useLayoutEffect(() => {
    const svg = content.current?.querySelector('svg');
    if (!svg) return;
    const { width, height } = svgSize(svg);
    if (!width) return;
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.style.maxWidth = 'none';
  }, [renderCount]);

  const decorationKey = JSON.stringify([map.focus, map.statuses, map.goal]);
  useLayoutEffect(() => {
    const root = content.current;
    if (!root) return;
    const slugByNode = new Map(map.nodes.map((n, i) => [`n${i}`, n.id]));
    // Mermaid flowchart nodes carry id="<diagram>-flowchart-n<index>-<n>" (no
    // data-id); edges carry data-id="e<index>" from the `e0@-->` syntax.
    for (const g of root.querySelectorAll<SVGGElement>('g.node[id]')) {
      const nodeId = /-flowchart-(n\d+)-\d+$/.exec(g.id)?.[1];
      const slug = slugByNode.get(nodeId ?? '');
      if (!slug) continue;
      for (const status of LESSON_NODE_STATUSES)
        g.classList.remove(`lm-status-${status}`);
      g.classList.add(`lm-status-${map.statuses[slug] ?? 'not-started'}`);
      g.classList.toggle('lm-active', focus.has(slug));
      g.classList.toggle('lm-goal', map.goal === slug);
      g.setAttribute(
        'aria-label',
        `${map.nodes.find((n) => n.id === slug)?.label}: ${STATUS_LABEL[map.statuses[slug] ?? 'not-started']}${focus.has(slug) ? ', being taught now' : ''}`,
      );
    }
    // An edge is active when it leads into a focused node: what it builds on.
    map.edges.forEach(([, to], i) => {
      for (const path of root.querySelectorAll<SVGElement>(`[data-id="e${i}"]`))
        path.classList.toggle('lm-edge-active', focus.has(to));
    });
  }, [renderCount, decorationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new or changed graph gets a fresh default view.
  useEffect(() => {
    if (renderCount) resetView();
  }, [renderCount, resetView]);

  // When the focus moves to a topic outside the visible area, bring it into view.
  useEffect(() => {
    if (!renderCount || collapsed) return;
    const box = focusBox();
    if (!box) return;
    const size = viewportSize();
    const v = viewRef.current;
    const left = v.x + box.x * v.scale;
    const top = v.y + box.y * v.scale;
    const visible =
      left >= 0 &&
      top >= 0 &&
      left + box.width * v.scale <= size.width &&
      top + box.height * v.scale <= size.height;
    if (!visible) setView(centerOn(v, box, size));
  }, [map.focus.join(), renderCount, collapsed, focusBox]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refit on pane resize, expand, or uncollapse until the learner moves the map.
  useEffect(() => {
    const element = viewport.current;
    if (!element || collapsed) return;
    const observer = new ResizeObserver(() => {
      if (!userMoved.current && renderCount) resetView();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed, renderCount, resetView]);

  // Wheel must be non-passive to stop the pane scrolling while panning/zooming.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      userMoved.current = true;
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // Trackpad pinch arrives as ctrl+wheel with small deltas.
        const factor = Math.exp(-event.deltaY * 0.01);
        setView((v) =>
          zoomAt(
            v,
            factor,
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        );
      } else {
        setView((v) => ({
          ...v,
          x: v.x - event.deltaX,
          y: v.y - event.deltaY,
        }));
      }
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [collapsed]);

  const zoomCenter = (factor: number) => {
    userMoved.current = true;
    const size = viewportSize();
    setView((v) => zoomAt(v, factor, size.width / 2, size.height / 2));
  };
  const pan = (dx: number, dy: number) => {
    userMoved.current = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  const total = map.nodes.length;
  const mastered = map.nodes.filter(
    (n) =>
      map.statuses[n.id] === 'mastered' || map.statuses[n.id] === 'retained',
  ).length;
  const now = map.nodes.filter((n) => focus.has(n.id)).map((n) => n.label);
  const control =
    'rounded p-1 text-white/60 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/70';

  return (
    <section
      aria-label="Lesson map"
      className="border-b border-white/10 bg-black/20 px-4 py-1.5"
      style={colors}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs text-white/60 hover:text-white/85"
          onClick={() => {
            const next = !collapsed;
            setCollapsed(next);
            window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
          }}
        >
          {collapsed ? (
            <IoChevronForward aria-hidden="true" size={12} />
          ) : (
            <IoChevronDown aria-hidden="true" size={12} />
          )}
          <span className="font-semibold uppercase tracking-wide">
            Lesson map
          </span>
          <span className="min-w-0 flex-1 truncate">
            {now.length ? (
              <>
                Now:{' '}
                <span style={{ color: 'var(--lm-focus)' }}>
                  {now.join(', ')}
                </span>
              </>
            ) : (
              'No topic in focus'
            )}
          </span>
          <span className="shrink-0">
            {mastered}/{total} mastered
          </span>
        </button>
        {!collapsed && (
          <div className="flex shrink-0 items-center" role="toolbar">
            <button
              type="button"
              className={control}
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => zoomCenter(1 / ZOOM_STEP)}
            >
              <IoRemove aria-hidden="true" size={13} />
            </button>
            <button
              type="button"
              className={control}
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => zoomCenter(ZOOM_STEP)}
            >
              <IoAdd aria-hidden="true" size={13} />
            </button>
            <button
              type="button"
              className={control}
              aria-label="Reset view"
              title="Reset view"
              onClick={resetView}
            >
              <IoScanOutline aria-hidden="true" size={13} />
            </button>
            <button
              type="button"
              className={control}
              aria-label={expanded ? 'Shrink map' : 'Enlarge map'}
              title={expanded ? 'Shrink map' : 'Enlarge map'}
              onClick={() => {
                const next = !expanded;
                setExpanded(next);
                window.localStorage.setItem(EXPANDED_KEY, next ? '1' : '0');
              }}
            >
              {expanded ? (
                <IoContract aria-hidden="true" size={13} />
              ) : (
                <IoExpand aria-hidden="true" size={13} />
              )}
            </button>
          </div>
        )}
      </div>
      <div hidden={collapsed}>
        <div
          ref={viewport}
          tabIndex={0}
          role="group"
          aria-label="Lesson map diagram. Drag or use arrow keys to pan, plus and minus to zoom, 0 to reset."
          className={`lesson-map relative mt-1 overflow-hidden rounded focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/50 ${expanded ? 'h-80' : 'h-44'} ${focus.size ? 'lesson-map--focused' : ''} ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ touchAction: 'none' }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;
            drag.current = { ...start, x: event.clientX, y: event.clientY };
            pan(dx, dy);
          }}
          onPointerUp={(event) => {
            if (drag.current?.id === event.pointerId) drag.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            const keys: Record<string, () => void> = {
              ArrowLeft: () => pan(PAN_STEP, 0),
              ArrowRight: () => pan(-PAN_STEP, 0),
              ArrowUp: () => pan(0, PAN_STEP),
              ArrowDown: () => pan(0, -PAN_STEP),
              '+': () => zoomCenter(ZOOM_STEP),
              '=': () => zoomCenter(ZOOM_STEP),
              '-': () => zoomCenter(1 / ZOOM_STEP),
              '0': resetView,
            };
            const action = keys[event.key];
            if (!action) return;
            event.preventDefault();
            action();
          }}
        >
          <div
            ref={content}
            className={`lesson-map-content absolute left-0 top-0 origin-top-left ${dragging ? '' : 'lesson-map-content--animated'}`}
            style={{
              transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            }}
          >
            <MermaidBlock
              source={source}
              appearance={appearance}
              onReady={onReady}
            />
          </div>
        </div>
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-[11px] text-white/50">
          {(
            [
              'retained',
              'mastered',
              'independent',
              'guided',
              'needs-review',
            ] as const
          ).map((status) => (
            <li key={status} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className={`lm-swatch lm-swatch-${status} inline-block h-2 w-2 rounded-full`}
              />
              {STATUS_LABEL[status]}
            </li>
          ))}
          <li className="ml-auto">{Math.round(view.scale * 100)}%</li>
        </ul>
      </div>
    </section>
  );
}
