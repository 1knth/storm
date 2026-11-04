import { useEffect, useRef, useState } from 'react';

/**
 * Inline session title. Click to edit in place; Enter or blur saves, Escape
 * reverts. The field keeps the title's typography so editing does not jump.
 */
export default function QuizSessionName({
  name,
  placeholder = 'New session',
  onRename,
  editing: controlledEditing,
  onEditingChange,
  className = '',
  showTrigger = true,
}: {
  name: string | undefined;
  placeholder?: string;
  /** Resolves false to keep editing, for example after a failed save. */
  onRename: (name: string) => Promise<boolean>;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  className?: string;
  /** Hide the clickable title, for rows that open editing from elsewhere. */
  showTrigger?: boolean;
}) {
  const [localEditing, setLocalEditing] = useState(false);
  const editing = controlledEditing ?? localEditing;
  const setEditing = (value: boolean) => {
    setLocalEditing(value);
    onEditingChange?.(value);
  };
  const [draft, setDraft] = useState(name ?? '');
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Blur after Enter or Escape must not save a second time.
  const settled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    settled.current = false;
    setDraft(name ?? '');
    requestAnimationFrame(() => input.current?.select());
  }, [editing]);

  const commit = async () => {
    if (settled.current || saving) return;
    const next = draft.trim();
    if (!next || next === (name ?? '').trim()) {
      settled.current = true;
      setEditing(false);
      return;
    }
    settled.current = true;
    setSaving(true);
    const ok = await onRename(next).catch(() => false);
    setSaving(false);
    if (ok) setEditing(false);
    else {
      settled.current = false;
      requestAnimationFrame(() => input.current?.focus());
    }
  };

  if (editing)
    return (
      <input
        ref={input}
        aria-label="Session name"
        value={draft}
        maxLength={120}
        disabled={saving}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void commit();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            settled.current = true;
            setEditing(false);
          }
        }}
        onBlur={() => void commit()}
        className={`quiz-session-name-input min-w-[6ch] max-w-full rounded-md px-1.5 py-0.5 text-white outline-none placeholder:text-white/35 disabled:opacity-60 ${className}`}
      />
    );
  if (!showTrigger) return null;
  return (
    <button
      type="button"
      title="Rename session"
      aria-label={`Rename session ${name || placeholder}`}
      onClick={() => setEditing(true)}
      className={`flex min-w-0 max-w-full cursor-text items-center rounded-md px-1.5 py-0.5 text-left hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-1 focus-visible:outline-white/60 ${className}`}
    >
      <span className={`truncate ${name ? '' : 'text-white/50'}`}>
        {name || placeholder}
      </span>
    </button>
  );
}
