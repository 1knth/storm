export type TextItemRange = { start: number; end: number; item: number };

export function mapTextItemRanges(
  items: string[],
  separator = ' ',
): TextItemRange[] {
  let offset = 0;
  return items.map((value, item) => {
    const range = { start: offset, end: offset + value.length, item };
    offset = range.end + separator.length;
    return range;
  });
}

export async function searchPdfPages(
  pageCount: number,
  query: string,
  getPageText: (page: number) => Promise<string>,
  isCancelled: () => boolean,
  onProgress: (
    page: number,
    matches: { page: number; start: number; end: number }[],
  ) => void,
  yieldToBrowser: () => Promise<void>,
): Promise<{ page: number; start: number; end: number }[]> {
  const results: { page: number; start: number; end: number }[] = [];
  for (let page = 1; page <= pageCount; page++) {
    if (isCancelled()) return results;
    const text = await getPageText(page);
    if (isCancelled()) return results;
    for (const start of findMatches(text, query))
      results.push({ page, start, end: start + query.length });
    if (page % 10 === 0 || page === pageCount) {
      onProgress(page, [...results]);
      await yieldToBrowser();
    }
  }
  return results;
}

export function findMatches(text: string, query: string): number[] {
  if (!query) return [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const found: number[] = [];
  for (
    let from = 0, at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, from)
  ) {
    found.push(at);
    from = at + 1;
  }
  return found;
}
