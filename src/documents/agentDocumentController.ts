import { EditorState, Transaction } from '@codemirror/state';
import type { SaveNoteRequest, SaveNoteResult } from '../shared/types';
import type { AgentActivity } from '../shared/agentProtocol';

export type AgentDocumentStatus =
  | 'connected'
  | 'writing'
  | 'finished'
  | 'stopped'
  | 'disconnected';
export type SaveNote = (request: SaveNoteRequest) => Promise<SaveNoteResult>;
export type AgentEditPlan =
  | { type: 'replace'; content: string }
  | {
      type: 'replaceText';
      replacements: Array<{ find: string; replace: string }>;
    };
export type AgentEditPreview = { content: string; changed: boolean };
/** UTF-16 source ranges accepted as new agent text; corrections are intentionally absent. */
export type AgentRevealMetadata = {
  generation: number;
  documentVersion: number;
  ranges: Array<{ from: number; to: number }>;
};
export type AgentDocument = {
  key: string;
  vaultId?: string;
  absolutePath: string;
  vaultPath: string;
  path: string;
  revision: string;
  state: EditorState;
  status: AgentDocumentStatus;
  activity?: AgentActivity;
  appendCount: number;
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
  persistedContent?: string;
  reveal: AgentRevealMetadata;
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
    if (existing && !existing.closed) {
      // Reconcile a clean, idle cached snapshot with the authoritative open.
      // Never replace local edits, an in-progress save, or an active writer.
      const incomingContent = state.doc.toString();
      const cachedContent = existing.state.doc.toString();
      const hasLocalChanges =
        existing.dirty ||
        existing.inFlight ||
        existing.saveError !== undefined ||
        (existing.persistedContent !== undefined &&
          cachedContent !== existing.persistedContent);
      const hasActiveWriter =
        existing.status === 'writing' || existing.appendCount > 0;
      if (!hasLocalChanges && !hasActiveWriter) {
        existing.state = state;
        existing.revision = revision;
        existing.persistedContent = incomingContent;
        this.notify(existing);
      }
      return existing;
    }
    const document: AgentDocument = {
      key,
      absolutePath: path,
      vaultPath,
      path,
      revision,
      state,
      status: 'connected',
      appendCount: 0,
      acceptedVersion: 0,
      pending: Promise.resolve(),
      savePending: Promise.resolve(),
      closed: false,
      closing: false,
      dirty: false,
      inFlight: false,
      generation: 0,
      conflict: false,
      persistedContent: state.doc.toString(),
      reveal: { generation: 0, documentVersion: 0, ranges: [] },
    };
    this.documents.set(key, document);
    this.notify(document);
    return document;
  }

  updateFromEditor(documentId: string, state: EditorState): void {
    const document = this.documents.get(documentId);
    if (!document || document.closed) return;
    document.state = state;
    document.acceptedVersion++;
    document.reveal = {
      ...document.reveal,
      documentVersion: document.acceptedVersion,
      ranges: [],
    };
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
          document.persistedContent = request.content;
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

  previewEdit(
    document: AgentDocument,
    expectedVersion: number,
    plan: AgentEditPlan,
  ): AgentEditPreview {
    if (document.acceptedVersion !== expectedVersion)
      throw new Error('Stale document version');
    const original = document.state.doc.toString();
    if (plan.type === 'replace')
      return { content: plan.content, changed: plan.content !== original };
    const matches = plan.replacements.map(({ find }) => {
      if (!find) throw new Error('Find text must not be empty');
      const first = original.indexOf(find);
      if (first < 0) throw new Error('Find text not found');
      if (original.indexOf(find, first + 1) >= 0)
        throw new Error('Find text is ambiguous');
      return { from: first, to: first + find.length };
    });
    const ordered = [...matches].sort((a, b) => a.from - b.from);
    for (let index = 1; index < ordered.length; index++)
      if (ordered[index].from < ordered[index - 1].to)
        throw new Error('Replacement targets overlap');
    let content = original;
    for (let index = plan.replacements.length - 1; index >= 0; index--) {
      const range = matches[index];
      content =
        content.slice(0, range.from) +
        plan.replacements[index].replace +
        content.slice(range.to);
    }
    return { content, changed: content !== original };
  }

  async applyEdit(
    document: AgentDocument,
    expectedVersion: number,
    plan: AgentEditPlan,
  ): Promise<{ version: number; content: string }> {
    const preview = this.previewEdit(document, expectedVersion, plan);
    if (
      document.closed ||
      document.closing ||
      document.status === 'stopped' ||
      document.status === 'disconnected'
    )
      throw new Error('Agent session is closed');
    if (preview.changed) {
      const before = document.state.doc.toString();
      const insertions = classifyEditInsertions(before, preview.content);
      const revealRanges =
        plan.type === 'replace' &&
        isSubstantialRewrite(before, preview.content, insertions)
          ? [{ from: 0, to: preview.content.length }]
          : insertions;
      document.state = document.state.update({
        changes: {
          from: 0,
          to: document.state.doc.length,
          insert: preview.content,
        },
        annotations: Transaction.remote.of(true),
      }).state;
      document.acceptedVersion++;
      document.generation++;
      document.reveal = {
        generation: document.reveal.generation + 1,
        documentVersion: document.acceptedVersion,
        ranges: revealRanges,
      };
      document.dirty = true;
      this.notify(document);
      this.scheduleSave(document);
    }
    const acceptedVersion = document.acceptedVersion;
    const acceptedGeneration = document.generation;
    await document.pending;
    const saved = await this.flush(document);
    if (!saved) throw new Error('Could not save document edit');
    if (
      document.generation !== acceptedGeneration ||
      document.persistedContent !== preview.content
    )
      throw new Error(
        'Document changed while saving edit; requested content was not acknowledged',
      );
    return { version: acceptedVersion, content: preview.content };
  }

  setActivity(document: AgentDocument, activity: AgentActivity | null): void {
    if (
      document.closed ||
      document.closing ||
      document.status === 'finished' ||
      document.status === 'stopped' ||
      document.status === 'disconnected'
    )
      throw new Error('Agent session is closed');
    document.activity = activity ?? undefined;
  }

  append(document: AgentDocument, text: string): Promise<{ version: number }> {
    if (
      document.closed ||
      document.closing ||
      document.status === 'stopped' ||
      document.status === 'disconnected'
    )
      return Promise.reject(new Error('Agent session is closed'));
    document.activity = undefined;
    document.appendCount++;
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
        document.appendCount--;
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
      const from = document.state.doc.length - text.length;
      document.reveal = {
        generation: document.reveal.generation || 1,
        documentVersion: document.acceptedVersion,
        ranges: text.length
          ? [...document.reveal.ranges, { from, to: from + text.length }]
          : document.reveal.ranges,
      };
      document.dirty = true;
      document.appendCount--;
      document.status = document.appendCount > 0 ? 'writing' : 'connected';
      this.notify(document);
      resolveResult({ version: document.acceptedVersion });
      this.scheduleSave(document);
    });
    return result;
  }

  finish(document: AgentDocument): void {
    if (
      !document.closed &&
      (document.status === 'connected' || document.status === 'writing')
    ) {
      document.activity = undefined;
      document.status = 'finished';
      this.notify(document);
    }
  }
  stop(document: AgentDocument): void {
    if (!document.closed) {
      document.activity = undefined;
      document.status = 'stopped';
      this.notify(document);
    }
  }
  disconnect(document: AgentDocument): void {
    if (!document.closed) {
      document.activity = undefined;
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
    document.activity = undefined;
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

  resetFinished(key: string): boolean {
    const document = this.documents.get(key);
    if (!document || document.closed) {
      this.documents.delete(key);
      return true;
    }
    if (document.status !== 'finished' || document.dirty || document.inFlight)
      return false;
    document.closed = true;
    this.documents.delete(key);
    return true;
  }

  get(key: string): AgentDocument | undefined {
    return this.documents.get(key);
  }
  getDocument(key: string): AgentDocument | undefined {
    return this.get(key);
  }
}

/** Legacy focused helper: returns a range only for a single exact insertion. */
export function classifySingleInsertion(
  before: string,
  after: string,
): { from: number; to: number } | null {
  if (before === after) return null;
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  return before.length === prefix + suffix
    ? { from: prefix, to: after.length - suffix }
    : null;
}

/** A guarded whole-note replacement can present a genuinely new draft coherently. */
function isSubstantialRewrite(
  before: string,
  after: string,
  _insertions: Array<{ from: number; to: number }>,
): boolean {
  if (!before || !after) return false;
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  const unchanged = prefix + suffix;
  return unchanged < before.length / 2 && unchanged < after.length / 2;
}

/** Maximum DP cells used by the token diff; larger edits safely reveal nothing. */
const MAX_DIFF_CELLS = 250_000;

/** Classifies pure inserted token runs; replacement hunks (delete + insert) stay immediate. */
export function classifyEditInsertions(
  before: string,
  after: string,
): Array<{ from: number; to: number }> {
  if (before === after) return [];
  const prefix = commonPrefixLength(before, after);
  if (prefix === before.length) return [{ from: prefix, to: after.length }];
  if (prefix === after.length) return [];
  const suffix = commonSuffixLength(before, after, prefix);
  if (suffix === before.length - prefix) {
    return [{ from: prefix, to: after.length - suffix }];
  }
  if (suffix === after.length - prefix) return [];

  const oldTokens = tokenize(before);
  const newTokens = tokenize(after);
  // Large pure insertions are common in streamed notes. A linear exact
  // subsequence check handles them without allocating the bounded LCS table.
  const insertionOnly = classifySubsequenceInsertions(
    after,
    oldTokens,
    newTokens,
  );
  if (insertionOnly !== null) return insertionOnly;

  const columns = newTokens.length + 1;
  const cells = (oldTokens.length + 1) * columns;
  if (!Number.isSafeInteger(cells) || cells > MAX_DIFF_CELLS) return [];

  // A bounded LCS table makes work and memory predictable; tied alignments are
  // resolved conservatively below so repeated unchanged text is never replayed.
  const lcs = new Uint32Array(cells);
  for (let i = oldTokens.length - 1; i >= 0; i--) {
    for (let j = newTokens.length - 1; j >= 0; j--) {
      const index = i * columns + j;
      lcs[index] =
        oldTokens[i].text === newTokens[j].text
          ? lcs[(i + 1) * columns + j + 1] + 1
          : Math.max(lcs[(i + 1) * columns + j], lcs[index + 1]);
    }
  }
  const ranges: Array<{ from: number; to: number }> = [];
  let i = 0;
  let j = 0;
  let insertionStart: number | null = null;
  let deletedInHunk = false;
  while (i < oldTokens.length || j < newTokens.length) {
    if (
      i < oldTokens.length &&
      j < newTokens.length &&
      oldTokens[i].text === newTokens[j].text
    ) {
      if (insertionStart !== null) {
        if (
          !deletedInHunk &&
          isTokenBoundary(after, insertionStart) &&
          isTokenBoundary(after, newTokens[j].from)
        )
          ranges.push({ from: insertionStart, to: newTokens[j].from });
        insertionStart = null;
      }
      deletedInHunk = false;
      i++;
      j++;
    } else if (
      j < newTokens.length &&
      (i === oldTokens.length ||
        lcs[i * columns + j + 1] > lcs[(i + 1) * columns + j])
    ) {
      if (insertionStart === null) insertionStart = newTokens[j].from;
      j++;
    } else {
      // Prefer consuming old text on ties: this keeps ambiguous repeated content
      // from being mislabeled as new, while independent later additions survive.
      deletedInHunk = true;
      i++;
    }
  }
  if (
    insertionStart !== null &&
    !deletedInHunk &&
    isTokenBoundary(after, insertionStart)
  )
    ranges.push({ from: insertionStart, to: after.length });
  return ranges.filter(({ from, to }) => to > from);
}

function classifySubsequenceInsertions(
  after: string,
  oldTokens: TextToken[],
  newTokens: TextToken[],
): Array<{ from: number; to: number }> | null {
  const matched: number[] = [];
  let next = 0;
  for (const oldToken of oldTokens) {
    while (next < newTokens.length && newTokens[next].text !== oldToken.text)
      next++;
    if (next === newTokens.length) return null;
    matched.push(next++);
  }

  const ranges: Array<{ from: number; to: number }> = [];
  let previousNew = -1;
  for (const index of matched) {
    if (index > previousNew + 1) {
      const from = previousNew < 0 ? 0 : newTokens[previousNew + 1].from;
      const to = newTokens[index].from;
      if (!isTokenBoundary(after, from) || !isTokenBoundary(after, to))
        return null;
      ranges.push({ from, to });
    }
    previousNew = index;
  }
  if (previousNew + 1 < newTokens.length) {
    const from = newTokens[previousNew + 1].from;
    if (!isTokenBoundary(after, from)) return null;
    ranges.push({ from, to: after.length });
  }
  return ranges;
}

type TextToken = { text: string; from: number };
function tokenize(text: string): TextToken[] {
  const tokens: TextToken[] = [];
  const pattern = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
  for (const match of text.matchAll(pattern))
    tokens.push({ text: match[0], from: match.index });
  return tokens;
}

function isTokenBoundary(text: string, offset: number): boolean {
  const word = /[\p{L}\p{N}_]/u;
  return !(
    offset > 0 &&
    offset < text.length &&
    word.test(text[offset - 1]) &&
    word.test(text[offset])
  );
}

function commonPrefixLength(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index++;
  return index;
}
function commonSuffixLength(a: string, b: string, prefix: number): number {
  let length = 0;
  while (
    length < a.length - prefix &&
    length < b.length - prefix &&
    a[a.length - length - 1] === b[b.length - length - 1]
  )
    length++;
  return length;
}
