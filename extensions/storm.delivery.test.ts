import { piRegistry, pause, until } from './storm-test-fixtures';
// Synthetic CLI with the production Pi extension; regression coverage for delivery and ownership.
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { default: extension, runCli } = await import('./storm');

const contextId = (text: string) => text.match(/"contextId":"([^"]+)"/)![1];
async function fixture(snapshots: unknown[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'storm-live-diagnostic-'));
  const flags = new Set<string>();
  const logs = new Map<string, any[]>();
  const logValue = (name: string, value: any) =>
    logs.set(name, [...(logs.get(name) ?? []), value]);
  let realCli = false;
  let studyScope: unknown;
  let studyAttempts = 0;
  const transport = {
    async request(args: string[], input?: any, token?: string) {
      if (realCli && args[1] === 'request') return runCli(args, input, token);
      if (args[0] === 'study') {
        if (args[1] === 'capabilities')
          return {
            ok: true,
            result: { ok: true, value: { schemaVersion: 1 } },
          };
        if (input?.action === 'open') {
          studyAttempts++;
          if (flags.has('fail-study')) throw new Error('study unavailable');
          return {
            ok: true,
            result: {
              ok: true,
              value: { studyId: `study-${studyAttempts}`, root: '/vault' },
            },
          };
        }
        logValue('study.log', input);
        return { ok: true, result: { ok: true, value: {} } };
      }
      const session = {
        scope: studyScope,
        id: args[2],
        revision: 8,
        eventCursor: 3,
        status: 'connected',
      };
      const ok = (value: any) => ({ ok: true, result: { ok: true, value } });
      switch (args[1]) {
        case 'capabilities':
          return ok({
            integrationVersion: 2,
            features: [
              'learning',
              'support-update',
              'answer-confidence',
              'tutor-notes',
            ],
          });
        case 'attach':
          return ok({
            agentToken: 'synthetic',
            snapshot: { session, events: [] },
          });
        case 'status':
          return {
            ok: true,
            operation: 'snapshot',
            snapshot: { session, events: [] },
          };
        case 'image':
          flags.add('image-started');
          await until(() => flags.has('allow-image'));
          return ok({ path: join(dir, 'image.png'), mimeType: 'image/png' });
        case 'image-release':
          logValue('released.log', args[args.indexOf('--image-id') + 1]);
          return ok({});
        case 'request':
          logValue('requests.log', { targetSessionId: args[2], ...input });
          if (flags.has('reject-input'))
            return { ok: true, result: { ok: false, error: 'invalid-input' } };
          if (flags.delete('drop-reply')) throw new Error('invalid JSON');
          return ok({ revision: input.expectedRevision + 1 });
        default:
          return ok({});
      }
    },
    wait(sessionId: string, after: number) {
      logValue('waits.log', { after: String(after) });
      let timer: ReturnType<typeof setInterval>;
      const result = new Promise<any>((resolve, reject) => {
        timer = setInterval(() => {
          if (flags.has('fail-wait')) {
            clearInterval(timer);
            reject(new Error('wait failed'));
            return;
          }
          if (!flags.has('allow-events')) return;
          const next = (snapshots as any[]).find(
            (snapshot) => snapshot.session.eventCursor > after,
          );
          if (next) {
            clearInterval(timer);
            resolve({
              value: { ...next, session: { ...next.session, id: sessionId } },
              cursor: next.session.eventCursor,
            });
          }
        }, 1);
      });
      return { result, kill: () => clearInterval(timer) };
    },
  };
  const { commands, tools, listeners: handlers, host } = piRegistry();
  const calls: Array<{ text: string; options?: unknown }> = [];
  const notices: string[] = [];
  let idle = true,
    activeTools = ['read'];
  extension(
    {
      ...host,
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names;
      },
      sendMessage: (message: any, options?: unknown) =>
        calls.push({ text: message.content, options }),
      sendUserMessage: (text: string, options?: unknown) =>
        calls.push({ text, options }),
      appendEntry: () => {},
    } as never,
    transport,
  );
  const ctx = {
    isIdle: () => idle,
    ui: { notify: (message: string) => notices.push(message) },
  };
  return {
    setScope: (scope: unknown) => {
      studyScope = scope;
    },
    activeTools: () => activeTools,
    studyAttempts: () => studyAttempts,
    calls,
    notices,
    tools,
    log: async (name: string) => logs.get(name) ?? [],
    useRealCli: () => {
      realCli = true;
    },
    cliArgs: undefined,
    flag: async (name: string) => {
      flags.add(name);
      await writeFile(join(dir, name), '');
    },
    unflag: async (name: string) => {
      flags.delete(name);
      await rm(join(dir, name), { force: true });
    },
    command: (input: string) => commands.get('storm').handler(input, ctx),
    busy: () => {
      idle = false;
    },
    async close() {
      try {
        for (const fn of handlers.get('session_shutdown') ?? []) await fn();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function snapshot(cursor: number, text: string, image = false) {
  return {
    session: {
      id: 'diagnostic',
      revision: cursor + 5,
      eventCursor: cursor,
      status: 'connected',
    },
    events: [
      {
        cursor,
        type: 'message',
        data: { text, ...(image ? { attachments: ['image-one'] } : {}) },
      },
    ],
  };
}

test('a transient listener failure recovers without losing the pending event', async () => {
  const f = await fixture([snapshot(4, 'learner-message')]);
  try {
    await f.flag('fail-wait');
    await f.command('attach diagnostic');
    await until(async () => (await f.log('waits.log')).length === 1);
    await pause(60);
    await f.unflag('fail-wait');
    await f.flag('allow-events');
    await f.tools.get('storm').execute('status', { action: 'status' });
    await f.command('status');
    await until(() => f.calls.length === 2);
    expect((await f.log('waits.log')).length).toBeGreaterThanOrEqual(2);
    expect(f.calls[1].text).toContain('learner-message');
    expect(
      f.notices.some((message) => message.includes('retrying listener')),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test('queued learner activity rejects an older turn context without submitting it', async () => {
  const f = await fixture([
    snapshot(4, 'New requirement: use a different example.'),
  ]);
  try {
    await f.command('attach diagnostic');
    f.busy();
    await f.flag('allow-events');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].options).toEqual({ deliverAs: 'followUp' });
    await expect(
      f.tools.get('storm').execute('old-turn', {
        action: 'message',
        text: 'Response prepared before the new requirement.',
        contextId: contextId(f.calls[0].text),
      }),
    ).rejects.toThrow('Stale contextId');
    expect(await f.log('requests.log')).toEqual([]);
    await f.tools.get('storm').execute('new-turn', {
      action: 'message',
      text: 'I will use the new requirement.',
      contextId: contextId(f.calls[1].text),
    });
    expect((await f.log('requests.log'))[0].expectedRevision).toBe(9);
  } finally {
    await f.close();
  }
});

test('slow image resolution preserves learner-event enqueue order', async () => {
  const f = await fixture([
    snapshot(4, 'FIRST-image-message', true),
    snapshot(5, 'SECOND-text-message'),
  ]);
  try {
    await f.command('attach diagnostic');
    await f.flag('allow-events');
    await pause(80);
    expect(f.calls).toHaveLength(1);
    await f.flag('allow-image');
    await until(() => f.calls.length === 3);
    expect(f.calls[1].text).toContain('FIRST-image-message');
    expect(f.calls[2].text).toContain('SECOND-text-message');
  } finally {
    await f.close();
  }
});

test('an old-turn reply cannot release a queued image; its owning context can', async () => {
  const f = await fixture([snapshot(4, 'IMAGE-in-follow-up', true)]);
  try {
    await f.command('attach diagnostic');
    f.busy();
    await f.flag('allow-image');
    await f.flag('allow-events');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].options).toEqual({ deliverAs: 'followUp' });
    await expect(
      f.tools.get('storm').execute('old-turn', {
        action: 'message',
        text: 'Reply to an earlier topic.',
        contextId: contextId(f.calls[0].text),
      }),
    ).rejects.toThrow('Stale contextId');
    expect(await f.log('released.log')).toEqual([]);
    await f.tools.get('storm').execute('image-turn', {
      action: 'message',
      text: 'I reviewed the image.',
      contextId: contextId(f.calls[1].text),
    });
    expect(await f.log('released.log')).toEqual(['image-one']);
  } finally {
    await f.close();
  }
});

test('identical retry after a lost reply preserves its idempotency key and revision', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
    await f.flag('drop-reply');
    const tool = f.tools.get('storm');
    const request = {
      action: 'message',
      text: 'Same intended reply.',
      contextId: contextId(f.calls[0].text),
      operationId: 'same-logical-reply',
    };
    await expect(tool.execute('reply', request)).rejects.toThrow(
      'invalid JSON',
    );
    await tool.execute('retry', request);
    const requests = await f.log('requests.log');
    expect(requests).toHaveLength(2);
    expect(requests[0].expectedRevision).toBe(requests[1].expectedRevision);
    expect(requests[0].idempotencyKey).toBe(requests[1].idempotencyKey);
  } finally {
    await f.close();
  }
});

test('switching quizzes invalidates the old queued context', async () => {
  const f = await fixture([snapshot(4, 'OLD-QUIZ-learner-request')]);
  try {
    await f.command('attach old-quiz');
    f.busy();
    await f.flag('allow-events');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].options).toEqual({ deliverAs: 'followUp' });
    expect(f.calls[1].text).toContain('old-quiz');
    await f.unflag('allow-events');
    await f.command('attach new-quiz');
    // The old follow-up is already in Pi's queue; stop() cannot retract it.
    await expect(
      f.tools.get('storm').execute('old-event-reply', {
        action: 'message',
        text: 'Response to OLD-QUIZ-learner-request.',
        contextId: contextId(f.calls[1].text),
      }),
    ).rejects.toThrow('different-session contextId');
    expect(await f.log('requests.log')).toEqual([]);
  } finally {
    await f.close();
  }
});

test('model-facing schema derives action fields and limits from validation variants', async () => {
  const f = await fixture();
  try {
    const schema = f.tools.get('storm').parameters;
    expect(schema.properties.contextId.description).toContain('contextId');
    const variants = schema.anyOf;
    const prompt = variants.find(
      (variant: any) => variant.properties.action.const === 'prompt',
    ).properties;
    expect(prompt.text.maxLength).toBe(4000);
    expect(prompt.choices.items.properties).toHaveProperty('effect');
    const notes = variants.find(
      (variant: any) => variant.properties.action.const === 'notes',
    ).properties;
    expect(notes.text.maxLength).toBe(10000);
    expect(schema.properties.text.maxLength).toBe(10000);
  } finally {
    await f.close();
  }
});

test('real CLI validation returns a safe actionable error to the model', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
    f.useRealCli();
    process.env.STORM_QUIZ_CLI = process.execPath;
    process.env.STORM_QUIZ_CLI_ARGS = JSON.stringify([
      new URL('../scripts/storm.ts', import.meta.url).pathname,
    ]);
    await expect(
      f.tools.get('storm').execute('too-long', {
        contextId: contextId(f.calls[0].text),
        action: 'prompt',
        kind: 'clarification',
        text: 'Q'.repeat(4001),
        choices: [{ id: 'a', text: 'A' }],
      }),
    ).rejects.toThrow('pose-prompt requires');
  } finally {
    delete process.env.STORM_QUIZ_CLI_ARGS;
    delete process.env.STORM_QUIZ_CLI;
    await f.close();
  }
});

test('initial planning choices explain invalid Continue effects and accept ordinary choices', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
    const params = {
      contextId: contextId(f.calls[0].text),
      action: 'prompt',
      kind: 'next-steps',
      text: 'Start with a diagnostic?',
      choices: [{ id: 'start', text: 'Start', effect: 'continue' }],
    };
    await expect(
      f.tools.get('storm').execute('planning', params),
    ).rejects.toThrow('Omit effect');
    await f.tools.get('storm').execute('planning-fixed', {
      ...params,
      choices: [{ id: 'start', text: 'Start' }],
    });
  } finally {
    await f.close();
  }
});

test('rejected input instructs correction while uncertain delivery retains identical retry guidance', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
    await f.flag('reject-input');
    await expect(
      f.tools.get('storm').execute('rejected', {
        contextId: contextId(f.calls[0].text),
        action: 'message',
        text: 'Plan',
      }),
    ).rejects.toThrow('correct the request');
  } finally {
    await f.close();
  }
});

test('failed scope rebind invalidates the old study and status retries successfully', async () => {
  const f = await fixture();
  try {
    f.setScope({ vaultId: 'vault', folderPath: 'A' });
    await f.command('attach diagnostic');
    expect(f.activeTools()).toContain('storm_study');
    f.setScope({ vaultId: 'vault', folderPath: 'B' });
    await f.flag('fail-study');
    await f.tools.get('storm').execute('status-failed', { action: 'status' });
    expect(f.activeTools()).not.toContain('storm_study');
    await expect(
      f.tools.get('storm_study').execute('old', { action: 'tree' }),
    ).rejects.toThrow('No shared study scope');
    expect(await f.log('study.log')).toEqual([]);
    await f.unflag('fail-study');
    await f.tools.get('storm').execute('status-retry', { action: 'status' });
    expect(f.activeTools()).toContain('storm_study');
    await f.tools.get('storm_study').execute('new', { action: 'tree' });
    expect((await f.log('study.log'))[0].studyId).toBe(
      `study-${f.studyAttempts()}`,
    );
  } finally {
    await f.close();
  }
});

test('metadata writes retain uncertain operations, merge revisions and preserve learner activity', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
    const tool = f.tools.get('storm');
    const receipt = contextId(f.calls[0].text);
    const notes = { action: 'notes', text: 'Plan', operationId: 'notes-once' };
    await f.flag('drop-reply');
    await expect(tool.execute('notes', notes)).rejects.toThrow('notes-once');
    await tool.execute('retry', notes);
    await tool.execute('test', {
      action: 'test',
      step: 'start',
      testConcepts: ['concept'],
    });
    await tool.execute('map', {
      action: 'map',
      nodes: [{ id: 'concept', label: 'Concept' }],
      edges: [],
    });
    const requests = await f.log('requests.log');
    expect(requests[0]).toEqual(requests[1]);
    expect(requests.map((request: any) => request.expectedRevision)).toEqual([
      8, 8, 9, 10,
    ]);
    expect(
      requests.every(
        (request: any) => request.handledThroughCursor === undefined,
      ),
    ).toBe(true);
    await expect(
      tool.execute('old-turn', {
        action: 'message',
        text: 'Old reply',
        contextId: receipt,
      }),
    ).rejects.toThrow('Stale contextId');
  } finally {
    await f.close();
  }
});
