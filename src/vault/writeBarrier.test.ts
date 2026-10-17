import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { VaultWriteBarrier } from './writeBarrier';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test('unload waits for authorized writes and rejects writes until reset completes', async () => {
  const barrier = new VaultWriteBarrier();
  const write = deferred<void>();
  const writeStarted = deferred<void>();
  const resetStarted = deferred<void>();
  const writeOperation = barrier.run(async () => {
    writeStarted.resolve();
    await write.promise;
  });
  await writeStarted.promise;
  let resetFinished = false;
  const reset = barrier.close(async () => {
    resetStarted.resolve();
    resetFinished = true;
  });
  assert.throws(() => barrier.run(async () => {}), /unloading/);
  await Promise.resolve();
  assert.equal(resetFinished, false);
  write.resolve();
  await writeOperation;
  await resetStarted.promise;
  await reset;
  assert.equal(resetFinished, true);
  await barrier.run(async () => {});
});

test('failed reset preserves ability to write and retry', async () => {
  const barrier = new VaultWriteBarrier();
  await assert.rejects(
    barrier.close(async () => {
      throw new Error('persist failed');
    }),
    /persist failed/,
  );
  let ran = false;
  await barrier.run(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
