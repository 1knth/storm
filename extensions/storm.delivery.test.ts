// Synthetic CLI with the production Pi extension; regression coverage for delivery and ownership.
import { expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const type =
  (kind: string) =>
  (...args: unknown[]) => ({ kind, args });
mock.module('typebox', () => ({
  Type: Object.fromEntries(
    ['Object', 'Union', 'Literal', 'Optional', 'String', 'Array', 'Number'].map(
      (key) => [key, type(key)],
    ),
  ),
}));
const { default: extension } = await import('./storm');

const contextId = (text: string) => text.match(/"contextId":"([^"]+)"/)![1];
const pause = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (!(await check())) {
    if (Date.now() >= deadline)
      throw new Error('Diagnostic condition timed out');
    await pause();
  }
}

async function fixture(snapshots: unknown[] = []) {
  const dir = await mkdtemp(join(tmpdir(), 'storm-live-diagnostic-'));
  const executable = join(dir, 'fake-cli.cjs');
  await writeFile(join(dir, 'snapshots.json'), JSON.stringify(snapshots));
  await writeFile(
    executable,
    `
const fs = require('node:fs'), path = require('node:path');
const root = __dirname, args = process.argv.slice(2), op = args[1];
const file = n => path.join(root,n), exists = n => fs.existsSync(file(n));
const log = (n,v) => fs.appendFileSync(file(n),JSON.stringify(v)+'\\n');
const ok = value => process.stdout.write(JSON.stringify({ok:true,result:{ok:true,value}}));
const session = {id:args[2],revision:8,eventCursor:3,status:'connected'};
if(op==='capabilities') ok({integrationVersion:2,features:['learning', 'support-update', 'answer-confidence', 'tutor-notes']});
else if(op==='attach') ok({agentToken:'synthetic',snapshot:{session,events:[]}});
else if(op==='activity'||op==='detach') ok({});
else if(op==='status') process.stdout.write(JSON.stringify({ok:true,operation:'snapshot',snapshot:{session,events:[]}}));
else if(op==='wait') {
  log('waits.log',{after:args[args.indexOf('--after')+1]});
  if(exists('fail-wait')) {process.stderr.write(JSON.stringify({error:{code:'TEMPORARY'}}));process.exitCode=1;}
  else {
    const after=Number(args[args.indexOf('--after')+1]);
    const tick=()=>{
      if(!exists('allow-events')) return;
      const snapshots=JSON.parse(fs.readFileSync(file('snapshots.json'),'utf8'));
      const next=snapshots.find(s=>s.session.eventCursor>after);
      if(next){clearInterval(timer);process.stdout.write(JSON.stringify({ok:true,snapshot:{...next,session:{...next.session,id:args[2]}},after:next.session.eventCursor}));}
    }; const timer=setInterval(tick,10); tick();
  }
}
else if(op==='image') {
  fs.writeFileSync(file('image-started'),'');
  const timer=setInterval(()=>{if(exists('allow-image')){clearInterval(timer);ok({path:file('image.png'),mimeType:'image/png'});}},10);
}
else if(op==='image-release') {log('released.log',args[args.indexOf('--image-id')+1]);ok({});}
else if(op==='request') {
  let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{
    const request=JSON.parse(input);log('requests.log',{targetSessionId:args[2],...request});
    if(exists('drop-reply')) {fs.unlinkSync(file('drop-reply'));process.stdout.write('incomplete');}
    else ok({revision:request.expectedRevision+1});
  });
}
`,
  );
  const oldExecutable = process.env.STORM_QUIZ_CLI;
  const oldArgs = process.env.STORM_QUIZ_CLI_ARGS;
  process.env.STORM_QUIZ_CLI = process.execPath;
  process.env.STORM_QUIZ_CLI_ARGS = JSON.stringify([executable]);
  const commands = new Map<string, any>(),
    tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const calls: Array<{ text: string; options?: unknown }> = [];
  const notices: string[] = [];
  let idle = true,
    activeTools = ['read'];
  extension({
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, fn: Function) =>
      handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    getActiveTools: () => activeTools,
    setActiveTools: (names: string[]) => {
      activeTools = names;
    },
    sendUserMessage: (text: string, options?: unknown) =>
      calls.push({ text, options }),
  } as never);
  const ctx = {
    isIdle: () => idle,
    ui: { notify: (message: string) => notices.push(message) },
  };
  async function log(name: string) {
    try {
      return (await readFile(join(dir, name), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  return {
    calls,
    notices,
    tools,
    log,
    cliArgs: JSON.stringify([executable]),
    flag: (name: string) => writeFile(join(dir, name), ''),
    unflag: (name: string) => rm(join(dir, name), { force: true }),
    command: (input: string) => commands.get('storm').handler(input, ctx),
    busy: () => {
      idle = false;
    },
    async close() {
      try {
        for (const fn of handlers.get('session_shutdown') ?? []) await fn();
      } finally {
        if (oldExecutable === undefined) delete process.env.STORM_QUIZ_CLI;
        else process.env.STORM_QUIZ_CLI = oldExecutable;
        if (oldArgs === undefined) delete process.env.STORM_QUIZ_CLI_ARGS;
        else process.env.STORM_QUIZ_CLI_ARGS = oldArgs;
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

test('model-facing schemas expose limits, context ownership, and Continue effects', async () => {
  const f = await fixture();
  try {
    const variants = f.tools
      .get('storm')
      .parameters.args[1].anyOf.map((variant: any) => variant.args[0]);
    const prompt = variants.find(
      (fields: any) => fields.action.args[0] === 'prompt',
    );
    expect(prompt.text.args[0].maxLength).toBe(4000);
    expect(prompt.contextId).toBeDefined();
    expect(prompt.choices.args[0].args[0]).toHaveProperty('effect');
    const schema = f.tools.get('storm').parameters.args[0];
    const learner = variants.find(
      (fields: any) => fields.action.args[0] === 'learner',
    );
    expect(Object.keys(learner)).toEqual(['action']);
    expect(schema.action.args[0].map((value: any) => value.args[0])).toContain(
      'learner',
    );
    const questions = variants.filter(
      (fields: any) => fields.action.args[0] === 'question',
    );
    expect(questions).toHaveLength(4);
    for (const fields of [schema, ...questions]) {
      const concepts = fields.concepts.args[0];
      expect(concepts.args[1]).toEqual({
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
      });
      expect(concepts.args[0].args[0].pattern).toBe(
        '^[a-z0-9][a-z0-9-]{0,63}$',
      );
      expect(
        fields.level.args[0].args[0].map((value: any) => value.args[0]),
      ).toEqual(['recall', 'explain', 'apply', 'transfer']);
      expect(
        fields.support.args[0].args[0].map((value: any) => value.args[0]),
      ).toEqual(['independent', 'hinted', 'worked']);
    }
  } finally {
    await f.close();
  }
});

test('real CLI validation returns a safe actionable error to the model', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
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
    process.env.STORM_QUIZ_CLI_ARGS = f.cliArgs;
    await f.close();
  }
});
