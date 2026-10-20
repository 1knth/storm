const MAX_FOLD_STATES = 2_000;
const foldStates = new Map<string, boolean>();

export function getHeadingFoldState(key: string): boolean | undefined {
  const value = foldStates.get(key);
  if (value === undefined) return undefined;
  // Refresh insertion order so frequently used notes survive eviction.
  foldStates.delete(key);
  foldStates.set(key, value);
  return value;
}

export function setHeadingFoldState(key: string, collapsed: boolean): void {
  foldStates.delete(key);
  foldStates.set(key, collapsed);
  if (foldStates.size > MAX_FOLD_STATES) {
    const oldestKey = foldStates.keys().next().value;
    if (oldestKey !== undefined) foldStates.delete(oldestKey);
  }
}
