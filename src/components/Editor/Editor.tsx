import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { MdOutlineHideImage, MdOutlineRemoveRedEye } from 'react-icons/md';
import { IoSearch } from 'react-icons/io5';
import { RxLightningBolt } from 'react-icons/rx';
import { markdown } from '@codemirror/lang-markdown';
import { Vim, vim } from '@replit/codemirror-vim';
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  lineNumbers,
} from '@codemirror/view';
import type { NoteData } from '../../shared/types';
import { markdownEditorExtensions } from './extensions';
import { foldGutter } from '@codemirror/language';
import { createMarkdownSyntaxHighlighting } from './markdownHighlighting';
import type { Appearance } from '../../appearance';
import { rgbaColor } from '../../appearance';
import MarkdownPreview from './MarkdownPreview';
import AssetPreviewPane from '../AssetPreviewDialog';
import PdfViewer from './PdfViewer';
import { taskMarkerChange, taskToggleMatchesBinding } from './markdownTasks';
import type { TaskTogglePayload } from './markdownTasks';
import { formatMarkdownSelection } from './markdownFormatting';
import {
  imagePasteChange,
  mapImagePasteAnchor,
  type ImagePasteAnchor,
} from './imagePasteAnchor';
import {
  isUserSelectionChange,
  previewScrollTopForCursor,
  smoothScrollTo,
  previewTopAtSourceLine as mapPreviewTopAtSourceLine,
  type PreviewAnchor,
} from './previewScroll';
import { useToast } from '../Toast';
import { isPreviewFindShortcut } from './previewFind';
import { scrollReadingPreview } from './readingScroll';
import {
  agentWritingLockExtensions,
  matchesAgentEditor,
  shouldBlockAgentEditorMouseDown,
} from './agentEditorAdapter';
import type { AgentEditorAdapter } from './agentEditorAdapter';
import type { AgentSessionStatus } from '../../shared/agentProtocol';
import { AgentStatusBar } from './AgentStatusBar';
import {
  acquireWritingBaseline,
  appendedContentStartLine,
  createManagedPreviewBatch,
  createRevealScheduleRegistry,
  hasRecentPreviewScrollIntent,
  PREVIEW_SCROLL_INTENT_MS,
  shouldFinalizeReveal,
  deriveFinalPreviewState,
  shouldAutoOpenAgentStatus,
  shouldShowRevealingStatus,
} from './managedPreviewBatch';
import {
  isCurrentSaveCompletion,
  isSaveCompletionContentUnchanged,
  shouldSaveBoundDocument,
} from './saveBinding';

// Keep these as Vim mappings (not CodeMirror key handlers) so uppercase J/K remain
// ordinary inserted text outside Vim modes and Vim's counts/operators keep working.
// Keep j/k as Vim mappings so counts and Vim's wrapped-line motion preserve
// normal-mode behavior without intercepting Insert, Visual, or operator-pending keys.
Vim.map('j', 'gj', 'normal');
Vim.map('k', 'gk', 'normal');
Vim.map('J', '}', 'normal');
Vim.map('J', '}', 'visual');
Vim.map('J', '}', 'operatorPending');
Vim.map('K', '{', 'normal');
Vim.map('K', '{', 'visual');
Vim.map('K', '{', 'operatorPending');

export type NoteTabSnapshot = {
  kind: 'note';
  note: NoteData;
  vaultPath: string;
  vaultId: string;
  state: EditorState;
  scrollTop: number;
};
export type ImageTabSnapshot = {
  kind: 'image';
  vaultId: string;
  path: string;
  filename: string;
};
export type PdfTabSnapshot = {
  kind: 'pdf';
  vaultId: string;
  relativePath: string;
  fileName: string;
};
export type EmptyTabSnapshot = { kind: 'empty'; id: string };
export type TabSnapshot =
  | NoteTabSnapshot
  | ImageTabSnapshot
  | PdfTabSnapshot
  | EmptyTabSnapshot;
export type EditorHandle = {
  flush: () => Promise<boolean>;
  snapshot: () => TabSnapshot | null;
  activate: (tab: TabSnapshot) => void;
  openNote: (note: NoteData, vaultPath: string, vaultId: string) => void;
  createState: (content: string) => EditorState;
  clear: () => void;
  focus: () => void;
  isNormalMode: () => boolean;
  format?: (kind: 'bold' | 'italic') => boolean;
  /** Apply owner state only while its vault/path identity is the active note. */
  syncManagedState: (
    vaultId: string,
    path: string,
    state: EditorState,
  ) => boolean;
};
type EditorProps = {
  vimMode: boolean;
  tabs: ReactNode;
  tabsVisible: boolean;
  vaultId: string | null;
  onLayoutChange?: () => void;
  onOpenNote?: (target: string) => void;
  readingMode?: boolean;
  onToggleReadingMode?: () => void;
  commandHeld?: boolean;
  appearance: Appearance;
  imageAsset?: { vaultId: string; path: string; filename: string } | null;
  pdfAsset?: PdfTabSnapshot | null;
  agentDocument?: AgentEditorAdapter | null;
  agentStatus?: AgentSessionStatus;
  agentWriting?: boolean;
  agentGenerationFinished?: boolean;
  renameInProgress?: boolean;
  onStopAgent?: (sessionId: string) => void;
};

const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  {
    vimMode,
    tabs,
    vaultId,
    onLayoutChange,
    onOpenNote,
    readingMode = false,
    onToggleReadingMode,
    commandHeld = false,
    appearance,
    tabsVisible,
    imageAsset = null,
    pdfAsset = null,
    agentDocument = null,
    agentStatus,
    agentWriting = false,
    agentGenerationFinished = false,
    renameInProgress = false,
    onStopAgent,
  },
  ref,
) {
  const { notifyError, notifySuccess } = useToast();
  const host = useRef<HTMLDivElement>(null);
  const paneRoot = useRef<HTMLElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vimCompartment = useRef(new Compartment());
  const appearanceCompartment = useRef(new Compartment());
  const writingLockCompartment = useRef(new Compartment());
  const renameReadOnlyCompartment = useRef(new Compartment());
  const renameInProgressRef = useRef(renameInProgress);
  renameInProgressRef.current = renameInProgress;
  const extensions = useRef<Extension[]>([]);
  const current = useRef<{
    note: NoteData;
    vaultPath: string;
    vaultId: string;
  } | null>(null);
  const revision = useRef<string | null>(null);
  const generation = useRef(0);
  const binding = useRef<{ view: EditorView; generation: number } | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const pendingImagePastes = useRef<ImagePasteAnchor[]>([]);
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  const agentDocumentRef = useRef(agentDocument);
  agentDocumentRef.current = agentDocument;
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<{
    vaultId: string;
    notePath: string;
    markdown: string;
    previewRevision: number;
  } | null>(null);
  const previewRevision = useRef(0);
  const previewSnapshot = useRef(preview);
  const publishPreviewSnapshot = useCallback(
    (next: { vaultId: string; notePath: string; markdown: string }) => {
      const previous = previewSnapshot.current;
      if (
        previous?.vaultId === next.vaultId &&
        previous.notePath === next.notePath &&
        previous.markdown === next.markdown
      )
        return;
      const snapshot = { ...next, previewRevision: ++previewRevision.current };
      previewSnapshot.current = snapshot;
      setPreview(snapshot);
    },
    [],
  );
  const documentKey = current.current
    ? JSON.stringify([current.current.vaultId, current.current.note.path])
    : null;
  const previousWriting = useRef(new Map<string, boolean>());
  const writingBaseline = useRef(new Map<string, string>());
  const [appendReveals, setAppendReveals] = useState(
    () =>
      new Map<
        string,
        {
          documentKey: string;
          markdown: string;
          startLine: number;
          id: string;
          ranges?: readonly { from: number; to: number }[];
        }
      >(),
  );
  const appendReveal = documentKey
    ? (appendReveals.get(documentKey) ?? null)
    : null;
  const setAppendReveal = useCallback(
    (
      value:
        | {
            documentKey: string;
            markdown: string;
            startLine: number;
            id: string;
          }
        | null
        | ((
            current: {
              documentKey: string;
              markdown: string;
              startLine: number;
              id: string;
            } | null,
          ) => {
            documentKey: string;
            markdown: string;
            startLine: number;
            id: string;
          } | null),
    ) => {
      const key = documentKey;
      if (!key) return;
      setAppendReveals((previous) => {
        const next =
          typeof value === 'function'
            ? value(previous.get(key) ?? null)
            : value;
        const updated = new Map(previous);
        if (next) updated.set(key, next);
        else updated.delete(key);
        return updated;
      });
    },
    [documentKey],
  );
  const revealReceipts = useRef(
    new Map<
      number,
      {
        generationId: string;
        previewKey: number;
        pending: boolean;
      }
    >(),
  );
  const [revealProgressVersion, setRevealProgressVersion] = useState(0);
  const revealId = useRef(0);
  const revealSessions = useRef(
    new Map<
      string,
      {
        identity: string | undefined;
        registry: ReturnType<typeof createRevealScheduleRegistry>;
      }
    >(),
  );
  const revealSession = useRef<{
    identity: string | undefined;
    registry: ReturnType<typeof createRevealScheduleRegistry>;
  } | null>(null);
  const managedPreviewBatch = useRef(
    createManagedPreviewBatch<{
      vaultId: string;
      notePath: string;
      markdown: string;
    }>(publishPreviewSnapshot),
  );
  const [hasActiveNote, setHasActiveNote] = useState(false);
  const previousReadingMode = useRef(readingMode);
  const pendingFocus = useRef(false);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const onReadingKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const modalOpen = Boolean(
        document.querySelector(
          '[role="dialog"], [role="menu"], [role="listbox"]',
        ),
      );
      scrollReadingPreview(
        event.nativeEvent,
        previewScrollRef.current,
        modalOpen,
      );
    },
    [],
  );
  const expectedPreviewScroll = useRef<number | null>(null);
  const expectedEditorScroll = useRef<number | null>(null);
  const previewAnimation = useRef({ active: false, cancel: () => {} });
  const editorAnimation = useRef({ active: false, cancel: () => {} });
  const pendingCursorFollow = useRef<number | null>(null);
  const cancelScrollAnimations = useCallback(() => {
    previewAnimation.current.cancel();
    editorAnimation.current.cancel();
    expectedPreviewScroll.current = null;
    expectedEditorScroll.current = null;
  }, []);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [findOpen, setFindOpen] = useState(false);
  const findReturnFocus = useRef<HTMLElement | null>(null);
  const previousFindOpen = useRef(findOpen);
  const [agentStatusVisibleForNotes, setAgentStatusVisibleForNotes] = useState<
    Set<string>
  >(() => new Set());
  const seenAgentSessionsByNote = useRef(new Map<string, Set<string>>());
  const activeNoteKey = documentKey;
  const explicitReveal = agentDocument?.reveal;
  const explicitRanges = explicitReveal?.ranges ?? [];
  const explicitRevealIdentity =
    explicitReveal && explicitRanges.length > 0
      ? JSON.stringify([
          documentKey,
          explicitReveal.generation,
          explicitReveal.documentVersion,
        ])
      : undefined;
  const activeReveal = explicitRevealIdentity
    ? {
        documentKey: documentKey!,
        id: explicitRevealIdentity,
        startLine: 1,
        ranges: explicitRanges,
      }
    : appendReveal;
  const currentRevealIdentity = activeReveal
    ? JSON.stringify([activeReveal.documentKey, activeReveal.id])
    : undefined;
  const currentRevealIdentityRef = useRef(currentRevealIdentity);
  currentRevealIdentityRef.current = currentRevealIdentity;
  const currentDocumentKeyRef = useRef(documentKey);
  currentDocumentKeyRef.current = documentKey;
  useEffect(() => {
    const writing = Boolean(agentWriting);
    const activeMarkdown = preview?.markdown;
    const currentBaseline = documentKey
      ? writingBaseline.current.get(documentKey)
      : undefined;
    const wasWriting = documentKey
      ? (previousWriting.current.get(documentKey) ?? false)
      : false;
    if (writing && !wasWriting) {
      if (currentBaseline === undefined) {
        if (documentKey && activeMarkdown !== undefined) {
          const acquired = acquireWritingBaseline(
            null,
            documentKey,
            activeMarkdown,
          );
          if (acquired)
            writingBaseline.current.set(documentKey, acquired.markdown);
        }
        setAppendReveal(null);
      } else if (documentKey && activeMarkdown !== undefined) {
        const baseline = { documentKey, markdown: currentBaseline };
        const startLine = appendedContentStartLine(
          baseline.markdown,
          activeMarkdown,
        );
        if (startLine !== null) {
          setAppendReveal((currentReveal) => ({
            documentKey: baseline.documentKey,
            markdown: activeMarkdown,
            startLine,
            id:
              currentReveal?.documentKey === baseline.documentKey
                ? currentReveal.id
                : String(++revealId.current),
          }));
        }
      }
    } else if (
      writing &&
      documentKey &&
      currentBaseline !== undefined &&
      activeMarkdown !== undefined
    ) {
      const baseline = { documentKey, markdown: currentBaseline };
      const startLine = appendedContentStartLine(
        baseline.markdown,
        activeMarkdown,
      );
      if (startLine !== null) {
        setAppendReveal({
          documentKey: baseline.documentKey,
          markdown: activeMarkdown,
          startLine,
          id:
            appendReveal?.documentKey === baseline.documentKey
              ? appendReveal.id
              : String(++revealId.current),
        });
      }
    } else if (!writing && documentKey && currentBaseline !== undefined) {
      const baseline = { documentKey, markdown: currentBaseline };
      if (
        shouldFinalizeReveal(
          baseline.documentKey === documentKey,
          writing,
          agentGenerationFinished,
        ) &&
        activeMarkdown !== undefined
      ) {
        const startLine = appendedContentStartLine(
          baseline.markdown,
          activeMarkdown,
        );
        if (startLine !== null) {
          setAppendReveal({
            documentKey: baseline.documentKey,
            markdown: activeMarkdown,
            startLine,
            id:
              appendReveal?.documentKey === baseline.documentKey
                ? appendReveal.id
                : String(++revealId.current),
          });
        }
      }
    }
    if (documentKey) previousWriting.current.set(documentKey, writing);
  }, [agentWriting, agentGenerationFinished, documentKey, preview?.markdown]);
  const agentStatusVisible = Boolean(
    activeNoteKey && agentStatusVisibleForNotes.has(activeNoteKey),
  );
  if (revealSession.current?.identity !== currentRevealIdentity) {
    const sessionKey = currentRevealIdentity ?? `document:${documentKey ?? ''}`;
    let session = revealSessions.current.get(sessionKey);
    if (!session) {
      session = {
        identity: currentRevealIdentity,
        registry: createRevealScheduleRegistry(),
      };
      revealSessions.current.set(sessionKey, session);
    }
    revealSession.current = session;
  }
  useEffect(() => {
    if (
      !activeNoteKey ||
      !agentStatus ||
      !['connected', 'writing'].includes(agentStatus.state)
    )
      return;
    let seen = seenAgentSessionsByNote.current.get(activeNoteKey);
    if (!seen) {
      seen = new Set();
      seenAgentSessionsByNote.current.set(activeNoteKey, seen);
    }
    if (
      !shouldAutoOpenAgentStatus(agentStatus.sessionId, agentStatus.state, seen)
    )
      return;
    setAgentStatusVisibleForNotes((visibleNotes) =>
      new Set(visibleNotes).add(activeNoteKey),
    );
  }, [activeNoteKey, agentStatus?.sessionId, agentStatus?.state]);
  const onRevealProgress = useCallback(
    (progress: {
      generationId: string;
      previewKey: number;
      pending: boolean;
      snapshot: string;
      revision: number;
    }) => {
      if (
        progress.generationId !== currentRevealIdentityRef.current ||
        JSON.parse(progress.generationId)[0] !== currentDocumentKeyRef.current
      )
        return;
      const receipt = {
        generationId: progress.generationId,
        previewKey: progress.revision,
        pending: progress.pending,
      };
      const previous = revealReceipts.current.get(progress.revision);
      revealReceipts.current.set(progress.revision, receipt);
      if (
        !previous ||
        previous.pending !== receipt.pending ||
        previous.generationId !== receipt.generationId
      )
        setRevealProgressVersion((version) => version + 1);
    },
    [],
  );
  const publishedPreview = previewSnapshot.current;
  const editorDocument = viewRef.current?.state.doc.toString();
  const finalRevealDrained = deriveFinalPreviewState({
    activeDocumentKey: documentKey,
    latestAcceptedMarkdown: editorDocument,
    publishedSnapshot: publishedPreview
      ? {
          docKey: JSON.stringify([
            publishedPreview.vaultId,
            publishedPreview.notePath,
          ]),
          markdown: publishedPreview.markdown,
          previewRevision: publishedPreview.previewRevision,
        }
      : null,
    batchPending: managedPreviewBatch.current.hasPending,
    generationKey: currentRevealIdentity ?? '',
    receiptsMap: revealReceipts.current,
  });
  void revealProgressVersion;
  const statusVisualOverride = shouldShowRevealingStatus(
    agentStatus?.state === 'finished',
    agentWriting,
    Boolean(
      activeReveal &&
      activeReveal.documentKey === documentKey &&
      preview &&
      vaultId === preview.vaultId &&
      (readingMode || previewVisible),
    ),
    finalRevealDrained,
  )
    ? 'Revealing…'
    : undefined;
  const toggleAgentStatusVisibility = () => {
    if (!activeNoteKey) return;
    setAgentStatusVisibleForNotes((visibleNotes) => {
      const next = new Set(visibleNotes);
      if (next.has(activeNoteKey)) next.delete(activeNoteKey);
      else next.add(activeNoteKey);
      return next;
    });
  };
  const formatSelection = useCallback((kind: 'bold' | 'italic') => {
    const view = viewRef.current;
    const installed = binding.current;
    const active = current.current;
    if (
      !view ||
      !installed ||
      !active ||
      !shouldSaveBoundDocument({
        currentView: view,
        bindingView: installed.view,
        currentGeneration: generation.current,
        bindingGeneration: installed.generation,
        currentNote: active,
        boundNote: current.current,
        blocked: blocked.current,
      })
    )
      return false;
    view.dispatch({
      ...formatMarkdownSelection(view.state, kind),
      annotations: Transaction.userEvent.of('input.format'),
    });
    return true;
  }, []);
  const sourceLineAtPreviewTop = (scrollTop: number) => {
    const pane = previewScrollRef.current;
    if (!pane) return null;
    const anchors = Array.from(
      pane.querySelectorAll<HTMLElement>('[data-source-start]'),
    )
      .map((element) => ({
        element,
        start: Number(element.dataset.sourceStart),
        end: Number(element.dataset.sourceEnd ?? element.dataset.sourceStart),
        top:
          element.getBoundingClientRect().top -
          pane.getBoundingClientRect().top +
          pane.scrollTop,
        height: element.offsetHeight,
      }))
      .filter(
        (anchor) =>
          Number.isFinite(anchor.start) && Number.isFinite(anchor.end),
      );
    if (!anchors.length) return null;
    let previous = anchors[0];
    for (const anchor of anchors) {
      if (anchor.top > scrollTop) {
        const span = Math.max(1, previous.end - previous.start + 1);
        const progress = Math.max(
          0,
          Math.min(
            1,
            (scrollTop - previous.top) / Math.max(1, previous.height),
          ),
        );
        return previous.start + (span - 1) * progress;
      }
      previous = anchor;
    }
    return previous.end;
  };
  const previewTopAtSourceLine = (line: number) => {
    const pane = previewScrollRef.current;
    if (!pane) return null;
    const anchors: PreviewAnchor[] = Array.from(
      pane.querySelectorAll<HTMLElement>('[data-source-start]'),
    ).map((element) => ({
      start: Number(element.dataset.sourceStart),
      end: Number(element.dataset.sourceEnd ?? element.dataset.sourceStart),
      top:
        element.getBoundingClientRect().top -
        pane.getBoundingClientRect().top +
        pane.scrollTop,
      height: element.offsetHeight,
    }));
    return mapPreviewTopAtSourceLine(line, anchors);
  };
  const previewScrollIntentUntil = useRef(0);
  const markPreviewScrollIntent = useCallback(() => {
    previewScrollIntentUntil.current = Date.now() + PREVIEW_SCROLL_INTENT_MS;
  }, []);
  const syncFromPreview = useCallback(() => {
    if (previewAnimation.current.active) return;
    const pane = previewScrollRef.current;
    const view = viewRef.current;
    if (!pane || !view) return;
    if (
      expectedPreviewScroll.current !== null &&
      Math.abs(pane.scrollTop - expectedPreviewScroll.current) < 1
    ) {
      expectedPreviewScroll.current = null;
      return;
    }
    expectedPreviewScroll.current = null;
    if (
      !hasRecentPreviewScrollIntent(
        previewScrollIntentUntil.current,
        Date.now(),
      )
    )
      return;
    const line = sourceLineAtPreviewTop(pane.scrollTop);
    if (line === null) return;
    const position = view.state.doc.line(
      Math.max(1, Math.min(view.state.doc.lines, Math.round(line))),
    ).from;
    const top = view.lineBlockAt(position).top;
    expectedEditorScroll.current = Math.max(
      0,
      Math.min(view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight, top),
    );
    smoothScrollTo(
      view.scrollDOM,
      expectedEditorScroll.current,
      editorAnimation.current,
      140,
      (top) => {
        expectedEditorScroll.current = top;
      },
    );
  }, []);
  const followCursor = () => {
    const pane = previewScrollRef.current;
    const view = viewRef.current;
    const active = current.current;
    if (
      !pane ||
      !view ||
      !active ||
      previewSnapshot.current?.markdown !== view.state.doc.toString() ||
      previewSnapshot.current.notePath !== active.note.path ||
      previewSnapshot.current.vaultId !== active.vaultId
    )
      return;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    const top = previewTopAtSourceLine(line);
    if (top === null) return;
    const revealTop = previewScrollTopForCursor(
      top,
      pane.scrollTop,
      pane.clientHeight,
      pane.scrollHeight,
    );
    if (revealTop !== null) {
      expectedPreviewScroll.current = revealTop;
      smoothScrollTo(
        pane,
        expectedPreviewScroll.current,
        previewAnimation.current,
        140,
        (appliedTop) => {
          expectedPreviewScroll.current = appliedTop;
        },
      );
    }
  };

  const onToggleTask = useCallback((payload: TaskTogglePayload) => {
    const view = viewRef.current;
    const active = current.current;
    if (
      renameInProgressRef.current ||
      !view ||
      !taskToggleMatchesBinding(
        payload,
        active ? { vaultId: active.vaultId, notePath: active.note.path } : null,
      ) ||
      blocked.current ||
      !view.state.doc.toString().startsWith(payload.source)
    )
      return;
    const changes = taskMarkerChange(
      payload.offset,
      payload.expected,
      payload.source,
    );
    if (!changes) return;
    view.dispatch({
      changes,
      annotations: Transaction.userEvent.of('input.task'),
    });
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: renameReadOnlyCompartment.current.reconfigure(
        renameInProgress
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [],
      ),
    });
  }, [renameInProgress]);

  useLayoutEffect(() => {
    const wasReading = previousReadingMode.current;
    previousReadingMode.current = readingMode;
    if (!wasReading && readingMode && hasActiveNote) {
      // The key handler lives on the preview, so move focus there when it mounts.
      previewScrollRef.current?.focus({ preventScroll: true });
    } else if (wasReading && !readingMode && hasActiveNote) {
      // CodeMirror retains its selection, scroll position, and Vim state while
      // reading mode is on.
      viewRef.current?.focus();
    }
  }, [hasActiveNote, readingMode]);

  useLayoutEffect(() => {
    if (!hasActiveNote || !pendingFocus.current) return;
    pendingFocus.current = false;
    viewRef.current?.focus();
  }, [hasActiveNote]);

  useEffect(
    () =>
      window.vault.onTogglePreview(() => {
        setPreviewVisible((visible) => !visible);
      }),
    [],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        !isPreviewFindShortcut(event) ||
        !(event.target instanceof Element) ||
        !event.target.closest('[data-pane="editor"]') ||
        !hasActiveNote
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (findOpen) {
        setFindOpen(false);
      } else {
        const target = event.target.closest('.cm-editor, [data-preview-focus]');
        if (target instanceof HTMLElement) findReturnFocus.current = target;
        setPreviewVisible(true);
        setFindOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [findOpen, hasActiveNote]);

  useLayoutEffect(() => {
    const wasOpen = previousFindOpen.current;
    previousFindOpen.current = findOpen;
    if (!wasOpen || findOpen) return;

    // Let the preview's Find input unmount and finish its blur before restoring
    // focus; otherwise its cleanup can move focus back to document.body.
    const frame = requestAnimationFrame(() => {
      const savedTarget = findReturnFocus.current;
      const target =
        savedTarget?.isConnected && typeof savedTarget.focus === 'function'
          ? savedTarget
          : viewRef.current?.dom;
      target?.focus({ preventScroll: true });
      if (
        document.activeElement === document.body ||
        !paneRoot.current?.contains(document.activeElement)
      ) {
        paneRoot.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [findOpen]);

  const managedActive = () => {
    const active = current.current;
    return Boolean(
      active &&
      matchesAgentEditor(
        agentDocumentRef.current ?? undefined,
        active.vaultId,
        active.note.path,
      ),
    );
  };

  const save = async (): Promise<boolean> => {
    if (managedActive()) return agentDocumentRef.current!.flush();
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) {
      const succeeded = await inFlight.current;
      return succeeded && (dirty.current ? save() : true);
    }
    const view = viewRef.current;
    const active = current.current;
    const installed = binding.current;
    if (!dirty.current) return true;
    if (
      !active ||
      !view ||
      !installed ||
      !shouldSaveBoundDocument({
        currentView: view,
        bindingView: installed.view,
        currentGeneration: generation.current,
        bindingGeneration: installed.generation,
        currentNote: active,
        boundNote: current.current,
        blocked: blocked.current,
      })
    ) {
      setStatus('Unsaved');
      notifyError(
        'Note is not safely bound to this editor. Edits were not saved.',
        true,
      );
      return false;
    }
    const saveGeneration = installed.generation;
    const saveActive = active;
    const content = view.state.doc.toString();
    const expectedRevision = revision.current;
    if (!expectedRevision) return false;
    setStatus('Saving…');
    const operation = window.vault
      .saveNote({
        vaultPath: active.vaultPath,
        path: active.note.path,
        content,
        revision: expectedRevision,
      })
      .then((result) => {
        const stillBound =
          binding.current === installed &&
          isCurrentSaveCompletion({
            currentView: viewRef.current,
            bindingView: installed.view,
            currentGeneration: generation.current,
            bindingGeneration: saveGeneration,
            currentNote: current.current,
            boundNote: saveActive,
            blocked: blocked.current,
          });
        if (stillBound) revision.current = result.revision;
        if (
          stillBound &&
          isSaveCompletionContentUnchanged(view.state.doc.toString(), content)
        ) {
          dirty.current = false;
          active.note = { ...active.note, content, revision: result.revision };
          setStatus('Saved');
        }
        return true;
      })
      .catch((cause: unknown) => {
        if (
          binding.current === installed &&
          generation.current === saveGeneration &&
          current.current === saveActive
        ) {
          blocked.current = true;
          const message =
            cause instanceof Error ? cause.message : 'Unable to save note.';
          setStatus('Unsaved');
          notifyError(
            /changed outside|revision/i.test(message)
              ? `Save conflict: ${message} Reload the note before saving again.`
              : `Could not save note: ${message}`,
            true,
          );
        }
        return false;
      })
      .finally(() => {
        inFlight.current = null;
        if (dirty.current && !blocked.current)
          timer.current = setTimeout(() => {
            void save();
          }, 750);
      });
    inFlight.current = operation;
    return operation;
  };

  const install = (tab: NoteTabSnapshot) => {
    previewAnimation.current.cancel();
    editorAnimation.current.cancel();
    expectedPreviewScroll.current = null;
    expectedEditorScroll.current = null;
    managedPreviewBatch.current.dispose();
    const view = viewRef.current;
    if (!view) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    binding.current = null;
    generation.current += 1;
    current.current = {
      note: tab.note,
      vaultPath: tab.vaultPath,
      vaultId: tab.vaultId,
    };
    setHasActiveNote(true);
    revision.current = tab.note.revision;
    dirty.current = false;
    blocked.current = false;
    view.setState(tab.state);
    binding.current = { view, generation: generation.current };
    publishPreviewSnapshot({
      vaultId: tab.vaultId,
      notePath: tab.note.path,
      markdown: tab.state.doc.toString(),
    });
    view.dispatch({
      effects: vimCompartment.current.reconfigure(vimMode ? vim() : []),
    });
    view.scrollDOM.scrollTop = tab.scrollTop;
    setStatus('');
  };

  useImperativeHandle(ref, () => ({
    flush: save,
    syncManagedState: (vaultId, path, state) => {
      const view = viewRef.current;
      const active = current.current;
      if (
        !view ||
        !active ||
        !matchesAgentEditor(
          agentDocumentRef.current ?? undefined,
          vaultId,
          path,
        ) ||
        active.vaultId !== vaultId ||
        active.note.path !== path
      )
        return false;
      if (view.state !== state) view.setState(state);
      const nextPreview = {
        vaultId,
        notePath: path,
        markdown: state.doc.toString(),
      };
      const managedWriting =
        (agentDocumentRef.current?.writing ?? agentWriting) ||
        Boolean(activeNoteKey && writingBaseline.current.has(activeNoteKey));
      const currentPreview = previewSnapshot.current;
      const previewUnchanged =
        currentPreview?.vaultId === nextPreview.vaultId &&
        currentPreview.notePath === nextPreview.notePath &&
        currentPreview.markdown === nextPreview.markdown;
      if (previewUnchanged) return true;
      if (managedWriting) {
        if (activeNoteKey && !writingBaseline.current.has(activeNoteKey)) {
          const baseline = previewSnapshot.current;
          if (baseline?.vaultId === vaultId && baseline.notePath === path) {
            const acquired = acquireWritingBaseline(
              null,
              activeNoteKey,
              baseline.markdown,
            );
            if (acquired)
              writingBaseline.current.set(activeNoteKey, acquired.markdown);
          }
        }
        managedPreviewBatch.current.schedule(nextPreview);
      } else {
        managedPreviewBatch.current.publishNow(nextPreview);
      }
      return true;
    },
    snapshot: () => {
      const view = viewRef.current;
      const active = current.current;
      if (!view || !active) return null;
      return {
        kind: 'note',
        note: {
          ...active.note,
          content: view.state.doc.toString(),
          revision: revision.current ?? active.note.revision,
        },
        vaultPath: active.vaultPath,
        vaultId: active.vaultId,
        state: view.state,
        scrollTop: view.scrollDOM.scrollTop,
      };
    },
    activate: (tab) => {
      if (tab.kind === 'note') install(tab);
      else {
        cancelScrollAnimations();
        expectedPreviewScroll.current = null;
        expectedEditorScroll.current = null;
        binding.current = null;
        generation.current += 1;
        current.current = null;
        pendingFocus.current = false;
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        dirty.current = false;
        blocked.current = false;
        revision.current = null;
        setHasActiveNote(false);
        previewSnapshot.current = null;
        setPreview(null);
        viewRef.current?.setState(
          EditorState.create({
            doc: '',
            extensions: [...extensions.current, EditorState.readOnly.of(true)],
          }),
        );
        setStatus('');
      }
    },
    createState: (content) =>
      EditorState.create({ doc: content, extensions: extensions.current }),
    openNote: (note, vaultPath, vaultId) =>
      install({
        kind: 'note',
        note,
        vaultPath,
        vaultId,
        state: EditorState.create({
          doc: note.content,
          extensions: extensions.current,
        }),
        scrollTop: 0,
      }),
    focus: () => {
      if (imageAsset || pdfAsset) {
        host.current
          ?.closest('[data-pane="editor"]')
          ?.querySelector<HTMLElement>('[data-image-viewer="true"]')
          ?.focus({ preventScroll: true });
      } else if (readingMode && previewScrollRef.current) {
        previewScrollRef.current.focus({ preventScroll: true });
      } else if (hasActiveNote) viewRef.current?.focus();
      else if (current.current) pendingFocus.current = true;
    },
    format: (kind) => {
      const target = document.activeElement;
      if (
        !(target instanceof HTMLElement) ||
        !target.closest('.cm-content') ||
        target.closest('.cm-vim-panel')
      )
        return false;
      return formatSelection(kind);
    },
    isNormalMode: () => {
      const state = viewRef.current?.state as
        | (EditorState & {
            vim?: { insertMode?: boolean; visualMode?: boolean };
          })
        | undefined;
      const vimState = state?.vim;
      return Boolean(
        vimState &&
        vimState.insertMode === false &&
        vimState.visualMode === false,
      );
    },
    clear: () => {
      const view = viewRef.current;
      if (!view) return;
      cancelScrollAnimations();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      expectedPreviewScroll.current = null;
      expectedEditorScroll.current = null;
      binding.current = null;
      generation.current += 1;
      current.current = null;
      pendingFocus.current = false;
      setHasActiveNote(false);
      revision.current = null;
      dirty.current = false;
      blocked.current = false;
      view.setState(
        EditorState.create({
          doc: '',
          extensions: [...extensions.current, EditorState.readOnly.of(true)],
        }),
      );
      previewSnapshot.current = null;
      setPreview(null);
      view.dispatch({
        effects: vimCompartment.current.reconfigure(vimMode ? vim() : []),
      });
      view.scrollDOM.scrollTop = 0;
      setStatus('Select a note');
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    extensions.current = [
      markdown(),
      Prec.highest(
        EditorView.domEventHandlers({
          mousedown: (event, view) => {
            if (
              event.button === 0 &&
              event.target === view.contentDOM &&
              view.state.selection.ranges.some((range) => !range.empty)
            ) {
              const position = view.posAtCoords({
                x: event.clientX,
                y: event.clientY,
              });
              if (position !== null) {
                view.focus();
                view.dispatch({ selection: { anchor: position } });
                return false;
              }
            }
            if (
              !shouldBlockAgentEditorMouseDown(
                Boolean(agentDocumentRef.current?.writing),
              )
            )
              return false;
            event.preventDefault();
            return true;
          },
          paste: (event, view) => {
            if (renameInProgressRef.current) return false;
            const target = event.target;
            const active = current.current;
            const installed = binding.current;
            if (
              readingMode ||
              !active ||
              !installed ||
              !view.hasFocus ||
              !(target instanceof HTMLElement) ||
              !target.closest('.cm-content') ||
              target.closest('.cm-vim-panel') ||
              !shouldSaveBoundDocument({
                currentView: view,
                bindingView: installed.view,
                currentGeneration: generation.current,
                bindingGeneration: installed.generation,
                currentNote: active,
                boundNote: current.current,
                blocked: blocked.current,
              })
            )
              return false;
            const item = Array.from(event.clipboardData?.items ?? []).find(
              (entry) =>
                entry.kind === 'file' && entry.type.startsWith('image/'),
            );
            const file = item?.getAsFile();
            if (!file) return false;
            const supported = new Set([
              'image/png',
              'image/jpeg',
              'image/gif',
              'image/webp',
              'image/avif',
            ]);
            if (!supported.has(file.type)) return false;
            event.preventDefault();
            const pastePosition = {
              from: view.state.selection.main.from,
              to: view.state.selection.main.to,
              replaceSelection:
                view.state.selection.main.from !== view.state.selection.main.to,
            };
            pendingImagePastes.current.push(pastePosition);
            const captured = {
              vaultId: active.vaultId,
              notePath: active.note.path,
              installed,
              generation: generation.current,
              pastePosition,
            };
            void file
              .arrayBuffer()
              .then(async (buffer) => {
                const bytes = new Uint8Array(buffer);
                if (bytes.length > 10 * 1024 * 1024)
                  throw new Error('Clipboard image exceeds the 10 MB limit.');
                let binary = '';
                for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                  binary += String.fromCharCode(
                    ...bytes.subarray(offset, offset + 0x8000),
                  );
                }
                const result = await window.vault.pasteImage({
                  vaultId: active.vaultId,
                  notePath: active.note.path,
                  mimeType: file.type,
                  base64: btoa(binary),
                });
                const filename =
                  result.imagePath.split('/').pop() ?? result.imagePath;
                const copyPath = async () => {
                  try {
                    if (!navigator.clipboard?.writeText)
                      throw new Error('Clipboard access is unavailable.');
                    await navigator.clipboard.writeText(result.imagePath);
                    notifySuccess(`Copied ${result.imagePath}`);
                  } catch {
                    notifyError('Could not copy image path to clipboard.');
                  }
                };
                if (
                  renameInProgressRef.current ||
                  viewRef.current !== view ||
                  !current.current ||
                  current.current.vaultId !== captured.vaultId ||
                  current.current.note.path !== captured.notePath ||
                  binding.current !== captured.installed ||
                  generation.current !== captured.generation
                ) {
                  pendingImagePastes.current =
                    pendingImagePastes.current.filter(
                      (pending) => pending !== captured.pastePosition,
                    );
                  notifySuccess('Image saved; note is no longer active', {
                    label: 'Copy path',
                    onClick: () => void copyPath(),
                  });
                  return;
                }
                const link = `![](${result.imagePath})`;
                const { from } = captured.pastePosition;
                view.dispatch({
                  changes: imagePasteChange(captured.pastePosition, link),
                  selection: { anchor: from + link.length },
                  annotations: Transaction.userEvent.of('input.paste'),
                });
                pendingImagePastes.current = pendingImagePastes.current.filter(
                  (pending) => pending !== captured.pastePosition,
                );
                notifySuccess(`Image pasted: ${filename}`, {
                  label: 'Copy path',
                  onClick: () => void copyPath(),
                });
              })
              .catch((error: unknown) => {
                pendingImagePastes.current = pendingImagePastes.current.filter(
                  (pending) => pending !== captured.pastePosition,
                );
                notifyError(
                  error instanceof Error
                    ? error.message
                    : 'Could not paste image.',
                );
              });
            return true;
          },
          keydown: (event) => {
            if (
              !event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              [
                'ArrowUp',
                'ArrowDown',
                'PageUp',
                'PageDown',
                'Home',
                'End',
                ' ',
              ].includes(event.key)
            )
              cancelScrollAnimations();
          },
        }),
      ),
      vimCompartment.current.of(vimMode ? vim() : []),
      renameReadOnlyCompartment.current.of(
        renameInProgress
          ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
          : [],
      ),
      writingLockCompartment.current.of([]),
      ...markdownEditorExtensions,
      appearanceCompartment.current.of(
        createMarkdownSyntaxHighlighting(
          appearance.headings.map((color, index) =>
            rgbaColor(color, appearance.opacity[`heading-${index + 1}`]),
          ),
        ),
      ),
      lineNumbers(),
      foldGutter({
        markerDOM: (open) => {
          const marker = document.createElement('span');
          marker.classList.add('cm-foldMarker');
          const icon = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg',
          );
          icon.setAttribute('viewBox', '0 0 24 24');
          icon.setAttribute('aria-hidden', 'true');
          icon.classList.add('cm-foldMarkerIcon');
          if (!open) icon.classList.add('is-collapsed');
          const path = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'path',
          );
          path.setAttribute('d', 'm6 9 6 6 6-6');
          icon.append(path);
          marker.append(icon);
          return marker;
        },
      }),
      EditorView.lineWrapping,
      drawSelection({ cursorBlinkRate: 1000 }),
      highlightActiveLine(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          for (const pending of pendingImagePastes.current) {
            mapImagePasteAnchor(pending, update.changes);
          }
        }
        const active = current.current;
        const installed = binding.current;
        if (
          !active ||
          !installed ||
          installed.view !== viewRef.current ||
          installed.generation !== generation.current
        )
          return;
        const userSelectionChange = isUserSelectionChange(
          update.selectionSet,
          update.transactions,
        );
        if (update.selectionSet || update.docChanged)
          onLayoutChangeRef.current?.();
        if (userSelectionChange) {
          if (pendingCursorFollow.current !== null)
            cancelAnimationFrame(pendingCursorFollow.current);
          pendingCursorFollow.current = requestAnimationFrame(() => {
            pendingCursorFollow.current = null;
            followCursor();
          });
        }
        if (!update.docChanged) return;
        if (active) {
          publishPreviewSnapshot({
            vaultId: active.vaultId,
            notePath: active.note.path,
            markdown: update.state.doc.toString(),
          });
        }
        if (managedActive()) {
          agentDocumentRef.current!.onStateChange(update.state);
          return;
        }
        dirty.current = true;
        setStatus('');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void save();
        }, 750);
      }),
      EditorView.theme({
        '.cm-gutters': {
          backgroundColor: 'transparent',
          border: 'none',
          color: 'rgba(255, 255, 255, 0.4)',
        },
        '.cm-tooltip, .cm-vim-panel': {
          color: 'rgba(255, 255, 255, 0.9)',
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          backdropFilter: 'blur(12px)',
        },
        '.cm-tooltip-autocomplete ul li[aria-selected]': {
          backgroundColor: 'rgba(255, 255, 255, 0.18)',
          color: 'white',
        },
        '.cm-vim-panel input': {
          color: 'inherit',
          backgroundColor: 'transparent',
          caretColor: 'white',
        },
        '.cm-content': {
          caretColor: 'var(--storm-cursor)',
          padding: '0 16px 0 0',
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeft: '1.5px solid var(--storm-cursor)',
        },
        '.cm-activeLine': { backgroundColor: 'var(--storm-active-line)' },
      }),
    ];
    const view = new EditorView({
      state: EditorState.create({ extensions: extensions.current }),
      parent: host.current,
    });
    viewRef.current = view;
    const onScroll = () => {
      if (editorAnimation.current.active) return;
      if (
        expectedEditorScroll.current !== null &&
        Math.abs(view.scrollDOM.scrollTop - expectedEditorScroll.current) < 1
      ) {
        expectedEditorScroll.current = null;
        return;
      }
      expectedEditorScroll.current = null;
      if (current.current) onLayoutChangeRef.current?.();
    };
    const cancelOnUserInput = () => {
      if (pendingCursorFollow.current !== null) {
        cancelAnimationFrame(pendingCursorFollow.current);
        pendingCursorFollow.current = null;
      }
      cancelScrollAnimations();
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    view.scrollDOM.addEventListener('wheel', cancelOnUserInput, {
      passive: true,
    });
    view.scrollDOM.addEventListener('pointerdown', cancelOnUserInput, {
      passive: true,
    });
    view.scrollDOM.addEventListener('touchstart', cancelOnUserInput, {
      passive: true,
    });
    const previewPane = previewScrollRef.current;
    previewPane?.addEventListener('wheel', cancelOnUserInput, {
      passive: true,
    });
    previewPane?.addEventListener('pointerdown', cancelOnUserInput, {
      passive: true,
    });
    previewPane?.addEventListener('touchstart', cancelOnUserInput, {
      passive: true,
    });
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      view.scrollDOM.removeEventListener('wheel', cancelOnUserInput);
      view.scrollDOM.removeEventListener('pointerdown', cancelOnUserInput);
      view.scrollDOM.removeEventListener('touchstart', cancelOnUserInput);
      previewPane?.removeEventListener('wheel', cancelOnUserInput);
      previewPane?.removeEventListener('pointerdown', cancelOnUserInput);
      previewPane?.removeEventListener('touchstart', cancelOnUserInput);
      previewAnimation.current.cancel();
      editorAnimation.current.cancel();
      if (pendingCursorFollow.current !== null) {
        cancelAnimationFrame(pendingCursorFollow.current);
        pendingCursorFollow.current = null;
      }
      if (timer.current) clearTimeout(timer.current);
      managedPreviewBatch.current.dispose();
      pendingImagePastes.current = [];
      if (binding.current?.view === view) {
        binding.current = null;
        generation.current += 1;
      }
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!agentWriting && !agentDocument?.writing)
      managedPreviewBatch.current.flush();
    viewRef.current?.dispatch({
      effects: [
        vimCompartment.current.reconfigure(vimMode ? vim() : []),
        writingLockCompartment.current.reconfigure(
          agentWritingLockExtensions(Boolean(agentDocument?.writing)),
        ),
      ],
    });
  }, [vimMode, agentDocument?.writing, agentWriting]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: appearanceCompartment.current.reconfigure(
        createMarkdownSyntaxHighlighting(
          appearance.headings.map((color, index) =>
            rgbaColor(color, appearance.opacity[`heading-${index + 1}`]),
          ),
        ),
      ),
    });
    document.documentElement.style.setProperty(
      '--storm-selection',
      rgbaColor(appearance.selection, appearance.opacity.selection),
    );
    document.documentElement.style.setProperty(
      '--storm-active-line',
      rgbaColor(appearance.activeLine, appearance.opacity.activeLine),
    );
    document.documentElement.style.setProperty(
      '--storm-cursor',
      rgbaColor(appearance.cursor, appearance.opacity.cursor),
    );
  }, [appearance]);

  return (
    <section
      ref={paneRoot}
      data-pane="editor"
      tabIndex={-1}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-0 p-4 text-white"
    >
      <div
        className={`editor-pane-shell relative flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl ${tabsVisible ? 'editor-pane-shell--visible' : 'editor-pane-shell--hidden'}`}
      >
        <main
          className={`editor-pane-surface relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border p-0 ${tabsVisible ? 'editor-pane-surface--visible' : 'editor-pane-surface--hidden'}`}
        >
          <div
            className={`editor-toolbar flex min-h-0 shrink-0 items-center gap-2 overflow-visible px-2 ${tabsVisible || hasActiveNote ? 'h-11' : 'h-0'}`}
          >
            <div
              className={`tab-bar-slot min-w-0 flex-1 ${tabsVisible ? 'tab-bar-slot--visible' : 'tab-bar-slot--hidden'}`}
              aria-hidden={!tabsVisible}
              inert={!tabsVisible}
            >
              <div
                className={`tab-bar-content ${tabsVisible ? 'tab-bar-content--visible' : 'tab-bar-content--hidden'}`}
              >
                {tabs}
              </div>
            </div>
            <div className="flex shrink-0 items-center justify-end gap-0.5">
              {hasActiveNote && (
                <>
                  <button
                    type="button"
                    aria-label="Toggle note search"
                    title={`Find in note (${navigator.platform.toLowerCase().includes('mac') ? '⌘F' : 'Ctrl+F'})`}
                    onClick={() => {
                      if (!findOpen) {
                        findReturnFocus.current =
                          document.activeElement instanceof HTMLElement
                            ? document.activeElement
                            : null;
                      }
                      setFindOpen((open) => !open);
                    }}
                    className="editor-action-button app-icon-button"
                  >
                    <IoSearch size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={
                      previewVisible ? 'Hide preview' : 'Show preview'
                    }
                    aria-pressed={previewVisible}
                    title={`${previewVisible ? 'Hide' : 'Show'} preview (${navigator.platform.toLowerCase().includes('mac') ? '⌘⇧M' : 'Ctrl+Shift+M'})`}
                    onClick={() => {
                      cancelScrollAnimations();
                      setPreviewVisible((visible) => !visible);
                    }}
                    className={`editor-action-button app-icon-button relative ${previewVisible ? 'bg-white/10 !text-white' : ''}`}
                  >
                    <MdOutlineHideImage size={14} aria-hidden="true" />
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-150 ${commandHeld ? 'opacity-100' : 'opacity-0'}`}
                    >
                      <span className="whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white">
                        {navigator.platform.toLowerCase().includes('mac')
                          ? '⌘⇧M'
                          : 'Ctrl+Shift+M'}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={
                      agentStatusVisible
                        ? 'Hide agent status'
                        : 'Show agent status'
                    }
                    title={
                      agentStatusVisible
                        ? 'Hide agent status'
                        : 'Show agent status'
                    }
                    aria-pressed={agentStatusVisible}
                    onClick={toggleAgentStatusVisibility}
                    className={`editor-action-button app-icon-button ${agentStatusVisible ? 'bg-white/10 !text-white' : ''}`}
                  >
                    <RxLightningBolt size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={
                      readingMode ? 'Exit reading mode' : 'Enter reading mode'
                    }
                    aria-pressed={readingMode}
                    title={`Toggle reading mode (${navigator.platform.includes('Mac') ? '⌘E' : 'Ctrl+E'})`}
                    onClick={onToggleReadingMode}
                    className={`editor-action-button app-icon-button relative ${readingMode ? 'bg-white/10 !text-white' : ''}`}
                  >
                    <MdOutlineRemoveRedEye size={14} aria-hidden="true" />
                    <span
                      aria-hidden="true"
                      className={`pointer-events-none absolute inset-0 z-20 flex items-center justify-center transition-opacity duration-150 ${commandHeld ? 'opacity-100' : 'opacity-0'}`}
                    >
                      <span className="whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white">
                        {navigator.platform.toLowerCase().includes('mac')
                          ? '⌘E'
                          : 'Ctrl+E'}
                      </span>
                    </span>
                  </button>
                </>
              )}
            </div>
          </div>
          <AgentStatusBar
            status={agentStatus}
            onStop={onStopAgent}
            visible={agentStatusVisible}
            visualStatus={statusVisualOverride}
          />
          <div className="flex w-full min-h-0 min-w-0 flex-1 overflow-hidden">
            {imageAsset ? (
              <AssetPreviewPane
                vaultId={imageAsset.vaultId}
                relativePath={imageAsset.path}
                filename={imageAsset.filename}
              />
            ) : pdfAsset ? (
              <PdfViewer
                vaultId={pdfAsset.vaultId}
                relativePath={pdfAsset.relativePath}
                fileName={pdfAsset.fileName}
              />
            ) : null}
            <div
              className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${!hasActiveNote || imageAsset || pdfAsset ? 'hidden' : ''}`}
            >
              <div
                ref={host}
                className={`h-full min-h-0 min-w-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:min-h-0 [&_.cm-editor]:min-w-0 [&_.cm-scroller]:overflow-auto ${readingMode ? 'invisible' : ''}`}
              />
              {readingMode && preview && vaultId === preview.vaultId && (
                <div className="absolute inset-0 z-10 overflow-hidden">
                  <MarkdownPreview
                    key={`reading:${preview.vaultId}:${preview.notePath}`}
                    markdown={preview.markdown}
                    vaultId={preview.vaultId}
                    notePath={preview.notePath}
                    onToggleTask={onToggleTask}
                    onOpenNote={onOpenNote}
                    scrollRef={previewScrollRef}
                    onScroll={syncFromPreview}
                    onScrollIntent={markPreviewScrollIntent}
                    onUserScroll={cancelScrollAnimations}
                    onReadingKeyDown={onReadingKeyDown}
                    appearance={appearance}
                    compact
                    findOpen={findOpen}
                    onCloseFind={() => setFindOpen(false)}
                    previewRevision={preview?.previewRevision}
                    revealStartLine={
                      activeReveal?.documentKey === documentKey
                        ? activeReveal.startLine
                        : undefined
                    }
                    revealRanges={
                      activeReveal?.documentKey === documentKey
                        ? activeReveal.ranges
                        : undefined
                    }
                    revealId={
                      activeReveal?.documentKey === documentKey
                        ? currentRevealIdentity
                        : undefined
                    }
                    revealRegistry={revealSession.current?.registry}
                    onRevealProgress={onRevealProgress}
                  />
                </div>
              )}
              <div
                className="pointer-events-none absolute bottom-2 right-3 z-10 text-xs text-white/60"
                role="status"
              >
                {status}
              </div>
            </div>
            {hasActiveNote &&
            previewVisible &&
            !readingMode &&
            preview &&
            vaultId === preview.vaultId ? (
              <MarkdownPreview
                key={`${preview.vaultId}:${preview.notePath}`}
                markdown={preview.markdown}
                vaultId={preview.vaultId}
                notePath={preview.notePath}
                findOpen={findOpen}
                onCloseFind={() => setFindOpen(false)}
                onToggleTask={onToggleTask}
                onOpenNote={onOpenNote}
                scrollRef={previewScrollRef}
                onScroll={syncFromPreview}
                onScrollIntent={markPreviewScrollIntent}
                onUserScroll={cancelScrollAnimations}
                appearance={appearance}
                previewRevision={preview?.previewRevision}
                revealStartLine={
                  activeReveal?.documentKey === documentKey
                    ? activeReveal.startLine
                    : undefined
                }
                revealRanges={
                  activeReveal?.documentKey === documentKey
                    ? activeReveal.ranges
                    : undefined
                }
                revealId={
                  activeReveal?.documentKey === documentKey
                    ? currentRevealIdentity
                    : undefined
                }
                revealRegistry={revealSession.current?.registry}
                onRevealProgress={onRevealProgress}
              />
            ) : !hasActiveNote && !imageAsset && !pdfAsset ? (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 select-none">
                <div className="empty-editor-wordmark text-2xl font-medium tracking-wide text-white/50">
                  storm
                </div>
                <div className="empty-editor-shortcut flex items-center gap-2 text-sm">
                  <span>search note</span>
                  <kbd className="rounded-md bg-neutral-800/50 px-2 py-0.5 text-xs">
                    {navigator.platform.toLowerCase().includes('mac')
                      ? 'cmd + p'
                      : 'ctrl + p'}
                  </kbd>
                </div>
                <div className="empty-editor-shortcut flex items-center gap-2 text-sm">
                  <span>restore last tabs</span>
                  <kbd className="rounded-md bg-neutral-800/50 px-2 py-0.5 text-xs">
                    {navigator.platform.toLowerCase().includes('mac')
                      ? 'cmd + shift + t'
                      : 'ctrl + shift + t'}
                  </kbd>
                </div>
                <div className="empty-editor-shortcut flex items-center gap-2 text-sm">
                  <span>new tab</span>
                  <kbd className="rounded-md bg-neutral-800/50 px-2 py-0.5 text-xs">
                    {navigator.platform.toLowerCase().includes('mac')
                      ? 'cmd + t'
                      : 'ctrl + t'}
                  </kbd>
                </div>
                <div className="empty-editor-shortcut flex items-center gap-2 text-sm">
                  <span>close tab</span>
                  <kbd className="rounded-md bg-neutral-800/50 px-2 py-0.5 text-xs">
                    {navigator.platform.toLowerCase().includes('mac')
                      ? 'cmd + w'
                      : 'ctrl + w'}
                  </kbd>
                </div>
              </div>
            ) : null}
          </div>
        </main>
      </div>
    </section>
  );
});
export default Editor;
