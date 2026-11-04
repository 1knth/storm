/**
 * Replays saved Pi Tutor sessions through Storm's context savings and estimates
 * how much smaller their message content would have been. This is a byte-based
 * estimate scaled by each session's recorded input tokens; it ignores branches,
 * compaction, cache writes, and any re-reads the tutor would make after stubs.
 *
 *   bun scripts/measurePiSession.ts <session.jsonl> [...]
 *
 * Sessions live under ~/.pi/agent/sessions. Images count as a flat ~1k tokens
 * rather than their base64 size. Only reads the files.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  compactLearnerState,
  pruneStormContext,
  writeAck,
} from '../extensions/storm-runtime';

const IMAGE_BYTES = 4000;
const WRITES = new Set([
  'question',
  'feedback',
  'message',
  'prompt',
  'skip-question',
  'support-update',
]);

const size = (messages: any[]) =>
  messages.reduce((total, message) => {
    const parts = Array.isArray(message.content)
      ? message.content
      : [message.content];
    return (
      total +
      parts.reduce(
        (sum: number, part: any) =>
          sum +
          (part?.type === 'image'
            ? IMAGE_BYTES
            : Buffer.byteLength(JSON.stringify(part ?? ''))),
        0,
      )
    );
  }, 0);

/** What write results and learner reads would have been in compact form. */
function compactWrites(messages: any[]) {
  const actions = new Map<string, string>();
  for (const message of messages)
    if (message.role === 'assistant' && Array.isArray(message.content))
      for (const part of message.content)
        if (part?.type === 'toolCall' && part.name === 'storm')
          actions.set(part.id, part.arguments?.action);
  return messages.map((message) => {
    const action = actions.get(message.toolCallId) ?? '';
    if (message.role !== 'toolResult' || message.toolName !== 'storm')
      return message;
    if (action === 'learner')
      try {
        const text = JSON.stringify(
          compactLearnerState(JSON.parse(message.content[0].text)),
        );
        return { ...message, content: [{ type: 'text', text }] };
      } catch {
        return message;
      }
    if (!WRITES.has(action)) return message;
    try {
      const value = JSON.parse(message.content[0].text);
      const { message: note, contextId, sessionId, ...session } = value;
      return {
        ...message,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              message: note,
              ...writeAck(session),
              contextId,
              sessionId,
            }),
          },
        ],
      };
    } catch {
      return message;
    }
  });
}

for (const path of process.argv.slice(2)) {
  const rows = (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const messages = rows
    .map((row) => row.message)
    .filter((m) => m && ['user', 'assistant', 'toolResult'].includes(m.role));
  const usage = messages.filter((m) => m.role === 'assistant').at(-1)?.usage;
  const measured = usage ? usage.input + (usage.cacheRead ?? 0) : 0;
  const before = size(messages);
  const acks = size(compactWrites(messages));
  const after = size(pruneStormContext(compactWrites(messages)));
  const perByte = measured / before;
  const tok = (bytes: number) => Math.round(bytes * perByte);
  console.log(basename(path));
  console.log(`  recorded final input        ${measured} tok`);
  console.log(
    `  ≈ compact writes and learner ${tok(acks)} tok (-${tok(before - acks)})`,
  );
  console.log(
    `  ≈ plus context pruning      ${tok(after)} tok (-${tok(before - after)}, ${(((before - after) / before) * 100).toFixed(1)}%)`,
  );
}
