export type WordSegment = { text: string; offset: number; animate: boolean };

export const PREVIEW_SCROLL_INTENT_MS = 450;
export const PREVIEW_REVEAL_CADENCE_MS = 150;
export const PREVIEW_REVEAL_FRAME_PADDING_MS = 16;

export function revealDelayFromCommit(
  scheduledAt: number,
  committedAt: number,
): number {
  return Math.max(0, scheduledAt - committedAt);
}

export function hasRecentPreviewScrollIntent(
  intentUntil: number,
  now: number,
): boolean {
  return now <= intentUntil;
}

export type RevealSchedule = {
  ordinal: number;
  scheduledAt: number;
  mounted?: boolean;
};
export type RevealUnitDescriptor = {
  key: string;
  sourceOffset: number;
  kind: 'word' | 'block';
  paragraphKey?: string;
};
export type PlannedRevealUnit = RevealUnitDescriptor & RevealSchedule;
export type RevealScheduleRegistry = {
  startedAt: number | null;
  nextOrdinal: number;
  lastPendingStartAt: number | null;
  tailParagraphKey: string | null;
  tailParagraphEndAt: number | null;
  words: Map<string, RevealSchedule>;
};

export function createRevealScheduleRegistry(): RevealScheduleRegistry {
  return {
    startedAt: null,
    nextOrdinal: 0,
    lastPendingStartAt: null,
    tailParagraphKey: null,
    tailParagraphEndAt: null,
    words: new Map(),
  };
}

/** Idempotently assign new words to one generation-wide reading-order timeline. */
export function scheduleRevealWords(
  registry: RevealScheduleRegistry,
  keys: readonly string[],
  now: number,
  cadence = PREVIEW_REVEAL_CADENCE_MS,
): RevealSchedule[] {
  if (keys.length > 0 && registry.startedAt === null) registry.startedAt = now;
  return keys.map((key) => {
    let schedule = registry.words.get(key);
    if (!schedule) {
      const ordinal = registry.nextOrdinal++;
      const previous = [...registry.words.values()].reduce<number | null>(
        (latest, item) =>
          Math.max(latest ?? item.scheduledAt, item.scheduledAt),
        null,
      );
      const scheduledAt = Math.max(
        previous === null
          ? now + PREVIEW_REVEAL_FRAME_PADDING_MS
          : previous + cadence,
        now + PREVIEW_REVEAL_FRAME_PADDING_MS,
      );
      registry.lastPendingStartAt = scheduledAt;
      registry.startedAt ??= scheduledAt;
      schedule = { ordinal, scheduledAt };
      registry.words.set(key, schedule);
    }
    return schedule;
  });
}

/** Reserve every unit in source order before callers hand plans to React. */
export function planRevealUnits(
  registry: RevealScheduleRegistry,
  units: readonly RevealUnitDescriptor[],
  now: number,
  cadence = PREVIEW_REVEAL_CADENCE_MS,
): PlannedRevealUnit[] {
  const ordered = units
    .map((unit, inputOrder) => ({ unit, inputOrder }))
    .sort(
      (a, b) =>
        a.unit.sourceOffset - b.unit.sourceOffset ||
        a.inputOrder - b.inputOrder,
    );
  const schedules: RevealSchedule[] = [];
  let previousParagraph = registry.tailParagraphKey ?? undefined;
  let previousParagraphEnd = registry.tailParagraphEndAt;
  for (const { unit } of ordered) {
    let schedule = registry.words.get(unit.key);
    if (!schedule) {
      const previousStart = [...registry.words.values()].reduce<number | null>(
        (latest, item) =>
          Math.max(latest ?? item.scheduledAt, item.scheduledAt),
        null,
      );
      const paragraphChanged =
        unit.paragraphKey !== undefined &&
        previousParagraph !== undefined &&
        unit.paragraphKey !== previousParagraph;
      const scheduledAt = Math.max(
        now + PREVIEW_REVEAL_FRAME_PADDING_MS,
        previousStart === null
          ? now + PREVIEW_REVEAL_FRAME_PADDING_MS
          : previousStart +
              (paragraphChanged ? Math.max(cadence, 200) : cadence),
      );
      schedule = { ordinal: registry.nextOrdinal++, scheduledAt };
      registry.words.set(unit.key, schedule);
      registry.lastPendingStartAt = scheduledAt;
    }
    schedules.push(schedule);
    if (unit.paragraphKey !== undefined) {
      if (unit.paragraphKey !== previousParagraph) previousParagraphEnd = null;
      previousParagraph = unit.paragraphKey;
      previousParagraphEnd = Math.max(
        previousParagraphEnd ?? schedule.scheduledAt + 100,
        schedule.scheduledAt + 100,
      );
      registry.tailParagraphKey = previousParagraph;
      registry.tailParagraphEndAt = previousParagraphEnd;
    }
  }
  return ordered.map(({ unit }, index) => ({ ...unit, ...schedules[index] }));
}

/** Assign one atomic slot to a newly appended structured Markdown block. */
export function scheduleRevealBlock(
  registry: RevealScheduleRegistry,
  key: string,
  now: number,
  cadence = PREVIEW_REVEAL_CADENCE_MS,
): RevealSchedule {
  return scheduleRevealWords(registry, [key], now, cadence)[0];
}

/** Resolve once from the shared registry at first component render; mounted units never move. */
export function getRevealTiming(
  registry: RevealScheduleRegistry,
  key: string,
  now: number,
  cadence = PREVIEW_REVEAL_CADENCE_MS,
): number {
  const schedule = registry.words.get(key);
  if (!schedule) return 0;
  if (!schedule.mounted) {
    const pending = [...registry.words.entries()]
      .filter(([, item]) => !item.mounted)
      .sort((a, b) => a[1].ordinal - b[1].ordinal);
    const overdue = pending.filter(([, item]) => item.scheduledAt <= now);
    if (overdue.length) {
      // Rebase the entire unmounted tail, not just slots already overdue. A
      // later unmounted slot may still be in the future; leaving it fixed
      // would create a cadence-sized hole after the rebased overdue prefix.
      let startAt = now + PREVIEW_REVEAL_FRAME_PADDING_MS;
      for (const [, item] of pending) {
        item.scheduledAt = startAt;
        startAt += cadence;
      }
      registry.lastPendingStartAt = startAt - cadence;
    }
    schedule.mounted = true;
  }
  return Math.max(0, schedule.scheduledAt - now);
}

/** Whether a source-positioned word begins in newly appended content. */
export function isRevealWordEligible(
  wordStartOffset: number,
  revealStartOffset: number,
): boolean {
  return wordStartOffset >= revealStartOffset;
}

/** Split visible text into whitespace-preserving word segments with stable offsets. */
export function wordSegments(
  text: string,
  startOffset: number,
  appendedFrom: number,
): WordSegment[] {
  return (text.match(/\s+|\S+/g) ?? []).map((part, index, parts) => {
    const offset = startOffset + parts.slice(0, index).join('').length;
    return {
      text: part,
      offset,
      animate:
        !/^\s+$/.test(part) && isRevealWordEligible(offset, appendedFrom),
    };
  });
}

export type ManagedPreview = {
  vaultId: string;
  notePath: string;
  markdown: string;
};

export type WritingBaseline = { documentKey: string; markdown: string };

/** Finalize a retained baseline after generation even if writing=true was missed. */
export function shouldFinalizeReveal(
  hasBaseline: boolean,
  isWriting: boolean,
  generationFinished: boolean,
): boolean {
  return hasBaseline && !isWriting && generationFinished;
}

/** Keep the first synchronous snapshot for a writing generation. */
export function acquireWritingBaseline(
  current: WritingBaseline | null,
  documentKey: string,
  markdown: string,
): WritingBaseline {
  return current?.documentKey === documentKey
    ? current
    : { documentKey, markdown };
}

/** First fully new paragraph line; an open baseline paragraph is never animated. */
export function appendedContentStartLine(
  baseline: string,
  markdown: string,
): number | null {
  if (!markdown.startsWith(baseline) || markdown.length === baseline.length)
    return null;
  if (baseline.length === 0) return 1;

  const separator = markdown.indexOf('\n\n', baseline.length);
  const boundary = baseline.endsWith('\n\n')
    ? baseline.length
    : separator >= 0
      ? separator + 2
      : -1;
  if (boundary < 0) return null;
  return markdown.slice(0, boundary).split('\n').length;
}

/** Coalesces owner-managed writing updates; the editor/save state is untouched. */
export function createManagedPreviewBatch<T>(
  publish: (value: T) => void,
  delay = 150,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest: T | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (latest === null) return;
    const value = latest;
    latest = null;
    publish(value);
  };

  return {
    schedule(value: T) {
      latest = value;
      if (!timer) timer = setTimeout(flush, delay);
    },
    flush,
    publishNow(value: T) {
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
      publish(value);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      latest = null;
    },
  };
}
