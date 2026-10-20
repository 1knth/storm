export type RenameResult = {
  oldPath: string;
  newPath: string;
  kind: 'note' | 'image' | 'directory';
  changedNotes: { path: string; content: string; revision: string }[];
};

export function remapRenamedPath(
  path: string,
  oldPath: string,
  newPath: string,
): string {
  const normalized = path.replace(/\\/g, '/');
  const oldNormalized = oldPath.replace(/\\/g, '/');
  if (normalized === oldNormalized) return newPath;
  return normalized.startsWith(`${oldNormalized}/`)
    ? `${newPath}${normalized.slice(oldNormalized.length)}`
    : path;
}

export function remapRenamedTabAssignments(
  assignments: Record<string, string>,
  rename: RenameResult,
): Record<string, string> {
  const remapped: Record<string, string> = {};
  for (const [tabId, groupId] of Object.entries(assignments)) {
    let nextId = remapRenamedPath(tabId, rename.oldPath, rename.newPath);
    try {
      const parsed: unknown = JSON.parse(tabId);
      if (
        Array.isArray(parsed) &&
        parsed.length === 2 &&
        typeof parsed[0] === 'string' &&
        typeof parsed[1] === 'string'
      ) {
        const nextPath = remapRenamedPath(
          parsed[1],
          rename.oldPath,
          rename.newPath,
        );
        if (nextPath !== parsed[1])
          nextId = JSON.stringify([parsed[0], nextPath]);
      }
    } catch {
      // Note and non-image tab IDs are plain strings.
    }
    remapped[nextId] = groupId;
  }
  return remapped;
}

export function remapRenamedTabs<
  T extends {
    kind: string;
    path?: string;
    filename?: string;
    note?: { path: string; content: string; revision: string };
    state?: { doc: { toString(): string } };
  },
>(
  tabs: T[],
  rename: RenameResult,
  createState: (content: string) => T extends { state?: infer S } ? S : never,
): T[] {
  return tabs.map((tab) => {
    if (tab.kind === 'image' && tab.path) {
      const path = remapRenamedPath(tab.path, rename.oldPath, rename.newPath);
      return (
        path === tab.path
          ? tab
          : { ...tab, path, filename: path.split('/').at(-1) }
      ) as T;
    }
    if (tab.kind !== 'note' || !tab.note || !tab.state) return tab;
    const path = remapRenamedPath(
      tab.note.path,
      rename.oldPath,
      rename.newPath,
    );
    const changed = rename.changedNotes.find((note) => note.path === path);
    if (path === tab.note.path && !changed) return tab;
    const content = changed?.content ?? tab.state.doc.toString();
    return {
      ...tab,
      note: changed ? { ...changed } : { ...tab.note, path },
      state: createState(content),
    } as T;
  });
}

export async function coordinateRename<T>(options: {
  flushAllAffectedNotes: () => Promise<boolean>;
  mutate: () => Promise<T>;
  remap: (result: T) => Promise<void> | void;
}): Promise<T> {
  if (!(await options.flushAllAffectedNotes()))
    throw new Error('Could not save open notes before renaming.');
  const result = await options.mutate();
  await options.remap(result);
  return result;
}
