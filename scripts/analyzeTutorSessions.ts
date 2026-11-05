/**
 * Groups failed tool calls in saved Pi Tutor sessions into stable signatures so
 * recurring tutor bottlenecks can be counted and fixed.
 *
 *   bun scripts/analyzeTutorSessions.ts [--json] [session.jsonl ...]
 *
 * With no paths it scans ~/.pi/agent/sessions for sessions that used Storm's
 * tools. Only reads the files. Output never carries argument values or the
 * learner-derived arguments Pi echoes in validation errors: a signature is a
 * hash of the tool, action and normalized error text, and arguments are
 * reduced to their shape (keys, types, length buckets).
 *
 * Hashes group; they do not anonymize. Low-entropy values can be recovered by
 * guessing, so key them (HMAC) before anything leaves the machine.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Bump when normalization changes so older counts are not silently split. */
export const SIGNATURE_VERSION = 1;

const TOOLS = new Set(['storm', 'storm_study']);

/** Error text with identifiers, numbers and echoed arguments removed. */
export function normalizeError(text: string): string {
  return text
    .split(/\n\s*Received arguments:/)[0]
    .replace(/call_[\w|]+/g, 'call_#')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '#',
    )
    .replace(/\b[0-9a-f]{16,}\b/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function errorSignature(key: string, normalized: string): string {
  return createHash('sha256')
    .update(`${SIGNATURE_VERSION}\0${key}\0${normalized}`)
    .digest('hex')
    .slice(0, 12);
}

function valueShape(value: unknown): string {
  if (typeof value === 'string')
    return value.length <= 1000
      ? 'str'
      : `str≤${Math.ceil(value.length / 1000)}k`;
  if (Array.isArray(value)) return `arr[${value.length}]`;
  return value === null ? 'null' : typeof value;
}

/** Keys, types and length buckets; never values. */
export function argumentShape(args: unknown): string {
  if (!args || typeof args !== 'object') return valueShape(args);
  return Object.entries(args as Record<string, unknown>)
    .filter(([key]) => key !== 'action')
    .map(([key, value]) => `${key}:${valueShape(value)}`)
    .sort()
    .join(' ');
}

export type FailureSummary = {
  signature: string;
  key: string;
  error: string;
  count: number;
  sessions: number;
  /** Failures followed by a success of the same tool action in the session. */
  recovered: number;
  /** Further failed calls of that action before the success, averaged over recoveries. */
  meanRetries: number;
  shapes: Array<{ shape: string; count: number }>;
};

export type Analysis = {
  signatureVersion: number;
  sessions: number;
  calls: number;
  failures: number;
  signatures: FailureSummary[];
};

type Failure = {
  signature: string;
  key: string;
  error: string;
  shape: string;
  session: number;
  retries?: number;
};

/** Analyze sessions given as parsed JSONL rows, one array per session. */
export function analyzeSessions(sessions: unknown[][]): Analysis {
  let calls = 0;
  const failures: Failure[] = [];
  sessions.forEach((rows, session) => {
    const pending = new Map<string, { key: string; shape: string }>();
    const open = new Map<string, Failure[]>();
    for (const row of rows) {
      const message = (row as { message?: any })?.message;
      if (message?.role === 'assistant' && Array.isArray(message.content))
        for (const part of message.content) {
          if (part?.type !== 'toolCall' || !TOOLS.has(part.name)) continue;
          const action = part.arguments?.action;
          pending.set(part.id, {
            key: `${part.name}:${typeof action === 'string' ? action : ''}`,
            shape: argumentShape(part.arguments),
          });
          calls++;
        }
      if (message?.role !== 'toolResult') continue;
      const call = pending.get(message.toolCallId);
      if (!call) continue;
      pending.delete(message.toolCallId);
      const unresolved = open.get(call.key) ?? [];
      if (!message.isError) {
        unresolved.forEach(
          (failure, index) => (failure.retries = unresolved.length - 1 - index),
        );
        open.delete(call.key);
        continue;
      }
      const text = (Array.isArray(message.content) ? message.content : [])
        .map((part: { text?: unknown }) =>
          typeof part?.text === 'string' ? part.text : '',
        )
        .join('');
      const error = normalizeError(text);
      const failure: Failure = {
        signature: errorSignature(call.key, error),
        key: call.key,
        error,
        shape: call.shape,
        session,
      };
      failures.push(failure);
      open.set(call.key, [...unresolved, failure]);
    }
  });

  const grouped = new Map<string, Failure[]>();
  for (const failure of failures)
    grouped.set(failure.signature, [
      ...(grouped.get(failure.signature) ?? []),
      failure,
    ]);
  const signatures = [...grouped.values()]
    .map((group): FailureSummary => {
      const recovered = group.filter((f) => f.retries !== undefined);
      const shapes = new Map<string, number>();
      for (const f of group)
        shapes.set(f.shape, (shapes.get(f.shape) ?? 0) + 1);
      return {
        signature: group[0].signature,
        key: group[0].key,
        error: group[0].error,
        count: group.length,
        sessions: new Set(group.map((f) => f.session)).size,
        recovered: recovered.length,
        meanRetries: recovered.length
          ? recovered.reduce((sum, f) => sum + (f.retries ?? 0), 0) /
            recovered.length
          : 0,
        shapes: [...shapes]
          .map(([shape, count]) => ({ shape, count }))
          .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape)),
      };
    })
    .sort(
      (a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
    );
  return {
    signatureVersion: SIGNATURE_VERSION,
    sessions: sessions.length,
    calls,
    failures: failures.length,
    signatures,
  };
}

function parseRows(text: string): unknown[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

async function sessionFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function report(analysis: Analysis): string {
  const lines = [
    `${analysis.sessions} sessions, ${analysis.calls} Storm tool calls, ${analysis.failures} failures (signature v${analysis.signatureVersion})`,
  ];
  for (const s of analysis.signatures) {
    lines.push(
      '',
      `${s.count}× ${s.key}  [${s.signature}]  ${s.sessions} session(s), ${s.recovered}/${s.count} recovered` +
        (s.recovered
          ? `, ${s.meanRetries.toFixed(1)} extra failed call(s) on average`
          : ''),
      `  ${s.error}`,
      ...s.shapes
        .slice(0, 3)
        .map((shape) => `  ${shape.count}× args ${shape.shape || '(none)'}`),
    );
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const explicit = args.filter((arg) => arg !== '--json');
  const paths = explicit.length
    ? explicit
    : await sessionFiles(join(homedir(), '.pi', 'agent', 'sessions'));
  const sessions: unknown[][] = [];
  for (const path of paths) {
    const text = await readFile(path, 'utf8');
    // Skip ordinary coding sessions when scanning; explicit paths are kept.
    if (!explicit.length && !/"name":"storm(_study)?"/.test(text)) continue;
    sessions.push(parseRows(text));
  }
  const analysis = analyzeSessions(sessions);
  console.log(json ? JSON.stringify(analysis, null, 2) : report(analysis));
}
