const messages = new Map([
  ['Invalid saved tab layout', 'Saved tab layout was rejected'],
  ['Saved tab layouts exceed the size limit', 'Saved tab layout was rejected'],
  ['Unknown vault', 'Vault is no longer available'],
  ['Invalid vault ID', 'Vault is no longer available'],
]);

export function checkpointErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    /no handler registered|handler.*not found|unknown.*method|not implemented/i.test(
      detail,
    )
  ) {
    return 'Restart Storm to load updated tab support';
  }

  for (const [known, message] of messages) {
    if (detail === known || detail.endsWith(`: ${known}`)) return message;
  }

  if (/eacces|eperm|read.?only|permission denied/i.test(detail)) {
    return 'Cannot write Storm settings';
  }

  return 'Unable to save tabs; check that Storm settings are writable';
}
