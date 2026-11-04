import { useState } from 'react';
import {
  Excalidraw,
  exportToBlob,
  getNonDeletedElements,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';

type Props = {
  onAttach: (file: File) => void;
  onClose: () => void;
};

/** Freehand canvas for work that is awkward to type, such as truth tables. */
export default function QuizSketch({ onAttach, onClose }: Props) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [busy, setBusy] = useState(false);

  async function attach() {
    if (!api) return;
    const elements = getNonDeletedElements(api.getSceneElements());
    if (!elements.length) return onClose();
    setBusy(true);
    try {
      const blob = await exportToBlob({
        elements,
        files: api.getFiles(),
        mimeType: 'image/png',
        exportPadding: 16,
        // A light background keeps strokes legible for the grader.
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff' },
      });
      onAttach(new File([blob], 'sketch.png', { type: 'image/png' }));
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Sketch your answer"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void attach();
        }
      }}
    >
      <div className="flex h-full max-h-[48rem] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/15 bg-[#121212]">
        <div className="relative min-h-0 flex-1">
          <Excalidraw
            excalidrawAPI={setApi}
            theme="dark"
            initialData={{ appState: { gridModeEnabled: true } }}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                saveAsImage: false,
              },
            }}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-white/10 px-3 py-2 text-sm">
          <button
            type="button"
            className="cursor-pointer rounded px-3 py-1 text-white/70 hover:bg-white/10"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!api || busy}
            className="cursor-pointer rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-500 disabled:opacity-50"
            onClick={() => void attach()}
          >
            Attach sketch
          </button>
        </div>
      </div>
    </div>
  );
}
