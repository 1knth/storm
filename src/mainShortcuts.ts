type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

export function isToggleExplorerShortcut(
  event: ShortcutKeyEvent,
  isMac: boolean,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    (isMac ? event.metaKey : event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 's'
  );
}

export function isToggleVaultsShortcut(
  event: ShortcutKeyEvent,
  isMac: boolean,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    (isMac ? event.metaKey : event.ctrlKey) &&
    event.shiftKey &&
    !event.altKey &&
    event.key.toLowerCase() === 's'
  );
}
