import type { AgentEditPlan } from './agentProtocol';

export function isAgentEditPlan(value: unknown): value is AgentEditPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const plan = value as Record<string, unknown>;
  if (plan.type === 'replace') return typeof plan.content === 'string';
  if (plan.type !== 'replaceText' || !Array.isArray(plan.replacements))
    return false;
  return plan.replacements.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const replacement = item as Record<string, unknown>;
    return (
      typeof replacement.find === 'string' &&
      replacement.find.length > 0 &&
      typeof replacement.replace === 'string'
    );
  });
}
