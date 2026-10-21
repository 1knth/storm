import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, mapTextItemRanges, searchPdfPages } from './pdfSearch';

test('PDF text item ranges account for joined separators and empty text items', () => {
  assert.deepEqual(mapTextItemRanges(['foo', '', 'bar']), [
    { start: 0, end: 3, item: 0 },
    { start: 4, end: 4, item: 1 },
    { start: 5, end: 8, item: 2 },
  ]);
});

test('PDF search finds case-insensitive non-overlapping occurrences', () => {
  assert.deepEqual(findMatches('Storm stormy STORM', 'storm'), [0, 6, 13]);
});

test('PDF search over 2000 pages requests sequentially and reports bounded batches', async () => {
  let requests = 0;
  const progress: number[] = [];
  const results = await searchPdfPages(
    2000,
    'needle',
    async (page) => {
      assert.equal(page, ++requests);
      return page === 1999 ? 'a needle here' : 'no hit';
    },
    () => false,
    (page, matches) => {
      progress.push(page);
      assert.equal(matches.length, page >= 1999 ? 1 : 0);
    },
    async () => {},
  );
  assert.equal(requests, 2000);
  assert.deepEqual(
    progress,
    Array.from({ length: 200 }, (_, index) => (index + 1) * 10),
  );
  assert.deepEqual(results, [{ page: 1999, start: 2, end: 8 }]);
});

test('PDF search cancellation after a batch prevents further page requests', async () => {
  let requests = 0;
  let cancelled = false;
  const results = await searchPdfPages(
    2000,
    'hit',
    async () => {
      requests++;
      return 'hit';
    },
    () => cancelled,
    (page) => {
      if (page === 10) cancelled = true;
    },
    async () => {},
  );
  assert.equal(requests, 10);
  assert.equal(results.length, 10);
});

test('PDF search handles empty and absent queries', () => {
  assert.deepEqual(findMatches('document', ''), []);
  assert.deepEqual(findMatches('document', 'missing'), []);
});
