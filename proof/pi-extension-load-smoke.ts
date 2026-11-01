// Offline verification against the installed Pi loader and its real Typebox.
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const packageRoot =
  process.env.PI_PACKAGE_ROOT ??
  join(
    homedir(),
    '.bun/install/global/node_modules/@earendil-works/pi-coding-agent',
  );
const require = createRequire(join(packageRoot, 'package.json'));
const { loadExtensions } = await import(
  pathToFileURL(join(packageRoot, 'dist/core/extensions/loader.js')).href
);
const { Check } = await import(
  pathToFileURL(require.resolve('typebox/value')).href
);
const loaded = await loadExtensions(
  [resolve('extensions/storm-quiz.ts')],
  process.cwd(),
);
assert.deepEqual(loaded.errors, []);
const registered = loaded.extensions[0].tools.get('storm_quiz');
const schema = (registered.definition ?? registered).parameters;
const studyTool = loaded.extensions[0].tools.get('storm_study');
assert.ok(studyTool);
const studySchema = (studyTool.definition ?? studyTool).parameters;
assert.equal(
  Check(studySchema, { action: 'retrieve', query: 'relevant definitions' }),
  true,
);
assert.equal(
  Check(studySchema, {
    action: 'read',
    snapshotId: 'pinned-source',
    offset: -1,
  }),
  false,
);
assert.equal(schema.type, 'object');
assert.ok(schema.properties.action);
assert.ok(schema.properties.contextId);
assert.ok(schema.properties.text.description.includes('4000'));
assert.equal(Check(schema, { action: 'status' }), true);
assert.equal(
  Check(schema, { action: 'message', text: 'Missing response context' }),
  false,
);
assert.equal(
  Check(schema, {
    action: 'message',
    text: 'A connected answer.',
    contextId: 'observed-context',
  }),
  true,
);
assert.equal(
  Check(schema, {
    action: 'question',
    kind: 'short-answer',
    text: 'Q'.repeat(4001),
    contextId: 'observed-context',
  }),
  false,
);
assert.equal(
  Check(schema, {
    action: 'prompt',
    kind: 'next-steps',
    text: 'What next?',
    contextId: 'observed-context',
    choices: [{ id: 'next', text: 'Continue', effect: 'continue' }],
  }),
  true,
);
process.stdout.write(
  JSON.stringify(
    {
      loader: packageRoot,
      extensionLoaded: true,
      sharedStudyToolLoaded: true,
      rootObjectProperties: true,
      missingContextRejected: true,
      actionLengthLimits: true,
      continueChoices: true,
      modelCalls: 0,
    },
    null,
    2,
  ) + '\n',
);
