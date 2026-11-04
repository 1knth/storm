import type { Appearance } from '../../appearance';

/**
 * Appearance colors are addressed by a stable field key. Heading and chart
 * series colors live in arrays, so they use indexed keys (`heading-1`,
 * `chartSeries-3`) that match the keys used by `appearance.opacity`.
 */
export type AppearanceColorRow = { label: string; key: string };
export type AppearanceColorGroup = {
  title: string;
  rows: AppearanceColorRow[];
};

const HEADING_PREFIX = 'heading-';
const SERIES_PREFIX = 'chartSeries-';

function indexedKey(key: string, prefix: string): number {
  if (!key.startsWith(prefix)) return -1;
  const position = Number(key.slice(prefix.length)) - 1;
  return Number.isInteger(position) && position >= 0 ? position : -1;
}

export function appearanceColor(appearance: Appearance, key: string): string {
  const heading = indexedKey(key, HEADING_PREFIX);
  if (heading >= 0) return appearance.headings[heading];
  const series = indexedKey(key, SERIES_PREFIX);
  if (series >= 0) return appearance.chartSeries[series];
  return appearance[key as keyof Appearance] as string;
}

export function withAppearanceColor(
  appearance: Appearance,
  key: string,
  color: string,
): Appearance {
  const heading = indexedKey(key, HEADING_PREFIX);
  if (heading >= 0)
    return {
      ...appearance,
      headings: appearance.headings.map((current, index) =>
        index === heading ? color : current,
      ),
    };
  const series = indexedKey(key, SERIES_PREFIX);
  if (series >= 0)
    return {
      ...appearance,
      chartSeries: appearance.chartSeries.map((current, index) =>
        index === series ? color : current,
      ),
    };
  return { ...appearance, [key]: color };
}

export function withAppearanceOpacity(
  appearance: Appearance,
  key: string,
  opacity: number,
): Appearance {
  return {
    ...appearance,
    opacity: { ...appearance.opacity, [key]: opacity },
  };
}

/** Only colors with a stored opacity offer an opacity field. */
export function hasAppearanceOpacity(
  appearance: Appearance,
  key: string,
): boolean {
  return Object.hasOwn(appearance.opacity, key);
}

/** Preview emphasis colors are nullable: null means "follow the theme". */
export const PREVIEW_EMPHASIS_ROWS = [
  { label: 'Bold text', key: 'previewBoldColor' },
  { label: 'Italic text', key: 'previewItalicColor' },
  { label: 'List markers', key: 'listMarkerColor' },
] as const satisfies readonly AppearanceColorRow[];

export type PreviewEmphasisKey = (typeof PREVIEW_EMPHASIS_ROWS)[number]['key'];

export function editorColorGroups(
  appearance: Appearance,
): AppearanceColorGroup[] {
  return [
    {
      title: 'Editor surface',
      rows: [
        { label: 'Selection highlight', key: 'selection' },
        { label: 'Active line', key: 'activeLine' },
        { label: 'Cursor', key: 'cursor' },
        { label: 'Folder icons', key: 'folderIcon' },
      ],
    },
    {
      title: 'Heading levels',
      rows: appearance.headings.map((_, index) => ({
        label: `Heading ${index + 1}`,
        key: `${HEADING_PREFIX}${index + 1}`,
      })),
    },
  ];
}

export function diagramColorGroups(): AppearanceColorGroup[] {
  return [
    {
      title: 'Canvas and nodes',
      rows: [
        { label: 'Background', key: 'mermaidBackground' },
        { label: 'Node fill', key: 'mermaidNodeFill' },
        { label: 'Node border', key: 'mermaidNodeBorder' },
        { label: 'Group fill', key: 'mermaidGroupFill' },
        { label: 'Group border', key: 'mermaidGroupBorder' },
        { label: 'Group text', key: 'mermaidGroupText' },
        { label: 'Diagram text', key: 'mermaidText' },
      ],
    },
    {
      title: 'Connectors and sequence',
      rows: [
        { label: 'Diagram connectors', key: 'mermaidConnectors' },
        { label: 'Sequence arrows and lines', key: 'mermaidSignalColor' },
      ],
    },
    {
      title: 'Quiz lesson map',
      rows: [
        { label: 'Topic being taught', key: 'lessonMapFocus' },
        { label: 'Mastered', key: 'lessonMapMastered' },
        { label: 'Independent', key: 'lessonMapIndependent' },
        { label: 'Guided', key: 'lessonMapGuided' },
        { label: 'Needs review', key: 'lessonMapNeedsReview' },
      ],
    },
  ];
}

export function chartColorGroups(
  appearance: Appearance,
): AppearanceColorGroup[] {
  return [
    {
      title: 'Labels and grid',
      rows: [
        { label: 'Text and labels', key: 'chartText' },
        { label: 'Grid lines', key: 'chartGrid' },
      ],
    },
    {
      title: 'Series',
      rows: appearance.chartSeries.map((_, index) => ({
        label: `Series ${index + 1}`,
        key: `${SERIES_PREFIX}${index + 1}`,
      })),
    },
  ];
}
