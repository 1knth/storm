import { describe, it as test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PatchPreviewReceipts,
  type IssuePatchPreviewReceiptInput,
} from './patchPreviewReceipts';

const seed: IssuePatchPreviewReceiptInput = {
  sessionId: 'session-a',
  documentIdentity: 'vault/note.md',
  expectedVersion: 'v7',
  plan: 'replace heading\nwith revised heading',
  baseContentFingerprint: 'base-hash',
  resultContentFingerprint: 'result-hash',
};

function issue(cache: PatchPreviewReceipts, input = seed) {
  const result = cache.issue(input);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function request(
  receiptId: string,
  overrides: Partial<IssuePatchPreviewReceiptInput> = {},
) {
  return { ...seed, ...overrides, receiptId };
}

describe('PatchPreviewReceipts', () => {
  test('issues opaque session-bound receipts containing metadata only', () => {
    const cache = new PatchPreviewReceipts({ now: () => 100 });
    const receipt = issue(cache);
    assert.match(receipt.receiptId, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(receipt.planFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      { ...receipt, planFingerprint: 'fingerprint' },
      {
        receiptId: receipt.receiptId,
        sessionId: seed.sessionId,
        documentIdentity: seed.documentIdentity,
        expectedVersion: seed.expectedVersion,
        planFingerprint: 'fingerprint',
        baseContentFingerprint: seed.baseContentFingerprint,
        resultContentFingerprint: seed.resultContentFingerprint,
        expiresAt: 600100,
        state: 'available',
      },
    );
    assert.deepEqual(Object.keys(receipt).sort(), [
      'baseContentFingerprint',
      'documentIdentity',
      'expectedVersion',
      'expiresAt',
      'planFingerprint',
      'receiptId',
      'resultContentFingerprint',
      'sessionId',
      'state',
    ]);
    assert.equal(JSON.stringify(receipt).includes('replace heading'), false);
  });

  test('validates session, document, version, plan, and content fingerprints', () => {
    const cache = new PatchPreviewReceipts();
    const receipt = issue(cache);
    const cases: Array<[Partial<IssuePatchPreviewReceiptInput>, string]> = [
      [{ sessionId: 'other' }, 'session_mismatch'],
      [{ documentIdentity: 'other.md' }, 'document_mismatch'],
      [{ expectedVersion: 'v8' }, 'version_mismatch'],
      [{ plan: 'different plan' }, 'plan_mismatch'],
      [
        { baseContentFingerprint: 'different-base' },
        'base_fingerprint_mismatch',
      ],
      [
        { resultContentFingerprint: 'different-result' },
        'result_fingerprint_mismatch',
      ],
    ];
    for (const [override, error] of cases) {
      assert.deepEqual(cache.validate(request(receipt.receiptId, override)), {
        ok: false,
        error,
      });
    }
    assert.deepEqual(
      cache.validate({
        ...request(receipt.receiptId),
        plan: 'replace heading\r\nwith revised heading',
      }),
      { ok: false, error: 'plan_mismatch' },
    );
    assert.deepEqual(cache.validate(request('unknown-id')), {
      ok: false,
      error: 'unknown',
    });
  });

  test('expires receipts and prunes them without a background timer', () => {
    let now = 10;
    const cache = new PatchPreviewReceipts({ now: () => now, ttlMs: 50 });
    const receipt = issue(cache);
    now = 60;
    assert.deepEqual(cache.validate(request(receipt.receiptId)), {
      ok: false,
      error: 'expired',
    });
    assert.equal(cache.size, 0);
  });

  test('claims atomically once; another or duplicate operation cannot reclaim', () => {
    const cache = new PatchPreviewReceipts();
    const receipt = issue(cache);
    const input = { ...request(receipt.receiptId), opId: 'operation-1' };
    assert.equal(cache.claim(input).ok, true);
    assert.deepEqual(cache.claim(input), {
      ok: false,
      error: 'already_claimed',
    });
    assert.deepEqual(cache.claim({ ...input, opId: 'operation-2' }), {
      ok: false,
      error: 'already_claimed',
    });
    assert.deepEqual(cache.validate(request(receipt.receiptId)), {
      ok: true,
      value: { ...receipt, state: 'claimed', opId: 'operation-1' },
    });
  });

  test('binds exact plan whitespace and uses limit error rather than evicting claimed receipts', () => {
    let now = 0;
    const cache = new PatchPreviewReceipts({ maxReceipts: 2, now: () => now });
    const first = issue(cache);
    assert.equal(
      cache.claim({ ...request(first.receiptId), opId: 'op' }).ok,
      true,
    );
    const second = issue(cache, { ...seed, plan: '  plan  ' });
    assert.deepEqual(
      cache.validate({ ...request(second.receiptId), plan: 'plan' }),
      { ok: false, error: 'plan_mismatch' },
    );
    assert.equal(
      cache.validate({ ...request(second.receiptId), plan: '  plan  ' }).ok,
      true,
    );
    const third = issue(cache, { ...seed, plan: 'another' });
    assert.deepEqual(cache.validate(request(second.receiptId)), {
      ok: false,
      error: 'unknown',
    });
    assert.deepEqual(cache.validate(request(first.receiptId)), {
      ok: true,
      value: { ...first, state: 'claimed', opId: 'op' },
    });
    assert.equal(
      cache.validate(request(third.receiptId, { plan: 'another' })).ok,
      true,
    );
    assert.equal(
      cache.claim({
        ...request(third.receiptId, { plan: 'another' }),
        opId: 'op-3',
      }).ok,
      true,
    );
    assert.deepEqual(cache.issue(seed), { ok: false, error: 'limit' });
  });

  test('revokes by session, clears all receipts, and evicts oldest available at capacity', () => {
    let now = 0;
    const cache = new PatchPreviewReceipts({ maxReceipts: 2, now: () => now });
    const old = issue(cache);
    now = 1;
    const other = issue(cache, { ...seed, sessionId: 'session-b' });
    now = 2;
    const newest = issue(cache);
    assert.deepEqual(cache.validate(request(old.receiptId)), {
      ok: false,
      error: 'unknown',
    });
    assert.equal(cache.revokeSession('session-b'), 1);
    assert.deepEqual(
      cache.validate(request(other.receiptId, { sessionId: 'session-b' })),
      { ok: false, error: 'unknown' },
    );
    assert.equal(cache.validate(request(newest.receiptId)).ok, true);
    cache.clear();
    assert.equal(cache.size, 0);
  });
});
