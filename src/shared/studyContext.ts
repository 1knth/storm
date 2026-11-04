import type { QuizScope } from './quizProtocol';

export const STUDY_SCHEMA_VERSION = 1 as const;
export const STUDY_LIMITS = {
  pageBytes: 12_000,
  responseBytes: 24_000,
  chunkBytes: 6_000,
  sourceBytes: 2_000_000,
  scanBytes: 8_000_000,
  scanNotes: 64,
  entries: 10_000,
  storeBytes: 32_000_000,
} as const;

export type StudyRequest =
  | { action: 'capabilities' }
  | { action: 'open'; scope: QuizScope }
  | { action: 'tree'; studyId: string; offset?: number; indexRevision?: string }
  | { action: 'retrieve'; studyId: string; query: string; offset?: number }
  | {
      action: 'read';
      studyId: string;
      snapshotId: string;
      chunkId?: string;
      offset?: number;
    }
  | { action: 'validate'; studyId: string; snapshotId: string };

export type StudySource = {
  id: string;
  path: string;
  kind: string;
  role: 'unclassified';
};
export type StudyChunk = {
  id: string;
  sourceId: string;
  contentHash: string;
  heading: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  completeness: 'section' | 'continuation';
  text: string;
};
export type StudyCapturedSource = StudySource & {
  contentHash: string;
  origin: 'disk' | 'editor';
  saveState?: 'pending' | 'saved' | 'failed';
  text: string;
  chunks: StudyChunk[];
  links: Array<{ target: string; path?: string; issue?: string }>;
};
export type StudySnapshot = {
  schemaVersion: 1;
  id: string;
  studyId: string;
  scope: QuizScope;
  createdAt: string;
  sources: StudyCapturedSource[];
};
export type StudyIssue = { path: string; reason: string };
export type StudyTree = {
  studyId: string;
  scope: QuizScope;
  /** Absolute vault folder, so agents can open files Storm cannot read. */
  root?: string;
  indexRevision: string;
  entries: StudySource[];
  nextOffset: number | null;
  total: number;
  incomplete: boolean;
  issues: StudyIssue[];
};
export type StudyPacket = {
  studyId: string;
  snapshotId: string;
  createdAt: string;
  sources: Array<Omit<StudyCapturedSource, 'text' | 'chunks'>>;
  chunks: StudyChunk[];
  nextOffset: number | null;
  incomplete: boolean;
  scannedNotes?: number;
  nextScanOffset?: number | null;
  issues: StudyIssue[];
};
export type StudyValue =
  | StudyTree
  | StudyPacket
  | {
      studyId: string;
      snapshotId: string;
      sources: Array<{
        sourceId: string;
        state: 'current' | 'changed' | 'unavailable';
      }>;
    }
  | { schemaVersion: 1; capabilities: string[] };

export type StudyReference = {
  snapshotId: string;
  sourceId: string;
  contentHash: string;
  chunkId: string;
  quote?: string;
};

/** Checks provenance against context actually delivered, not whether a claim is true. */
export function validateStudyEvidence(
  packet: StudyPacket,
  references: StudyReference[],
): string[] {
  if (
    !Array.isArray(references) ||
    !references.length ||
    references.length > 20
  )
    return ['Provide 1–20 evidence references.'];
  return references.flatMap((reference, index) => {
    if (!reference || typeof reference !== 'object')
      return [`Reference ${index + 1} is invalid.`];
    const chunk = packet.chunks.find((c) => c.id === reference.chunkId);
    if (
      reference.snapshotId !== packet.snapshotId ||
      !chunk ||
      chunk.sourceId !== reference.sourceId ||
      chunk.contentHash !== reference.contentHash
    )
      return [
        `Reference ${index + 1} does not match the delivered snapshot and chunk.`,
      ];
    if (
      reference.quote !== undefined &&
      (typeof reference.quote !== 'string' ||
        !chunk.text.includes(reference.quote))
    )
      return [
        `Reference ${index + 1} quote is not present in the pinned chunk.`,
      ];
    return [];
  });
}

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown) =>
  typeof v === 'string' && v.length > 0 && v.length <= 128;
export function isStudyPath(v: unknown, folder = false): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 2048 &&
    ((folder && v === '.') ||
      (!/^[\\/]|^[a-z]:|\0/i.test(v) &&
        !v.split(/[\\/]/).some((p) => !p || p === '.' || p === '..')))
  );
}
export function isStudyScope(v: unknown): v is QuizScope {
  if (
    !record(v) ||
    !id(v.vaultId) ||
    !Array.isArray(v.selectedNotePaths) ||
    v.selectedNotePaths.length > 1000
  )
    return false;
  const selected = v.selectedNotePaths;
  return (
    (v.notePath === null &&
      v.folderPath === null &&
      selected.length > 0 &&
      selected.every((p) => isStudyPath(p))) ||
    (isStudyPath(v.notePath) &&
      v.folderPath === null &&
      selected.length === 0) ||
    (v.notePath === null &&
      isStudyPath(v.folderPath, true) &&
      selected.length === 0)
  );
}
export function isStudyRequest(v: unknown): v is StudyRequest {
  if (!record(v)) return false;
  if (v.action === 'capabilities') return true;
  if (v.action === 'open') return isStudyScope(v.scope);
  if (
    !id(v.studyId) ||
    (v.offset !== undefined &&
      (!Number.isSafeInteger(v.offset) || Number(v.offset) < 0))
  )
    return false;
  if (v.action === 'tree')
    return v.indexRevision === undefined || id(v.indexRevision);
  if (v.action === 'retrieve')
    return (
      typeof v.query === 'string' &&
      v.query.trim().length > 0 &&
      v.query.length <= 512
    );
  if (v.action === 'read')
    return id(v.snapshotId) && (v.chunkId === undefined || id(v.chunkId));
  return v.action === 'validate' && id(v.snapshotId);
}
export function studyContains(scope: QuizScope, path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return scope.notePath !== null
    ? normalized === scope.notePath
    : scope.folderPath !== null
      ? scope.folderPath === '.' ||
        normalized === scope.folderPath ||
        normalized.startsWith(scope.folderPath + '/')
      : scope.selectedNotePaths.includes(normalized);
}
