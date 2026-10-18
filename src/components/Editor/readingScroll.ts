export function scrollReadingPreview(
  event: Pick<
    KeyboardEvent,
    | 'key'
    | 'metaKey'
    | 'ctrlKey'
    | 'altKey'
    | 'shiftKey'
    | 'target'
    | 'preventDefault'
    | 'stopPropagation'
  >,
  pane: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'> | null,
  modalOpen: boolean,
): boolean {
  if (
    !pane ||
    modalOpen ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  )
    return false;
  const target = event.target as EventTarget | null;
  if (
    target &&
    'closest' in target &&
    typeof target.closest === 'function' &&
    target.closest(
      'input:not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="textbox"]',
    )
  )
    return false;
  if (event.key !== 'j' && event.key !== 'k') return false;

  const maxScroll = Math.max(0, pane.scrollHeight - pane.clientHeight);
  const next = Math.max(
    0,
    Math.min(maxScroll, pane.scrollTop + (event.key === 'j' ? 40 : -40)),
  );
  if (next === pane.scrollTop) return false;
  pane.scrollTop = next;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
