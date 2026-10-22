export type WordSegment = { text: string; offset: number; animate: boolean };

export type RevealProgress = {
  generationId: string;
  previewKey: number;
  pending: boolean;
};

export type FinalPreviewStateInput = {
  activeDocumentKey: string | null;
  latestAcceptedMarkdown: string | undefined;
  publishedSnapshot: {
    docKey: string;
    markdown: string;
    previewRevision: number;
  } | null;
  batchPending: boolean;
  generationKey: string;
  receiptsMap: ReadonlyMap<number, RevealProgress>;
};

/** Derive the actual editor barrier from its accepted source and published snapshot. */
export function deriveFinalPreviewState({
  activeDocumentKey,
  latestAcceptedMarkdown,
  publishedSnapshot,
  batchPending,
  generationKey,
  receiptsMap,
}: FinalPreviewStateInput): boolean {
  const sourceMatchesPublished = Boolean(
    activeDocumentKey !== null &&
    publishedSnapshot?.docKey === activeDocumentKey &&
    latestAcceptedMarkdown !== undefined &&
    publishedSnapshot.markdown === latestAcceptedMarkdown,
  );
  const requiredRevision =
    sourceMatchesPublished && !batchPending
      ? publishedSnapshot?.previewRevision
      : undefined;
  return isFinalPreviewDrained({
    requiredRevision,
    latestPublishedRevision: publishedSnapshot?.previewRevision ?? 0,
    requiredGenerationId: generationKey,
    progressReceipt:
      requiredRevision === undefined
        ? null
        : (receiptsMap.get(requiredRevision) ?? null),
  });
}

export function isFinalPreviewDrained({
  requiredRevision,
  latestPublishedRevision,
  requiredGenerationId,
  progressReceipt,
}: {
  requiredRevision: number | null | undefined;
  latestPublishedRevision: number;
  requiredGenerationId: string;
  progressReceipt: RevealProgress | null;
}): boolean {
  return Boolean(
    requiredRevision !== null &&
    latestPublishedRevision === requiredRevision &&
    progressReceipt?.previewKey === requiredRevision &&
    progressReceipt.generationId === requiredGenerationId &&
    !progressReceipt.pending,
  );
}

/** Query animations once: per-word getAnimations() repeatedly flushes browser state. */
export function collectPendingRevealKeys(
  root: Pick<HTMLElement, 'getAnimations'>,
  units: readonly HTMLElement[],
  reducedMotion: boolean,
): Set<string> {
  const pending = new Set<string>();
  if (reducedMotion) return pending;
  const eligible = new Set<Element>(units);
  for (const unit of units) {
    if (unit.getAttribute('data-reveal-gated') === 'pending') {
      const key = unit.getAttribute('data-reveal-key');
      if (key) pending.add(key);
    }
  }
  for (const animation of root.getAnimations({ subtree: true })) {
    if (animation.playState !== 'running') continue;
    if (
      'animationName' in animation &&
      animation.animationName !== 'markdown-word-reveal'
    )
      continue;
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (!target || !eligible.has(target)) continue;
    const key = target.getAttribute('data-reveal-key');
    if (key) pending.add(key);
  }
  return pending;
}

export type RevealProgressState = {
  generationId: string;
  previewKey: number;
  pendingKeys: Set<string>;
};

export function shouldShowRevealingStatus(
  isFinished: boolean,
  isWriting: boolean,
  hasFinalAppend: boolean,
  finalRevealDrained: boolean,
): boolean {
  return isFinished && !isWriting && hasFinalAppend && !finalRevealDrained;
}

export function createRevealProgressState(
  generationId: string,
  previewKey: number,
  keys: readonly string[],
  reducedMotion: boolean,
): RevealProgressState {
  return {
    generationId,
    previewKey,
    pendingKeys: reducedMotion ? new Set() : new Set(keys),
  };
}

export function completeRevealProgressUnit(
  state: RevealProgressState,
  generationId: string,
  key: string,
): boolean | null {
  if (state.generationId !== generationId || !state.pendingKeys.delete(key))
    return null;
  return state.pendingKeys.size > 0;
}

export const PREVIEW_SCROLL_INTENT_MS = 450;
export const PREVIEW_REVEAL_CADENCE_MS = 50;
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
  committed?: boolean;
  started?: boolean;
};
export type RevealUnitDescriptor = {
  key: string;
  sourceOffset: number;
  kind: 'word' | 'block';
  paragraphKey?: string;
};
export type PlannedRevealUnit = RevealUnitDescriptor & RevealSchedule;
export function revealSessionIdentity(
  documentKey: string,
  generationId: string,
): string {
  return JSON.stringify([documentKey, generationId]);
}

export function shouldAutoOpenAgentStatus(
  sessionId: string,
  state: string,
  seenSessionIds: Set<string>,
): boolean {
  if (
    !['connected', 'writing'].includes(state) ||
    seenSessionIds.has(sessionId)
  )
    return false;
  seenSessionIds.add(sessionId);
  return true;
}

export type RevealScheduleRegistry = {
  startedAt: number | null;
  nextOrdinal: number;
  lastPendingStartAt: number | null;
  tailParagraphKey: string | null;
  tailParagraphEndAt: number | null;
  words: Map<string, RevealSchedule>;
  completed: Set<string>;
};

export function createRevealScheduleRegistry(): RevealScheduleRegistry {
  return {
    startedAt: null,
    nextOrdinal: 0,
    lastPendingStartAt: null,
    tailParagraphKey: null,
    tailParagraphEndAt: null,
    words: new Map(),
    completed: new Set(),
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
  let previous = [...registry.words.values()].reduce<number | null>(
    (latest, item) => Math.max(latest ?? item.scheduledAt, item.scheduledAt),
    null,
  );
  return keys.map((key) => {
    let schedule = registry.words.get(key);
    if (!schedule) {
      const ordinal = registry.nextOrdinal++;
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
      previous = scheduledAt;
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
  let previousStart = [...registry.words.values()].reduce<number | null>(
    (latest, item) => Math.max(latest ?? item.scheduledAt, item.scheduledAt),
    null,
  );
  let previousParagraph = registry.tailParagraphKey ?? undefined;
  let previousParagraphEnd = registry.tailParagraphEndAt;
  for (const { unit } of ordered) {
    let schedule = registry.words.get(unit.key);
    if (!schedule) {
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
      previousStart = scheduledAt;
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

/** Rebase only never-started slots after the preview's first DOM commit. */
export function commitRevealTimeline(
  registry: RevealScheduleRegistry,
  now: number,
  cadence = PREVIEW_REVEAL_CADENCE_MS,
): boolean {
  const pending = [...registry.words.entries()]
    .filter(
      ([key, schedule]) =>
        !registry.completed.has(key) &&
        !schedule.started &&
        !schedule.committed,
    )
    .sort((a, b) => a[1].ordinal - b[1].ordinal);
  let previous = now - cadence;
  // Keep future assignments where possible; move elapsed, unpainted slots into
  // fresh ordered slots so a delayed first commit cannot launch the queue at once.
  let changed = false;
  for (const [, schedule] of pending) {
    schedule.committed = true;
    if (schedule.scheduledAt <= now) {
      const next = Math.max(
        now + PREVIEW_REVEAL_FRAME_PADDING_MS,
        previous + cadence,
      );
      schedule.scheduledAt = next;
      changed = true;
    } else if (previous !== null && schedule.scheduledAt < previous + cadence) {
      schedule.scheduledAt = previous + cadence;
      changed = true;
    }
    previous = schedule.scheduledAt;
  }
  return changed;
}

export function markRevealStarted(
  registry: RevealScheduleRegistry,
  key: string,
): void {
  const schedule = registry.words.get(key);
  if (schedule) schedule.started = true;
}

/** Resolve a unit's CSS delay against its shared absolute schedule. */
export function getRevealTiming(
  registry: RevealScheduleRegistry,
  key: string,
  now: number,
): number {
  const schedule = registry.words.get(key);
  if (!schedule) return 0;
  // A tab may unmount while its absolute timeline continues. Never rebase the
  // remaining tail on remount: doing so changes the generation's schedule and
  // can make the preview appear to restart or reveal out of order.
  schedule.mounted = true;
  // Registration can happen during Markdown render long before React commits the
  // unit. Never treat elapsed wall time as proof that an animation was painted.
  // Overdue slots start at commit instead of being silently settled.
  return Math.max(0, schedule.scheduledAt - now);
}

export function getReadyRevealDelay(
  scheduledAt: number,
  readyAt: number,
): number {
  return Math.max(0, scheduledAt - readyAt);
}

export function isRevealComplete(
  registry: RevealScheduleRegistry,
  key: string,
  now: number,
  duration = 100,
): boolean {
  void now;
  void duration;
  return registry.completed.has(key);
}

export function completeRevealUnit(
  registry: RevealScheduleRegistry,
  key: string,
): void {
  if (registry.words.has(key)) registry.completed.add(key);
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
    get hasPending() {
      return latest !== null;
    },
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
