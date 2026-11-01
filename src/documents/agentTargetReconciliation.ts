export type AgentTargetReconciliation = 'current' | 'refresh' | 'unsaved';

/** A view may have fresh text but stale note metadata after an acknowledged save. */
export function agentTargetDiskRevision(
  disk: { content: string; revision: string },
  liveContent: string,
): string {
  if (liveContent !== disk.content)
    throw new Error(
      'Agent target changed while opening; preserve the local edit and inspect again',
    );
  return disk.revision;
}

/** Reconcile a tab against fresh disk without mistaking an acknowledged save for a local edit. */
export function reconcileAgentTargetContent({
  baseline,
  tabContent,
  diskContent,
  activeContent,
}: {
  baseline: string;
  tabContent: string;
  diskContent: string;
  activeContent?: string;
}): AgentTargetReconciliation {
  const currentContent = activeContent ?? tabContent;
  if (currentContent === diskContent) return 'current';
  if (currentContent === baseline) return 'refresh';
  return 'unsaved';
}
