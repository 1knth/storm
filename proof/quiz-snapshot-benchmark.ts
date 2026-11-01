// Synthetic, warm local-filesystem benchmark. No learner data or model calls.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QuizStore } from '../src/main/quizStore';
import { QuizService } from '../src/main/quizService';
import { createQuizAgentHandler } from '../src/main/quizAgentHandler';

const dir = await mkdtemp(join(tmpdir(), 'storm-snapshot-benchmark-'));
const results: unknown[] = [];
try {
  for (const count of [100, 1000, 5000]) {
    const path = join(dir, `${count}.json`);
    const stamp = '2026-10-25T00:00:00Z';
    const text = 'source-grounded tutoring explanation '.repeat(30);
    const transcript = Array.from({ length: count }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? 'learner' : 'agent',
      text,
      createdAt: stamp,
    }));
    const events = transcript.map((message, index) => ({
      cursor: index + 1,
      revision: index + 1,
      type: message.role === 'learner' ? 'message' : 'agent-message',
      data: { text },
      createdAt: stamp,
    }));
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: 'benchmark',
            agentToken: 'synthetic',
            revision: count,
            eventCursor: count,
            status: 'disconnected',
            transcript,
            currentQuestion: null,
            freeChatDraft: '',
            createdAt: stamp,
            updatedAt: stamp,
          },
        ],
        events: { benchmark: events },
        idempotency: {},
      }),
    );
    const service = new QuizService(new QuizStore(path), () => true);
    const handler = createQuizAgentHandler(service);
    // Await startup and warm the filesystem/parser path.
    await service.getSnapshot('benchmark', count);
    const samples = [];
    let response: any;
    for (let iteration = 0; iteration < 7; iteration++) {
      const start = performance.now();
      response = await handler({
        protocol: 1,
        requestId: 'benchmark',
        type: 'quiz',
        operation: 'snapshot',
        sessionId: 'benchmark',
        agentToken: 'synthetic',
        after: count,
      });
      JSON.stringify(response);
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const responseBytes = Buffer.byteLength(JSON.stringify(response));
    const compactSamples = [];
    let compact: any;
    for (let iteration = 0; iteration < 7; iteration++) {
      const start = performance.now();
      compact = await handler({
        protocol: 1,
        requestId: 'compact',
        type: 'quiz',
        operation: 'snapshot',
        sessionId: 'benchmark',
        agentToken: 'synthetic',
        after: count,
        compact: true,
      });
      JSON.stringify(compact);
      compactSamples.push(performance.now() - start);
    }
    compactSamples.sort((left, right) => left - right);
    results.push({
      compactIdleSnapshotBytes: Buffer.byteLength(JSON.stringify(compact)),
      compactMedianSnapshotAndSerializeMs: Number(compactSamples[3].toFixed(3)),
      messages: count,
      charsPerMessage: text.length,
      databaseBytes: (await readFile(path)).byteLength,
      idleSnapshotBytes: responseBytes,
      newEvents: response.snapshot.events.length,
      medianSnapshotAndSerializeMs: Number(samples[3].toFixed(2)),
      snapshotBytesPerIdleHourAtOnePollPerSecond: responseBytes * 3600,
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        runtime: `bun ${Bun.version} (${process.version} compatibility)`,
        platform: process.platform,
        arch: process.arch,
        trials: 7,
        results,
        limitations:
          'Synthetic warm local filesystem. Measures service handler plus serialization, excludes socket/CLI/model cost. Per-hour traffic is arithmetic at 1 poll/s; real cadence also includes request latency.',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
