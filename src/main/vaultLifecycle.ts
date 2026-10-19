const tails = new Map<string, Promise<void>>();

/** Serialize lifecycle transitions for one canonical vault root. */
export async function runVaultLifecycleExclusive<T>(
  canonicalRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(canonicalRoot) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(canonicalRoot, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(canonicalRoot) === current) tails.delete(canonicalRoot);
  }
}
