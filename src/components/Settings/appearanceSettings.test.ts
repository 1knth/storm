import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_APPEARANCE } from '../../appearance';
import {
  appearanceColor,
  chartColorGroups,
  diagramColorGroups,
  editorColorGroups,
  hasAppearanceOpacity,
  PREVIEW_EMPHASIS_ROWS,
  withAppearanceColor,
  withAppearanceOpacity,
} from './appearanceSettings';

test('appearanceColor reads direct, heading, and series keys', () => {
  assert.equal(
    appearanceColor(DEFAULT_APPEARANCE, 'cursor'),
    DEFAULT_APPEARANCE.cursor,
  );
  assert.equal(
    appearanceColor(DEFAULT_APPEARANCE, 'heading-3'),
    DEFAULT_APPEARANCE.headings[2],
  );
  assert.equal(
    appearanceColor(DEFAULT_APPEARANCE, 'chartSeries-2'),
    DEFAULT_APPEARANCE.chartSeries[1],
  );
});

test('withAppearanceColor updates only the addressed color', () => {
  const direct = withAppearanceColor(DEFAULT_APPEARANCE, 'cursor', '#123456');
  assert.equal(direct.cursor, '#123456');
  assert.deepEqual(direct.headings, DEFAULT_APPEARANCE.headings);

  const heading = withAppearanceColor(
    DEFAULT_APPEARANCE,
    'heading-2',
    '#abcdef',
  );
  assert.equal(heading.headings[1], '#abcdef');
  assert.equal(heading.headings[0], DEFAULT_APPEARANCE.headings[0]);
  assert.equal(heading.cursor, DEFAULT_APPEARANCE.cursor);

  const series = withAppearanceColor(
    DEFAULT_APPEARANCE,
    'chartSeries-8',
    '#000000',
  );
  assert.equal(series.chartSeries[7], '#000000');
  assert.equal(series.chartSeries[0], DEFAULT_APPEARANCE.chartSeries[0]);
});

test('withAppearanceColor leaves the original appearance untouched', () => {
  const before = DEFAULT_APPEARANCE.headings[0];
  withAppearanceColor(DEFAULT_APPEARANCE, 'heading-1', '#ff0000');
  assert.equal(DEFAULT_APPEARANCE.headings[0], before);
});

test('withAppearanceOpacity keeps other opacity entries', () => {
  const next = withAppearanceOpacity(DEFAULT_APPEARANCE, 'selection', 55);
  assert.equal(next.opacity.selection, 55);
  assert.equal(next.opacity.activeLine, DEFAULT_APPEARANCE.opacity.activeLine);
});

test('hasAppearanceOpacity reports only colors with a stored opacity', () => {
  assert.equal(hasAppearanceOpacity(DEFAULT_APPEARANCE, 'selection'), true);
  assert.equal(hasAppearanceOpacity(DEFAULT_APPEARANCE, 'heading-6'), true);
  assert.equal(hasAppearanceOpacity(DEFAULT_APPEARANCE, 'chartSeries-8'), true);
  assert.equal(hasAppearanceOpacity(DEFAULT_APPEARANCE, 'folderIcon'), false);
});

test('color groups cover every appearance color the panes offer', () => {
  const grouped = [
    ...editorColorGroups(DEFAULT_APPEARANCE),
    ...diagramColorGroups(),
    ...chartColorGroups(DEFAULT_APPEARANCE),
  ].flatMap((group) => group.rows.map((row) => row.key));

  const mermaidKeys = Object.keys(DEFAULT_APPEARANCE).filter(
    (key) => key.startsWith('mermaid') || key.startsWith('lessonMap'),
  );
  const expected = [
    'selection',
    'activeLine',
    'cursor',
    'folderIcon',
    ...DEFAULT_APPEARANCE.headings.map((_, index) => `heading-${index + 1}`),
    ...mermaidKeys,
    'chartText',
    'chartGrid',
    ...DEFAULT_APPEARANCE.chartSeries.map(
      (_, index) => `chartSeries-${index + 1}`,
    ),
  ];
  assert.deepEqual([...grouped].sort(), [...expected].sort());
});

test('every grouped color resolves to a hex value', () => {
  for (const group of [
    ...editorColorGroups(DEFAULT_APPEARANCE),
    ...diagramColorGroups(),
    ...chartColorGroups(DEFAULT_APPEARANCE),
  ]) {
    for (const row of group.rows) {
      assert.match(
        appearanceColor(DEFAULT_APPEARANCE, row.key),
        /^#[\da-fA-F]{6}$/,
        `${row.key} should resolve to a hex color`,
      );
    }
  }
});

test('preview emphasis rows address the nullable theme colors', () => {
  assert.deepEqual(
    PREVIEW_EMPHASIS_ROWS.map((row) => row.key),
    ['previewBoldColor', 'previewItalicColor', 'listMarkerColor'],
  );
  for (const row of PREVIEW_EMPHASIS_ROWS)
    assert.equal(DEFAULT_APPEARANCE[row.key], null);
});
