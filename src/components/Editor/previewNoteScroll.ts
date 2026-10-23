export type PreviewNoteScrollKey = {
  vaultId: string;
  notePath: string;
};

export function previewNoteScrollKey(note: PreviewNoteScrollKey): string {
  return JSON.stringify([note.vaultId, note.notePath]);
}

export function rememberPreviewScroll(
  positions: Map<string, number>,
  key: string,
  scrollTop: number,
): void {
  if (Number.isFinite(scrollTop) && scrollTop >= 0)
    positions.set(key, scrollTop);
}

export function previewScrollTarget(
  positions: Map<string, number>,
  key: string,
  scrollHeight: number,
  clientHeight: number,
): number | null {
  const saved = positions.get(key) ?? 0;
  if (!Number.isFinite(saved) || saved < 0) return 0;
  if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight))
    return null;
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  // A too-short first render is not ready: don't clamp away the saved position.
  if (saved > maxScroll) return null;
  return saved;
}
