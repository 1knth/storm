/**
 * Display order for posed answer options. Agents reliably author the correct
 * multiple-choice option first and parallel matching columns in pair order, so
 * Storm fixes the presentation order once, when the question is posed, and
 * stores it. Choice IDs, scoring, submitted drafts and reattachment all read
 * the stored order, so nothing reshuffles on rerender or reconnect.
 */
export type QuizOrderableItem = { id: string; text: string };

/**
 * Summary options such as "All of the above" only make sense last. They stay
 * anchored at the end in their authored order.
 */
const ANCHORED_CHOICE =
  /^[\s*_`"'(]*(?:all|none|both|neither|any|either)\s+(?:of\s+(?:the\s+)?(?:above|these|them|others|other\s+options|options|answers|choices)|the\s+above)\b/i;
/** A quantity option: optional sign, currency, digits, and a short unit. */
const QUANTITY =
  /^[\s*_`$€£¥]*([-+]?\d[\d,]*(?:\.\d+)?)\s*(?:[a-zA-Z%°/²³µ.·\s]{0,12})[\s*_`]*$/;

export function isAnchoredQuizChoice(text: string): boolean {
  return ANCHORED_CHOICE.test(text);
}

/** Deterministic PRNG (FNV-1a seed, xorshift32) so an order is reproducible from its seed. */
function seededRandom(seed: string): () => number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash ^ seed.charCodeAt(index)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let state = hash || 0x9e3779b9;
  return () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

/** Numeric options read best in ascending value, which is also position-neutral. */
function ascendingQuantities<T extends QuizOrderableItem>(
  items: T[],
): T[] | null {
  const values = new Map<T, number>();
  for (const item of items) {
    const match = QUANTITY.exec(item.text);
    if (!match) return null;
    const value = Number(match[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    values.set(item, value);
  }
  if (new Set(values.values()).size !== items.length) return null;
  return [...items].sort((a, b) => values.get(a)! - values.get(b)!);
}

/**
 * Presentation order for multiple-choice options. Quantities are sorted
 * ascending; anything else is shuffled from the seed. Position carries no
 * information about correctness either way.
 */
export function orderQuizChoices<T extends QuizOrderableItem>(
  choices: T[],
  seed: string,
): T[] {
  if (choices.length < 2) return [...choices];
  const anchored = choices.filter((choice) =>
    isAnchoredQuizChoice(choice.text),
  );
  const movable = choices.filter(
    (choice) => !isAnchoredQuizChoice(choice.text),
  );
  if (movable.length < 2) return [...movable, ...anchored];
  const ordered =
    ascendingQuantities(movable) ?? shuffled(movable, seededRandom(seed));
  return [...ordered, ...anchored];
}

/**
 * Presentation order for the matching column learners choose from. Pairings
 * travel by item ID, so reordering is safe, and an order identical to the
 * authored one is rotated because authored column order is usually the key.
 */
export function orderQuizMatchOptions<T extends QuizOrderableItem>(
  items: T[],
  seed: string,
): T[] {
  if (items.length < 2) return [...items];
  const candidate = shuffled(items, seededRandom(seed));
  if (candidate.some((item, index) => item !== items[index])) return candidate;
  return [...items.slice(1), items[0]];
}
