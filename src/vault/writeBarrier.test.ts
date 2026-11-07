import { runVaultLifecycleExclusive } from './vaultLifecycle';
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

test('independent vault scopes progress concurrently and unload drains both', async () => {
  const barrier = new VaultWriteBarrier();
  const release = deferred<void>();
  const started = deferred<void>();
  const first = barrier.mutate('/vault/one', async () => {
    started.resolve();
    await release.promise;
  });
  await started.promise;
  let secondRan = false;
  await barrier.mutate('/vault/two', async () => {
    secondRan = true;
  });
  assert.equal(secondRan, true);
  let reset = false;
  const closing = barrier.close(async () => {
    reset = true;
  });
  await Promise.resolve();
  assert.equal(reset, false);
  assert.throws(() => barrier.run(async () => {}, '/vault/three'), /unloading/);
  release.resolve();
  await Promise.all([first, closing]);
  assert.equal(reset, true);
});

test('unload drains admitted work waiting on a lifecycle lock before reset', async () => {
  const barrier = new VaultWriteBarrier();
  const entered = deferred<void>();
  const release = deferred<void>();
  const holder = runVaultLifecycleExclusive('/queued-vault', async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const order: string[] = [];
  const mutation = barrier.mutate('/queued-vault', async () => {
    order.push('mutation');
  });
  const closing = barrier.close(() =>
    runVaultLifecycleExclusive('/queued-vault', async () => {
      order.push('reset');
    }),
  );
  release.resolve();
  await Promise.all([holder, mutation, closing]);
  assert.deepEqual(order, ['mutation', 'reset']);
});

test('maintenance lease releases when unload rejects mutation admission', async () => {
  const barrier = new VaultWriteBarrier();
  const releaseReset = deferred<void>();
  const closing = barrier.close(() => releaseReset.promise);
  let released = false;
  await assert.rejects(
    barrier.maintain(
      '/vault',
      async () => () => {
        released = true;
      },
      async () => {},
    ),
    /unloading/,
  );
  assert.equal(released, true);
  releaseReset.resolve();
  await closing;
});

test('registry mutations fence earlier and later vault mutations without serializing independent roots', async () => {
  const barrier = new VaultWriteBarrier();
  const release = deferred<void>();
  const entered = deferred<void>();
  const order: string[] = [];
  const one = barrier.mutate('/registry-one', async () => {
    entered.resolve();
    await release.promise;
    order.push('one');
  });
  await entered.promise;
  const registry = barrier.run(async () => {
    order.push('registry');
  });
  const two = barrier.mutate('/registry-two', async () => {
    order.push('two');
  });
  await Promise.resolve();
  assert.deepEqual(order, []);
  release.resolve();
  await Promise.all([one, registry, two]);
  assert.deepEqual(order, ['one', 'registry', 'two']);
});
