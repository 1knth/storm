import { test } from 'node:test';
import assert from 'node:assert/strict';

test('real tool schema admits oversized notes for actionable execution validation', () => {
  // Exercise schema validation through a fresh host import.
  const result = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `
import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import extension from './extensions/storm';
const tools = new Map();
extension({
  registerTool(tool) { tools.set(tool.name, tool); },
  registerCommand() {},
  on() {},
});
const schema = tools.get('storm').parameters;
for (const length of [5900, 6086, 9999]) {
  assert.equal(Value.Check(schema, { action: 'notes', text: 'x'.repeat(length) }), true);
}
assert.equal(Value.Check(schema, { action: 'notes', text: 'x'.repeat(10001) }), false);
`,
    ],
    { cwd: new URL('..', import.meta.url).pathname },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString());
});
