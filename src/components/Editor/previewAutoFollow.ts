export function previewFollowTailSpace(clientHeight: number): number {
  return Math.max(0, clientHeight * 0.25);
}

export function previewFollowTarget({
  visualLineTop,
  clientHeight,
  scrollHeight,
}: {
  visualLineTop: number;
  clientHeight: number;
  scrollHeight: number;
}): number {
  const maxScroll = Math.max(0, scrollHeight - clientHeight);
  return Math.min(maxScroll, Math.max(0, visualLineTop - clientHeight * 0.75));
}

export function isNextPreviewVisualLine(
  visualLineTop: number,
  previousLineTop: number,
): boolean {
  return visualLineTop > previousLineTop + 2;
}

export function isActiveAgentPreviewReveal(
  revealId: string | undefined,
  ranges: readonly { from: number; to: number }[] | undefined,
): boolean {
  return Boolean(revealId && ranges?.length);
}
