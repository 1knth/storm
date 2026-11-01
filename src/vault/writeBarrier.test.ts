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

test('serializes operations and recovers after an operation rejects', async () => {
  const barrier = new VaultWriteBarrier();
  const first = deferred<void>();
  const started = deferred<void>();
  const order: string[] = [];
  const one = barrier.run(async () => {
    order.push('one-start');
    started.resolve();
    await first.promise;
    order.push('one-end');
    throw new Error('write failed');
  });
  await started.promise;
  const two = barrier.run(async () => {
    order.push('two');
    return 2;
  });
  await Promise.resolve();
  assert.deepEqual(order, ['one-start']);
  first.resolve();
  await assert.rejects(one, /write failed/);
  assert.equal(await two, 2);
  assert.deepEqual(order, ['one-start', 'one-end', 'two']);
});

test('rejects new operations and simultaneous close while closing', async () => {
  const barrier = new VaultWriteBarrier();
  const reset = deferred<void>();
  const started = deferred<void>();
  const closing = barrier.close(async () => {
    started.resolve();
    await reset.promise;
  });
  await started.promise;
  assert.throws(() => barrier.run(async () => {}), /unloading/);
  await assert.rejects(
    barrier.close(async () => {}),
    /already unloading/,
  );
  reset.resolve();
  await closing;
  await barrier.run(async () => {});
});

test('an in-flight write failure prevents reset', async () => {
  const barrier = new VaultWriteBarrier();
  const write = deferred<void>();
  const started = deferred<void>();
  const operation = barrier.run(async () => {
    started.resolve();
    await write.promise;
    throw new Error('write failed');
  });
  await started.promise;
  let resetCalled = false;
  const closing = barrier.close(async () => {
    resetCalled = true;
  });
  write.resolve();
  await assert.rejects(operation, /write failed/);
  await assert.rejects(closing, /write failed/);
  assert.equal(resetCalled, false);
});
