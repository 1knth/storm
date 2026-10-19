import { EditorState, Transaction } from '@codemirror/state';
import type { SaveNoteRequest, SaveNoteResult } from '../shared/types';

export type AgentDocumentStatus =
  | 'connected'
  | 'writing'
  | 'finished'
  | 'stopped'
  | 'disconnected';
export type SaveNote = (request: SaveNoteRequest) => Promise<SaveNoteResult>;
export type AgentDocument = {
  key: string;
  vaultId?: string;
  absolutePath: string;
  vaultPath: string;
  path: string;
  revision: string;
  state: EditorState;
  status: AgentDocumentStatus;
  acceptedVersion: number;
  pending: Promise<void>;
  savePending: Promise<void>;
  closed: boolean;
  closing: boolean;
  dirty: boolean;
  inFlight: boolean;
  generation: number;
  conflict: boolean;
  saveError?: unknown;
};

/** Renderer-side per-document owner. Persistence is injected; no view or global selection is owned here. */
export class AgentDocumentController {
  private readonly documents = new Map<string, AgentDocument>();
  private readonly listeners = new Set<(document: AgentDocument) => void>();

  constructor(private readonly saveNote?: SaveNote) {}

  subscribe(listener: (document: AgentDocument) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(document: AgentDocument): void {
    for (const listener of this.listeners) listener(document);
  }

  attach(key: string, absolutePath: string, state: EditorState): AgentDocument;
  attach(
    key: string,
    vaultPath: string,
    path: string,
    state: EditorState,
    revision: string,
  ): AgentDocument;
  attach(
    key: string,
    rootOrPath: string,
    pathOrState: string | EditorState,
    stateArg?: EditorState,
    revision = '',
  ): AgentDocument {
    const vaultPath = typeof pathOrState === 'string' ? rootOrPath : '';
    const path = typeof pathOrState === 'string' ? pathOrState : rootOrPath;
    const state = typeof pathOrState === 'string' ? stateArg! : pathOrState;
    const existing = this.documents.get(key);
    if (existing && !existing.closed) return existing;
    const document: AgentDocument = {
      key,
      absolutePath: path,
      vaultPath,
      path,
      revision,
      state,
      status: 'connected',
      acceptedVersion: 0,
      pending: Promise.resolve(),
      savePending: Promise.resolve(),
      closed: false,
      closing: false,
      dirty: false,
      inFlight: false,
      generation: 0,
      conflict: false,
    };
    this.documents.set(key, document);
    this.notify(document);
    return document;
  }

  updateFromEditor(documentId: string, state: EditorState): void {
    const document = this.documents.get(documentId);
    if (!document || document.closed) return;
    document.state = state;
    document.generation++;
    document.dirty = true;
    this.notify(document);
    this.scheduleSave(document);
  }

  private scheduleSave(document: AgentDocument): void {
    if (
      !this.saveNote ||
      document.inFlight ||
      !document.dirty ||
      document.conflict ||
      (document.closed && !document.closing)
    )
      return;
    document.inFlight = true;
    const save = this.saveNote;
    document.savePending = document.savePending.then(async () => {
      while (
        document.dirty &&
        !document.conflict &&
        (!document.closed || document.closing)
      ) {
        const generation = document.generation;
        const request: SaveNoteRequest = {
          vaultPath: document.vaultPath,
          path: document.path,
          content: document.state.doc.toString(),
          revision: document.revision,
        };
        try {
          const result = await save(request);
          document.revision = result.revision;
          document.dirty = document.generation !== generation;
        } catch (error) {
          document.conflict = true;
          document.saveError = error;
          document.dirty = true;
        }
        document.inFlight = false;
        this.notify(document);
      }
    });
  }

  publishHumanTransaction(
    document: AgentDocument,
    transaction: Transaction,
  ): void {
    if (!document.closed)
      this.updateFromEditor(
        document.key,
        document.state.update(transaction).state,
      );
  }

  append(document: AgentDocument, text: string): Promise<{ version: number }> {
    if (
      document.closed ||
      document.closing ||
      document.status === 'stopped' ||
      document.status === 'disconnected'
    )
      return Promise.reject(new Error('Agent session is closed'));
    document.status = 'writing';
    this.notify(document);
    let resolveResult!: (value: { version: number }) => void;
    let rejectResult!: (reason: Error) => void;
    const result = new Promise<{ version: number }>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    document.pending = document.pending.then(() => {
      if (
        document.closed ||
        document.status === 'stopped' ||
        document.status === 'disconnected'
      ) {
        rejectResult(
          new Error('Agent session closed before operation acceptance'),
        );
        return;
      }
      document.state = document.state.update({
        changes: { from: document.state.doc.length, insert: text },
        annotations: Transaction.remote.of(true),
      }).state;
      document.acceptedVersion++;
      document.generation++;
      document.dirty = true;
      this.notify(document);
      resolveResult({ version: document.acceptedVersion });
      this.scheduleSave(document);
    });
    return result;
  }

  finish(document: AgentDocument): void {
    if (!document.closed && document.status === 'writing') {
      document.status = 'finished';
      this.notify(document);
    }
  }
  stop(document: AgentDocument): void {
    if (!document.closed) {
      document.status = 'stopped';
      this.notify(document);
    }
  }
  disconnect(document: AgentDocument): void {
    if (!document.closed) {
      document.status = 'disconnected';
      this.notify(document);
    }
  }

  async flush(document: AgentDocument): Promise<boolean> {
    if (!this.saveNote) return !document.dirty;
    await document.pending;
    await document.savePending;
    if (document.saveError) throw document.saveError;
    if (document.dirty && !document.conflict) {
      this.scheduleSave(document);
      await document.savePending;
    }
    return !document.dirty;
  }

  async close(
    document: AgentDocument,
    flush: () => Promise<boolean>,
  ): Promise<boolean> {
    if (document.closed) return !document.dirty;
    document.closing = true;
    document.status = 'disconnected';
    this.notify(document);
    await document.pending.catch(() => undefined);
    try {
      const flushed = await flush();
      document.closing = false;
      if (flushed) document.closed = true;
      this.notify(document);
      return flushed;
    } catch (error) {
      document.closing = false;
      this.notify(document);
      throw error;
    }
  }

  get(key: string): AgentDocument | undefined {
    return this.documents.get(key);
  }
  getDocument(key: string): AgentDocument | undefined {
    return this.get(key);
  }
}
