import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import {
  APPEARANCE_KEY,
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
      primaryTextColor: 'rgba(51, 51, 51, 1)',
      lineColor: 'rgba(51, 51, 51, 1)',
    });
  });
});
