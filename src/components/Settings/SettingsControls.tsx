import { useEffect, useState } from 'react';
import { commitOpacityDraft } from '../../appearance';

/** A titled block of rows inside a pane. */
export function SettingsGroup({
  title,
  note,
  children,
}: {
  title?: string;
  note?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-group">
      {title && <h4 className="settings-group-title">{title}</h4>}
      {note && <p className="settings-group-note">{note}</p>}
      {children}
    </section>
  );
}

/** Label and optional hint on the left, control on the right. */
export function SettingsRow({
  label,
  hint,
  hintClassName,
  htmlFor,
  children,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  hintClassName?: string;
  htmlFor?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <span>
        {htmlFor ? (
          <label className="settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {hint && (
          <span className={`settings-row-hint ${hintClassName ?? ''}`.trim()}>
            {hint}
          </span>
        )}
      </span>
      {children && <span className="settings-row-control">{children}</span>}
    </div>
  );
}

/** A row whose whole label area toggles the switch. */
export function SettingsToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-row settings-row--toggle">
      <span>
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </span>
      <span className="settings-row-control">
        <input
          type="checkbox"
          className="settings-switch"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
      </span>
    </label>
  );
}

/** Renders a shortcut as separate keycaps: Keys chord="⌘ P". */
export function Keys({ chord }: { chord: string }) {
  return (
    <span className="settings-keys">
      {chord.split(' ').map((key, index) => (
        <kbd key={`${key}-${index}`}>{key}</kbd>
      ))}
    </span>
  );
}

/**
 * Opacity is typed as a percentage and committed on blur or Enter so partial
 * input never reaches persisted appearance.
 */
export function OpacityInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = commitOpacityDraft(draft, value);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      aria-label={`${label} opacity`}
      type="text"
      inputMode="decimal"
      className="app-input settings-opacity-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Color swatch with an aligned opacity field, when the color has one. */
export function ColorRow({
  label,
  colorKey,
  value,
  opacity,
  onColorChange,
  onOpacityChange,
}: {
  label: string;
  colorKey: string;
  value: string;
  opacity: number | null;
  onColorChange: (color: string) => void;
  onOpacityChange: (opacity: number) => void;
}) {
  const id = `appearance-${colorKey}`;
  return (
    <div className="settings-color-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-label={label}
        type="color"
        className="settings-swatch"
        value={value}
        onChange={(event) => onColorChange(event.target.value)}
      />
      {opacity === null ? (
        <>
          <span />
          <span />
        </>
      ) : (
        <>
          <OpacityInput
            label={label}
            value={opacity}
            onCommit={onOpacityChange}
          />
          <span className="settings-color-unit">%</span>
        </>
      )}
    </div>
  );
}

/** A color that may fall back to the theme rather than a chosen value. */
export function ThemeColorRow({
  label,
  colorKey,
  value,
  onChange,
}: {
  label: string;
  colorKey: string;
  value: string | null;
  onChange: (color: string | null) => void;
}) {
  const id = `appearance-${colorKey}`;
  return (
    <div className="settings-color-row settings-color-row--theme">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        aria-label={label}
        type="color"
        className="settings-swatch"
        value={value ?? '#ffffff'}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="settings-button settings-button--quiet"
        disabled={value === null}
        onClick={() => onChange(null)}
      >
        Use theme default
      </button>
    </div>
  );
}
