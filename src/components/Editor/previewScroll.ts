import { Transaction } from '@codemirror/state';

export function isUserSelectionChange(
  selectionSet: boolean,
  transactions: readonly Transaction[],
): boolean {
  return (
    selectionSet &&
    transactions.some((transaction) => {
      const userEvent = transaction.annotation(Transaction.userEvent);
      return (
        userEvent === 'select' ||
        userEvent?.startsWith('select.') ||
        userEvent?.startsWith('move.') ||
        userEvent?.startsWith('input.') ||
        userEvent === 'input'
      );
    })
  );
}

export type PreviewAnchor = {
  start: number;
  end: number;
  top: number;
  height: number;
};

export type SmoothScrollController = {
  active: boolean;
  cancel: () => void;
};

// Animate only programmatic pane-to-pane jumps; native wheel scrolling is untouched.
export function smoothScrollTo(
  element: HTMLElement,
  target: number,
  controller: SmoothScrollController,
  duration = 140,
  onApplied?: (top: number) => void,
): void {
  controller.cancel();
  const from = element.scrollTop;
  const to = Math.max(
    0,
    Math.min(element.scrollHeight - element.clientHeight, target),
  );
  const reducedMotion =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const apply = (top: number) => {
    element.scrollTop = top;
    onApplied?.(element.scrollTop);
  };
  if (duration <= 0 || reducedMotion || Math.abs(to - from) < 1) {
    controller.active = false;
    apply(to);
    return;
  }

  let frame = 0;
  let started: number | null = null;
  controller.active = true;
  controller.cancel = () => {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    controller.active = false;
  };
  const tick = (time: number) => {
    if (!controller.active) return;
    started ??= time;
    const progress = Math.min(1, (time - started) / duration);
    const eased = 1 - (1 - progress) ** 3;
    apply(from + (to - from) * eased);
    if (progress < 1) frame = window.requestAnimationFrame(tick);
    else controller.cancel();
  };
  frame = window.requestAnimationFrame(tick);
}

// Map a source line into the rendered block using its source span and measured height.
export function previewTopAtSourceLine(
  line: number,
  anchors: PreviewAnchor[],
): number | null {
  const valid = anchors.filter(
    (anchor) =>
      Number.isFinite(anchor.start) &&
      Number.isFinite(anchor.end) &&
      Number.isFinite(anchor.top) &&
      Number.isFinite(anchor.height),
  );
  if (!valid.length) return null;
  const anchor =
    valid.find((item) => line <= item.end) ?? valid[valid.length - 1];
  const fraction = Math.max(
    0,
    Math.min(
      1,
      (line - anchor.start) / Math.max(1, anchor.end - anchor.start + 1),
    ),
  );
  return anchor.top + fraction * anchor.height;
}

export function shouldRevealPreviewTop(
  top: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  const margin = clientHeight * 0.2;
  return top < scrollTop + margin || top > scrollTop + clientHeight - margin;
}

export function previewScrollTopForCursor(
  top: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): number | null {
  if (!shouldRevealPreviewTop(top, scrollTop, clientHeight)) return null;
  const margin = clientHeight * 0.2;
  return Math.max(0, Math.min(scrollHeight - clientHeight, top - margin));
}
