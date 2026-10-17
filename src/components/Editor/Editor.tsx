import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { AiOutlineFullscreen } from 'react-icons/ai';
import { markdown } from '@codemirror/lang-markdown';
import { Vim, vim } from '@replit/codemirror-vim';
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import type { ReactNode } from 'react';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  lineNumbers,
} from '@codemirror/view';
import type { NoteData } from '../../shared/types';
import { markdownEditorExtensions } from './extensions';
import { createMarkdownSyntaxHighlighting } from './markdownHighlighting';
import type { Appearance } from '../../appearance';
import { rgbaColor } from '../../appearance';
import MarkdownPreview from './MarkdownPreview';
import { taskMarkerChange, taskToggleMatchesBinding } from './markdownTasks';
import type { TaskTogglePayload } from './markdownTasks';
import { formatMarkdownSelection } from './markdownFormatting';
import {
  previewScrollTopForCursor,
  smoothScrollTo,
  previewTopAtSourceLine as mapPreviewTopAtSourceLine,
  type PreviewAnchor,
} from './previewScroll';
import { useToast } from '../Toast';
import {
  isCurrentSaveCompletion,
  isSaveCompletionContentUnchanged,
  shouldSaveBoundDocument,
} from './saveBinding';

// Keep these as Vim mappings (not CodeMirror key handlers) so uppercase J/K remain
// ordinary inserted text outside Vim modes and Vim's counts/operators keep working.
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
export type EmptyTabSnapshot = { kind: 'empty'; id: string };
export type TabSnapshot = NoteTabSnapshot | EmptyTabSnapshot;
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
  },
  ref,
) {
  const { notifyError } = useToast();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vimCompartment = useRef(new Compartment());
  const appearanceCompartment = useRef(new Compartment());
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
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;
  const [status, setStatus] = useState('');
  const [preview, setPreview] = useState<{
    vaultId: string;
    notePath: string;
    markdown: string;
  } | null>(null);
  const previewSnapshot = useRef(preview);
  previewSnapshot.current = preview;
  const [hasActiveNote, setHasActiveNote] = useState(false);
  const pendingFocus = useRef(false);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const expectedPreviewScroll = useRef<number | null>(null);
  const expectedEditorScroll = useRef<number | null>(null);
  const previewAnimation = useRef({ active: false, cancel: () => {} });
  const editorAnimation = useRef({ active: false, cancel: () => {} });
  const cancelScrollAnimations = useCallback(() => {
    previewAnimation.current.cancel();
    editorAnimation.current.cancel();
    expectedPreviewScroll.current = null;
    expectedEditorScroll.current = null;
  }, []);
  const [previewVisible, setPreviewVisible] = useState(true);
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
  const syncFromEditor = () => {
    const pane = previewScrollRef.current;
    const view = viewRef.current;
    if (!pane || !view) return;
    const lineBlock = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
    const line = view.state.doc.lineAt(lineBlock.from).number;
    const top = previewTopAtSourceLine(line);
    if (top === null) return;
    expectedPreviewScroll.current = Math.max(
      0,
      Math.min(pane.scrollHeight - pane.clientHeight, top),
    );
    smoothScrollTo(
      pane,
      expectedPreviewScroll.current,
      previewAnimation.current,
      140,
      (appliedTop) => {
        expectedPreviewScroll.current = appliedTop;
      },
    );
  };
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
      !view ||
      !taskToggleMatchesBinding(
        payload,
        active ? { vaultId: active.vaultId, notePath: active.note.path } : null,
      ) ||
      blocked.current ||
      view.state.doc.toString() !== payload.source
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

  const save = async (): Promise<boolean> => {
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
    setPreview({
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
      if (hasActiveNote) viewRef.current?.focus();
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
          paste: (event, view) => {
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
            const captured = {
              active,
              installed,
              generation: generation.current,
              state: view.state,
              from: view.state.selection.main.from,
              to: view.state.selection.main.to,
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
                if (
                  viewRef.current !== view ||
                  current.current !== captured.active ||
                  binding.current !== captured.installed ||
                  generation.current !== captured.generation ||
                  view.state !== captured.state ||
                  view.state.selection.main.from !== captured.from ||
                  view.state.selection.main.to !== captured.to
                )
                  return;
                const link = `![](${result.imagePath})`;
                view.dispatch({
                  changes: {
                    from: captured.from,
                    to: captured.to,
                    insert: link,
                  },
                  selection: { anchor: captured.from + link.length },
                  annotations: Transaction.userEvent.of('input.paste'),
                });
              })
              .catch((error: unknown) => {
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
      ...markdownEditorExtensions,
      appearanceCompartment.current.of(
        createMarkdownSyntaxHighlighting(
          appearance.headings.map((color, index) =>
            rgbaColor(color, appearance.opacity[`heading-${index + 1}`]),
          ),
          appearance.theme === 'light',
        ),
      ),
      lineNumbers(),
      EditorView.lineWrapping,
      drawSelection({ cursorBlinkRate: 1000 }),
      highlightActiveLine(),
      EditorView.updateListener.of((update) => {
        const active = current.current;
        const installed = binding.current;
        if (
          !active ||
          !installed ||
          installed.view !== viewRef.current ||
          installed.generation !== generation.current
        )
          return;
        if (update.selectionSet || update.docChanged) {
          onLayoutChangeRef.current?.();
          requestAnimationFrame(followCursor);
        }
        if (!update.docChanged) return;
        if (active) {
          setPreview({
            vaultId: active.vaultId,
            notePath: active.note.path,
            markdown: update.state.doc.toString(),
          });
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
        '.cm-content': { caretColor: 'var(--storm-cursor)', padding: '0 16px' },
        '.cm-cursor, .cm-dropCursor': {
          borderLeft: '1.5px solid var(--storm-cursor)',
        },
        '.cm-activeLine': { backgroundColor: 'rgba(224, 191, 255, 0.1)' },
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
      if (current.current) {
        syncFromEditor();
        onLayoutChangeRef.current?.();
      }
    };
    const cancelOnUserInput = () => {
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
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      view.scrollDOM.removeEventListener('wheel', cancelOnUserInput);
      view.scrollDOM.removeEventListener('pointerdown', cancelOnUserInput);
      view.scrollDOM.removeEventListener('touchstart', cancelOnUserInput);
      previewAnimation.current.cancel();
      editorAnimation.current.cancel();
      if (timer.current) clearTimeout(timer.current);
      if (binding.current?.view === view) {
        binding.current = null;
        generation.current += 1;
      }
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: vimCompartment.current.reconfigure(vimMode ? vim() : []),
    });
  }, [vimMode]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: appearanceCompartment.current.reconfigure(
        createMarkdownSyntaxHighlighting(
          appearance.headings.map((color, index) =>
            rgbaColor(color, appearance.opacity[`heading-${index + 1}`]),
          ),
          appearance.theme === 'light',
        ),
      ),
    });
    document.documentElement.style.setProperty(
      '--storm-selection',
      rgbaColor(appearance.selection, appearance.opacity.selection),
    );
    document.documentElement.style.setProperty(
      '--storm-cursor',
      rgbaColor(appearance.cursor, appearance.opacity.cursor),
    );
  }, [appearance]);

  return (
    <section
      data-pane="editor"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-0 p-4 text-white"
    >
      <div
        className={`tab-bar-slot shrink-0 ${tabsVisible ? 'tab-bar-slot--visible' : 'tab-bar-slot--hidden'}`}
        aria-hidden={!tabsVisible}
        inert={!tabsVisible}
      >
        <div
          className={`tab-bar-content ${tabsVisible ? 'tab-bar-content--visible' : 'tab-bar-content--hidden'}`}
        >
          {tabs}
        </div>
      </div>
      <div className="editor-pane-shell relative flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl">
        <main className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/15 bg-black/30 p-0">
          <div className="flex h-10 shrink-0 items-center justify-end gap-1 px-3">
            {hasActiveNote && (
              <>
                <button
                  type="button"
                  aria-label={previewVisible ? 'Hide preview' : 'Show preview'}
                  aria-pressed={previewVisible}
                  title={`${previewVisible ? 'Hide' : 'Show'} preview (${navigator.platform.toLowerCase().includes('mac') ? '⌘⇧M' : 'Ctrl+Shift+M'})`}
                  onClick={() => {
                    cancelScrollAnimations();
                    setPreviewVisible((visible) => !visible);
                  }}
                  className="editor-action-button app-button relative inline-flex h-7 items-center justify-center gap-1.5 px-2 text-xs text-white/60"
                >
                  {previewVisible ? 'Hide preview' : 'Show preview'}
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white transition-opacity duration-150 ${commandHeld ? 'opacity-100' : 'opacity-0'}`}
                  >
                    {navigator.platform.toLowerCase().includes('mac')
                      ? '⌘⇧M'
                      : 'Ctrl+Shift+M'}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={
                    readingMode ? 'Exit reading mode' : 'Enter reading mode'
                  }
                  aria-pressed={readingMode}
                  title={`Toggle reading mode (${navigator.platform.includes('Mac') ? '⌘E' : 'Ctrl+E'})`}
                  onClick={onToggleReadingMode}
                  className={`editor-action-button app-icon-button relative ${readingMode ? 'bg-white/10 text-white' : ''}`}
                >
                  <AiOutlineFullscreen size={14} aria-hidden="true" />
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute right-0 top-full z-20 mt-1 whitespace-nowrap rounded bg-black/90 px-1.5 py-0.5 text-[10px] leading-none text-white transition-opacity duration-150 ${commandHeld ? 'opacity-100' : 'opacity-0'}`}
                  >
                    {navigator.platform.toLowerCase().includes('mac')
                      ? '⌘E'
                      : 'Ctrl+E'}
                  </span>
                </button>
              </>
            )}
          </div>
          <div className="flex w-full min-h-0 min-w-0 flex-1 overflow-hidden">
            <div
              className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${!hasActiveNote ? 'hidden' : ''}`}
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
                    onUserScroll={cancelScrollAnimations}
                    appearance={appearance}
                    compact
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
                onToggleTask={onToggleTask}
                onOpenNote={onOpenNote}
                scrollRef={previewScrollRef}
                onScroll={syncFromPreview}
                onUserScroll={cancelScrollAnimations}
                appearance={appearance}
              />
            ) : !hasActiveNote ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 select-none">
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
