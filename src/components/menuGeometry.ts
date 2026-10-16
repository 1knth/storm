export type MenuPosition = { left: number; top: number };
export type SubmenuRect = { left: number; top: number };

export function positionSubmenu(
  anchorRect: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gutter = 8,
): SubmenuRect {
  const width = Math.min(size.width, Math.max(0, viewport.width - gutter * 2));
  const height = Math.min(
    size.height,
    Math.max(0, viewport.height - gutter * 2),
  );
  const right = anchorRect.right + 4;
  const left =
    right + width <= viewport.width - gutter
      ? right
      : anchorRect.left - width - 4;
  return clampMenuPosition(
    left,
    anchorRect.top,
    width,
    height,
    viewport.width,
    viewport.height,
    gutter,
  );
}

export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
  gutter = 8,
): MenuPosition {
  const boundedWidth = Math.min(width, Math.max(0, viewportWidth - gutter * 2));
  const boundedHeight = Math.min(
    height,
    Math.max(0, viewportHeight - gutter * 2),
  );
  return {
    left: Math.max(gutter, Math.min(x, viewportWidth - gutter - boundedWidth)),
    top: Math.max(gutter, Math.min(y, viewportHeight - gutter - boundedHeight)),
  };
}
