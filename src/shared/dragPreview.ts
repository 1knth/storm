// Native drag snapshots ignore the rounded surface when it belongs to an
// ancestor of the draggable node, or when the corners sit over another
// background. Render a detached clone of the visible surface instead.
export function setDragPreview(
  event: {
    clientX: number;
    clientY: number;
    dataTransfer: DataTransfer | null;
  },
  surface: HTMLElement | null,
): void {
  if (!surface || !event.dataTransfer?.setDragImage) return;
  const rect = surface.getBoundingClientRect();
  const style = getComputedStyle(surface);
  const clone = surface.cloneNode(true) as HTMLElement;
  clone.removeAttribute('id');
  Object.assign(clone.style, {
    position: 'fixed',
    top: '-10000px',
    left: '-10000px',
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    borderRadius: style.borderRadius,
    overflow: 'hidden',
    pointerEvents: 'none',
    transform: 'none',
    animation: 'none',
  });
  if (style.backgroundColor === 'rgba(0, 0, 0, 0)')
    clone.style.backgroundColor = 'rgb(32 32 32 / 85%)';
  document.body.append(clone);
  event.dataTransfer.setDragImage(
    clone,
    event.clientX - rect.left,
    event.clientY - rect.top,
  );
  requestAnimationFrame(() => clone.remove());
}
