import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Each caller owns cleanup so fixture lifetime follows its test's async work. */
export function temporaryVaultRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'storm-vault-test-'));
}
