import { runVaultLifecycleExclusive } from './vaultLifecycle';
import { KeyedQueue } from '../shared/asyncQueue';
export class VaultMutationCoordinator {
  private closing = false;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly queues = new KeyedQueue();
  private registryTail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>, scope = 'registry'): Promise<T> {
    if (this.closing)
      throw new Error('Vaults are unloading; try again shortly');
    // Capture dependencies at admission: later registry work must never become
    // a dependency of an earlier vault mutation that it is itself draining.
    const registryFence = this.registryTail;
    const pending =
      scope === 'registry'
        ? Promise.all(
            [...this.pending].map((work) => work.catch(() => undefined)),
          ).then(operation)
        : this.queues.run(scope, () =>
            registryFence.catch(() => undefined).then(operation),
          );
    if (scope === 'registry') this.registryTail = pending;
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => {});
    return pending;
  }

  /** Admission precedes the lifecycle lock; note queues are acquired by vault services inside it. */
  mutate<T>(canonicalRoot: string, operation: () => Promise<T>): Promise<T> {
    return this.run(
      () => runVaultLifecycleExclusive(canonicalRoot, operation),
      canonicalRoot,
    );
  }

  /** Maintenance exclusion precedes admission and lifecycle/note locks. */
  async maintain<T>(
    canonicalRoot: string,
    acquireLease: () => Promise<() => void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await acquireLease();
    try {
      return await this.mutate(canonicalRoot, operation);
    } finally {
      release();
    }
  }

  async close<T>(reset: () => Promise<T>): Promise<T> {
    if (this.closing) throw new Error('Vaults are already unloading');
    this.closing = true;
    try {
      await Promise.all(Array.from(this.pending));
      return await reset();
    } finally {
      this.closing = false;
    }
  }
}
