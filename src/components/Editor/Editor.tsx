import {
  forwardRef,
  useEffect,
  useImperativeHandle,
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
} from '@codemirror/view';
import type { NoteData } from '../../shared/types';
import { markdownEditorExtensions } from './extensions';

export type TabSnapshot = {
  note: NoteData;
  vaultPath: string;
  state: EditorState;
  scrollTop: number;
};
export type EditorHandle = {
  flush: () => Promise<boolean>;
  snapshot: () => TabSnapshot | null;
  activate: (tab: TabSnapshot) => void;
  openNote: (note: NoteData, vaultPath: string) => void;
};
type EditorProps = { vimMode: boolean; tabs: ReactNode };

const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { vimMode, tabs },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vimCompartment = useRef(new Compartment());
  const extensions = useRef<Extension[]>([]);
  const current = useRef<{ note: NoteData; vaultPath: string } | null>(null);
  const revision = useRef<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);
  const [status, setStatus] = useState('');

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
        revision.current = result.revision;
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
        blocked.current = true;
        setStatus(
          cause instanceof Error &&
            /changed outside|revision/i.test(cause.message)
            ? 'Conflict — reload before saving'
            : 'Save failed — changes kept in editor',
        );
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

  const install = (tab: TabSnapshot) => {
    const view = viewRef.current;
    if (!view) return;
    if (timer.current) clearTimeout(timer.current);
    current.current = { note: tab.note, vaultPath: tab.vaultPath };
    revision.current = tab.note.revision;
    dirty.current = false;
    blocked.current = false;
    view.setState(tab.state);
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
        note: {
          ...active.note,
          content: view.state.doc.toString(),
          revision: revision.current ?? active.note.revision,
        },
        vaultPath: active.vaultPath,
        state: view.state,
        scrollTop: view.scrollDOM.scrollTop,
      };
    },
    activate: install,
    openNote: (note, vaultPath) =>
      install({
        note,
        vaultPath,
        state: EditorState.create({
          doc: note.content,
          extensions: extensions.current,
        }),
        scrollTop: 0,
      }),
  }));

  useEffect(() => {
    if (!host.current) return;
    extensions.current = [
      markdown(),
      vimCompartment.current.of(vimMode ? vim() : []),
      ...markdownEditorExtensions,
      EditorView.lineWrapping,
      drawSelection({ cursorBlinkRate: 1000 }),
      highlightActiveLine(),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        dirty.current = true;
        setStatus('');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void save();
        }, 750);
      }),
      EditorView.theme({
        '.cm-content': { caretColor: '#027DFF' },
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
    return () => {
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
    <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-2 p-4 text-white">
      {tabs}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl bg-black/30 p-0">
        <div className="flex w-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="h-7 shrink-0 text-xs text-white/60" role="status">
            {status}
          </div>
          <div
            ref={host}
            className="min-h-0 min-w-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:min-h-0 [&_.cm-editor]:min-w-0 [&_.cm-scroller]:overflow-auto"
          />
        </div>
      </main>
    </section>
  );
});
export default Editor;
