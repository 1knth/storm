import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
} from 'pdfjs-dist';
// Vite emits the locally bundled PDF.js worker; PDFs never load a remote worker.
// @ts-expect-error Vite's ?url import is provided by the application bundler.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './PdfViewer.css';
import { findMatches, mapTextItemRanges, searchPdfPages } from './pdfSearch';
import { PdfPageMetrics } from './pdfPageMetrics';

GlobalWorkerOptions.workerSrc = workerUrl;

type Props = { vaultId: string; relativePath: string; fileName: string };
type Match = { page: number; start: number; end: number };

export function PdfViewer({ vaultId, relativePath, fileName }: Props) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const pageScrollRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Match[]>([]);
  const [searchProgress, setSearchProgress] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [windowPages, setWindowPages] = useState({ first: 1, last: 1 });
  const [metricsVersion, setMetricsVersion] = useState(0);
  const metrics = useMemo(
    () =>
      pdf
        ? new PdfPageMetrics(pdf.numPages, { width: 612, height: 792 }, 1)
        : null,
    [pdf],
  );
  const scrollPages = useRef(
    new Map<number, { canvas: HTMLCanvasElement; layer: HTMLDivElement }>(),
  );
  const renderTasks = useRef(
    new Map<number, { cancel(): void; promise: Promise<unknown> }>(),
  );
  const pageRef = useRef(page);
  const pageInputRef = useRef<HTMLInputElement>(null);
  const scrollAnchorRef = useRef<{ page: number; fraction: number } | null>(
    null,
  );

  const captureScrollAnchor = useCallback(() => {
    const scroller = pageScrollRef.current;
    if (!scroller || !metrics) return;
    const anchorPage = metrics.pageAt(scroller.scrollTop);
    const pageHeight = metrics.size(anchorPage).height;
    scrollAnchorRef.current = {
      page: anchorPage,
      fraction: Math.max(
        0,
        Math.min(
          1,
          (scroller.scrollTop - metrics.top(anchorPage)) / pageHeight,
        ),
      ),
    };
  }, [metrics]);

  const restoreScrollAnchor = useCallback(() => {
    const anchor = scrollAnchorRef.current;
    const scroller = pageScrollRef.current;
    if (!anchor || !scroller || !metrics) return;
    scroller.scrollTop =
      metrics.top(anchor.page) +
      metrics.size(anchor.page).height * anchor.fraction;
    scrollAnchorRef.current = null;
  }, [metrics]);

  useEffect(() => {
    let alive = true;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    setLoading(true);
    setError('');
    setPdf(null);
    if (!window.vault?.readPdf) {
      setError('PDF loading is not available in this version.');
      setLoading(false);
      return;
    }
    window.vault
      .readPdf(vaultId, relativePath)
      .then((data) => {
        if (!alive) return;
        loadingTask = getDocument({
          data,
          isEvalSupported: false,
        } as Parameters<typeof getDocument>[0]);
        return loadingTask.promise.then((result) => {
          if (alive) {
            setPdf(result);
            setPageCount(result.numPages);
            setPage(1);
          }
        });
      })
      .catch((reason) => {
        if (alive)
          setError(
            reason instanceof Error
              ? reason.message
              : 'Could not open this PDF.',
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      for (const task of renderTasks.current.values()) task.cancel();
      void loadingTask?.destroy();
    };
  }, [vaultId, relativePath]);

  useEffect(() => {
    if (!pdf || !fitWidth || !pageScrollRef.current) return;
    const scroll = pageScrollRef.current;
    let request = 0;
    const updateFit = () => {
      cancelAnimationFrame(request);
      request = requestAnimationFrame(() => {
        const width = scroll.clientWidth - 48;
        if (width <= 0) return;
        void pdf.getPage(page).then((pdfPage) => {
          const nativeWidth = pdfPage.getViewport({ scale: 1 }).width;
          captureScrollAnchor();
          setZoom(Math.min(2.5, Math.max(0.1, width / nativeWidth)));
        });
      });
    };
    const observer = new ResizeObserver(updateFit);
    observer.observe(scroll);
    updateFit();
    return () => {
      cancelAnimationFrame(request);
      observer.disconnect();
    };
  }, [pdf, page, fitWidth, captureScrollAnchor]);

  useEffect(() => {
    pageRef.current = page;
    const input = pageInputRef.current;
    if (input && document.activeElement !== input) input.value = String(page);
  }, [page]);

  useEffect(() => {
    if (!metrics) return;
    metrics.setZoom(zoom);
    restoreScrollAnchor();
    setMetricsVersion((value) => value + 1);
  }, [metrics, zoom, restoreScrollAnchor]);

  useEffect(() => {
    const scroller = pageScrollRef.current;
    if (!pdf || !scroller || !metrics) return;
    const refreshWindow = () => {
      const range = metrics.window(
        scroller.scrollTop,
        scroller.clientHeight,
        2,
      );
      setWindowPages((old) =>
        old.first === range.first && old.last === range.last ? old : range,
      );
      const center = metrics.pageAt(
        scroller.scrollTop + scroller.clientHeight / 2,
      );
      setPage((old) => (old === center ? old : center));
    };
    refreshWindow();
    scroller.addEventListener('scroll', refreshWindow, { passive: true });
    return () => scroller.removeEventListener('scroll', refreshWindow);
  }, [pdf, metrics, metricsVersion]);

  useEffect(() => {
    if (!pdf || !metrics) return;
    let alive = true;
    const active = new Set<number>();
    for (let number = windowPages.first; number <= windowPages.last; number++) {
      const refs = scrollPages.current.get(number);
      if (!refs) continue;
      active.add(number);
      const { canvas, layer } = refs;
      void (async () => {
        let task: { cancel(): void; promise: Promise<unknown> } | undefined;
        try {
          const item = await pdf.getPage(number);
          if (!alive || !active.has(number)) return;
          const native = item.getViewport({ scale: 1 });
          captureScrollAnchor();
          const oldHeight = metrics.totalHeight();
          metrics.setSize(number, {
            width: native.width,
            height: native.height,
          });
          const viewport = item.getViewport({ scale: zoom });
          const ratio = window.devicePixelRatio || 1;
          canvas.width = Math.floor(viewport.width * ratio);
          canvas.height = Math.floor(viewport.height * ratio);
          canvas.style.width = `${viewport.width}px`;
          canvas.style.height = `${viewport.height}px`;
          layer.style.width = `${viewport.width}px`;
          layer.style.height = `${viewport.height}px`;
          if (metrics.totalHeight() !== oldHeight) {
            restoreScrollAnchor();
            setMetricsVersion((value) => value + 1);
          }
          const context = canvas.getContext('2d');
          if (!context) return;
          task = item.render({
            canvas,
            canvasContext: context,
            viewport,
            transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
          });
          renderTasks.current.set(number, task);
          await task.promise;
          const content = await item.getTextContent();
          if (!alive || !active.has(number)) return;
          await new TextLayer({
            textContentSource: content,
            container: layer,
            viewport,
          }).render();
          if (number === pageRef.current)
            setText(
              [...layer.querySelectorAll('span:not(.markedContent)')]
                .map((span) => span.textContent ?? '')
                .join(' '),
            );
        } catch (reason) {
          if (
            alive &&
            !(
              reason instanceof Error &&
              reason.name === 'RenderingCancelledException'
            )
          )
            setError('This PDF page could not be rendered.');
        } finally {
          if (renderTasks.current.get(number) === task)
            renderTasks.current.delete(number);
        }
      })();
    }
    for (const [number, refs] of scrollPages.current) {
      if (active.has(number)) continue;
      renderTasks.current.get(number)?.cancel();
      renderTasks.current.delete(number);
      refs.canvas.width = 0;
      refs.canvas.height = 0;
      refs.layer.replaceChildren();
    }
    return () => {
      alive = false;
      for (const task of renderTasks.current.values()) task.cancel();
      renderTasks.current.clear();
    };
  }, [
    pdf,
    zoom,
    windowPages,
    metrics,
    captureScrollAnchor,
    restoreScrollAnchor,
  ]);

  useEffect(() => {
    if (!query.trim() || !pdf) {
      setMatches([]);
      setActiveMatch(0);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const term = query.trim();
        setMatches([]);
        setSearchProgress(0);
        const results = await searchPdfPages(
          pdf.numPages,
          term,
          async (pageNumber) => {
            const content = await (
              await pdf.getPage(pageNumber)
            ).getTextContent();
            return content.items
              .flatMap((item) => ('str' in item ? [item.str] : []))
              .join(' ');
          },
          () => cancelled,
          (progress, found) => {
            setMatches(found);
            setSearchProgress(progress);
          },
          () => new Promise((resolve) => window.setTimeout(resolve, 0)),
        );
        if (!cancelled) setActiveMatch(results.length ? 1 : 0);
      })().catch(() => {
        if (!cancelled) setMatches([]);
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pdf, query]);

  useEffect(() => {
    const layer = scrollPages.current.get(page)?.layer;
    if (layer) {
      const currentText = [
        ...layer.querySelectorAll('span:not(.markedContent)'),
      ]
        .map((span) => span.textContent ?? '')
        .join(' ');
      if (currentText) setText(currentText);
    }
    if (!layer || !text || !query.trim()) return;
    const spans = [...layer.querySelectorAll('span:not(.markedContent)')];
    const itemTexts = spans.map((span) => span.textContent ?? '');
    const ranges = mapTextItemRanges(itemTexts);
    const pageMatches = findMatches(text, query.trim());
    const highlights: Range[] = [];
    for (const start of pageMatches) {
      const end = start + query.trim().length;
      const first = ranges.find(
        (range) => start >= range.start && start < range.end,
      );
      const last = ranges.find(
        (range) => end > range.start && end <= range.end,
      );
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(
        spans[first.item].firstChild ?? spans[first.item],
        start - first.start,
      );
      range.setEnd(
        spans[last.item].firstChild ?? spans[last.item],
        end - last.start,
      );
      highlights.push(range);
    }
    const selected = matches[activeMatch - 1];
    const selectedRange =
      selected?.page === page
        ? highlights[pageMatches.indexOf(selected.start)]
        : undefined;
    const selectedRanges = selectedRange ? [selectedRange.cloneRange()] : [];
    if ('highlights' in CSS) {
      CSS.highlights.delete('pdf-search');
      CSS.highlights.delete('pdf-search-current');
      CSS.highlights.set('pdf-search', new Highlight(...highlights));
      if (selectedRanges.length) {
        CSS.highlights.set(
          'pdf-search-current',
          new Highlight(...selectedRanges),
        );
        const rect = selectedRanges[0].getBoundingClientRect();
        const scroll = layer.closest('.pdf-page-scroll');
        if (scroll && rect.width) {
          const bounds = scroll.getBoundingClientRect();
          if (
            rect.top < bounds.top ||
            rect.bottom > bounds.bottom ||
            rect.left < bounds.left ||
            rect.right > bounds.right
          )
            selectedRanges[0].startContainer.parentElement?.scrollIntoView({
              block: 'center',
              inline: 'center',
            });
        }
      }
    }
    return () => {
      CSS.highlights?.delete('pdf-search');
      CSS.highlights?.delete('pdf-search-current');
    };
  }, [text, query, matches, activeMatch, page]);

  const goTo = useCallback(
    (next: number) => {
      const target = Math.max(1, Math.min(pageCount, next));
      setPage(target);
      pageScrollRef.current?.scrollTo({
        top: metrics?.top(target) ?? 0,
        behavior: 'auto',
      });
    },
    [pageCount, metrics],
  );
  const moveMatch = (direction: number) => {
    if (!matches.length) return;
    const next =
      (activeMatch - 1 + direction + matches.length) % matches.length;
    setActiveMatch(next + 1);
    goTo(matches[next].page);
  };
  const searchLabel = query
    ? searchProgress < pageCount
      ? `${matches.length ? `${activeMatch || 1} of ${matches.length}+` : 'Searching'} · ${searchProgress}/${pageCount}`
      : matches.length
        ? `${activeMatch} of ${matches.length}`
        : 'No matches'
    : '';

  return (
    <section className="pdf-viewer" aria-label={`PDF viewer: ${fileName}`}>
      <header className="pdf-toolbar">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => goTo(page - 1)}
        >
          ‹
        </button>
        <label className="pdf-page-input">
          <input
            aria-label="Page number"
            type="number"
            min={1}
            max={pageCount}
            style={{ width: `${Math.max(2, String(pageCount || 1).length)}ch` }}
            ref={pageInputRef}
            onChange={() => {}}
            onBlur={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isInteger(value) && value >= 1 && value <= pageCount)
                goTo(value);
              else event.currentTarget.value = String(page);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                event.currentTarget.value = String(page);
                event.currentTarget.blur();
              }
            }}
            defaultValue={page}
          />{' '}
          <span>/ {pageCount || '—'}</span>
        </label>
        <button
          type="button"
          aria-label="Next page"
          disabled={!pageCount || page >= pageCount}
          onClick={() => goTo(page + 1)}
        >
          ›
        </button>
        <span className="pdf-toolbar-spacer" />
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => {
            setFitWidth(false);
            captureScrollAnchor();
            setZoom((value) => Math.max(0.5, value - 0.15));
          }}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Fit PDF to width"
          aria-pressed={fitWidth}
          onClick={() => setFitWidth(true)}
        >
          Fit width
        </button>
        <span className="pdf-zoom">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => {
            setFitWidth(false);
            captureScrollAnchor();
            setZoom((value) => Math.min(2.5, value + 0.15));
          }}
        >
          +
        </button>
        <div className="pdf-search">
          <input
            aria-label="Search PDF"
            placeholder="Search PDF"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') moveMatch(event.shiftKey ? -1 : 1);
            }}
          />
          <span aria-live="polite">{searchLabel}</span>
          <button
            aria-label="Previous match"
            type="button"
            disabled={!matches.length}
            onClick={() => moveMatch(-1)}
          >
            ↑
          </button>
          <button
            aria-label="Next match"
            type="button"
            disabled={!matches.length}
            onClick={() => moveMatch(1)}
          >
            ↓
          </button>
        </div>
      </header>
      {loading ? (
        <div className="pdf-status">Opening {fileName}…</div>
      ) : error ? (
        <div className="pdf-status pdf-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="pdf-body">
          <aside className="pdf-thumbnails" aria-label="Page thumbnails">
            {Array.from({ length: pageCount }, (_, index) => (
              <button
                type="button"
                key={index}
                className={page === index + 1 ? 'selected' : ''}
                aria-label={`Go to page ${index + 1}`}
                onClick={() => goTo(index + 1)}
              >
                <Thumbnail pdf={pdf!} page={index + 1} />
                <span>{index + 1}</span>
              </button>
            ))}
          </aside>
          <main className="pdf-page-scroll" ref={pageScrollRef}>
            <div
              className="pdf-page-list"
              style={{ height: metrics?.totalHeight() ?? 0 }}
            >
              {Array.from(
                {
                  length: Math.max(0, windowPages.last - windowPages.first + 1),
                },
                (_, index) => {
                  const number = windowPages.first + index;
                  const size = metrics?.size(number) ?? {
                    width: 612 * zoom,
                    height: 792 * zoom,
                  };
                  const top = metrics?.top(number) ?? 0;
                  return (
                    <div
                      key={number}
                      className="pdf-page-wrap"
                      style={{
                        position: 'absolute',
                        top,
                        height: size.height,
                        width: size.width,
                      }}
                    >
                      <canvas
                        ref={(canvas) => {
                          const previous = scrollPages.current.get(number);
                          if (canvas && previous) previous.canvas = canvas;
                          else if (canvas)
                            scrollPages.current.set(number, {
                              canvas,
                              layer: document.createElement('div'),
                            });
                        }}
                      />
                      <div
                        className="textLayer"
                        ref={(layer) => {
                          const refs = scrollPages.current.get(number);
                          if (refs && layer) refs.layer = layer;
                        }}
                      />
                    </div>
                  );
                },
              )}
            </div>
            {query && !matches.length && (
              <p className="pdf-status">
                {text
                  ? 'No matches on this document.'
                  : 'No searchable text found. This may be a scanned PDF.'}
              </p>
            )}
          </main>
        </div>
      )}
    </section>
  );
}

function Thumbnail({ pdf, page }: { pdf: PDFDocumentProxy; page: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const renderTaskRef = useRef<{ cancel(): void } | null>(null);
  const renderPromiseRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const canvas = ref.current;
    const container = canvas?.parentElement?.parentElement;
    if (!canvas || !container) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { root: container, rootMargin: '160px' },
    );
    observer.observe(canvas.parentElement!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const canvas = ref.current;
    if (!visible || !canvas) {
      renderTaskRef.current?.cancel();
      return;
    }
    let alive = true;
    const render = async () => {
      await renderPromiseRef.current;
      if (!alive || !ref.current) return;
      const item = await pdf.getPage(page);
      if (!alive || !ref.current) return;
      const viewport = item.getViewport({ scale: 0.16 });
      const target = ref.current;
      target.width = viewport.width;
      target.height = viewport.height;
      const task = item.render({
        canvas: target,
        canvasContext: target.getContext('2d')!,
        viewport,
      });
      renderTaskRef.current = task;
      try {
        await task.promise;
      } catch (reason) {
        if (
          !(
            reason instanceof Error &&
            reason.name === 'RenderingCancelledException'
          )
        )
          throw reason;
      } finally {
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      }
    };
    const promise = renderPromiseRef.current.then(render).catch(() => {});
    renderPromiseRef.current = promise;
    return () => {
      alive = false;
      renderTaskRef.current?.cancel();
      void promise;
    };
  }, [pdf, page, visible]);
  return <canvas ref={ref} aria-hidden="true" />;
}

export default PdfViewer;
