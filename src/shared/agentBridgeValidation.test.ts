import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAgentRequest,
  isAgentResult,
  isAgentStatus,
} from './agentBridgeValidation';

describe('agent bridge validators', () => {
  test('accepts supported request shapes including required snapshot identity', () => {
    assert.equal(isAgentRequest({ type: 'context', requestId: 'r1' }), true);
    assert.equal(
      isAgentRequest({
        type: 'snapshot',
        requestId: 'r2',
        sessionId: 's1',
        absolutePath: '/a',
        vaultId: 'v1',
        vaultRoot: '/v',
      }),
      true,
    );
    assert.equal(
      isAgentRequest({
        type: 'append',
        requestId: 'r3',
        sessionId: 's1',
        absolutePath: '/a',
        operationId: 'o1',
        sequence: 0,
        text: 'x',
      }),
      true,
    );
    assert.equal(
      isAgentRequest({
        type: 'activity',
        requestId: 'r4',
        sessionId: 's1',
        activity: null,
        activitySequence: 1,
        documentVersion: 0,
      }),
      true,
    );
  });

  test('rejects malformed request IDs, sequence values, and optional edit metadata', () => {
    assert.equal(isAgentRequest({ type: 'context', requestId: '' }), false);
    assert.equal(
      isAgentRequest({
        type: 'snapshot',
        requestId: 'r',
        absolutePath: '/a',
        vaultId: 'v',
        vaultRoot: '/v',
      }),
      false,
    );
    assert.equal(
      isAgentRequest({
        type: 'append',
        requestId: 'r',
        sessionId: 's',
        absolutePath: '/a',
        operationId: 'o',
        sequence: -1,
        text: 'x',
      }),
      false,
    );
    assert.equal(
      isAgentRequest({
        type: 'activity',
        requestId: 'r',
        sessionId: 's',
        activity: null,
        activitySequence: -1,
      }),
      false,
    );
    assert.equal(
      isAgentRequest({
        type: 'edit-preview',
        requestId: 'r',
        sessionId: 's',
        expectedVersion: 0,
        plan: { type: 'replace', content: 'x' },
        expectedFingerprints: { baseFingerprint: '', resultFingerprint: 'ok' },
      }),
      false,
    );
  });

  test('accepts valid result variants and legacy preview metadata omissions', () => {
    assert.equal(
      isAgentResult({ ok: true, inspected: true, open: false }),
      true,
    );
    assert.equal(
      isAgentResult({
        ok: true,
        preview: true,
        content: 'x',
        changed: true,
        documentVersion: 0,
        diskRevision: 'd',
      }),
      true,
    );
    assert.equal(
      isAgentResult({
        ok: true,
        preview: true,
        content: 'x',
        changed: true,
        documentVersion: 0,
        diskRevision: 'd',
        baseFingerprint: 'a',
        resultFingerprint: 'b',
        edits: [
          {
            start: 0,
            end: 1,
            line: 1,
            column: 1,
            contextBefore: '',
            contextAfter: '',
            find: 'x',
            replace: 'y',
          },
        ],
      }),
      true,
    );
    assert.equal(
      isAgentResult({
        ok: true,
        edited: true,
        content: 'x',
        documentVersion: 1,
        diskRevision: 'd',
        saveState: 'saved',
      }),
      true,
    );
  });

  test('rejects malformed discriminated results and optional preview metadata', () => {
    assert.equal(
      isAgentResult({ ok: true, inspected: true, open: true }),
      false,
    );
    assert.equal(
      isAgentResult({
        ok: true,
        inspected: true,
        open: false,
        documentVersion: -1,
        diskRevision: 'd',
      }),
      false,
    );
    assert.equal(
      isAgentResult({
        ok: true,
        preview: true,
        content: 'x',
        changed: true,
        documentVersion: 0,
        diskRevision: 'd',
        baseFingerprint: 4,
      }),
      false,
    );
    assert.equal(
      isAgentResult({
        ok: true,
        preview: true,
        content: 'x',
        changed: true,
        documentVersion: 0,
        diskRevision: 'd',
        edits: [{}],
      }),
      false,
    );
    assert.equal(
      isAgentResult({
        ok: true,
        edited: true,
        content: 'x',
        documentVersion: 0,
        diskRevision: 'd',
        saveState: 'pending',
      }),
      false,
    );
  });

  test('validates status integers and session IDs', () => {
    const session = {
      sessionId: 's',
      absolutePath: '/a',
      state: 'connected',
      documentVersion: 0,
      diskRevision: 'd',
      pendingOperations: 0,
    };
    assert.equal(isAgentStatus({ session }), true);
    assert.equal(
      isAgentStatus({ session: { ...session, pendingOperations: -1 } }),
      false,
    );
    assert.equal(
      isAgentStatus({ session: { ...session, sessionId: '' } }),
      false,
    );
  });
});
