import { createHash, randomBytes } from 'node:crypto';

export type PatchPreviewReceiptState = 'available' | 'claimed';

export interface PatchPreviewReceiptMetadata {
  receiptId: string;
  sessionId: string;
  documentIdentity: string;
  expectedVersion: string;
  planFingerprint: string;
  baseContentFingerprint: string;
  resultContentFingerprint: string;
  expiresAt: number;
  state: PatchPreviewReceiptState;
  opId?: string;
}

export interface IssuePatchPreviewReceiptInput {
  sessionId: string;
  documentIdentity: string;
  expectedVersion: string;
  plan: string;
  baseContentFingerprint: string;
  resultContentFingerprint: string;
}

export interface ValidatePatchPreviewReceiptInput extends IssuePatchPreviewReceiptInput {
  receiptId: string;
}

export type ReceiptErrorCode =
  | 'unknown'
  | 'expired'
  | 'session_mismatch'
  | 'document_mismatch'
  | 'version_mismatch'
  | 'plan_mismatch'
  | 'base_fingerprint_mismatch'
  | 'result_fingerprint_mismatch'
  | 'already_claimed'
  | 'limit';

export type ReceiptResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ReceiptErrorCode };

export interface PatchPreviewReceiptOptions {
  maxReceipts?: number;
  ttlMs?: number;
  now?: () => number;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function planFingerprint(plan: string): string {
  // Bind the exact serialized plan supplied for preview, including whitespace.
  return fingerprint(plan);
}

/** Bounded, process-local receipts. This service deliberately stores no note text. */
export class PatchPreviewReceipts {
  private readonly receipts = new Map<string, PatchPreviewReceiptMetadata>();
  private readonly maxReceipts: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: PatchPreviewReceiptOptions = {}) {
    this.maxReceipts = options.maxReceipts ?? 128;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxReceipts) || this.maxReceipts < 1) {
      throw new RangeError('maxReceipts must be a positive safe integer');
    }
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError('ttlMs must be positive');
    }
  }

  issue(
    input: IssuePatchPreviewReceiptInput,
  ): ReceiptResult<PatchPreviewReceiptMetadata> {
    const now = this.now();
    this.pruneExpired(now);
    while (this.receipts.size >= this.maxReceipts) {
      const oldestAvailable = [...this.receipts].find(
        ([, receipt]) => receipt.state === 'available',
      );
      if (!oldestAvailable) return { ok: false, error: 'limit' };
      this.receipts.delete(oldestAvailable[0]);
    }

    const receipt: PatchPreviewReceiptMetadata = {
      receiptId: randomBytes(32).toString('base64url'),
      sessionId: input.sessionId,
      documentIdentity: input.documentIdentity,
      expectedVersion: input.expectedVersion,
      planFingerprint: planFingerprint(input.plan),
      baseContentFingerprint: input.baseContentFingerprint,
      resultContentFingerprint: input.resultContentFingerprint,
      expiresAt: now + this.ttlMs,
      state: 'available',
    };
    this.receipts.set(receipt.receiptId, receipt);
    return { ok: true, value: { ...receipt } };
  }

  validate(
    input: ValidatePatchPreviewReceiptInput,
  ): ReceiptResult<PatchPreviewReceiptMetadata> {
    const found = this.findAndValidate(input);
    return found.ok ? { ok: true, value: { ...found.value } } : found;
  }

  /** Synchronous claim: a receipt authorizes at most one operation ID. */
  claim(
    input: ValidatePatchPreviewReceiptInput & { opId: string },
  ): ReceiptResult<PatchPreviewReceiptMetadata> {
    const found = this.findAndValidate(input);
    if (!found.ok) return found;
    const receipt = found.value;
    if (receipt.state === 'claimed')
      return { ok: false, error: 'already_claimed' };
    receipt.state = 'claimed';
    receipt.opId = input.opId;
    return { ok: true, value: { ...receipt } };
  }

  revokeSession(sessionId: string): number {
    let removed = 0;
    for (const [id, receipt] of this.receipts) {
      if (receipt.sessionId === sessionId) {
        this.receipts.delete(id);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.receipts.clear();
  }

  get size(): number {
    this.pruneExpired(this.now());
    return this.receipts.size;
  }

  private findAndValidate(
    input: ValidatePatchPreviewReceiptInput,
  ): ReceiptResult<PatchPreviewReceiptMetadata> {
    const now = this.now();
    const receipt = this.receipts.get(input.receiptId);
    this.pruneExpired(now);
    if (!receipt) return { ok: false, error: 'unknown' };
    if (receipt.expiresAt <= now) return { ok: false, error: 'expired' };
    if (receipt.sessionId !== input.sessionId)
      return { ok: false, error: 'session_mismatch' };
    if (receipt.documentIdentity !== input.documentIdentity)
      return { ok: false, error: 'document_mismatch' };
    if (receipt.expectedVersion !== input.expectedVersion)
      return { ok: false, error: 'version_mismatch' };
    if (receipt.planFingerprint !== planFingerprint(input.plan))
      return { ok: false, error: 'plan_mismatch' };
    if (
      input.baseContentFingerprint &&
      receipt.baseContentFingerprint !== input.baseContentFingerprint
    )
      return { ok: false, error: 'base_fingerprint_mismatch' };
    if (
      input.resultContentFingerprint &&
      receipt.resultContentFingerprint !== input.resultContentFingerprint
    )
      return { ok: false, error: 'result_fingerprint_mismatch' };
    return { ok: true, value: receipt };
  }

  private pruneExpired(now: number): void {
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) this.receipts.delete(id);
    }
  }
}
