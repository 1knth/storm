import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  acquireWritingBaseline,
  appendedContentStartLine,
  createManagedPreviewBatch,
  wordSegments,
  PREVIEW_REVEAL_CADENCE_MS,
  createRevealScheduleRegistry,
  scheduleRevealWords,
  getRevealTiming,
  planRevealUnits,
  hasRecentPreviewScrollIntent,
  PREVIEW_SCROLL_INTENT_MS,
  shouldFinalizeReveal,
} from './managedPreviewBatch';

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let now = 0;
let nextId = 1;
let timers = new Map<number, { at: number; callback: () => void }>();

function useFakeClock() {
  now = 0;
  nextId = 1;
  timers = new Map();
  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = nextId++;
    timers.set(id, {
      at: now + Number(delay),
      callback: callback as () => void,
    });
    return id as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    timers.delete(id as unknown as number);
  }) as typeof clearTimeout;
}

function advance(ms: number) {
  now += ms;
  for (;;) {
    const due = [...timers.entries()].find(([, timer]) => timer.at <= now);
    if (!due) return;
    timers.delete(due[0]);
    due[1].callback();
  }
}

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

describe('preview scroll intent', () => {
  it('allows wheel, touch-move, and scroll-key intent only within its window', () => {
    const markedAt = 1000;
    const intentUntil = markedAt + PREVIEW_SCROLL_INTENT_MS;
    assert.equal(hasRecentPreviewScrollIntent(intentUntil, markedAt), true);
    assert.equal(hasRecentPreviewScrollIntent(intentUntil, intentUntil), true);
    assert.equal(
      hasRecentPreviewScrollIntent(intentUntil, intentUntil + 1),
      false,
    );
  });

  it('blocks layout-only scroll and ordinary pointer clicks without intent', () => {
    assert.equal(hasRecentPreviewScrollIntent(0, 1000), false);
    // Link clicks and other pointer presses do not extend the intent deadline.
    assert.equal(hasRecentPreviewScrollIntent(0, 1000), false);
  });
});

describe('generation-wide word reveal schedule', () => {
  it('uses the single 150ms cadence and keeps assignments fixed across rapid appends', () => {
    const registry = createRevealScheduleRegistry();
    const baseline = scheduleRevealWords(registry, ['p1:first'], 1000);
    const append = scheduleRevealWords(
      registry,
      ['p1:first', 'p1:partial-tail'],
      1025,
    );
    assert.equal(PREVIEW_REVEAL_CADENCE_MS, 150);
    assert.deepEqual(baseline, [{ ordinal: 0, scheduledAt: 1016 }]);
    assert.deepEqual(append, [
      { ordinal: 0, scheduledAt: 1016 },
      { ordinal: 1, scheduledAt: 1166 },
    ]);
  });

  it('keeps paragraph/chunk order, existing assignments, and pending backlog', () => {
    const registry = createRevealScheduleRegistry();
    const first = scheduleRevealWords(registry, ['p1:a', 'p1:b'], 1000);
    const second = scheduleRevealWords(
      registry,
      ['p1:a', 'p1:b', 'p2:a'],
      1100,
    );
    const third = scheduleRevealWords(registry, ['p3:a'], 1200);
    assert.deepEqual(
      first.map((item) => item.scheduledAt),
      [1016, 1166],
    );
    assert.deepEqual(
      second.map((item) => item.scheduledAt),
      [1016, 1166, 1316],
    );
    assert.deepEqual(
      third.map((item) => item.scheduledAt),
      [1466],
    );
    assert.equal(registry.nextOrdinal, 4);
  });

  it('holds the next paragraph until the prior paragraph fade has finished', () => {
    const registry = createRevealScheduleRegistry();
    const paragraphs = [
      ...Array.from({ length: 10 }, (_, index) => ({
        key: `p1:${index}`,
        sourceOffset: index,
        kind: 'word' as const,
        paragraphKey: 'p1',
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `p2:${index}`,
        sourceOffset: 100 + index,
        kind: 'word' as const,
        paragraphKey: 'p2',
      })),
    ];
    const plan = planRevealUnits(registry, paragraphs, 1000);
    const firstParagraphLast = plan.find((unit) => unit.key === 'p1:9')!;
    const secondParagraphFirst = plan.find((unit) => unit.key === 'p2:0')!;
    assert.ok(
      secondParagraphFirst.scheduledAt >= firstParagraphLast.scheduledAt + 200,
    );
    assert.equal(firstParagraphLast.scheduledAt, 2366);
    assert.equal(secondParagraphFirst.scheduledAt, 2566);
  });

  it('keeps staggered paragraph arrivals ordered across actual mount delays', () => {
    const registry = createRevealScheduleRegistry();
    const planAndMount = (
      prefix: string,
      count: number,
      sourceOffset: number,
      arrivedAt: number,
    ) => {
      const units = Array.from({ length: count }, (_, index) => ({
        key: `${prefix}:${index}`,
        sourceOffset: sourceOffset + index,
        kind: 'word' as const,
        paragraphKey: prefix,
      }));
      const plan = planRevealUnits(registry, units, arrivedAt);
      const starts = plan.map(
        ({ key }) => arrivedAt + getRevealTiming(registry, key, arrivedAt),
      );
      return { plan, starts };
    };

    const p1 = planAndMount('p1', 10, 0, 0);
    const p1Timings = p1.plan.map(
      ({ key }) => registry.words.get(key)!.scheduledAt,
    );
    const p2 = planAndMount('p2', 5, 100, 150);
    const p2Timings = p2.plan.map(
      ({ key }) => registry.words.get(key)!.scheduledAt,
    );
    const p3 = planAndMount('p3', 1, 200, 300);

    assert.ok(
      p1.starts.every(
        (start, index) => index === 0 || start - p1.starts[index - 1] === 150,
      ),
    );
    assert.ok(
      p2.starts.every(
        (start, index) => index === 0 || start - p2.starts[index - 1] === 150,
      ),
    );
    assert.ok(p2.starts[0] >= p1.starts.at(-1)! + 200);
    assert.ok(p3.starts[0] >= p2.starts.at(-1)! + 200);
    assert.deepEqual(
      p1.plan.map(({ key }) => registry.words.get(key)!.scheduledAt),
      p1Timings,
    );
    assert.deepEqual(
      p2.plan.map(({ key }) => registry.words.get(key)!.scheduledAt),
      p2Timings,
    );
    const repeated = planRevealUnits(registry, p2.plan, 500);
    assert.deepEqual(
      repeated.map(({ key, ordinal, scheduledAt }) => ({
        key,
        ordinal,
        scheduledAt,
      })),
      p2.plan.map(({ key, ordinal, scheduledAt }) => ({
        key,
        ordinal,
        scheduledAt,
      })),
      'replanning the same units must not append a paragraph gap',
    );

    const emphasized = planRevealUnits(
      registry,
      [
        {
          key: 'emphasis-before',
          sourceOffset: 300,
          kind: 'word',
          paragraphKey: 'same',
        },
        {
          key: 'emphasis-after',
          sourceOffset: 301,
          kind: 'word',
          paragraphKey: 'same',
        },
      ],
      400,
    );
    assert.equal(emphasized[1].scheduledAt - emphasized[0].scheduledAt, 150);
  });

  it('plans mixed units in source order, with a block occupying one slot', () => {
    const registry = createRevealScheduleRegistry();
    const plan = planRevealUnits(
      registry,
      [
        { key: 'prose-2', sourceOffset: 30, kind: 'word' },
        { key: 'block', sourceOffset: 20, kind: 'block' },
        { key: 'prose-1', sourceOffset: 10, kind: 'word' },
      ],
      1000,
    );
    assert.deepEqual(
      plan.map(({ key, ordinal, scheduledAt }) => ({
        key,
        ordinal,
        scheduledAt,
      })),
      [
        { key: 'prose-1', ordinal: 0, scheduledAt: 1016 },
        { key: 'block', ordinal: 1, scheduledAt: 1166 },
        { key: 'prose-2', ordinal: 2, scheduledAt: 1316 },
      ],
    );
    assert.equal(registry.nextOrdinal, 3);
  });

  it('keeps repeated plans fixed and places later batch units after reserved units', () => {
    const registry = createRevealScheduleRegistry();
    const units = [
      { key: 'a', sourceOffset: 0, kind: 'word' as const },
      { key: 'b', sourceOffset: 1, kind: 'block' as const },
    ];
    const first = planRevealUnits(registry, units, 1000);
    assert.deepEqual(planRevealUnits(registry, units, 2000), first);
    assert.deepEqual(
      planRevealUnits(
        registry,
        [{ key: 'c', sourceOffset: 2, kind: 'word' }],
        2000,
      ),
      [
        {
          key: 'c',
          sourceOffset: 2,
          kind: 'word',
          ordinal: 2,
          scheduledAt: 2016,
        },
      ],
    );
  });

  it('rebases overdue unmounted plans together at first render while preserving mounted timings', () => {
    const registry = createRevealScheduleRegistry();
    const plans = planRevealUnits(
      registry,
      Array.from({ length: 10 }, (_, index) => ({
        key: `word-${index}`,
        sourceOffset: index,
        kind: 'word' as const,
      })),
      1000,
    );
    const delays = plans.map(({ key }) => getRevealTiming(registry, key, 2000));
    assert.deepEqual(
      delays,
      [16, 166, 316, 466, 616, 766, 916, 1066, 1216, 1366],
    );
    const retained = registry.words.get('word-0')!.scheduledAt;
    planRevealUnits(
      registry,
      [
        { key: 'word-0', sourceOffset: 0, kind: 'word' },
        { key: 'late', sourceOffset: 10, kind: 'word' },
      ],
      3000,
    );
    assert.equal(getRevealTiming(registry, 'word-0', 3000), 0);
    assert.equal(registry.words.get('word-0')!.scheduledAt, retained);
    assert.equal(getRevealTiming(registry, 'late', 3000), 516);
  });

  it('resets on cancellation/document generation reset', () => {
    const registry = createRevealScheduleRegistry();
    scheduleRevealWords(registry, ['old'], 0);
    const nextGeneration = createRevealScheduleRegistry();
    assert.deepEqual(scheduleRevealWords(nextGeneration, ['new'], 500), [
      { ordinal: 0, scheduledAt: 516 },
    ]);
  });
});

describe('word reveal segments', () => {
  it('starts late arrivals now and keeps the cadence between new words', () => {
    const registry = createRevealScheduleRegistry();
    scheduleRevealWords(registry, ['first'], 0);
    const late = scheduleRevealWords(registry, ['late-a', 'late-b'], 5000);
    assert.deepEqual(late, [
      { ordinal: 1, scheduledAt: 5016 },
      { ordinal: 2, scheduledAt: 5166 },
    ]);
  });

  it('computes a fixed CSS delay from commit time rather than ordinal', async () => {
    const { revealDelayFromCommit } = await import('./managedPreviewBatch');
    assert.equal(revealDelayFromCommit(5100, 5000), 100);
    assert.equal(revealDelayFromCommit(5100, 5200), 0);
  });
  it('preserves whitespace and animates only appended tail words', () => {
    assert.deepEqual(wordSegments('same same  tail', 10, 20), [
      { text: 'same', offset: 10, animate: false },
      { text: ' ', offset: 14, animate: false },
      { text: 'same', offset: 15, animate: false },
      { text: '  ', offset: 19, animate: false },
      { text: 'tail', offset: 21, animate: true },
    ]);
  });
});

describe('managed writing baseline lifecycle', () => {
  it('finalizes a missed-writing generation and retains its reveal id on repeat finish', () => {
    const baseline = acquireWritingBaseline(null, 'note-a', 'Original');
    const finishedMarkdown = 'Original\n\nGenerated';
    let revealId = 0;
    let retainedId: string | null = null;

    // React never observed writing=true; retained sync baseline still reveals.
    assert.equal(shouldFinalizeReveal(Boolean(baseline), false, true), true);
    const startLine = appendedContentStartLine(
      baseline.markdown,
      finishedMarkdown,
    );
    assert.equal(startLine, 3);
    retainedId = retainedId ?? String(++revealId);

    // Effect reruns for the same finished contents; keep generation metadata.
    assert.equal(shouldFinalizeReveal(Boolean(baseline), false, true), true);
    retainedId = retainedId ?? String(++revealId);
    assert.equal(retainedId, '1');
    assert.equal(revealId, 1);
  });
  it('preserves the sync-captured baseline when the React writing prop arrives late', () => {
    let baseline = acquireWritingBaseline(null, 'note-a', 'Original');
    const firstAppend = 'Original\n\nFirst paragraph';

    // Managed adapter sync runs before React receives its writing=true prop.
    assert.equal(appendedContentStartLine(baseline.markdown, firstAppend), 3);
    baseline = acquireWritingBaseline(baseline, 'note-a', firstAppend);
    assert.deepEqual(baseline, { documentKey: 'note-a', markdown: 'Original' });

    // The late transition sees the already-captured baseline and same first
    // paragraph boundary; subsequent chunks and finish retain the generation.
    assert.equal(
      appendedContentStartLine(baseline.markdown, `${firstAppend}\n\nSecond`),
      3,
    );
    assert.equal(appendedContentStartLine(baseline.markdown, firstAppend), 3);
    assert.equal(
      acquireWritingBaseline(null, 'note-a', baseline.markdown).markdown,
      'Original',
    );
  });
});

describe('append paragraph reveal boundary', () => {
  it('excludes additions within an existing paragraph', () => {
    assert.equal(
      appendedContentStartLine('Existing text', 'Existing text more'),
      null,
    );
  });

  it('starts reveal at the new paragraph after a blank line', () => {
    assert.equal(
      appendedContentStartLine('Existing text', 'Existing text\n\nNew text'),
      3,
    );
    assert.equal(
      appendedContentStartLine('Existing\n\n', 'Existing\n\nNew text'),
      3,
    );
  });

  it('starts a new note at line one and rejects rewrites or unchanged content', () => {
    assert.equal(appendedContentStartLine('', 'New text'), 1);
    assert.equal(appendedContentStartLine('Existing', 'Changed\n\nNew'), null);
    assert.equal(appendedContentStartLine('Existing', 'Existing'), null);
  });
});

describe('managed preview batching', () => {
  it('publishes only the latest update in the 150ms window', () => {
    useFakeClock();
    const published: string[] = [];
    const batch = createManagedPreviewBatch((value: string) =>
      published.push(value),
    );
    batch.schedule('first');
    advance(80);
    batch.schedule('latest');
    advance(69);
    assert.deepEqual(published, []);
    advance(1);
    assert.deepEqual(published, ['latest']);
  });

  it('flushes at the original cadence even as newer updates arrive', () => {
    useFakeClock();
    const published: string[] = [];
    const batch = createManagedPreviewBatch((value: string) =>
      published.push(value),
    );
    batch.schedule('first');
    advance(100);
    batch.schedule('latest');
    advance(50);
    assert.deepEqual(published, ['latest']);
  });

  it('flushes pending content immediately when writing completes', () => {
    useFakeClock();
    const published: string[] = [];
    const batch = createManagedPreviewBatch((value: string) =>
      published.push(value),
    );
    batch.schedule('done');
    advance(40);
    batch.flush();
    assert.deepEqual(published, ['done']);
    advance(200);
    assert.deepEqual(published, ['done']);
  });

  it('publishes ordinary updates immediately and cancels pending writing updates', () => {
    useFakeClock();
    const published: string[] = [];
    const batch = createManagedPreviewBatch((value: string) =>
      published.push(value),
    );
    batch.schedule('writing');
    batch.publishNow('ordinary');
    assert.deepEqual(published, ['ordinary']);
    advance(150);
    assert.deepEqual(published, ['ordinary']);
  });

  it('drops pending updates on document switch or unmount disposal', () => {
    useFakeClock();
    const published: string[] = [];
    const batch = createManagedPreviewBatch((value: string) =>
      published.push(value),
    );
    batch.schedule('stale');
    batch.dispose();
    advance(200);
    assert.deepEqual(published, []);
  });
});
