/** Pan/zoom maths for the quiz lesson map. Pure so it can be unit tested. */
export type MapView = { x: number; y: number; scale: number };
export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.5;
/** Below this, fitting the whole map makes labels too small to read. */
export const READABLE_SCALE = 0.7;
const PADDING = 12;

export const clampScale = (scale: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Scale and centre the whole diagram inside the viewport (never enlarge). */
export function fitView(content: Size, viewport: Size): MapView {
  if (!content.width || !content.height) return { x: 0, y: 0, scale: 1 };
  const scale = clampScale(
    Math.min(
      1,
      (viewport.width - PADDING * 2) / content.width,
      (viewport.height - PADDING * 2) / content.height,
    ),
  );
  return {
    scale,
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
  };
}

/** Centre a box given in diagram coordinates, keeping the current scale. */
export function centerOn(view: MapView, box: Box, viewport: Size): MapView {
  return {
    scale: view.scale,
    x: viewport.width / 2 - (box.x + box.width / 2) * view.scale,
    y: viewport.height / 2 - (box.y + box.height / 2) * view.scale,
  };
}

/**
 * Default view: fit the whole map when it stays readable; otherwise show it at
 * a readable scale centred on the focused topic (or the start of the map).
 */
export function initialView(
  content: Size,
  viewport: Size,
  focus: Box | undefined,
): MapView {
  const fitted = fitView(content, viewport);
  if (fitted.scale >= READABLE_SCALE) return fitted;
  const view = { x: PADDING, y: PADDING, scale: READABLE_SCALE };
  return focus ? centerOn(view, focus, viewport) : view;
}

/** Zoom by `factor` keeping the viewport point (px, py) fixed under the cursor. */
export function zoomAt(
  view: MapView,
  factor: number,
  px: number,
  py: number,
): MapView {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return {
    scale,
    x: px - (px - view.x) * ratio,
    y: py - (py - view.y) * ratio,
  };
}
