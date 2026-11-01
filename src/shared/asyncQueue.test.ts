import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyedQueue } from './asyncQueue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test('keeps same-key order, lets other keys proceed, and recovers from rejection', async () => {
  const queue = new KeyedQueue();
  const gate = deferred<void>();
  const firstStarted = deferred<void>();
  const order: string[] = [];
  const first = queue.run('same', async () => {
    order.push('first-start');
    firstStarted.resolve();
    await gate.promise;
    order.push('first-end');
    throw new Error('first failed');
  });
  await firstStarted.promise;
  const second = queue.run('same', async () => {
    order.push('second');
    return 'recovered';
  });
  const independent = queue.run('other', async () => {
    order.push('independent');
  });
  await independent;
  assert.deepEqual(order, ['first-start', 'independent']);
  gate.resolve();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, 'recovered');
  assert.deepEqual(order, [
    'first-start',
    'independent',
    'first-end',
    'second',
  ]);
});
