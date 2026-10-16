import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { vim } from '@replit/codemirror-vim';
import { Compartment, EditorState } from '@codemirror/state';
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
import MarkdownPreview from './MarkdownPreview';
import { useToast } from '../Toast';

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
};
type EditorProps = {
  vimMode: boolean;
  tabs: ReactNode;
  vaultId: string | null;
  onLayoutChange?: () => void;
};

const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { vimMode, tabs, vaultId, onLayoutChange },
  ref,
) {
  const { notifyError } = useToast();
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vimCompartment = useRef(new Compartment());
  const extensions = useRef<Extension[]>([]);
  const current = useRef<{
    note: NoteData;
    vaultPath: string;
    vaultId: string;
  } | null>(null);
  const revision = useRef<string | null>(null);
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
  const [hasActiveNote, setHasActiveNote] = useState(false);
  const pendingFocus = useRef(false);
  const [previewVisible, setPreviewVisible] = useState(true);

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
    if (!dirty.current || !active || !view || blocked.current)
      return !blocked.current;
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
        if (current.current === active) revision.current = result.revision;
        if (
          view.state.doc.toString() === content &&
          current.current === active
        ) {
          dirty.current = false;
          active.note = { ...active.note, content, revision: result.revision };
          setStatus('Saved');
        }
        return true;
      })
      .catch((cause: unknown) => {
        if (current.current === active) {
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
    const view = viewRef.current;
    if (!view) return;
    if (timer.current) clearTimeout(timer.current);
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
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
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
      vimCompartment.current.of(vimMode ? vim() : []),
      ...markdownEditorExtensions,
      lineNumbers(),
      EditorView.lineWrapping,
      drawSelection({ cursorBlinkRate: 1000 }),
      highlightActiveLine(),
      EditorView.updateListener.of((update) => {
        const active = current.current;
        if (!active) return;
        if (update.selectionSet || update.docChanged)
          onLayoutChangeRef.current?.();
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
        '.cm-content': { caretColor: '#027DFF', padding: '0 16px' },
        '.cm-cursor, .cm-dropCursor': { borderLeft: '1.5px solid #027DFF' },
        '.cm-activeLine': { backgroundColor: 'rgba(224, 191, 255, 0.1)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
          backgroundColor: 'rgba(224, 191, 255, 0.4)',
        },
      }),
    ];
    const view = new EditorView({
      state: EditorState.create({ extensions: extensions.current }),
      parent: host.current,
    });
    viewRef.current = view;
    const onScroll = () => {
      if (current.current) onLayoutChangeRef.current?.();
    };
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      view.scrollDOM.removeEventListener('scroll', onScroll);
      if (timer.current) clearTimeout(timer.current);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: vimCompartment.current.reconfigure(vimMode ? vim() : []),
    });
  }, [vimMode]);

  return (
    <section
      data-pane="editor"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 p-4 text-white"
    >
      {tabs}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-black/30 p-0">
        <div className="flex h-10 shrink-0 items-center justify-end px-3">
          {hasActiveNote && (
            <button
              type="button"
              aria-label={previewVisible ? 'Hide preview' : 'Show preview'}
              aria-pressed={previewVisible}
              title={`${previewVisible ? 'Hide' : 'Show'} preview (⌘⇧M)`}
              onClick={() => setPreviewVisible((visible) => !visible)}
              className="rounded-md px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white"
            >
              {previewVisible ? 'Hide preview' : 'Show preview'}
            </button>
          )}
        </div>
        <div className="flex w-full min-h-0 min-w-0 flex-1 overflow-hidden">
          <div
            className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${hasActiveNote ? '' : 'hidden'}`}
          >
            <div
              ref={host}
              className="h-full min-h-0 min-w-0 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:min-h-0 [&_.cm-editor]:min-w-0 [&_.cm-scroller]:overflow-auto"
            />
            <div
              className="pointer-events-none absolute bottom-2 right-3 z-10 text-xs text-white/60"
              role="status"
            >
              {status}
            </div>
          </div>
          {hasActiveNote &&
          previewVisible &&
          preview &&
          vaultId === preview.vaultId ? (
            <MarkdownPreview
              key={`${preview.vaultId}:${preview.notePath}`}
              markdown={preview.markdown}
              vaultId={preview.vaultId}
              notePath={preview.notePath}
            />
          ) : !hasActiveNote ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <div className="text-2xl font-medium tracking-wide text-white/50">
                storm
              </div>
              <div className="flex items-center gap-2 text-sm text-white/30">
                <span>search note</span>
                <kbd className="rounded-md bg-neutral-800/50 px-2 py-0.5 text-xs text-white/60">
                  cmd + p
                </kbd>
              </div>
              <div className="flex items-center gap-2 text-sm text-white/30">
                <span>restore last tabs</span>
                <kbd className="rounded-md bg-neutral-800/50 px-2 py-0.5 text-xs text-white/60">
                  cmd + shift + t
                </kbd>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </section>
  );
});
export default Editor;
