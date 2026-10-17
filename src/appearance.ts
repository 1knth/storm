import { DEFAULT_HEADING_COLORS } from './components/Editor/markdownHighlighting';

export const APPEARANCE_KEY = 'storm.appearance';
export const DEFAULT_APPEARANCE = {
  selection: '#e0bfff',
  cursor: '#027DFF',
  headings: DEFAULT_HEADING_COLORS,
  mermaidBackground: '#ffffff',
  mermaidNodeFill: '#ECECFF',
  mermaidNodeBorder: '#9370DB',
  mermaidText: '#333333',
  mermaidConnectors: '#333333',
};
export type Appearance = typeof DEFAULT_APPEARANCE;
const hex = /^#[\da-fA-F]{6}$/;
export function validateAppearance(value: unknown): Appearance {
  const input =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const color = (value: unknown, fallback: string) =>
    typeof value === 'string' && hex.test(value) ? value : fallback;
  const headings = Array.isArray(input.headings) ? input.headings : [];
  return {
    selection: color(input.selection, DEFAULT_APPEARANCE.selection),
    cursor: color(input.cursor, DEFAULT_APPEARANCE.cursor),
    headings: DEFAULT_HEADING_COLORS.map((fallback, index) =>
      color(headings[index], fallback),
    ),
    mermaidBackground: color(
      input.mermaidBackground,
      DEFAULT_APPEARANCE.mermaidBackground,
    ),
    mermaidNodeFill: color(
      input.mermaidNodeFill,
      DEFAULT_APPEARANCE.mermaidNodeFill,
    ),
    mermaidNodeBorder: color(
      input.mermaidNodeBorder,
      DEFAULT_APPEARANCE.mermaidNodeBorder,
    ),
    mermaidText: color(input.mermaidText, DEFAULT_APPEARANCE.mermaidText),
    mermaidConnectors: color(
      input.mermaidConnectors,
      DEFAULT_APPEARANCE.mermaidConnectors,
    ),
  };
}
export function loadAppearance(storage: Pick<Storage, 'getItem'>): Appearance {
  try {
    const raw = storage.getItem(APPEARANCE_KEY);
    return raw ? validateAppearance(JSON.parse(raw)) : validateAppearance(null);
  } catch {
    return validateAppearance(null);
  }
}
export function saveAppearance(
  storage: Pick<Storage, 'setItem'>,
  appearance: Appearance,
) {
  try {
    storage.setItem(
      APPEARANCE_KEY,
      JSON.stringify(validateAppearance(appearance)),
    );
  } catch {
    /* Preferences are optional. */
  }
}
export function mermaidThemeVariables(appearance: Appearance) {
  return {
    background: appearance.mermaidBackground,
    primaryColor: appearance.mermaidNodeFill,
    primaryBorderColor: appearance.mermaidNodeBorder,
    primaryTextColor: appearance.mermaidText,
    lineColor: appearance.mermaidConnectors,
  };
}
