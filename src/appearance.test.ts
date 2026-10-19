import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import {
  APPEARANCE_KEY,
  commitOpacityDraft,
  DEFAULT_APPEARANCE,
  loadAppearance,
  mermaidThemeVariables,
  rgbaColor,
  saveAppearance,
  validateAppearance,
} from './appearance';

describe('appearance preferences', () => {
  it('validates malformed colors and incomplete heading palettes', () => {
    const result = validateAppearance({
      selection: 'red',
      headings: ['#abcdef'],
    });
    strictEqual(result.selection, DEFAULT_APPEARANCE.selection);
    deepStrictEqual(result.headings, [
      '#abcdef',
      ...DEFAULT_APPEARANCE.headings.slice(1),
    ]);
  });
  it('ignores legacy theme values while retaining custom appearance settings', () => {
    const appearance = validateAppearance({
      theme: 'light',
      selection: '#123456',
      opacity: { selection: 63 },
    });
    strictEqual('theme' in appearance, false);
    strictEqual(appearance.selection, '#123456');
    strictEqual(appearance.opacity.selection, 63);
  });
  it('defaults Mermaid group colors for existing saved preferences', () => {
    const result = validateAppearance({ mermaidNodeFill: '#123456' });
    strictEqual(result.mermaidNodeFill, '#123456');
    strictEqual(result.mermaidGroupFill, DEFAULT_APPEARANCE.mermaidGroupFill);
    strictEqual(
      result.mermaidGroupBorder,
      DEFAULT_APPEARANCE.mermaidGroupBorder,
    );
    strictEqual(result.mermaidGroupText, DEFAULT_APPEARANCE.mermaidGroupText);
  });
  it('loads malformed storage safely and persists validated values', () => {
    const memory = new Map<string, string>([[APPEARANCE_KEY, '{bad']]);
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    };
    deepStrictEqual(loadAppearance(storage), DEFAULT_APPEARANCE);
    saveAppearance(storage, {
      ...DEFAULT_APPEARANCE,
      cursor: 'invalid',
    } as never);
    deepStrictEqual(loadAppearance(storage), DEFAULT_APPEARANCE);
  });
  it('persists and applies group-label color independently from node text', () => {
    const appearance = validateAppearance({
      mermaidGroupText: '#123456',
      mermaidText: '#abcdef',
      opacity: { mermaidGroupText: 60 },
    });
    strictEqual(appearance.mermaidGroupText, '#123456');
    strictEqual(appearance.mermaidText, '#abcdef');
    strictEqual(appearance.opacity.mermaidGroupText, 60);
    const variables = mermaidThemeVariables(appearance);
    strictEqual('titleColor' in variables, false);
    strictEqual(variables.primaryTextColor, 'rgba(171, 205, 239, 1)');
  });
  it('maps sequence labels to readable text and contrasting palette backgrounds', () => {
    const appearance = validateAppearance({
      mermaidText: '#102030',
      mermaidBackground: '#fefefe',
      mermaidConnectors: '#405060',
      opacity: { mermaidText: 75, mermaidBackground: 100 },
    });
    const variables = mermaidThemeVariables(appearance);
    for (const key of [
      'actorTextColor',
      'signalTextColor',
      'labelTextColor',
      'loopTextColor',
      'noteTextColor',
    ] as const) {
      strictEqual(variables[key], 'rgba(16, 32, 48, 0.75)');
    }
    strictEqual(variables.labelBoxBkgColor, 'rgba(254, 254, 254, 1)');
    strictEqual(variables.labelBoxBorderColor, 'rgba(64, 80, 96, 1)');
    strictEqual(variables.clusterBkg, 'rgba(244, 244, 244, 1)');
    strictEqual(variables.clusterBorder, 'rgba(147, 112, 219, 1)');
  });
  it('defaults active-line settings for existing preferences and preserves custom values', () => {
    const legacy = validateAppearance({ selection: '#123456' });
    strictEqual(legacy.activeLine, DEFAULT_APPEARANCE.activeLine);
    strictEqual(
      legacy.opacity.activeLine,
      DEFAULT_APPEARANCE.opacity.activeLine,
    );
    const custom = validateAppearance({
      activeLine: '#abcdef',
      opacity: { activeLine: 52 },
    });
    strictEqual(custom.activeLine, '#abcdef');
    strictEqual(custom.opacity.activeLine, 52);
  });
  it('clamps opacity drafts on commit and recovers invalid drafts', () => {
    for (const [draft, expected] of [
      ['-10', 0],
      ['150', 100],
      ['0', 0],
      ['100', 100],
      ['50', 50],
      ['12.5', 12.5],
    ] as const) {
      strictEqual(commitOpacityDraft(draft, 40), expected);
    }
    for (const draft of ['', '-', 'invalid', 'NaN', 'Infinity']) {
      strictEqual(commitOpacityDraft(draft, 40), 40);
    }
  });
  it('defaults opacity for legacy settings and rejects invalid values', () => {
    const result = validateAppearance({
      opacity: { selection: 140, cursor: -1, 'heading-1': NaN },
    });
    deepStrictEqual(result.opacity, DEFAULT_APPEARANCE.opacity);
  });
  it('clamps RGBA alpha and preserves valid RGB palette colors', () => {
    strictEqual(rgbaColor('#123456', 40), 'rgba(18, 52, 86, 0.4)');
    strictEqual(rgbaColor('#123456', 500), 'rgba(18, 52, 86, 1)');
    strictEqual(rgbaColor('#123456', -1), 'rgba(18, 52, 86, 0)');
  });
  it('maps Mermaid palette controls onto base theme variables', () => {
    deepStrictEqual(mermaidThemeVariables(DEFAULT_APPEARANCE), {
      background: 'rgba(255, 255, 255, 1)',
      primaryColor: 'rgba(236, 236, 255, 1)',
      primaryBorderColor: 'rgba(147, 112, 219, 1)',
      clusterBkg: 'rgba(244, 244, 244, 1)',
      clusterBorder: 'rgba(147, 112, 219, 1)',
      actorTextColor: 'rgba(51, 51, 51, 1)',
      signalTextColor: 'rgba(51, 51, 51, 1)',
      labelTextColor: 'rgba(51, 51, 51, 1)',
      loopTextColor: 'rgba(51, 51, 51, 1)',
      noteTextColor: 'rgba(51, 51, 51, 1)',
      labelBoxBkgColor: 'rgba(255, 255, 255, 1)',
      labelBoxBorderColor: 'rgba(51, 51, 51, 1)',
      primaryTextColor: 'rgba(51, 51, 51, 1)',
      lineColor: 'rgba(51, 51, 51, 1)',
    });
  });
});
