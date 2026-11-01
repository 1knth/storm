import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyContextStore } from '../../src/main/studyContextStore.ts';
const dir = await mkdtemp(join(tmpdir(), 'storm-study-limits-'));
const scope = {
  vaultId: 'v',
  notePath: 'note.md',
  folderPath: null,
  selectedNotePaths: [],
};
const snap = (id: string) => ({
  schemaVersion: 1 as const,
  id,
  studyId: 'study',
  scope,
  sources: [],
  createdAt: new Date().toISOString(),
});
try {
  const store = new StudyContextStore(join(dir, 'history.json'));
  await store.save(snap('historical'));
  await store.finalizeQuestion('quiz', 'historical', 'pending', 1);
  await store.save(snap('current'));
  await store.finalizeQuestion('quiz', 'current', 'pending', 2);
  for (let i = 0; i < 65; i++) await store.save(snap('later-' + i));
  console.log(
    JSON.stringify({
      historicalSnapshotSurvives: !!(await store.snapshot('historical')),
      currentSnapshotSurvives: !!(await store.snapshot('current')),
    }),
  );
  const pinned = new StudyContextStore(join(dir, 'pins.json'));
  let saved = 0;
  try {
    for (let i = 0; i < 65; i++) {
      await pinned.save(snap('p-' + i));
      await pinned.pin('q-' + i, 'p-' + i);
      saved++;
    }
  } catch (e) {
    console.log(
      JSON.stringify({
        pinnedSnapshotsSaved: saved,
        nextSaveError: (e as Error).message,
      }),
    );
  }
  const scopes = new StudyContextStore(join(dir, 'scopes.json'));
  let bound = 0;
  try {
    for (let i = 0; i < 101; i++) {
      await scopes.bind('s-' + i, { ...scope, notePath: i + '.md' });
      bound++;
    }
  } catch (e) {
    console.log(
      JSON.stringify({
        distinctScopesBound: bound,
        nextBindError: (e as Error).message,
      }),
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
