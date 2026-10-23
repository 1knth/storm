import { DEFAULT_HEADING_COLORS } from './components/Editor/markdownHighlighting';

export const APPEARANCE_KEY = 'storm.appearance';
export const DEFAULT_APPEARANCE = {
  selection: '#e0bfff',
  activeLine: '#e0bfff',
  cursor: '#027DFF',
  folderIcon: '#9EE4FF',
  previewBoldColor: null as string | null,
  previewItalicColor: null as string | null,
  headings: DEFAULT_HEADING_COLORS,
  mermaidBackground: '#ffffff',
  mermaidNodeFill: '#ECECFF',
  mermaidNodeBorder: '#9370DB',
  mermaidGroupFill: '#f4f4f4',
  mermaidGroupBorder: '#9370DB',
  mermaidGroupText: '#333333',
  mermaidText: '#333333',
  mermaidConnectors: '#333333',
  mermaidSignalColor: '#333333',
  chartText: '#d1d5db',
  chartGrid: '#4b5563',
  chartSeries: [
    '#38bdf8',
    '#f472b6',
    '#a3e635',
    '#fbbf24',
    '#a78bfa',
    '#fb7185',
    '#2dd4bf',
    '#c084fc',
  ],
  opacity: {
    selection: 40,
    activeLine: 10,
    cursor: 100,
    ...Object.fromEntries(
      [...Array(6)].map((_, i) => [`heading-${i + 1}`, 100]),
    ),
    mermaidBackground: 100,
    mermaidNodeFill: 100,
    mermaidNodeBorder: 100,
    mermaidGroupFill: 100,
    mermaidGroupBorder: 100,
    mermaidGroupText: 100,
    mermaidText: 100,
    mermaidConnectors: 100,
    mermaidSignalColor: 100,
    chartText: 100,
    chartGrid: 100,
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`chartSeries-${i + 1}`, 100]),
    ),
  } as Record<string, number>,
};
export type Appearance = typeof DEFAULT_APPEARANCE;
const hex = /^#[\da-fA-F]{6}$/;
export function validateAppearance(value: unknown): Appearance {
  const input =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  function color(value: unknown, fallback: string): string;
  function color(value: unknown, fallback: null): string | null;
  function color(value: unknown, fallback: string | null) {
    return typeof value === 'string' && hex.test(value) ? value : fallback;
  }
  const headings = Array.isArray(input.headings) ? input.headings : [];
  return {
    selection: color(input.selection, DEFAULT_APPEARANCE.selection),
    activeLine: color(input.activeLine, DEFAULT_APPEARANCE.activeLine),
    cursor: color(input.cursor, DEFAULT_APPEARANCE.cursor),
    folderIcon: color(input.folderIcon, DEFAULT_APPEARANCE.folderIcon),
    previewBoldColor:
      input.previewBoldColor === null || input.previewBoldColor === undefined
        ? null
        : color(input.previewBoldColor, null),
    previewItalicColor:
      input.previewItalicColor === null ||
      input.previewItalicColor === undefined
        ? null
        : color(input.previewItalicColor, null),
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
    mermaidGroupFill: color(
      input.mermaidGroupFill,
      DEFAULT_APPEARANCE.mermaidGroupFill,
    ),
    mermaidGroupBorder: color(
      input.mermaidGroupBorder,
      DEFAULT_APPEARANCE.mermaidGroupBorder,
    ),
    mermaidGroupText: color(
      input.mermaidGroupText,
      DEFAULT_APPEARANCE.mermaidGroupText,
    ),
    mermaidText: color(input.mermaidText, DEFAULT_APPEARANCE.mermaidText),
    mermaidConnectors: color(
      input.mermaidConnectors,
      DEFAULT_APPEARANCE.mermaidConnectors,
    ),
    mermaidSignalColor: color(
      input.mermaidSignalColor,
      color(input.mermaidConnectors, DEFAULT_APPEARANCE.mermaidSignalColor),
    ),
    chartText: color(input.chartText, DEFAULT_APPEARANCE.chartText),
    chartGrid: color(input.chartGrid, DEFAULT_APPEARANCE.chartGrid),
    chartSeries: DEFAULT_APPEARANCE.chartSeries.map((fallback, index) =>
      color((input.chartSeries as unknown[])?.[index], fallback),
    ),
    opacity: Object.fromEntries(
      Object.entries(DEFAULT_APPEARANCE.opacity).map(([key, fallback]) => {
        const storedOpacity = input.opacity as
          | Record<string, unknown>
          | undefined;
        const candidate =
          storedOpacity?.[key] ??
          (key === 'mermaidSignalColor'
            ? storedOpacity?.mermaidConnectors
            : undefined);
        return [
          key,
          typeof candidate === 'number' &&
          Number.isFinite(candidate) &&
          candidate >= 0 &&
          candidate <= 100
            ? candidate
            : fallback,
        ];
      }),
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
export function commitOpacityDraft(value: string, fallback: number): number {
  const parsed = value.trim() === '' ? NaN : Number(value);
  return Number.isFinite(parsed)
    ? Math.min(100, Math.max(0, parsed))
    : fallback;
}

export function rgbaColor(color: string, opacity: number): string {
  const match = /^#([\da-fA-F]{2})([\da-fA-F]{2})([\da-fA-F]{2})$/.exec(color);
  if (!match) return 'rgba(0, 0, 0, 1)';
  const alpha = Number.isFinite(opacity)
    ? Math.min(100, Math.max(0, opacity)) / 100
    : 1;
  return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${alpha})`;
}
export function mermaidThemeVariables(appearance: Appearance) {
  return {
    background: rgbaColor(
      appearance.mermaidBackground,
      appearance.opacity.mermaidBackground,
    ),
    primaryColor: rgbaColor(
      appearance.mermaidNodeFill,
      appearance.opacity.mermaidNodeFill,
    ),
    primaryBorderColor: rgbaColor(
      appearance.mermaidNodeBorder,
      appearance.opacity.mermaidNodeBorder,
    ),
    clusterBkg: rgbaColor(
      appearance.mermaidGroupFill,
      appearance.opacity.mermaidGroupFill,
    ),
    clusterBorder: rgbaColor(
      appearance.mermaidGroupBorder,
      appearance.opacity.mermaidGroupBorder,
    ),
    actorTextColor: rgbaColor(
      appearance.mermaidText,
      appearance.opacity.mermaidText,
    ),
    signalTextColor: rgbaColor(
      appearance.mermaidText,
      appearance.opacity.mermaidText,
    ),
    signalColor: rgbaColor(
      appearance.mermaidSignalColor,
      appearance.opacity.mermaidSignalColor,
    ),
    labelTextColor: rgbaColor(
      appearance.mermaidText,
      appearance.opacity.mermaidText,
    ),
    loopTextColor: rgbaColor(
      appearance.mermaidText,
      appearance.opacity.mermaidText,
    ),
    noteTextColor: rgbaColor(
      appearance.mermaidText,
      appearance.opacity.mermaidText,
    ),
    labelBoxBkgColor: rgbaColor(
      appearance.mermaidBackground,
      appearance.opacity.mermaidBackground,
    ),
    labelBoxBorderColor: rgbaColor(
      appearance.mermaidConnectors,
      appearance.opacity.mermaidConnectors,
    ),
    primaryTextColor: rgbaColor(
      appearance.mermaidText,
      appearance.opacity.mermaidText,
    ),
    lineColor: rgbaColor(
      appearance.mermaidConnectors,
      appearance.opacity.mermaidConnectors,
    ),
  };
}
