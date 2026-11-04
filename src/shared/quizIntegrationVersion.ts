/** Bump when the CLI/app/extension contract changes incompatibly. App versions
 * are deliberately separate: two builds may share a version but not features. */
export const QUIZ_INTEGRATION_VERSION = 2;
export const QUIZ_REQUIRED_FEATURES = [
  'learning',
  'support-update',
  'answer-confidence',
] as const;

export function quizIntegrationCompatibilityError(
  value: unknown,
): string | null {
  if (!value || typeof value !== 'object')
    return 'Storm did not advertise quiz integration capabilities.';
  const capabilities = value as Record<string, unknown>;
  if (capabilities.integrationVersion !== QUIZ_INTEGRATION_VERSION)
    return `Storm quiz integration version ${String(capabilities.integrationVersion ?? 'missing')} is incompatible; expected ${QUIZ_INTEGRATION_VERSION}.`;
  const features = capabilities.features;
  const missing = QUIZ_REQUIRED_FEATURES.filter(
    (feature) => !Array.isArray(features) || !features.includes(feature),
  );
  return missing.length
    ? `Storm is missing required quiz features: ${missing.join(', ')}.`
    : null;
}
