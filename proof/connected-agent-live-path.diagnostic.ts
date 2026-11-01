// Synthetic CLI, production Pi extension. Assertions demonstrate current defects.
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
const { default: extension } = await import('../extensions/storm-quiz');

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
const session = {id:'diagnostic',revision:8,eventCursor:3,status:'connected'};
if(op==='attach') ok({agentToken:'synthetic',snapshot:{session,events:[]}});
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
      if(next){clearInterval(timer);process.stdout.write(JSON.stringify({ok:true,snapshot:next,after:next.session.eventCursor}));}
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
    command: (input: string) => commands.get('storm-quiz').handler(input, ctx),
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

test('a transient listener failure is not repaired by model or slash status', async () => {
  const f = await fixture([snapshot(4, 'learner-message')]);
  try {
    await f.flag('fail-wait');
    await f.command('attach diagnostic');
    await until(async () => (await f.log('waits.log')).length === 1);
    await pause(60);
    await f.unflag('fail-wait');
    await f.flag('allow-events');
    await f.tools.get('storm_quiz').execute('status', { action: 'status' });
    await f.command('status');
    await pause(80);
    expect((await f.log('waits.log')).length).toBe(1);
    expect(f.calls).toHaveLength(1); // attach only, no learner event
    expect(f.notices.at(-1)).toContain('listener failed');
    expect(
      f.notices.filter((message) => message.includes('listener failed')),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('queued learner activity silently advances the revision stamped on an older turn response', async () => {
  const f = await fixture([
    snapshot(4, 'New requirement: use a different example.'),
  ]);
  try {
    await f.command('attach diagnostic');
    f.busy();
    await f.flag('allow-events');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].options).toEqual({ deliverAs: 'followUp' });
    await f.tools.get('storm_quiz').execute('old-turn', {
      action: 'message',
      text: 'Response prepared before the new requirement.',
    });
    expect((await f.log('requests.log'))[0].expectedRevision).toBe(9);
    // Attach exposed revision 8; the queued follow-up has not been processed.
    expect(f.calls[0].text).toContain('"revision":8');
  } finally {
    await f.close();
  }
});

test('slow image resolution lets a later learner event overtake an earlier one', async () => {
  const f = await fixture([
    snapshot(4, 'FIRST-image-message', true),
    snapshot(5, 'SECOND-text-message'),
  ]);
  try {
    await f.command('attach diagnostic');
    await f.flag('allow-events');
    await until(() =>
      f.calls.some((call) => call.text.includes('SECOND-text-message')),
    );
    expect(
      f.calls.some((call) => call.text.includes('FIRST-image-message')),
    ).toBe(false);
    await f.flag('allow-image');
    await until(() =>
      f.calls.some((call) => call.text.includes('FIRST-image-message')),
    );
    const texts = f.calls.slice(1).map((call) => call.text);
    expect(texts[0]).toContain('SECOND-text-message');
    expect(texts[1]).toContain('FIRST-image-message');
  } finally {
    await f.close();
  }
});

test('an unrelated old-turn reply releases an image in a queued learner follow-up', async () => {
  const f = await fixture([snapshot(4, 'IMAGE-in-follow-up', true)]);
  try {
    await f.command('attach diagnostic');
    f.busy();
    await f.flag('allow-image');
    await f.flag('allow-events');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].options).toEqual({ deliverAs: 'followUp' });
    await f.tools.get('storm_quiz').execute('old-turn', {
      action: 'message',
      text: 'Reply to an earlier topic.',
    });
    expect(await f.log('released.log')).toEqual(['image-one']);
  } finally {
    await f.close();
  }
});

test('identical retry after a lost reply sends a different idempotency key', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
    await f.flag('drop-reply');
    const tool = f.tools.get('storm_quiz');
    const request = { action: 'message', text: 'Same intended reply.' };
    await expect(tool.execute('reply', request)).rejects.toThrow(
      'invalid JSON',
    );
    await tool.execute('retry', request);
    const requests = await f.log('requests.log');
    expect(requests).toHaveLength(2);
    expect(requests[0].expectedRevision).toBe(requests[1].expectedRevision);
    expect(requests[0].idempotencyKey).not.toBe(requests[1].idempotencyKey);
  } finally {
    await f.close();
  }
});

test('queued activity has no session identity and a later tool call targets the newly attached quiz', async () => {
  const f = await fixture([snapshot(4, 'OLD-QUIZ-learner-request')]);
  try {
    await f.command('attach old-quiz');
    f.busy();
    await f.flag('allow-events');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].options).toEqual({ deliverAs: 'followUp' });
    expect(f.calls[1].text).not.toContain('old-quiz');
    await f.unflag('allow-events');
    await f.command('attach new-quiz');
    // The old follow-up is already in Pi's queue; stop() cannot retract it.
    await f.tools.get('storm_quiz').execute('old-event-reply', {
      action: 'message',
      text: 'Response to OLD-QUIZ-learner-request.',
    });
    expect((await f.log('requests.log'))[0].targetSessionId).toBe('new-quiz');
  } finally {
    await f.close();
  }
});

test('model-facing schema omits backend limits and explicit Continue choice effects', async () => {
  const f = await fixture();
  try {
    const schema = f.tools.get('storm_quiz').parameters;
    // Typebox is replaced by a recording builder; these are actual registration arguments.
    const fields = schema.args[0];
    expect(fields.text.args[0].args).toEqual([]); // no maxLength
    const choiceFields = fields.choices.args[0].args[0].args[0];
    expect(Object.keys(choiceFields)).toEqual(['id', 'text']);
    expect(choiceFields).not.toHaveProperty('effect');
  } finally {
    await f.close();
  }
});

test('a real CLI length validation failure becomes an opaque exit-code error for the model', async () => {
  const f = await fixture();
  try {
    await f.command('attach diagnostic');
    process.env.STORM_QUIZ_CLI_ARGS = JSON.stringify([
      new URL('../scripts/storm.ts', import.meta.url).pathname,
    ]);
    await expect(
      f.tools.get('storm_quiz').execute('too-long', {
        action: 'prompt',
        kind: 'clarification',
        text: 'Q'.repeat(4001),
        choices: [{ id: 'a', text: 'A' }],
      }),
    ).rejects.toThrow('Storm CLI exited with 2.');
  } finally {
    process.env.STORM_QUIZ_CLI_ARGS = f.cliArgs;
    await f.close();
  }
});
