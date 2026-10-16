import { parseDocument } from 'yaml';

export const MAX_CHART_SOURCE_LENGTH = 12_000;
const MAX_LABELS = 40;
const MAX_SERIES = 8;

export type NumericChartType = 'bar' | 'line' | 'pie' | 'doughnut';
export type NumericChartData = {
  type: NumericChartType;
  labels: string[];
  series: { title?: string; data: number[] }[];
  title?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseChartData(source: string): NumericChartData {
  if (source.length > MAX_CHART_SOURCE_LENGTH) {
    throw new Error(
      `Chart data is too large (maximum ${MAX_CHART_SOURCE_LENGTH} characters).`,
    );
  }

  const document = parseDocument(source, {
    strict: true,
    uniqueKeys: true,
    schema: 'core',
  });
  if (document.errors.length > 0) throw new Error(document.errors[0].message);

  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['type', 'labels', 'series', 'title'])
  ) {
    throw new Error(
      'Use only type, labels, series, and optional title fields.',
    );
  }
  if (!['bar', 'line', 'pie', 'doughnut'].includes(String(value.type))) {
    throw new Error('Chart type must be bar, line, pie, or doughnut.');
  }
  const labels = value.labels;
  if (
    !Array.isArray(labels) ||
    labels.length === 0 ||
    labels.length > MAX_LABELS ||
    !labels.every((label) => typeof label === 'string' && label.length <= 80)
  ) {
    throw new Error(
      `Labels must contain 1–${MAX_LABELS} strings (up to 80 characters each).`,
    );
  }
  if (
    !Array.isArray(value.series) ||
    value.series.length === 0 ||
    value.series.length > MAX_SERIES
  ) {
    throw new Error(`Series must contain 1–${MAX_SERIES} entries.`);
  }

  const series = value.series.map((entry, index) => {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ['title', 'data'])) {
      throw new Error(`Series ${index + 1} may contain only title and data.`);
    }
    if (
      entry.title !== undefined &&
      (typeof entry.title !== 'string' || entry.title.length > 80)
    ) {
      throw new Error(
        `Series ${index + 1} title must be a string up to 80 characters.`,
      );
    }
    if (
      !Array.isArray(entry.data) ||
      entry.data.length !== labels.length ||
      !entry.data.every(
        (number) => typeof number === 'number' && Number.isFinite(number),
      )
    ) {
      throw new Error(
        `Series ${index + 1} data must have one finite number per label.`,
      );
    }
    return {
      title: entry.title as string | undefined,
      data: entry.data as number[],
    };
  });

  if (
    value.title !== undefined &&
    (typeof value.title !== 'string' || value.title.length > 120)
  ) {
    throw new Error('Chart title must be a string up to 120 characters.');
  }

  return {
    type: value.type as NumericChartType,
    labels: labels as string[],
    series,
    title: value.title as string | undefined,
  };
}
