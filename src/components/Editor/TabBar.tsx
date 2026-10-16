import type { TabSnapshot } from './Editor';

type Props = {
  tabs: TabSnapshot[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
};
export default function TabBar({ tabs, activePath, onSelect, onClose }: Props) {
  return (
    <nav
      aria-label="Open notes"
      className="flex h-7 min-h-7 min-w-0 shrink-0 items-stretch gap-0 overflow-x-auto bg-black/50 px-3"
    >
      {tabs.map(({ note }) => (
        <div
          key={note.path}
          className={`flex max-w-56 shrink-0 items-center border-r border-white/10 ${activePath === note.path ? 'bg-black/50 text-white' : 'text-white/60 hover:bg-white/10'}`}
        >
          <button
            type="button"
            onClick={() => onSelect(note.path)}
            aria-current={activePath === note.path ? 'page' : undefined}
            className="truncate px-2 py-1 text-[11px]"
            title={note.path}
          >
            {note.path.split('/').at(-1)}
          </button>
          <button
            type="button"
            onClick={() => onClose(note.path)}
            aria-label={`Close ${note.path}`}
            className="min-w-6 px-1.5 py-1 text-[11px] text-white/50 hover:text-white"
          >
            ×
          </button>
        </div>
      ))}
    </nav>
  );
}
