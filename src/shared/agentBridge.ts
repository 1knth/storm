import type { AgentActivity, AgentSessionStatus } from './agentProtocol';
import type { AgentEditPlan } from '../documents/agentDocumentController';
import type { SaveNoteRequest, SaveNoteResult } from './types';

export type AgentBridgeRequest =
  | {
      type: 'inspect';
      requestId: string;
      vaultId: string;
      path: string;
    }
  | {
      type: 'snapshot';
      requestId: string;
      sessionId: string;
      absolutePath: string;
      vaultId: string;
      vaultRoot: string;
    }
  | {
      type: 'activity';
      requestId: string;
      sessionId: string;
      activity: AgentActivity | null;
    }
  | {
      type: 'append';
      requestId: string;
      sessionId: string;
      absolutePath: string;
      operationId: string;
      sequence: number;
      text: string;
    }
  | {
      type: 'edit-preview' | 'edit-apply';
      requestId: string;
      sessionId: string;
      expectedVersion: number;
      plan: AgentEditPlan;
    }
  | { type: 'finish' | 'cancel'; requestId: string; sessionId: string };

export type AgentBridgeResult =
  | {
      ok: true;
      inspected: true;
      open: false;
    }
  | {
      ok: true;
      inspected: true;
      open: true;
      content: string;
      documentVersion: number;
      diskRevision: string;
      saveState: 'pending' | 'saved' | 'failed';
    }
  | {
      ok: true;
      content?: string;
      documentVersion: number;
      diskRevision: string;
      saveState?: 'pending' | 'saved' | 'failed';
    }
  | {
      ok: true;
      preview: true;
      content: string;
      changed: boolean;
      documentVersion: number;
      diskRevision: string;
    }
  | {
      ok: true;
      edited: true;
      content: string;
      documentVersion: number;
      diskRevision: string;
      saveState: 'saved';
    }
  | { ok: false; code: string; message: string };

export type AgentBridgeStatusEvent = {
  session: AgentSessionStatus;
  reason?: string;
};

export interface StormAgentBridge {
  onRequest(callback: (request: AgentBridgeRequest) => void): () => void;
  respond(requestId: string, result: AgentBridgeResult): void;
  onStatus(callback: (event: AgentBridgeStatusEvent) => void): () => void;
  cancel(sessionId: string, reason?: string): void;
  saveNote(request: SaveNoteRequest): Promise<SaveNoteResult>;
}

declare global {
  interface Window {
    stormAgent: StormAgentBridge;
  }
}
