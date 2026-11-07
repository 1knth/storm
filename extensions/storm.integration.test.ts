import { piRegistry, until } from './storm-test-fixtures';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Subprocess smoke path for the production CLI transport and Pi lifecycle.
const { default: extension } = await import('./storm');

type Call = { command: string; options: any };
type Harness = ReturnType<typeof makePi>;
let dir = '';
let oldEnv: Record<string, string | undefined> = {};

function makePi() {
  const { commands, tools, listeners, host } = piRegistry();
  const calls: Call[] = [];
  const notices: any[] = [];
  let activeTools = ['read', 'custom'];
  let idle = true;
  let latestContextId = '';
  const entries: unknown[] = [];
  const observe = (text: string) => {
    latestContextId =
      text.match(/"contextId":"([^"]+)"/)?.[1] ?? latestContextId;
  };
  const pi: any = {
    ...host,
    registerTool: (tool: any) =>
      tools.set(tool.name, {
        ...tool,
        execute: async (id: string, params: any) => {
          const result = await tool.execute(id, {
            contextId: latestContextId,
            ...params,
          });
          observe(result.content[0].text);
          return result;
        },
      }),
    getActiveTools: () => activeTools,
    setActiveTools: (value: string[]) => {
      activeTools = value;
    },
    sendMessage: (message: any, options?: unknown) => {
      observe(message.content);
      calls.push({ command: message.content, options });
    },
    sendUserMessage: (message: string, options?: unknown) => {
      observe(message);
      calls.push({ command: message, options });
    },
    appendEntry: (customType: string, data?: unknown) =>
      entries.push({ type: 'custom', customType, data }),
  };
  extension(pi);
  const ctx = {
    isIdle: () => idle,
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (message: string, level: string) =>
        notices.push({ message, level }),
    },
  };
  return {
    commands,
    tools,
    calls,
    notices,
    ctx,
    pi,
    setIdle(value: boolean) {
      idle = value;
    },
    getActiveTools: () => activeTools,
    async command(input: string) {
      await commands.get('storm').handler(input, ctx);
    },
    async emit(event: string, value?: any) {
      let result;
      for (const fn of listeners.get(event) ?? []) result = await fn(value);
      return result;
    },
    async shutdown() {
      for (const fn of listeners.get('session_shutdown') ?? []) await fn();
    },
  };
}

async function fixture(options: Record<string, unknown> = {}) {
  dir = await mkdtemp(join(tmpdir(), 'storm-quiz-integration-'));
  const stateFile = join(dir, 'state.json');
  await writeFile(
    stateFile,
    JSON.stringify({
      revision: 8,
      cursor: 3,
      status: 'waiting',
      events: [],
      requests: [],
      activity: [],
      image: { path: join(dir, 'learner.png'), mimeType: 'image/png' },
      ...options,
    }),
  );
  // Synthetic-only fake CLI: every response is constructed from this test's
  // state file. wait deliberately blocks until the registered extension kills it.
  const executable = join(dir, 'fake-cli.cjs');
  await writeFile(
    executable,
    `
const fs=require('node:fs'); const p=process.env.QUIZ_FIXTURE;
const s=JSON.parse(fs.readFileSync(p,'utf8')); const a=process.argv.slice(2);
const baseline=JSON.parse(JSON.stringify(s));
const op=a[1], id=a[2]; const arg=(n)=>a[a.indexOf(n)+1];
function save(){
  const lock=p+'.lock', deadline=Date.now()+2000; let fd;
  while(fd===undefined){try{fd=fs.openSync(lock,'wx');}catch(e){if(e.code!=='EEXIST'||Date.now()>deadline)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}
  try{
    const current=JSON.parse(fs.readFileSync(p,'utf8'));
    for(const key of Object.keys(s)){
      if(JSON.stringify(s[key])===JSON.stringify(baseline[key]))continue;
      if(Array.isArray(s[key]))current[key]=(current[key]||[]).concat(s[key].slice((baseline[key]||[]).length));
      else if(key==='revision')current[key]=(current[key]||0)+(s[key]-(baseline[key]||0));
      else current[key]=s[key];
    }
    const tmp=p+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(current));fs.renameSync(tmp,p);
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
function ok(value){process.stdout.write(JSON.stringify({ok:true,result:{ok:true,value}}));}
if(a[0]==='study'){if(!s.study){ok({});}else if(op==='capabilities'){ok({schemaVersion:1});}else{let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{const r=JSON.parse(b);s.studyRequests=(s.studyRequests||[]).concat(r);save();ok(r.action==='open'?{studyId:'study-test',root:'/vault',entries:[{path:'Course/Note.md'}]}:{studyId:'study-test',snapshotId:'a'.repeat(64),sources:[],chunks:[{id:'chunk-test',text:'Pinned course definition'}]});});}}
else if(op==='capabilities'){ok(s.quizCapabilities ?? {integrationVersion:2,features:['learning', 'support-update', 'answer-confidence', 'tutor-notes']});}
else if(op==='list'){ok(s.list ?? [{id:'quiz-test',status:s.listStatus ?? s.status}]);}
else if(op==='attach'){ok({agentToken:'synthetic-capability',snapshot:{session:{id,revision:s.revision,eventCursor:s.cursor,status:s.status,scope:s.scope ?? 'synthetic'},events:[]}});}
else if(op==='wait'){if(s.waitError){process.stderr.write(JSON.stringify({error:{code:s.waitError}}));process.exitCode=1;}else if(s.waitSnapshot){process.stdout.write(JSON.stringify({ok:true,snapshot:s.waitSnapshot,after:s.waitSnapshot.session.eventCursor,timedOut:false}));}else {process.stdin.resume();setInterval(()=>{},1000);}}
else if(op==='learner'){s.learnerCalls=(s.learnerCalls||[]).concat({args:a,authenticated:process.env.STORM_QUIZ_TOKEN==='synthetic-capability'});save();ok(s.learner ?? {concepts:[],next:[]});}
else if(op==='status'){process.stdout.write(JSON.stringify({ok:true,operation:'snapshot',snapshot:{session:{id,revision:s.statusRevision ?? s.revision,eventCursor:s.statusCursor ?? s.cursor,status:s.status},events:[]}}));}
else if(op==='request'){let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>{s.requests.push(JSON.parse(b));s.revision++;save();ok({revision:s.revision,currentQuestion:null});});}
else if(op==='activity'){s.activity.push(arg('--state'));save();ok({});}
else if(op==='image'){ok(s.image);}
else if(op==='image-release'){if(s.imageReleaseFails){s.imageReleaseFails--;save();process.stderr.write(JSON.stringify({error:{code:'TEMPORARY'}}));process.exitCode=1;}else{s.released=(s.released||[]).concat(arg('--image-id'));save();ok({});}}
else if(op==='detach'){s.detached=true;save();ok({});}
else {ok({});}
`,
  );
  const bun = process.execPath;
  process.env.STORM_QUIZ_CLI = bun;
  process.env.STORM_QUIZ_CLI_ARGS = JSON.stringify([executable]);
  process.env.QUIZ_FIXTURE = stateFile;
  return { stateFile, cli: bun };
}
async function state(path: string) {
  return JSON.parse(await readFile(path, 'utf8'));
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function writeState(path: string, value: unknown) {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value));
  await rename(temporaryPath, path);
}

beforeEach(async () => {
  oldEnv = Object.fromEntries(
    ['STORM_QUIZ_CLI', 'STORM_QUIZ_CLI_ARGS', 'QUIZ_FIXTURE'].map((key) => [
      key,
      process.env[key],
    ]),
  );
});
afterEach(async () => {
  for (const [key, value] of Object.entries(oldEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

async function attach(pi: Harness) {
  await pi.command('attach quiz-test');
}

test('shared study context bootstraps the attached scope, guards question basis, and restores standalone tools', async () => {
  const { stateFile } = await fixture({
    study: true,
    scope: {
      vaultId: 'vault',
      notePath: 'Course/Note.md',
      folderPath: null,
      selectedNotePaths: [],
    },
  });
  const pi = makePi();
  pi.pi.setActiveTools(['read', 'quiz', 'ask_user_question']);
  try {
    await attach(pi);
    expect(pi.getActiveTools()).toContain('storm_study');
    expect(pi.getActiveTools()).not.toContain('quiz');
    expect(pi.getActiveTools()).not.toContain('ask_user_question');
    expect(pi.calls[0].command).toContain('Course/Note.md');
    expect(pi.calls[0].command).not.toContain('synthetic-capability');
    await pi.tools
      .get('storm_study')
      .execute('study-read', { action: 'retrieve', query: 'definition' });
    const stored = await state(stateFile);
    expect(stored.studyRequests.at(-1).studyId).toBe('study-test');
    expect(JSON.stringify(stored.studyRequests)).not.toContain(
      'synthetic-capability',
    );
    await expect(
      pi.tools.get('storm').execute('missing-basis', {
        action: 'question',
        kind: 'short-answer',
        text: 'Explain this',
      }),
    ).rejects.toThrow('studyBasis');
    await pi.tools.get('storm').execute('with-basis', {
      action: 'question',
      kind: 'short-answer',
      text: 'Explain this',
      studyBasis: 'a'.repeat(64),
      unmodelledReason: 'Source retrieval regression fixture.',
    });
    expect((await state(stateFile)).requests.at(-1).studyBasis).toBe(
      'a'.repeat(64),
    );
    // A question grounded in a PDF read with the tutor's own tools names it.
    await pi.tools.get('storm').execute('with-external-source', {
      action: 'question',
      kind: 'short-answer',
      text: 'Explain the slide',
      externalSource: '/vault/Course/Slides.pdf',
      unmodelledReason: 'External source regression fixture.',
    });
    expect((await state(stateFile)).requests.at(-1).question).toBe(
      'Explain the slide',
    );
    await pi.command('disconnect');
    expect(pi.getActiveTools()).toContain('quiz');
    expect(pi.getActiveTools()).toContain('ask_user_question');
    expect(pi.getActiveTools()).not.toContain('storm_study');
    expect(pi.getActiveTools()).not.toContain('storm');
  } finally {
    await pi.shutdown();
  }
});

describe('registered Storm quiz extension integration (synthetic CLI only)', () => {
  test('registers the production command and private capability tool; attach preserves tools and never exposes capability', async () => {
    await fixture();
    const pi = makePi();
    await attach(pi);
    expect(pi.commands.has('storm')).toBe(true);
    expect(pi.tools.has('storm')).toBe(true);
    expect(pi.getActiveTools()).toEqual(['read', 'custom', 'storm']);
    expect(pi.calls[0].command).not.toContain('synthetic-capability');
    expect(pi.tools.get('storm').description).not.toContain(
      'synthetic-capability',
    );
    expect(pi.notices[0].message).toContain('Attached');
    await pi.shutdown();
  });

  test('status uses top-level snapshot revision without advancing learner cursor', async () => {
    const { stateFile } = await fixture({
      statusRevision: 11,
      statusCursor: 9,
      events: [{ cursor: 7, type: 'answer' }],
    });
    const pi = makePi();
    await attach(pi);
    const result = await pi.tools
      .get('storm')
      .execute('call', { action: 'status' });
    expect(JSON.parse(result.content[0].text).revision).toBe(11);
    expect((await state(stateFile)).requests).toEqual([]);
    await pi.shutdown();
  });

  test('map sends a validated lesson-map request without a context ID', async () => {
    const { stateFile } = await fixture();
    const pi = makePi();
    try {
      await attach(pi);
      const tool = pi.tools.get('storm');
      await expect(
        tool.execute('map-bad', { action: 'map', focus: ['loops'] }),
      ).rejects.toThrow('first map update');
      await tool.execute('map-1', {
        action: 'map',
        nodes: [
          { id: 'loop-condition', label: 'Loop condition' },
          { id: 'loop-body', label: 'Loop body' },
        ],
        edges: [['loop-condition', 'loop-body']],
        statuses: [{ id: 'loop-condition', status: 'guided' }],
        focus: ['loop-body'],
      });
      const [request] = (await state(stateFile)).requests;
      expect(request).toMatchObject({
        type: 'lesson-map',
        expectedRevision: 8,
        map: {
          edges: [['loop-condition', 'loop-body']],
          statuses: { 'loop-condition': 'guided' },
          focus: ['loop-body'],
        },
      });
      expect(request.contextId).toBeUndefined();
    } finally {
      await pi.shutdown();
    }
  });

  test('notes send tutor-notes without a context ID', async () => {
    const { stateFile } = await fixture();
    const pi = makePi();
    try {
      await attach(pi);
      const tool = pi.tools.get('storm');
      await expect(
        tool.execute('notes-bad', { action: 'notes', text: 'x'.repeat(6001) }),
      ).rejects.toThrow('notes text is 6001 characters; the limit is 6000');
      await tool.execute('notes-1', {
        action: 'notes',
        text: 'Plan: loop condition, then loop body.',
      });
      const [request] = (await state(stateFile)).requests;
      expect(request).toMatchObject({
        type: 'tutor-notes',
        expectedRevision: 8,
        text: 'Plan: loop condition, then loop body.',
      });
      expect(request.contextId).toBeUndefined();
    } finally {
      await pi.shutdown();
    }
  });

  test('learner reads use the held token without context or write bookkeeping', async () => {
    const learner = {
      concepts: [{ id: 'loop-condition', zone: 'zpd' }],
      next: [],
      calibration: { rated: 0 },
    };
    const { stateFile } = await fixture({ learner });
    const pi = makePi();
    try {
      await attach(pi);
      const originalContext = pi.calls[0].command.match(
        /"contextId":"([^"]+)"/,
      )![1];
      const tool = pi.tools.get('storm');
      const result = await tool.execute('same-operation', {
        action: 'learner',
        contextId: undefined,
      });
      expect(JSON.parse(result.content[0].text)).toEqual({
        ...learner,
        conceptDefaults: expect.stringContaining('false'),
      });
      expect(result.content[0].text).not.toContain('contextId');
      const stored = await state(stateFile);
      expect(stored.learnerCalls).toEqual([
        { args: ['quiz', 'learner', 'quiz-test'], authenticated: true },
      ]);
      expect(stored.requests).toEqual([]);
      expect(stored.revision).toBe(8);
      // The read neither reserves this operation ID nor invalidates the original context.
      await tool.execute('same-operation', {
        action: 'question',
        contextId: originalContext,
        kind: 'short-answer',
        text: 'Explain the condition.',
        concepts: ['loop-condition'],
        level: 'explain',
        support: 'hinted',
      });
      expect((await state(stateFile)).requests[0]).toMatchObject({
        type: 'pose-question',
        expectedRevision: 8,
        handledThroughCursor: 3,
        concepts: ['loop-condition'],
        level: 'explain',
        support: 'hinted',
      });
    } finally {
      await pi.shutdown();
    }
  });

  test('tool question, feedback, and chat preserve structured payloads and nested response handling', async () => {
    const { stateFile } = await fixture();
    const pi = makePi();
    await attach(pi);
    const tool = pi.tools.get('storm');
    await tool.execute('q', {
      action: 'question',
      text: 'Match',
      unmodelledReason: 'Payload routing regression fixture.',
      kind: 'matching',
      leftItems: [{ id: 'a', text: 'A' }],
      rightItems: [{ id: 'b', text: 'B' }],
    });
    await tool.execute('f', {
      action: 'feedback',
      text: 'Correct',
      verdict: 'correct',
    });
    await tool.execute('p', {
      action: 'prompt',
      text: 'What next?',
      kind: 'next-steps',
      choices: [
        { id: 'review', text: 'Review' },
        { id: 'continue', text: 'Continue' },
      ],
      promptId: 'prompt-1',
    });
    await tool.execute('m', { action: 'message', text: 'Explain' });
    await tool.execute('skip', {
      action: 'skip-question',
      questionId: 'question-1',
      text: 'Cleared without grading.',
    });
    const requests = (await state(stateFile)).requests;
    expect(requests.map((r: any) => r.type)).toEqual([
      'pose-question',
      'feedback',
      'pose-prompt',
      'agent-message',
      'skip-question',
    ]);
    expect(requests[0].leftItems).toEqual([{ id: 'a', text: 'A' }]);
    expect(requests[1].text).toBe('Correct');
    expect(requests[1].verdict).toBe('correct');
    expect(requests[2]).toMatchObject({
      kind: 'next-steps',
      prompt: 'What next?',
      promptId: 'prompt-1',
      choices: [
        { id: 'review', text: 'Review' },
        { id: 'continue', text: 'Continue' },
      ],
    });
    expect(requests[3].text).toBe('Explain');
    expect(requests[4]).toMatchObject({
      questionId: 'question-1',
      text: 'Cleared without grading.',
    });
    expect(requests[4].verdict).toBeUndefined();
    expect(requests.every((r: any) => r.expectedRevision >= 8)).toBe(true);
    await pi.shutdown();
  });

  test('/storm status reports the connection, session ID and name', async () => {
    await fixture({
      list: [{ id: 'quiz-test', status: 'connected', name: 'Logic drills' }],
    });
    const pi = makePi();
    await attach(pi);
    await pi.command('status');
    const notice = pi.notices.at(-1);
    expect(notice.message).toContain(
      'Storm: connected to "Logic drills" (quiz-test).',
    );
    expect(notice.level).toBe('info');
    await pi.shutdown();
  });

  test('/storm resume reattaches the last session after Storm drops it', async () => {
    const { stateFile } = await fixture({
      waitError: 'INVALID_REQUEST',
      listStatus: 'disconnected',
    });
    const pi = makePi();
    await attach(pi);
    await until(() => !pi.getActiveTools().includes('storm'));
    expect(pi.getActiveTools()).not.toContain('storm');
    await pi.command('status');
    expect(pi.notices.at(-1).message).toContain(
      'Storm: not connected. Last session quiz-test is disconnected. Run /storm resume',
    );
    // Storm reopens and the session waits for an agent again.
    const saved = await state(stateFile);
    saved.waitError = undefined;
    saved.status = 'waiting';
    saved.listStatus = 'waiting';
    await writeState(stateFile, saved);
    await pi.command('resume');
    expect(pi.getActiveTools()).toContain('storm');
    expect(pi.notices.at(-1).message).toContain(
      'Attached to Storm quiz quiz-test.',
    );
    await pi.shutdown();
  });

  test('GUI stop reconciliation removes tool once, reports once, and permits fresh attachment', async () => {
    const { stateFile } = await fixture({
      waitError: 'INVALID_REQUEST',
      listStatus: 'disconnected',
    });
    const pi = makePi();
    await attach(pi);
    await until(() => !pi.getActiveTools().includes('storm'));
    expect(pi.getActiveTools()).not.toContain('storm');
    expect(
      pi.notices.filter(
        (n: any) => n.message === 'Storm stopped the quiz; Pi detached.',
      ),
    ).toHaveLength(1);
    const saved = await state(stateFile);
    saved.waitError = undefined;
    saved.status = 'waiting';
    await writeState(stateFile, saved);
    await attach(pi);
    expect(pi.getActiveTools()).toContain('storm');
    await pi.shutdown();
  });

  test('transient wait transport errors do not claim ownership was revoked', async () => {
    const { stateFile } = await fixture({ waitError: 'TEMPORARY' });
    const pi = makePi();
    await attach(pi);
    await flush();
    await flush();
    expect(pi.getActiveTools()).toContain('storm');
    expect(
      pi.notices.some(
        (n: any) => n.message === 'Storm stopped the quiz; Pi detached.',
      ),
    ).toBe(false);
    expect((await state(stateFile)).detached).toBeUndefined();
    await pi.shutdown();
  });

  test('learner image is delivered as a temporary path and released after successful Pi reply', async () => {
    const { stateFile } = await fixture();
    const pi = makePi();
    await attach(pi);
    const s = await state(stateFile);
    s.waitSnapshot = {
      session: {
        id: 'quiz-test',
        revision: 8,
        eventCursor: 4,
        status: 'connected',
      },
      events: [
        {
          cursor: 4,
          type: 'answer',
          data: { answer: 'see image', attachments: [{ id: 'img-1' }] },
        },
      ],
    };
    await writeFile(stateFile, JSON.stringify(s));
    await pi.command('disconnect');
    await attach(pi);
    await flush();
    await until(() =>
      pi.calls.some((call) => call.command.includes('Attached images:')),
    );
    const delivered = pi.calls.find((call) =>
      call.command.includes('Attached images:'),
    );
    expect(delivered?.command).toContain(join(dir, 'learner.png'));
    expect(delivered?.command).not.toMatch(/base64|data:image/);
    expect((await state(stateFile)).released).toBeUndefined();
    await pi.tools.get('storm').execute('reply', {
      action: 'message',
      text: 'I inspected the image.',
    });
    expect((await state(stateFile)).released).toEqual(['img-1']);
    await pi.shutdown();
  });

  test('failed image release retains image for retry on later successful reply', async () => {
    const { stateFile } = await fixture({ imageReleaseFails: 1 });
    const pi = makePi();
    await attach(pi);
    const s = await state(stateFile);
    s.waitSnapshot = {
      session: {
        id: 'quiz-test',
        revision: 8,
        eventCursor: 4,
        status: 'connected',
      },
      events: [
        { cursor: 4, type: 'answer', data: { attachments: ['img-retry'] } },
      ],
    };
    await writeFile(stateFile, JSON.stringify(s));
    await pi.command('disconnect');
    await attach(pi);
    // Wait for the context that owns the image, rather than racing subprocess
    // startup against a fixed delay when the full suite is running.
    await until(() =>
      pi.calls.some((call) => call.command.includes('img-retry')),
    );
    await pi.tools.get('storm').execute('reply', {
      action: 'feedback',
      text: 'I reviewed the image.',
    });
    expect((await state(stateFile)).released).toBeUndefined();
    await pi.tools.get('storm').execute('reply-again', {
      action: 'message',
      text: 'Follow-up.',
    });
    expect((await state(stateFile)).released).toEqual(['img-retry']);
    await pi.shutdown();
  });

  test('busy-turn learner delivery queues follow-up and preserves thinking until its actual turn ends', async () => {
    // Regression contract for the production event handlers: a queued learner turn
    // must survive the preceding agent_end and become idle only after next end.
    const { stateFile } = await fixture();
    const pi = makePi();
    pi.setIdle(false);
    await attach(pi);
    const s = await state(stateFile);
    s.waitSnapshot = {
      session: {
        id: 'quiz-test',
        revision: 8,
        eventCursor: 4,
        status: 'connected',
      },
      events: [
        { cursor: 4, type: 'message', data: { text: 'queued learner turn' } },
      ],
    };
    await writeState(stateFile, s);
    await pi.command('disconnect');
    await attach(pi);
    await until(() =>
      pi.calls.some((call) => call.command.includes('queued learner turn')),
    );
    expect(pi.calls.at(-1)?.options).toEqual({ deliverAs: 'followUp' });
    await pi.emit('agent_start');
    await flush();
    await pi.emit('agent_end');
    await flush();
    expect((await state(stateFile)).activity.at(-1)).toBe('thinking');
    await pi.emit('agent_start');
    await flush();
    await pi.emit('agent_end');
    await flush();
    await until(
      async () => (await state(stateFile)).activity.at(-1) === 'idle',
    );
    expect((await state(stateFile)).activity.at(-1)).toBe('idle');
    await pi.shutdown();
  });
});

test('incompatible app cannot attach or activate the new extension', async () => {
  const { stateFile } = await fixture({
    quizCapabilities: { integrationVersion: 1, features: [] },
  });
  const pi = makePi();
  try {
    await attach(pi);
    expect(pi.calls).toHaveLength(0);
    expect(pi.getActiveTools()).not.toContain('storm');
    expect(pi.notices.some((n) => n.message.includes('incompatible'))).toBe(
      true,
    );
    expect((await state(stateFile)).requests).toEqual([]);
  } finally {
    await pi.shutdown();
  }
});

test('new Tutor questions enforce metadata and support updates forward actual help with its question ID', async () => {
  const { stateFile } = await fixture();
  const pi = makePi();
  try {
    await attach(pi);
    const tool = pi.tools.get('storm');
    await expect(
      tool.execute('missing-learning', {
        action: 'question',
        kind: 'short-answer',
        text: 'Explain.',
      }),
    ).rejects.toThrow('complete concepts');
    await tool.execute('unmodelled', {
      action: 'question',
      kind: 'short-answer',
      text: 'Explain.',
      unmodelledReason: 'An exploratory diagnostic outside this material.',
    });
    expect((await state(stateFile)).requests.at(-1)).toMatchObject({
      type: 'pose-question',
      unmodelledReason: 'An exploratory diagnostic outside this material.',
    });
    await tool.execute('help', {
      action: 'support-update',
      questionId: 'q1',
      support: 'hinted',
      text: 'Check what happens before the first iteration.',
    });
    expect((await state(stateFile)).requests.at(-1)).toMatchObject({
      type: 'support-update',
      questionId: 'q1',
      support: 'hinted',
      text: 'Check what happens before the first iteration.',
    });
  } finally {
    await pi.shutdown();
  }
});
