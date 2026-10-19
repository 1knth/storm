import type { AgentSessionStatus } from './agentProtocol';
import type { SaveNoteRequest, SaveNoteResult } from './types';

export type AgentBridgeRequest =
  | {
      type: 'snapshot';
      requestId: string;
      sessionId: string;
      absolutePath: string;
      vaultId: string;
      vaultRoot: string;
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
  | { type: 'finish' | 'cancel'; requestId: string; sessionId: string };

export type AgentBridgeResult =
  | {
      ok: true;
      content?: string;
      documentVersion: number;
      diskRevision: string;
      saveState?: 'pending' | 'saved' | 'failed';
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
