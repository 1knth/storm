/**
 * Measures how much context the Pi Tutor receives from Storm, using real quiz
 * data. Replays saved sessions through the production projection functions
 * (attach prompt, learner notifications, write results, learner reads) and
 * reports bytes and approximate tokens per piece.
 *
 *   bun scripts/measureTutorContext.ts [quiz-sessions.json] [learner-model.json]
 *
 * Defaults to the installed app's data. Nothing is written or sent anywhere.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import extension from '../extensions/storm';
import {
  attachPrompt,
  learnerNotification,
  compactLearnerState,
  modelSession,
  writeAck,
} from '../extensions/storm-runtime';
import { quizRecovery } from '../src/shared/quizAgentContext';
import { computeLearnerState } from '../src/shared/learnerModel';
import {
  learnerScopeKey,
  learnerScopeSignature,
} from '../src/main/learnerStore';

const appData = join(homedir(), 'Library/Application Support/storm');
const sessionsPath = process.argv[2] ?? join(appData, 'quiz-sessions.json');
const learnerPath = process.argv[3] ?? join(appData, 'learner-model.json');
const CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW ?? 500_000);
// JSON-heavy text tokenizes at roughly 3.5–4 bytes per token.
const BYTES_PER_TOKEN = Number(process.env.BYTES_PER_TOKEN ?? 3.7);

const bytes = (value: unknown) =>
  Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const tokens = (n: number) => Math.round(n / BYTES_PER_TOKEN);
const pct = (n: number) =>
  ((tokens(n) / CONTEXT_WINDOW) * 100).toFixed(2) + '%';
const row = (label: string, n: number) =>
  console.log(
    `  ${label.padEnd(34)} ${String(n).padStart(8)} B ${String(tokens(n)).padStart(7)} tok ${pct(n).padStart(7)}`,
  );

/** Tool definitions the model sees on every request. */
function toolDefinitions() {
  const tools: any[] = [];
  extension({
    registerCommand() {},
    registerTool: (tool: any) => tools.push(tool),
    on() {},
    getActiveTools: () => [],
    setActiveTools() {},
    sendUserMessage() {},
    appendEntry() {},
  } as any);
  return tools.map((tool) => ({
    name: tool.name,
    bytes: bytes({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }),
  }));
}

const LEARNER = ['answer', 'message', 'continue', 'respond-prompt', 'skip'];
const OUTPUT = [
  'pose-question',
  'pose-prompt',
  'feedback',
  'agent-message',
  'skip-question',
];

/** Final session state, minus the transcript tail written after event `upTo`. */
function sessionAt(session: any, events: any[], upTo: number) {
  const outputs = events.filter(
    (e) => e.cursor <= upTo && OUTPUT.includes(e.type),
  ).length;
  const all = events.filter((e) => OUTPUT.includes(e.type)).length;
  const ratio = all ? outputs / all : 1;
  const transcript = session.transcript ?? [];
  return {
    ...session,
    transcript: transcript.slice(0, Math.round(transcript.length * ratio)),
  };
}

const main = async () => {
  const store = JSON.parse(await readFile(sessionsPath, 'utf8'));
  const learner = JSON.parse(
    await readFile(learnerPath, 'utf8').catch(() => '{"scopes":{}}'),
  );
  const sessions: any[] = Object.values(store.sessions ?? {});
  const fixed = toolDefinitions();

  console.log(
    `Context window ${CONTEXT_WINDOW} tokens, ~${BYTES_PER_TOKEN} bytes/token\n`,
  );
  console.log('Fixed (every request, while attached)');
  for (const tool of fixed) row(`tool ${tool.name}`, tool.bytes);

  for (const session of sessions.sort(
    (a, b) => bytes(b.transcript) - bytes(a.transcript),
  )) {
    const events: any[] = store.events?.[session.id] ?? [];
    if (!events.length) continue;
    console.log(
      `\n${session.name ?? session.id} (${session.transcript?.length ?? 0} transcript entries, ${events.length} events)`,
    );

    // Attach: the one-off user message at /storm attach.
    const recovery = quizRecovery(session, events);
    const context = {
      sessionId: session.id,
      contextId: '00000000-0000-0000-0000-000000000000',
    };
    const prompt = attachPrompt(session, {
      ...context,
      recovery,
      study: { available: false, reason: 'not measured' },
    });
    const projected = modelSession(session);
    console.log(' Attach');
    row('total attach message', bytes(prompt));
    row(
      '  instructions (prose)',
      bytes(prompt) - bytes({ ...projected, ...context, recovery, study: {} }),
    );
    row('  recovery.history', bytes(recovery.history));
    row('  recovery.recentEvents', bytes(recovery.recentEvents));
    row('  lessonMap', bytes(projected.lessonMap ?? ''));
    row('  tutorNotes', bytes(projected.tutorNotes ?? ''));
    row(
      '  currentQuestion/prompt',
      bytes([projected.currentQuestion, projected.currentPrompt]),
    );

    // Turns: learner batches between agent outputs, plus the agent's writes.
    let batch: any[] = [];
    let question: any = null;
    const notifications: number[] = [];
    const writes: number[] = [];
    const writeSessionPart: number[] = [];
    let questions = 0;
    for (const event of events) {
      const data = event.data ?? {};
      if (event.type === 'pose-question') {
        question = data.question;
        questions++;
      }
      if (event.type === 'answer' && question)
        question = { ...question, status: 'answered', ...data };
      if (LEARNER.includes(event.type)) batch.push(event);
      if (OUTPUT.includes(event.type)) {
        if (batch.length)
          notifications.push(
            bytes(learnerNotification(batch, question, [], context)),
          );
        batch = [];
        // Write result = ack + compact session + context.
        const after = writeAck(sessionAt(session, events, event.cursor));
        const result = JSON.stringify({
          message: `Storm quiz updated (${event.type}).`,
          ...after,
          ...context,
        });
        writes.push(bytes(result));
        writeSessionPart.push(bytes(after));
      }
    }
    const scopeKey = learnerScopeKey(session.scope, session.id);
    const attempts = learner.scopes?.[scopeKey]?.attempts ?? [];
    const learnerRead = bytes(
      compactLearnerState({
        ...computeLearnerState(attempts, {
          scopeKey,
          scopeSignature: learnerScopeSignature(session.scope),
          now: new Date(),
        }),
        diagnostics: {},
        recording: {},
      }),
    );
    const avg = (xs: number[]) =>
      xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    console.log(
      ` Per turn (averages over ${notifications.length} learner updates)`,
    );
    row('learner notification', avg(notifications));
    row('write result (pose/feedback/msg)', avg(writes));
    row('  of which session state', avg(writeSessionPart));
    row(`learner read (${attempts.length} attempts)`, learnerRead);
    const perTurn =
      (sum(notifications) + sum(writes) + learnerRead * questions) /
      Math.max(1, notifications.length);
    row('≈ Storm bytes per learner update', Math.round(perTurn));
  }
};

await main();
