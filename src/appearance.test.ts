import { deepStrictEqual, strictEqual } from 'node:assert';
import { describe, it } from 'node:test';
import {
  APPEARANCE_KEY,
  DEFAULT_APPEARANCE,
  loadAppearance,
  mermaidThemeVariables,
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
  it('maps Mermaid palette controls onto base theme variables', () => {
    deepStrictEqual(mermaidThemeVariables(DEFAULT_APPEARANCE), {
      background: DEFAULT_APPEARANCE.mermaidBackground,
      primaryColor: DEFAULT_APPEARANCE.mermaidNodeFill,
      primaryBorderColor: DEFAULT_APPEARANCE.mermaidNodeBorder,
      primaryTextColor: DEFAULT_APPEARANCE.mermaidText,
      lineColor: DEFAULT_APPEARANCE.mermaidConnectors,
    });
  });
});
