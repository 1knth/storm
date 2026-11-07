import { randomInt } from 'node:crypto';
import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import type { QuizScope } from '../shared/quizProtocol';
import type { VaultEntry } from '../shared/types';
import {
  STUDY_LIMITS,
  isStudyScope,
  studyContains,
  type StudyRequest,
  type StudyValue,
  type StudyTree,
  type StudySource,
  type StudyCapturedSource,
  type StudySnapshot,
  type StudyPacket,
  type StudyIssue,
} from '../shared/studyContext';
import { studyHash, indexStudySource } from '../vault/studySourceIndex';
import { resolveVaultNote } from '../vault/vaultNoteResolver';
import { StudyContextStore } from './studyContextStore';

export interface StudyContextPorts {
  vaults(): Promise<Array<{ id: string; path: string }>>;
  entries(root: string, scope?: QuizScope): Promise<VaultEntry[]>;
  live(
    vaultId: string,
    relativePath: string,
  ): Promise<{
    text: string;
    saveState: 'pending' | 'saved' | 'failed';
  } | null>;
  capture<T>(root: string, operation: () => Promise<T>): Promise<T>;
  read(root: string, relativePath: string): Promise<string>;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const publicSource = ({
  text: _text,
  chunks: _chunks,
  ...source
}: StudyCapturedSource) => ({
  ...source,
  links: source.links.slice(0, 3).map((link) => ({
    target: link.target.slice(0, 256),
    ...(link.path ? { path: link.path.slice(0, 256) } : {}),
    ...(link.issue ? { issue: link.issue } : {}),
  })),
  linksIncomplete:
    source.links.length > 3 ||
    source.links.some(
      (link) => link.target.length > 256 || (link.path?.length ?? 0) > 256,
    ),
});

type StudyIndexEntry = {
  revision: string;
  cost: number;
  indexed: ReturnType<typeof indexStudySource>;
  frequencies: Map<string, number>[];
};

/** Shared read context; never owns editor text, quiz state, or a model executor. */
export class StudyContextService {
  private cache = new Map<string, StudyIndexEntry>();
  private namespaceRevisions = new WeakMap<VaultEntry[], string>();
  private cursors = new Map<
    number,
    { studyId: string; query: string; revision: string; offset: number }
  >();
  private cursorSequence = randomInt(1, 2 ** 40);
  private cacheBytes = 0;
  constructor(
    private readonly store: StudyContextStore,
    private readonly ports: StudyContextPorts,
  ) {}
  private normalize(scope: QuizScope): QuizScope {
    if (!isStudyScope(scope)) throw new Error('STUDY_INVALID_SCOPE');
    return {
      vaultId: scope.vaultId,
      notePath: scope.notePath?.replace(/\\/g, '/') ?? null,
      folderPath: scope.folderPath?.replace(/\\/g, '/') ?? null,
      selectedNotePaths: [
        ...new Set(scope.selectedNotePaths.map((p) => p.replace(/\\/g, '/'))),
      ].sort(),
    };
  }
  private async root(scope: QuizScope) {
    const vault = (await this.ports.vaults()).find(
      (v) => v.id === scope.vaultId,
    );
    if (!vault || (await realpath(vault.path)) !== vault.path)
      throw new Error('STUDY_VAULT_UNAVAILABLE');
    return vault.path;
  }
  private async binding(id: string) {
    const scope = await this.store.scope(id);
    if (!scope) throw new Error('STUDY_NOT_FOUND');
    return { scope, root: await this.root(scope) };
  }
  private async listing(studyId: string) {
    const { scope, root } = await this.binding(studyId);
    const all = await this.ports.entries(root, scope);
    const scoped = all.filter((e) =>
      studyContains(scope, e.path.replace(/\\/g, '/')),
    );
    const partial = scoped.length > STUDY_LIMITS.entries;
    const entries = scoped.slice(0, STUDY_LIMITS.entries);
    const sources: StudySource[] = entries.map((e) => ({
      id: studyHash(`${scope.vaultId}:${e.path}`),
      path: e.path.replace(/\\/g, '/'),
      kind: e.kind,
      role: 'unclassified',
    }));
    let indexRevision = this.namespaceRevisions.get(all);
    if (!indexRevision) {
      indexRevision = studyHash(
        JSON.stringify({
          sources,
          namespace: all.map((e) => [e.path, e.kind]),
        }),
      );
      this.namespaceRevisions.set(all, indexRevision);
    }
    return { scope, root, all, sources, indexRevision, partial };
  }
  async execute(request: StudyRequest): Promise<StudyValue> {
    if (request.action === 'capabilities')
      return {
        schemaVersion: 1,
        capabilities: [
          'markdown',
          'scoped-tree',
          'immutable-snapshots',
          'live-text',
          'validate',
          'question-basis',
        ],
      };
    if (request.action === 'open') {
      const scope = this.normalize(request.scope);
      await this.root(scope);
      const id = studyHash(JSON.stringify(scope));
      await this.store.bind(id, scope);
      return this.tree(id, 0);
    }
    if (request.action === 'tree')
      return this.tree(
        request.studyId,
        request.offset ?? 0,
        request.indexRevision,
      );
    if (request.action === 'retrieve')
      return this.retrieve(request.studyId, request.query, request.offset ?? 0);
    const { scope } = await this.binding(request.studyId);
    const snapshot = await this.store.snapshot(request.snapshotId);
    if (
      !snapshot ||
      snapshot.studyId !== request.studyId ||
      JSON.stringify(snapshot.scope) !== JSON.stringify(scope)
    )
      throw new Error('STUDY_SNAPSHOT_UNAVAILABLE');
    if (request.action === 'validate') return this.validate(snapshot);
    const chunks = snapshot.sources
      .flatMap((s) => s.chunks)
      .filter((c) => !request.chunkId || c.id === request.chunkId);
    if (request.chunkId && !chunks.length)
      throw new Error('STUDY_CHUNK_NOT_FOUND');
    return this.packet(snapshot, chunks, request.offset ?? 0, []);
  }
  private async tree(
    studyId: string,
    offset: number,
    expected?: string,
  ): Promise<StudyTree> {
    const info = await this.listing(studyId);
    if (expected && expected !== info.indexRevision)
      throw new Error('STUDY_INDEX_CHANGED');
    const scopeOmitted = bytes(info.scope) > 4000;
    const result: StudyTree = {
      studyId,
      scope: scopeOmitted
        ? { ...info.scope, selectedNotePaths: [] }
        : info.scope,
      root: info.root,
      indexRevision: info.indexRevision,
      entries: [],
      total: info.sources.length,
      nextOffset: null,
      incomplete: info.partial || scopeOmitted,
      issues: scopeOmitted
        ? [
            {
              path: '',
              reason: 'selected-paths-omitted; exact scope retained by studyId',
            },
          ]
        : [],
    };
    let end = offset;
    while (end < info.sources.length && end - offset < 100) {
      const source = info.sources[end];
      if (
        bytes({ ...result, entries: [...result.entries, source] }) >
        STUDY_LIMITS.pageBytes
      )
        break;
      result.entries.push(source);
      end++;
    }
    result.nextOffset = end < info.sources.length ? end : null;
    if (info.partial)
      result.issues.push({ path: '', reason: 'metadata-index-truncated' });
    if (!info.sources.length)
      result.issues.push({ path: '', reason: 'no-matching-files' });
    return result;
  }
  private async captured(
    scope: QuizScope,
    root: string,
    sources: StudySource[],
  ) {
    // Renderer calls occur before lifecycle/write-barrier acquisition.
    const live = new Map<
      string,
      Awaited<ReturnType<StudyContextPorts['live']>>
    >();
    for (const source of sources)
      live.set(source.path, await this.ports.live(scope.vaultId, source.path));
    const reads = await this.ports.capture(root, async () => {
      if ((await this.root(scope)) !== root)
        throw new Error('STUDY_VAULT_UNAVAILABLE');
      let total = 0;
      const values: Array<{
        source: StudySource;
        text?: string;
        origin?: 'disk' | 'editor';
        saveState?: 'pending' | 'saved' | 'failed';
        issue?: string;
      }> = [];
      for (const source of sources) {
        if (total + STUDY_LIMITS.sourceBytes > STUDY_LIMITS.scanBytes) {
          values.push({ source, issue: 'STUDY_SCAN_LIMIT' });
          break;
        }
        try {
          const buffer = live.get(source.path);
          const text =
            buffer?.text ?? (await this.ports.read(root, source.path));
          if (Buffer.byteLength(text) > STUDY_LIMITS.sourceBytes)
            throw new Error('STUDY_SOURCE_TOO_LARGE');
          total += Buffer.byteLength(text);
          if (total > STUDY_LIMITS.scanBytes)
            throw new Error('STUDY_SCAN_LIMIT');
          values.push({
            source,
            text,
            origin: buffer ? 'editor' : 'disk',
            ...(buffer ? { saveState: buffer.saveState } : {}),
          });
        } catch (e) {
          values.push({
            source,
            issue: (e as Error).message.startsWith('STUDY_')
              ? (e as Error).message
              : 'source-unavailable',
          });
        }
      }
      return values;
    });
    // No renderer call or parsing inside the mutation/lifecycle critical section.
    for (const read of reads) {
      if (!read.text && read.text !== '') continue;
      const previous = live.get(read.source.path);
      const current = await this.ports.live(scope.vaultId, read.source.path);
      if (previous?.text !== current?.text) {
        read.issue = 'STUDY_SOURCE_BUSY';
        delete read.text;
      }
    }
    return reads;
  }
  private async retrieve(
    studyId: string,
    query: string,
    offset: number,
  ): Promise<StudyPacket> {
    const info = await this.listing(studyId);
    const issues: StudyIssue[] = info.sources
      .filter((s) => s.kind !== 'note' && s.kind !== 'directory')
      .slice(0, 20)
      .map((s) => ({ path: s.path, reason: 'reader-unavailable' }));
    const tokenize = (text: string) =>
      text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const terms = [...new Set(tokenize(query))];
    const notes = info.sources.filter((s) => s.kind === 'note');
    const documents: Array<{
      source: StudySource;
      entry: StudyIndexEntry;
    }> = [];
    let scopeBytes = 0;
    for (const source of notes) {
      try {
        // Metadata invalidates disk entries; live buffers are checked on every request.
        const live = await this.ports.live(info.scope.vaultId, source.path);
        const metadata = live
          ? null
          : await stat(path.join(info.root, source.path));
        const revision = live
          ? studyHash(live.text)
          : `${metadata!.ino}:${metadata!.size}:${metadata!.mtimeMs}:${metadata!.ctimeMs}`;
        const key = `${info.root}:${source.id}`;
        let entry = this.cache.get(key);
        if (!entry || entry.revision !== revision) {
          const text =
            live?.text ?? (await this.ports.read(info.root, source.path));
          if (Buffer.byteLength(text) > STUDY_LIMITS.sourceBytes)
            throw new Error('STUDY_SOURCE_TOO_LARGE');
          const indexed = indexStudySource(source.id, text);
          const frequencies = indexed.chunks.map((chunk) => {
            const counts = new Map<string, number>();
            for (const term of tokenize(chunk.text))
              counts.set(term, (counts.get(term) ?? 0) + 1);
            return counts;
          });
          const cost = bytes(indexed) + bytes(frequencies.map((f) => [...f]));
          if (entry) {
            this.cacheBytes -= entry.cost;
            this.cache.delete(key);
          }
          entry = { revision, indexed, frequencies, cost };
          this.cache.set(key, entry);
          this.cacheBytes += cost;
          while (
            this.cacheBytes > STUDY_LIMITS.storeBytes ||
            this.cache.size > STUDY_LIMITS.entries
          ) {
            const oldest = this.cache.keys().next().value!;
            this.cacheBytes -= this.cache.get(oldest)!.cost;
            this.cache.delete(oldest);
          }
        }
        scopeBytes += entry.cost;
        if (scopeBytes > STUDY_LIMITS.storeBytes)
          throw new Error('STUDY_INDEX_LIMIT');
        documents.push({ source, entry });
      } catch (error) {
        if ((error as Error).message === 'STUDY_INDEX_LIMIT') throw error;
        issues.push({
          path: source.path,
          reason: (error as Error).message.startsWith('STUDY_')
            ? (error as Error).message
            : 'source-unavailable',
        });
      }
    }
    const revision = studyHash(
      JSON.stringify([
        info.indexRevision,
        documents.map((d) => [d.source.id, d.entry.revision]),
      ]),
    );
    let rankOffset = 0;
    if (offset) {
      const cursor = this.cursors.get(offset);
      if (
        !cursor ||
        cursor.studyId !== studyId ||
        cursor.query !== query ||
        cursor.revision !== revision
      )
        throw new Error('STUDY_CURSOR_STALE');
      rankOffset = cursor.offset;
    }
    const chunkCount = documents.reduce(
      (n, d) => n + d.entry.indexed.chunks.length,
      0,
    );
    const df = new Map(
      terms.map((term) => [
        term,
        documents.reduce(
          (n, d) => n + d.entry.frequencies.filter((f) => f.has(term)).length,
          0,
        ),
      ]),
    );
    const candidates = documents
      .flatMap(({ source, entry }) => {
        const names = new Set(
          tokenize(path.posix.basename(source.path, '.md')),
        );
        return entry.indexed.chunks.map((chunk, i) => {
          const frequencies = entry.frequencies[i];
          let score = 0;
          for (const term of terms) {
            const tf = frequencies.get(term) ?? 0;
            if (tf)
              score +=
                (Math.log(1 + (chunkCount + 1) / ((df.get(term) ?? 0) + 1)) *
                  tf) /
                (tf + 0.5);
          }
          // A basename helps break content ties; it cannot manufacture content hits.
          if (score > 0)
            score += terms.filter((t) => names.has(t)).length * 0.05;
          return { chunk, score, source };
        });
      })
      .filter((c) => c.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id),
      );
    const remaining = candidates.slice(rankOffset);
    const selectedIds = [...new Set(remaining.map((c) => c.source.id))].slice(
      0,
      4,
    );
    const selected = notes.filter((s) => selectedIds.includes(s.id));
    const reads = await this.captured(info.scope, info.root, selected);
    const captured: StudyCapturedSource[] = [];
    const notePaths = info.all
      .filter((e) => e.kind === 'note')
      .map((e) => e.path);
    for (const read of reads) {
      if (read.issue || read.text === undefined) {
        issues.push({
          path: read.source.path,
          reason: read.issue ?? 'source-unavailable',
        });
        continue;
      }
      const contentHash = studyHash(read.text);
      const indexed = indexStudySource(read.source.id, read.text);
      const expected = documents.find((d) => d.source.id === read.source.id);
      if (
        !expected ||
        expected.entry.indexed.chunks[0]?.contentHash !==
          indexed.chunks[0]?.contentHash
      ) {
        issues.push({ path: read.source.path, reason: 'STUDY_SOURCE_BUSY' });
        continue;
      }
      const links: StudyCapturedSource['links'] = [];
      for (const target of indexed.links) {
        if (info.partial) {
          links.push({ target, issue: 'index-incomplete' });
          continue;
        }
        try {
          const resolved = await resolveVaultNote(
            info.root,
            read.source.path,
            target,
            notePaths,
          );
          links.push(
            studyContains(info.scope, resolved)
              ? { target, path: resolved }
              : { target, issue: 'outside-scope' },
          );
        } catch {
          links.push({ target, issue: 'unresolved' });
        }
      }
      captured.push({
        ...read.source,
        contentHash,
        origin: read.origin!,
        ...(read.saveState ? { saveState: read.saveState } : {}),
        text: read.text,
        ...indexed,
        links,
      });
    }
    const capturedIds = new Set(captured.map((s) => s.id));
    const ranked = remaining
      .filter((c) => capturedIds.has(c.source.id))
      .map((c) => c.chunk);
    const sourceIds = selectedIds;
    const sources = captured;
    const snapshot: StudySnapshot = {
      schemaVersion: 1,
      id: studyHash(
        JSON.stringify({
          studyId,
          indexRevision: info.indexRevision,
          sources: sources.map((s) => [s.id, s.contentHash, s.origin]),
        }),
      ),
      studyId,
      scope: info.scope,
      createdAt: new Date().toISOString(),
      sources,
    };
    await this.store.save(snapshot);
    const stored = (await this.store.snapshot(snapshot.id))!;
    const packet = this.packet(
      stored,
      ranked.filter((c) => sourceIds.includes(c.sourceId)),
      0,
      issues,
    );
    // Retrieval is ranked; read pages use source order. Resume full-source context at zero.
    if (packet.nextOffset !== null) packet.nextOffset = 0;
    packet.scannedNotes = notes.length;
    const delivered = new Set(packet.chunks.map((c) => c.id));
    let next = rankOffset;
    while (next < candidates.length && delivered.has(candidates[next].chunk.id))
      next++;
    packet.nextScanOffset = null;
    if (next < candidates.length && next > rankOffset) {
      const token = ++this.cursorSequence;
      this.cursors.set(token, { studyId, query, revision, offset: next });
      while (this.cursors.size > 128)
        this.cursors.delete(this.cursors.keys().next().value!);
      packet.nextScanOffset = token;
    }
    packet.incomplete ||=
      info.partial || next < candidates.length || issues.length > 0;
    return packet;
  }
  private packet(
    snapshot: StudySnapshot,
    chunks: StudyCapturedSource['chunks'],
    offset: number,
    issues: StudyIssue[],
  ): StudyPacket {
    const packet: StudyPacket = {
      studyId: snapshot.studyId,
      snapshotId: snapshot.id,
      createdAt: snapshot.createdAt,
      sources: [],
      chunks: [],
      nextOffset: null,
      incomplete: false,
      issues: issues.slice(0, 20).map((issue) => ({
        path: issue.path.slice(0, 256),
        reason: issue.reason.slice(0, 128),
      })),
    };
    let end = offset;
    for (; end < chunks.length; end++) {
      const chunk = chunks[end];
      const source = snapshot.sources.find((s) => s.id === chunk.sourceId)!;
      const sources = packet.sources.some((s) => s.id === source.id)
        ? packet.sources
        : [...packet.sources, publicSource(source)];
      if (
        bytes({ ...packet, chunks: [...packet.chunks, chunk], sources }) >
        STUDY_LIMITS.responseBytes - 2000
      )
        break;
      packet.sources = sources;
      packet.chunks.push(chunk);
    }
    packet.nextOffset = end < chunks.length ? end : null;
    packet.incomplete = packet.nextOffset !== null;
    return packet;
  }
  private async validate(snapshot: StudySnapshot): Promise<StudyValue> {
    const { root } = await this.binding(snapshot.studyId);
    const reads = await this.captured(snapshot.scope, root, snapshot.sources);
    return {
      studyId: snapshot.studyId,
      snapshotId: snapshot.id,
      sources: reads.map((read) => ({
        sourceId: read.source.id,
        state:
          read.text === undefined
            ? ('unavailable' as const)
            : studyHash(read.text) ===
                snapshot.sources.find((s) => s.id === read.source.id)!
                  .contentHash
              ? ('current' as const)
              : ('changed' as const),
      })),
    };
  }
  async pinQuestion(key: string, snapshotId: string, scope?: QuizScope) {
    const snapshot = await this.store.snapshot(snapshotId);
    if (
      !snapshot ||
      !snapshot.sources.length ||
      !scope ||
      JSON.stringify(this.normalize(scope)) !== JSON.stringify(snapshot.scope)
    )
      throw new Error('STUDY_SCOPE_MISMATCH');
    const state = await this.validate(snapshot);
    if (
      !('sources' in state) ||
      state.sources.some((s) => !('state' in s) || s.state !== 'current')
    )
      throw new Error('STUDY_SOURCES_CHANGED');
    await this.store.pin(key, snapshotId);
  }
}
