import { isAgentContext } from './agentProtocol';
import { isAgentEditPlan } from './agentEditValidation';
import type {
  AgentBridgeRequest,
  AgentBridgeResult,
  AgentBridgeStatusEvent,
} from './agentBridge';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
const safeNonnegativeInt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const optionalSafeInt = (item: Record<string, unknown>, key: string) =>
  item[key] === undefined || safeNonnegativeInt(item[key]);
const fingerprint = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const patchEdit = (value: unknown): boolean => {
  if (!record(value)) return false;
  return (
    safeNonnegativeInt(value.start) &&
    safeNonnegativeInt(value.end) &&
    value.end >= value.start &&
    safeNonnegativeInt(value.line) &&
    safeNonnegativeInt(value.column) &&
    typeof value.contextBefore === 'string' &&
    typeof value.contextAfter === 'string' &&
    typeof value.find === 'string' &&
    typeof value.replace === 'string' &&
    (value.heading === undefined || typeof value.heading === 'string')
  );
};

export function isAgentRequest(value: unknown): value is AgentBridgeRequest {
  if (!record(value) || !id(value.requestId)) return false;
  const item = value;
  switch (item.type) {
    case 'context':
      return true;
    case 'inspect':
      return id(item.vaultId) && typeof item.path === 'string';
    case 'snapshot':
      return (
        id(item.sessionId) &&
        typeof item.absolutePath === 'string' &&
        id(item.vaultId) &&
        typeof item.vaultRoot === 'string'
      );
    case 'activity':
      return (
        id(item.sessionId) &&
        (item.activity === null ||
          item.activity === 'thinking' ||
          item.activity === 'drafting') &&
        optionalSafeInt(item, 'activitySequence') &&
        optionalSafeInt(item, 'documentVersion')
      );
    case 'append':
      return (
        id(item.sessionId) &&
        typeof item.absolutePath === 'string' &&
        id(item.operationId) &&
        safeNonnegativeInt(item.sequence) &&
        typeof item.text === 'string' &&
        new TextEncoder().encode(item.text).byteLength <= 262144
      );
    case 'edit-preview':
    case 'edit-apply':
      return (
        id(item.sessionId) &&
        safeNonnegativeInt(item.expectedVersion) &&
        isAgentEditPlan(item.plan) &&
        (item.previewReceipt === undefined || id(item.previewReceipt)) &&
        (item.expectedFingerprints === undefined ||
          (record(item.expectedFingerprints) &&
            fingerprint(item.expectedFingerprints.baseFingerprint) &&
            fingerprint(item.expectedFingerprints.resultFingerprint)))
      );
    case 'finish':
    case 'cancel':
      return id(item.sessionId);
    default:
      return false;
  }
}

export function isAgentResult(value: unknown): value is AgentBridgeResult {
  if (!record(value)) return false;
  const item = value;
  if (item.ok === false)
    return (
      typeof item.code === 'string' &&
      item.code.length > 0 &&
      item.code.length <= 128 &&
      typeof item.message === 'string'
    );
  if (item.ok !== true) return false;
  if (item.context !== undefined) return isAgentContext(item.context);
  if (item.inspected === true)
    return (
      (item.open === false &&
        item.content === undefined &&
        item.documentVersion === undefined &&
        item.diskRevision === undefined &&
        item.saveState === undefined) ||
      (item.open === true &&
        typeof item.content === 'string' &&
        safeNonnegativeInt(item.documentVersion) &&
        typeof item.diskRevision === 'string' &&
        ['pending', 'saved', 'failed'].includes(String(item.saveState)))
    );
  if (item.preview === true) {
    if (
      typeof item.content !== 'string' ||
      typeof item.changed !== 'boolean' ||
      !safeNonnegativeInt(item.documentVersion) ||
      typeof item.diskRevision !== 'string'
    )
      return false;
    return (
      (item.edits === undefined ||
        (Array.isArray(item.edits) && item.edits.every(patchEdit))) &&
      (item.baseFingerprint === undefined ||
        fingerprint(item.baseFingerprint)) &&
      (item.resultFingerprint === undefined ||
        fingerprint(item.resultFingerprint)) &&
      (item.saveState === undefined || item.saveState === 'saved')
    );
  }
  if (item.edited === true)
    return (
      typeof item.content === 'string' &&
      safeNonnegativeInt(item.documentVersion) &&
      typeof item.diskRevision === 'string' &&
      item.saveState === 'saved'
    );
  if (
    item.inspected !== undefined ||
    item.preview !== undefined ||
    item.edited !== undefined
  )
    return false;
  return (
    safeNonnegativeInt(item.documentVersion) &&
    typeof item.diskRevision === 'string' &&
    (item.content === undefined || typeof item.content === 'string') &&
    (item.saveState === undefined ||
      item.saveState === 'pending' ||
      item.saveState === 'saved' ||
      item.saveState === 'failed')
  );
}

export function isAgentStatus(value: unknown): value is AgentBridgeStatusEvent {
  if (!record(value) || !record(value.session)) return false;
  const status = value.session;
  return (
    id(status.sessionId) &&
    typeof status.absolutePath === 'string' &&
    [
      'connected',
      'writing',
      'finished',
      'cancelled',
      'disconnected',
      'failed',
    ].includes(String(status.state)) &&
    safeNonnegativeInt(status.documentVersion) &&
    typeof status.diskRevision === 'string' &&
    safeNonnegativeInt(status.pendingOperations) &&
    (status.activity === undefined ||
      status.activity === 'thinking' ||
      status.activity === 'drafting') &&
    (status.name === undefined || typeof status.name === 'string') &&
    (status.outcomeUncertain === undefined ||
      typeof status.outcomeUncertain === 'boolean') &&
    (value.reason === undefined || typeof value.reason === 'string')
  );
}
