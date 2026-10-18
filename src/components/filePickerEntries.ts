import type { VaultEntry } from '../shared/types';

export function filterPickerEntries(
  entries: VaultEntry[],
  query: string,
): VaultEntry[] {
  const normalizedQuery = query.trim().toLowerCase();
  return entries.filter(
    (entry) =>
      !entry.isDirectory && entry.path.toLowerCase().includes(normalizedQuery),
  );
}
