import path from 'node:path';
import { createHash } from 'node:crypto';
import type { VaultService } from './vaultService';
import { planRenameLinks } from './renameLinks';

export async function executeVaultRename(
  service: VaultService,
  relativePath: unknown,
  newBaseName: unknown,
) {
  // Reject invalid requests before scanning unrelated notes for link rewrites.
  const move = await service.validateRenameEntry(relativePath, newBaseName);
  const root = service.getSelectedVaultPath();
  if (!root) throw new Error('No vault selected');
  if (move.oldPath === move.newPath) return { ...move, changedNotes: [] };
  if (move.kind === 'pdf') {
    const renamed = await service.renameEntry(
      move.oldPath,
      path.posix.basename(move.newPath),
    );
    return { ...renamed, changedNotes: [] };
  }
  const entries = await service.listNotes({ previews: false });
  const documents: { path: string; content: string; revision: string }[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'note') continue;
    const note = await service.readNote(entry.path);
    documents.push(note);
  }
  // Compute all rewrites before the first mutation.
  const plans = planRenameLinks(documents, move.oldPath, move.newPath);
  const documentsByPath = new Map(documents.map((doc) => [doc.path, doc]));
  const changes = plans.flatMap((plan) => {
    const oldPath =
      plan.path === move.newPath || plan.path.startsWith(`${move.newPath}/`)
        ? move.oldPath + plan.path.slice(move.newPath.length)
        : plan.path;
    const original = documentsByPath.get(oldPath);
    return original && original.content !== plan.content
      ? [
          {
            oldPath,
            newPath: plan.path,
            before: original.content,
            after: plan.content,
            revision: original.revision,
          },
        ]
      : [];
  });
  if (move.oldPath === move.newPath) return { ...move, changedNotes: [] };

  // Revalidate every document used for resolution, not just documents being edited.
  for (const doc of documents) {
    const latest = await service.readNote(doc.path);
    if (latest.revision !== doc.revision)
      throw new Error(
        `Rename aborted: note changed during link planning (${doc.path})`,
      );
  }
  await service.renameEntry(move.oldPath, path.posix.basename(move.newPath));
  const written: {
    path: string;
    before: string;
    after: string;
    revision: string;
  }[] = [];
  try {
    for (const change of changes) {
      await service.saveNote({
        vaultPath: root,
        path: change.newPath,
        content: change.after,
        revision: change.revision,
      });
      written.push({
        path: change.newPath,
        before: change.before,
        after: change.after,
        revision: revisionOf(change.after),
      });
    }
  } catch (error) {
    const recovery: string[] = [];
    for (const item of written.reverse()) {
      try {
        const current = await service.readNote(item.path);
        if (current.revision !== item.revision)
          throw new Error('revision changed');
        await service.saveNote({
          vaultPath: root,
          path: item.path,
          content: item.before,
          revision: current.revision,
        });
      } catch {
        recovery.push(item.path);
      }
    }
    if (recovery.length)
      throw new Error(
        `Rename failed; rollback incomplete. Recoverable paths: ${[move.newPath, ...recovery].join(', ')}. Original error: ${String(error)}`,
      );
    try {
      await service.renameEntry(
        move.newPath,
        path.posix.basename(move.oldPath),
      );
    } catch {
      throw new Error(
        `Rename failed; rollback incomplete. Recoverable path: ${move.newPath}. Original error: ${String(error)}`,
      );
    }
    throw error;
  }
  const changedNotes = changes.map((change) => ({
    oldPath: change.oldPath,
    newPath: change.newPath,
    oldContent: change.before,
    newContent: change.after,
    oldRevision: change.revision,
    newRevision: revisionOf(change.after),
    path: change.newPath,
    content: change.after,
    revision: revisionOf(change.after),
  }));
  return { ...move, changedNotes };
}
function revisionOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
