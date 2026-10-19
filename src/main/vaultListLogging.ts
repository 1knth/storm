export type ConsoleSeverity = 'INFO' | 'WARNING' | 'MODERATE' | 'SEVERE';

export function classifyVaultListError(error: unknown): ConsoleSeverity {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' ? 'MODERATE' : 'SEVERE';
}

export function formatVaultListError(
  severity: ConsoleSeverity,
  trace: string,
  error: unknown,
): string {
  const stack = error instanceof Error ? error.stack : undefined;
  const source = stack
    ?.split('\n')
    .slice(1)
    .map((line) => line.match(/(?:\(|at )(.+?):(\d+):\d+\)?$/))
    .find(Boolean);
  const file = source?.[1].split(/[\\/]/).at(-1) || 'unknown';
  const line = source?.[2] || 'unknown';
  const detail = error instanceof Error ? error.message : String(error);
  return `[${severity}] [Trace ${trace}] [${file}] [line ${line}] [Error: ${detail}]`;
}
