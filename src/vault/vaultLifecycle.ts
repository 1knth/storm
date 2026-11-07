import { KeyedQueue } from '../shared/asyncQueue';

const queue = new KeyedQueue();

/** Serialize lifecycle transitions for one canonical vault root. */
export async function runVaultLifecycleExclusive<T>(
  canonicalRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  return queue.run(canonicalRoot, operation);
}

export function runVaultsLifecycleExclusive<T>(
  roots: string[],
  operation: () => Promise<T>,
): Promise<T> {
  const ordered = [...new Set(roots)].sort();
  const acquire = (index: number): Promise<T> =>
    index === ordered.length
      ? operation()
      : runVaultLifecycleExclusive(ordered[index], () => acquire(index + 1));
  return acquire(0);
}
