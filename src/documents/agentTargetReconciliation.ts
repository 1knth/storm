export type AgentTargetReconciliation = 'current' | 'refresh' | 'unsaved';

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
