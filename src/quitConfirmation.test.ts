import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmQuitAndFlush } from './quitConfirmation';

test('cancellation never starts the shutdown flush', async () => {
  let flushCalls = 0;
  const proceed = await confirmQuitAndFlush(
    async () => false,
    async () => {
      flushCalls += 1;
      return true;
    },
  );
  assert.equal(proceed, false);
  assert.equal(flushCalls, 0);
});

test('approval waits for the flush and returns its result', async () => {
  const calls: string[] = [];
  const proceed = await confirmQuitAndFlush(
    async () => {
      calls.push('confirm');
      return true;
    },
    async () => {
      calls.push('flush-start');
      await Promise.resolve();
      calls.push('flush-complete');
      return true;
    },
  );
  assert.equal(proceed, true);
  assert.deepEqual(calls, ['confirm', 'flush-start', 'flush-complete']);
});

test('a failed flush prevents quit approval', async () => {
  const proceed = await confirmQuitAndFlush(
    async () => true,
    async () => false,
  );
  assert.equal(proceed, false);
});

test('confirmation failures propagate and do not flush', async () => {
  const error = new Error('dialog failed');
  let flushCalls = 0;
  await assert.rejects(
    confirmQuitAndFlush(
      async () => {
        throw error;
      },
      async () => {
        flushCalls += 1;
        return true;
      },
    ),
    error,
  );
  assert.equal(flushCalls, 0);
});

test('flush failures propagate to the caller', async () => {
  const error = new Error('flush failed');
  await assert.rejects(
    confirmQuitAndFlush(
      async () => true,
      async () => {
        throw error;
      },
    ),
    error,
  );
});
