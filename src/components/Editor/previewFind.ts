export type PreviewTextMatch = { start: number; end: number };

export function findPreviewTextMatches(
  text: string,
  query: string,
): PreviewTextMatch[] {
  if (!query) return [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const matches: PreviewTextMatch[] = [];
  let start = 0;
  while ((start = haystack.indexOf(needle, start)) !== -1) {
    matches.push({ start, end: start + needle.length });
    start += needle.length;
  }
  return matches;
}

export function findPreviewTextMatchesInBlocks(
  blocks: readonly string[],
  query: string,
): PreviewTextMatch[] {
  const matches: PreviewTextMatch[] = [];
  let offset = 0;
  for (const block of blocks) {
    matches.push(
      ...findPreviewTextMatches(block, query).map(({ start, end }) => ({
        start: start + offset,
        end: end + offset,
      })),
    );
    offset += block.length + 1;
  }
  return matches;
}

export function nextPreviewFindIndex(
  current: number,
  direction: number,
  count: number,
): number {
  return count ? (current + direction + count) % count : 0;
}
